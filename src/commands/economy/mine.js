'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { attachGrind, persistGrindIfNew, saveGrind } = require('../../utils/grindProfile');
const { isVersionError } = require('../../utils/versionRetry');
const { detachBalanceDelta, commitBalanceDelta, saveWithBalanceDelta } = require('../../utils/balanceDelta');
const { chargeExact, refundCharge } = require('../../utils/balanceDebit');
const GrindProfile = require('../../models/GrindProfile');
const Guild = require('../../models/Guild');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse }          = require('../../utils/shopBrowse');
const { packFields }             = require('../../utils/embedFields');
const {
    DEPTHS, DEPTH_LIST, TIER_COLORS, LIMITS, PICKAXE_BY_TIER,
    MATERIAL_NAMES, CONSUMABLES, BLAST_PACKS,
    PICKAXE_TIERS, PICKAXE_BY_SLUG, PICKAXE_UPGRADES,
    MINER_LEVELS, PRESTIGE_BONUSES, MINE_QUEST_TEMPLATES,
    RAID_COOLDOWN_MS, RAID_SHIELD_MS, RAID_STEAL_MIN, RAID_STEAL_MAX
} = require('../../data/mineData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { TIER_NUM, TIER_RIBBON, TIER_STARS } = require('../../data/materialRarity');
const { randomFrom, MINE_CAVE_LINES } = require('../../utils/copyLines');
const { getPityBonus, buildPityStreakField, PITY_COPY } = require('../../utils/pityBonus');
const {
    ensureMineData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    executeMine,
    assignDailyMineQuests,
    updateMineQuestProgress,
    formatMs,
    pickaxeStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel,
    activateConsumable,
    isCondemned,
    quoteRepair,
    applyRepair,
    updatePickaxeStatus,
    applyXp,
    updateMineMap,
    renderMineMap,
    msUntilDailyReset,
    getRaidableMaterials,
    hasRaidableMaterials,
    planRaidHaul,
    RAID_MAX_PER_MATERIAL
} = require('../../services/mineService');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { stackBar } = require('../../utils/rewardReveal');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { tryUpdateHourlyWinner, getCurrentHourlyLeader } = require('../../utils/hourlyWinner');
const { isDistrictActive } = require('../../services/districtService');
const { ensureQuests, onMine, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { recordMissionProgress } = require('../../services/seasonMissionService');
const { getActiveSynergies } = require('../../services/synergyService');
const { refundEffectCharge } = require('../../services/effectsService');
const { CROSS_CONSUMABLES } = require('../../data/crossSystemData');

const WILDERNESS_YIELD_BONUS = 0.10;

// Resolve a consumable's display metadata from the mine shop or cross-system registry.
function resolveConsumableDef(id) {
    return CONSUMABLES[id] ?? CROSS_CONSUMABLES[id] ?? null;
}

const walletOf = interaction => ({ userId: interaction.user.id, guildId: interaction.guild.id });

// One contract for both, shared with the other grind shops: the charge is a
// conditional update rather than `user.balance -= cost` followed by a save,
// because the loaded document's balance goes stale the moment any other
// command pays the player. See src/utils/balanceDebit.js.
const chargeBalance = (interaction, cost) => chargeExact(User, walletOf(interaction), cost);
const refundBalance = (interaction, cost) => refundCharge(User, walletOf(interaction), cost, 'mineshop');

const DEPTH_CHOICES    = DEPTH_LIST.map(d => ({ name: d.name, value: d.id }));
const PICKAXE_CHOICES  = PICKAXE_TIERS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost.toLocaleString()} coins`, value: p.slug }));
const ALL_ITEMS        = [...Object.values(CONSUMABLES), ...BLAST_PACKS];
const ITEM_CHOICES     = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const ACTIVATABLE      = ['ore_magnet', 'premium_magnet', 'miners_lamp', 'miners_instinct', 'xp_scroll', 'energy_tonic', 'reinforced_trap', 'mine_lock'];
const UPGRADE_CHOICES  = Object.values(PICKAXE_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES   = DEPTH_LIST.filter(d => !d.defaultUnlocked).map(d => ({ name: `${d.emoji} ${d.name}`, value: d.id }));

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

// Miner Level tops out at the end of the MINER_LEVELS ladder; prestige tops out at
// the end of the bonus table. Both are derived so the two tables stay the authority.
const MAX_MINER_LEVEL   = MINER_LEVELS.length;
const MAX_MINE_PRESTIGE = PRESTIGE_BONUSES.length - 1;

// Depth risk levels for the pre-dig selection prompt
const INTENSITY_LEVELS = [
    { level: 1, name: 'Surface',  emoji: '☀️',  multiplier: 0.7, caveInRisk: 0.00, durLoss: 1 },
    { level: 2, name: 'Shallow',  emoji: '🪨',  multiplier: 1.0, caveInRisk: 0.05, durLoss: 1 },
    { level: 3, name: 'Mid',      emoji: '🔩',  multiplier: 1.4, caveInRisk: 0.12, durLoss: 2 },
    { level: 4, name: 'Deep',     emoji: '💎',  multiplier: 2.0, caveInRisk: 0.20, durLoss: 3 },
    { level: 5, name: 'Abyss',    emoji: '🌑',  multiplier: 3.0, caveInRisk: 0.30, durLoss: 4 },
];

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Mining: dig, profile, inventory, quests, and shop.')
        .addSubcommand(sub =>
            sub.setName('dig')
                .setDescription('Mine ore in your current depth. Uses 1 stamina. Cooldown: 30s.')
                .addStringOption(o =>
                    o.setName('depth')
                        .setDescription('Depth to mine in (defaults to your active depth).')
                        .setRequired(false)
                        .addChoices(...DEPTH_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's miner profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommandGroup(group =>
            group.setName('inv')
                .setDescription('Manage your mining inventory and pickaxes')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View your pickaxes, charges, consumables, and materials'))
                .addSubcommand(sub =>
                    sub.setName('equip')
                        .setDescription('Equip a pickaxe from your inventory')
                        .addIntegerOption(o =>
                            o.setName('slot')
                                .setDescription('Pickaxe slot number (use /mine inv view to see slots)')
                                .setRequired(true)
                                .setMinValue(1)))
                .addSubcommand(sub =>
                    sub.setName('discard')
                        .setDescription('Discard a broken or condemned pickaxe')
                        .addIntegerOption(o =>
                            o.setName('slot')
                                .setDescription('Pickaxe slot number (use /mine inv view to see slots)')
                                .setRequired(true)
                                .setMinValue(1))))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily mine quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('See your active daily mine quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addStringOption(o =>
                            o.setName('quest')
                                .setDescription('Quest to claim')
                                .setRequired(true)
                                .addChoices(...MINE_QUEST_TEMPLATES.map(t => ({ name: t.name, value: t.id }))))))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Reset your Miner Level for permanent bonuses (requires Miner Level 50)'))
        .addSubcommand(sub =>
            sub.setName('map')
                .setDescription('View your persistent mine map — see every cell you have excavated.'))
        .addSubcommand(sub =>
            sub.setName('raid')
                .setDescription('Raid another miner and steal some of their crafting materials (requires pickaxe equipped)')
                .addUserOption(o =>
                    o.setName('target')
                        .setDescription('The miner to raid')
                        .setRequired(true)))
        .addSubcommandGroup(group =>
            group.setName('shop')
                .setDescription('Browse and purchase all mining gear, charges, and supplies')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse everything available in the mining shop'))
                .addSubcommand(sub =>
                    sub.setName('pickaxe')
                        .setDescription('Buy a new pickaxe')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which pickaxe to buy')
                                .setRequired(true)
                                .addChoices(...PICKAXE_CHOICES))
                        .addBooleanOption(o =>
                            o.setName('equip')
                                .setDescription('Auto-equip after purchase (default: true)')
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('upgrade')
                        .setDescription('Install a module upgrade on your equipped pickaxe (one per pickaxe, permanent)')
                        .addStringOption(o =>
                            o.setName('module')
                                .setDescription('Upgrade module to install')
                                .setRequired(true)
                                .addChoices(...UPGRADE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('buy')
                        .setDescription('Purchase blast charge packs or consumables')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Item to buy')
                                .setRequired(true)
                                .addChoices(...ITEM_CHOICES))
                        .addIntegerOption(o =>
                            o.setName('quantity')
                                .setDescription('How many to buy (default: 1)')
                                .setRequired(false)
                                .setMinValue(1)
                                .setMaxValue(20)))
                .addSubcommand(sub =>
                    sub.setName('use')
                        .setDescription('Activate a consumable buff')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Consumable to activate')
                                .setRequired(true)
                                .addChoices(...ACTIVATABLE.map(id => ({ name: resolveConsumableDef(id)?.name ?? id, value: id })))))
                .addSubcommand(sub =>
                    sub.setName('repair')
                        .setDescription('Repair your equipped pickaxe at the shop or use a repair kit')
                        .addStringOption(o =>
                            o.setName('method')
                                .setDescription('Repair method')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Shop repair (pay coins)', value: 'shop' },
                                    { name: 'Use Small Repair Kit',    value: 'kit_small' },
                                    { name: 'Use Large Repair Kit',    value: 'kit_large' }
                                )))
                .addSubcommand(sub =>
                    sub.setName('unlock')
                        .setDescription('Unlock a new mine depth')
                        .addStringOption(o =>
                            o.setName('depth')
                                .setDescription('Depth to unlock')
                                .setRequired(true)
                                .addChoices(...UNLOCK_CHOICES)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'dig')     return handleDig(interaction);
            if (sub === 'profile') return handleProfile(interaction);
            if (sub === 'map')     return handleMap(interaction);
            if (sub === 'raid')    return handleRaid(interaction);
            if (sub === 'prestige') return handlePrestige(interaction);
        }
        if (group === 'inv')    return handleInv(interaction, sub);
        if (group === 'quests') return handleQuests(interaction, sub);
        if (group === 'shop')   return handleShop(interaction, sub);
    }
};

// ─── Staged loot reveal for rare+ drops ──────────────────────────────────────
async function stagedLootReveal(interaction, tier, finalEmbed) {
    const tierNum = TIER_NUM[tier] ?? 0;
    if (tierNum < 3) {
        await interaction.editReply({ embeds: [finalEmbed] });
        return;
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));

    const fogEmbed = new EmbedBuilder()
        .setColor('#4a4a4a')
        .setTitle('🌫️ Your pickaxe strikes something unusual...')
        .setDescription('━━━━━━━━━━━━━━━\n*The rock face glints in your lantern light.*\n━━━━━━━━━━━━━━━');

    if (tierNum === 3) {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
    } else {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
        const midColor = tierNum === 6 ? '#e74c3c' : tierNum === 4 ? '#9c27b0' : '#ff9800';
        const midTitle = tierNum === 6 ? '☄️ The rock itself begins to hum...' : tierNum === 4 ? '🔮 A rare vein reveals itself...' : '⚡ The tunnel fills with an impossible glow...';
        const midTierLabel = tierNum === 6 ? 'EVENT' : tierNum === 4 ? 'EPIC' : 'LEGENDARY';
        const midEmbed = new EmbedBuilder()
            .setColor(midColor)
            .setTitle(midTitle)
            .setDescription(`━━━━━━━━━━━━━━━\n❓❓❓  **${midTierLabel}**  ❓❓❓\n━━━━━━━━━━━━━━━`);
        await interaction.editReply({ embeds: [midEmbed] });
        await wait(1500);
        if (tierNum >= 5) {
            const isEvent = tierNum === 6;
            const fanfareEmbed = new EmbedBuilder()
                .setColor(isEvent ? '#e74c3c' : '#ff9800')
                .setTitle(isEvent ? '☄️ 🌋 𝗣 𝗥 𝗜 𝗠 𝗢 𝗥 𝗗 𝗜 𝗔 𝗟 🌋 ☄️' : '⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡')
                .setDescription(isEvent ? '━━━━━━━━━━━━━━━\n*This ore has no business existing. Nobody will believe you.*\n━━━━━━━━━━━━━━━' : '━━━━━━━━━━━━━━━\n*Miners dream of this their whole careers.*\n━━━━━━━━━━━━━━━');
            await interaction.editReply({ embeds: [fanfareEmbed] });
            await wait(1500);
        }
    }
    await interaction.editReply({ embeds: [finalEmbed] });
}

// ─── DIG ──────────────────────────────────────────────────────────────────────

async function handleDig(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );

    await attachGrind(user);
    ensureMineData(user);
    applyStaminaRegen(user);
    applyDailyReset(user);
    assignDailyMineQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[mine] pre-check save error:', e));
    }

    const m = user.mining;

    const requestedDepth = interaction.options.getString('depth');
    const depthId = requestedDepth ?? m.activeDepth;
    const depth   = DEPTHS[depthId];

    if (!depth) {
        return interaction.reply({ content: `Unknown depth \`${depthId}\`. Use \`/mine shop list\` to see available depths.`, flags: MessageFlags.Ephemeral });
    }
    // Access is decided by `unlockedDepths` alone. The level requirement is enforced
    // once, at `/mine shop unlock`; re-checking it here would lock a prestiged miner
    // out of depths they already paid for, since prestige resets the level and the
    // purchase is permanent.
    if (!m.unlockedDepths.includes(depthId)) {
        const gate = depth.defaultUnlocked
            ? ''
            : ` (Miner Level ${depth.unlockLevel}, ${depth.unlockCost.toLocaleString()} coins)`;
        return interaction.reply({
            content: `You haven't unlocked **${depth.name}** yet. Use \`/mine shop unlock\` to unlock it${gate}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    if (m.injuryUntil && Date.now() < m.injuryUntil.getTime()) {
        const nextAt = new Date(m.injuryUntil.getTime());
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🤕 Recovering from Cave-in',
                description: "You took a hit down there. Rest up before heading back underground.",
                color: '#b5651d',
                nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (m.lastMine && Date.now() - m.lastMine.getTime() < LIMITS.MINE_COOLDOWN_MS) {
        const nextAt = new Date(m.lastMine.getTime() + LIMITS.MINE_COOLDOWN_MS);
        // Intensity is earned in the vein-reading rounds, not picked from a menu —
        // so the preview promises what a good read pays, not a setting to choose.
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '⛏️ Catching Your Breath',
                description: 'You just came up from a dig.\nTake a short break before heading back down.',
                color: '#b5651d',
                nextAt,
                nextRewardPreview: 'Read the vein 3/3 on your next dig and the haul pays 2× — 3× if it opens into the Abyss',
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (m.stamina <= 0) {
        const regenMs   = msUntilNextStamina(user);
        const nextAt    = new Date(Date.now() + regenMs);
        // Report the fail-streak pity that actually exists, through the shared curve
        // so this cannot drift from what calculateSuccessChance applies. Mining has
        // no rare-material guarantee — only hunting implements one
        // (LIMITS.RARE_PITY_GUARANTEE) — so sinceRare is reported as the stat it is.
        const sinceRare = m.sinceRare ?? 0;
        const pityBonus = getPityBonus(m.consecutiveFails ?? 0, LIMITS);
        const pityBits  = [];
        if (pityBonus > 0) {
            pityBits.push(`🎯 ${m.consecutiveFails} ${PITY_COPY.mining.streakNoun} • +${Math.round(pityBonus * 100)}% success on your next dig`);
        }
        if (sinceRare >= 5) pityBits.push(`⛏️ ${sinceRare} digs since your last Rare+ material`);
        const pityStat = pityBits.length ? pityBits.join('\n') : null;
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Out of Stamina',
                description: "You've dug yourself to exhaustion.\nBuy an **Energy Tonic** from `/mine shop` to recover faster.",
                color: '#b5651d',
                nextAt,
                pityStat,
                // Stamina buys swings, not luck: tier odds come from the depth you
                // dig, your pickaxe and an active magnet. Don't imply otherwise.
                nextRewardPreview: 'Deeper depths, a better pickaxe and an Ore Magnet are what move your rare odds',
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
        return interaction.reply({
            content: `You don't have a pickaxe equipped! Buy one with \`/mine shop pickaxe\` and equip it with \`/mine inv equip 1\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

    if (pickaxe.status === 'broken' || pickaxe.currentDurability <= 0) {
        return interaction.reply({
            content: `Your **${pickaxe.name}** is broken! Repair it with \`/mine shop repair\` or buy a new one with \`/mine shop pickaxe\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // ── Charge check (read-only; the stock is spent after the claim below) ──
    const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
    if (pickaxeData.requiresCharge && (m.charges[pickaxeData.chargeType] ?? 0) <= 0) {
        return interaction.reply({
            content: `You're out of **${pickaxeData.chargeType.replace(/_/g, ' ')}**! Buy more with \`/mine shop buy\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Atomically claim the cooldown slot now that all preflight checks have passed —
    // lastMine is set the moment the dig is actually accepted, not earlier, so a
    // failed precheck (stamina/pickaxe/charge) never burns the cooldown. The same
    // guard stops two concurrent /mine dig calls from both slipping through.
    //
    // The claim targets GrindProfile, not User: mining state lives in its own
    // collection (see src/models/User.js), so a User-level guard would match every
    // document on the missing `mining` field and never reject anything.
    const mineClaimNow = new Date();
    const mineCooldownFloor = new Date(mineClaimNow.getTime() - LIMITS.MINE_COOLDOWN_MS);
    const priorLastMine = m.lastMine ?? null;
    await persistGrindIfNew(user, 'mining');
    const mineClaimQuery = { userId: interaction.user.id, guildId: interaction.guild.id, system: 'mining' };
    const claimedMine = await GrindProfile.findOneAndUpdate(
        {
            ...mineClaimQuery,
            $or: [{ 'data.lastMine': null }, { 'data.lastMine': { $lte: mineCooldownFloor } }],
        },
        { $set: { 'data.lastMine': mineClaimNow } },
        { new: true },
    );

    if (!claimedMine) {
        // Losing the claim means another dig already took the slot, so the
        // in-memory snapshot is stale — read the winning timestamp back so the
        // countdown reflects the dig that actually happened. If that read fails,
        // fall back to now rather than the snapshot: reaching the claim at all
        // means the snapshot was already past the cooldown floor, so it would
        // render a countdown in the past and tell the player they can dig again.
        const current = await GrindProfile.findOne(mineClaimQuery).catch(() => null);
        const lastAt  = current?.data?.lastMine ?? mineClaimNow;
        const nextAt  = new Date(new Date(lastAt).getTime() + LIMITS.MINE_COOLDOWN_MS);
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '⛏️ Catching Your Breath',
                description: 'You just came up from a dig.\nTake a short break before heading back down.',
                color: '#b5651d',
                nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }
    m.lastMine = mineClaimNow;

    // The claim is a real write now, so a dig that dies before its result is
    // saved would otherwise cost the player a full cooldown for nothing. Hand the
    // slot back — but only while it is still ours, so a newer claim isn't undone.
    const releaseMineClaim = () => GrindProfile.updateOne(
        { ...mineClaimQuery, 'data.lastMine': mineClaimNow },
        { $set: { 'data.lastMine': priorLastMine } },
    ).catch(() => null);

    // Everything between here and the save can still fail — a Discord API error
    // while collecting the vein prompts, a service throwing — and until the result
    // is persisted the player has nothing to show for the cooldown they just paid
    // for. Hand the slot back on the way out unless the dig committed.
    let mineCommitted = false;

    // Everything below runs across the interactive prompts, during which the
    // player can spend coins elsewhere. The run's own coin movement is
    // collected as a delta against this reading and applied as an atomic
    // `$inc` at the save, so `save()` never writes an absolute balance read
    // before that window. See src/utils/balanceDelta.js.
    const balanceAtLoad = user.balance ?? 0;
    const balanceFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

    try {

        // The charge comes out only once the cooldown slot is ours, so a lost race
        // never costs the player a charge.
        if (pickaxeData.requiresCharge) {
            m.charges[pickaxeData.chargeType] = (m.charges[pickaxeData.chargeType] ?? 0) - 1;
            user.markModified('mining');
        }

        // Digging an explicit depth makes it your active depth. Without this it only
        // ever moved when you unlocked something, so /mine profile and /mine map kept
        // reporting a depth you had long since stopped digging.
        if (requestedDepth && m.activeDepth !== depthId) {
            m.activeDepth = depthId;
            user.markModified('mining');
        }

        // ── Vein-Following Puzzle ──────────────────────────────────────────────────
        // 3 rounds of directional navigation through a mine tunnel.
        // Each round: a 3×3 emoji grid shows the current position (⛏️) and a mineral
        // trace in one of the 4 adjacent cells. Player picks the matching direction.
        // Correct directions accumulate depth; final depth maps to intensity level.
        //   0/3 correct → Surface  (0.7×, 0% cave-in)
        //   1/3 correct → Shallow  (1.0×, 5% cave-in)
        //   2/3 correct → Mid      (1.4×, 12% cave-in)
        //   3/3 correct → Deep     (2.0×, 20% cave-in)
        //   3/3 + lucky → Abyss    (3.0×, 30% cave-in)  10% chance on a perfect run

        const featured         = getDailyFeatured(interaction.guild.id);
        const isFeaturedDepth  = depthId === featured.mineDepth.id;
        const timeBand         = getTimeBand();
        const delay = ms => new Promise(r => setTimeout(r, ms));

        const DIRS = [
            { id: 'N', label: '⬆️ North', row: 0, col: 1 },
            { id: 'S', label: '⬇️ South', row: 2, col: 1 },
            { id: 'W', label: '⬅️ West',  row: 1, col: 0 },
            { id: 'E', label: '➡️ East',  row: 1, col: 2 },
        ];

        // Build a 3×3 grid string highlighting the ore direction
        function buildGrid(oreDir) {
            const grid = [
                ['🪨', '🪨', '🪨'],
                ['🪨', '⛏️', '🪨'],
                ['🪨', '🪨', '🪨'],
            ];
            const d = DIRS.find(d => d.id === oreDir);
            grid[d.row][d.col] = '✨';
            return grid.map(row => row.join(' ')).join('\n');
        }

        const featuredDepthNote = isFeaturedDepth
            ? `\n🌟 **Featured Depth!** +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout active.`
            : '';

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(isFeaturedDepth ? '#FFD700' : '#8B4513')
                .setTitle(`⛏️ Entering ${depth.emoji} ${depth.name}…`)
                .setDescription(
                    `*You lower yourself into the shaft. Dust settles. Your lamp catches a glint…*\n\n` +
                    `**Follow the vein** — 3 rounds of directional choices. The deeper you follow it, the richer the haul.${featuredDepthNote}`
                )
                .setFooter({ text: `${timeBand.emoji} ${timeBand.label} · 15 seconds per choice — miss a round and you stop there.` })],
            components: [],
        });
        const mineMsg = await interaction.fetchReply();
        await delay(1500);

        let veinDepth = 0;
        const roundLog = [];

        for (let round = 0; round < 3; round++) {
            const oreDir  = DIRS[Math.floor(Math.random() * DIRS.length)];
            const grid    = buildGrid(oreDir.id);
            const prevLog = roundLog.map((r, i) => r ? `✅` : `❌`).join(' ');

            const veinEmbed = new EmbedBuilder()
                .setColor('#B8860B')
                .setTitle(`⛏️ Vein Read — Round ${round + 1}/3`)
                .setDescription(
                    `${prevLog ? prevLog + '\n\n' : ''}` +
                    `*Mineral trace spotted — which way does the vein run?*\n\n` +
                    `\`\`\`\n${grid}\n\`\`\``
                )
                .setFooter({ text: '15 seconds to choose a direction.' });

            const dirRow = new ActionRowBuilder().addComponents(
                ...DIRS.map(d => new ButtonBuilder()
                    .setCustomId(`vein_${d.id}`)
                    .setLabel(d.label)
                    .setStyle(ButtonStyle.Primary)
                )
            );

            await interaction.editReply({ embeds: [veinEmbed], components: [dirRow] });

            const picked = await new Promise(resolve => {
                const col = mineMsg.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id && i.customId.startsWith('vein_'),
                    time: 15_000,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(i.customId.replace('vein_', '')); });
                col.on('end',     (_, reason) => { if (reason !== 'limit') resolve(null); });
            });

            const correct = picked === oreDir.id;
            roundLog.push(correct);
            if (correct) veinDepth++;

            const roundResult = new EmbedBuilder()
                .setColor(correct ? '#00CC55' : picked ? '#CC4400' : '#888888')
                .setTitle(correct ? '✅ Vein found!' : picked ? '❌ Dead end — rubble.' : '⏰ Hesitated…')
                .setDescription(
                    correct
                        ? `You followed the vein **${oreDir.label}**. It runs deeper here.`
                        : picked
                        ? `The vein ran **${oreDir.label}** — you hit rubble instead.`
                        : `The vein ran **${oreDir.label}** — you didn't move in time.`
                );
            await interaction.editReply({ embeds: [roundResult], components: [] });
            if (round < 2) await delay(900);
        }

        // Map vein depth to intensity level
        let intensityIndex = veinDepth; // 0→L1, 1→L2, 2→L3, 3→L4
        if (veinDepth === 3 && Math.random() < 0.10) intensityIndex = 4; // lucky Abyss
        const chosenIntensity = INTENSITY_LEVELS[intensityIndex];

        const finalIcons = roundLog.map(r => r ? '✅' : '❌').join(' ');
        const confirmEmbed = new EmbedBuilder()
            .setColor(chosenIntensity.level >= 4 ? '#FF4444' : chosenIntensity.level >= 3 ? '#FFA500' : '#00AA55')
            .setTitle(`${chosenIntensity.emoji} Digging ${chosenIntensity.name}…`)
            .setDescription(
                `${finalIcons}\n\n` +
                `Vein depth reached: **${veinDepth}/3 correct**\n` +
                `**${chosenIntensity.multiplier}×** payout  |  **${(chosenIntensity.caveInRisk * 100).toFixed(0)}%** cave-in risk`
            );
        await interaction.editReply({ embeds: [confirmEmbed], components: [] });

        // Crystal Fox pet: +15% mine yield (only if hunger >= 30)
        const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, isPetActive, TRAIT_FLAVOR, tryGrantRarePet } = require('../../services/petService');
        const petMineYieldPct = getTotalBonus(user.pets || [], 'mine_yield');

        const marketplaceActive = isDistrictActive(guildSettings, 'marketplace');
        const result = executeMine(user, depthId, { intensity: chosenIntensity, marketplaceActive });

        // ── Cave-in Interactive Event ─────────────────────────────────────────────
        // Resolved FIRST: pity, find counters, and yield bonuses below must only
        // apply to rewards the player actually keeps, not ore abandoned in a collapse.
        if (result.caveIn) {
            const m = user.mining;
            const equippedPickaxe = m.pickaxes?.[m.equippedPickaxeIndex];
            const pickaxeStaticData = equippedPickaxe ? PICKAXE_BY_TIER[equippedPickaxe.tier] : null;
            const chargeType = pickaxeStaticData?.chargeType;
            const chargesAvailable = chargeType ? (m.charges?.[chargeType] ?? 0) : 0;

            const caveInEmbed = new EmbedBuilder()
                .setColor('#8B0000')
                .setTitle('🌑 CAVE-IN!')
                .setDescription(
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `The tunnel is collapsing around you. Dust fills the air.\n` +
                    `You have seconds to decide.\n\n` +
                    `⚡ **Ore at stake:** ${((result.caveInPayout ?? 0) + (result.caveInEscrow ?? 0)).toLocaleString()} coins` +
                    (result.caveInEscrow > 0
                        ? ` *(includes the ${chosenIntensity.multiplier}× your vein read earned)*\n\n`
                        : `\n\n`) +
                    (chargesAvailable > 0
                        ? `💥 You have **${chargesAvailable}** blast charge${chargesAvailable !== 1 ? 's' : ''} — enough to blow an escape route.`
                        : `⚠️ You have no blast charges — you'll have to run.`)
                )
                .setFooter({ text: 'You have 20 seconds to decide.' });

            const caveInId = `cavein_${interaction.id}`;
            const blastBtn = new ButtonBuilder()
                .setCustomId(`${caveInId}_blast`)
                .setLabel('💥 Use a Blast Charge — save your ore')
                .setStyle(ButtonStyle.Success)
                .setDisabled(chargesAvailable <= 0);
            const abandonBtn = new ButtonBuilder()
                .setCustomId(`${caveInId}_abandon`)
                .setLabel('🏃 Abandon the Dig — flee empty-handed')
                .setStyle(ButtonStyle.Danger);
            const caveInRow = new ActionRowBuilder().addComponents(blastBtn, abandonBtn);

            await interaction.editReply({ embeds: [caveInEmbed], components: [caveInRow] });
            const caveInMsg = await interaction.fetchReply();

            const caveInChoice = await new Promise(resolve => {
                const col = caveInMsg.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id && i.customId.startsWith(caveInId),
                    time: 20_000,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(i.customId.endsWith('_blast') ? 'blast' : 'abandon'); });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve('abandon'); });
            });

            if (caveInChoice === 'blast' && chargesAvailable > 0) {
                // Deduct one blast charge and keep the payout
                if (chargeType) {
                    m.charges[chargeType] = chargesAvailable - 1;
                    user.markModified('mining');
                }
                // Digging clear releases the escrowed intensity bonus — the charge buys
                // back the whole haul, multiplier included. Clamped to the daily hard
                // cap the same way the uninterrupted path clamps it.
                if (result.caveInEscrow > 0) {
                    const remainingCap = Math.max(0, LIMITS.DAILY_HARD_CAP - m.dailyCoins);
                    const bonus        = Math.min(result.caveInEscrow, remainingCap);
                    if (bonus > 0) {
                        user.balance       += bonus;
                        m.totalEarned      += bonus;
                        m.dailyCoins       += bonus;
                        result.finalPayout  = (result.finalPayout ?? 0) + bonus;
                        result.caveInBonusPaid = bonus;
                    }
                }
                result.caveInEscaped = true;
            } else {
                // Abandon: reverse the payout and any tier-find counters executeMine already booked
                if (result.caveInPayout) {
                    user.balance       -= result.caveInPayout;
                    m.totalEarned      -= result.caveInPayout;
                    m.dailyCoins       -= result.caveInPayout;
                    result.finalPayout  = 0;
                }
                // The doubling charge bought ore that is now buried — hand it back
                // rather than billing a Black Market item for coins never kept.
                if (result.gatheringYield) {
                    refundEffectCharge(user, result.gatheringYield.effect);
                    result.gatheringYield = null;
                }
                if (result.tier === 'legendary') m.legendaryFinds = Math.max(0, m.legendaryFinds - 1);
                if (result.tier === 'event')     m.eventFinds     = Math.max(0, m.eventFinds - 1);
                result.caveInAbandoned = true;
            }
        }

        // Pity counter: reset only when a rare+ find was actually kept (not abandoned in a cave-in)
        const keptRareFind = result.success && !result.caveInAbandoned && ['rare', 'epic', 'legendary', 'event'].includes(result.tier);
        if (keptRareFind) {
            user.mining.sinceRare = 0;
        } else {
            user.mining.sinceRare = (user.mining.sinceRare ?? 0) + 1;
        }

        // Yield bonuses below are gated on result.finalPayout > 0, which an abandoned
        // cave-in resets to 0 above — so abandoning correctly forfeits these too.
        if (result.success && result.finalPayout > 0 && isFeaturedDepth) {
            const featBonus = Math.round(result.finalPayout * FEATURED_PAYOUT_BONUS);
            if (featBonus > 0) {
                user.balance               += featBonus;
                user.mining.totalEarned    += featBonus;
                user.mining.dailyCoins     += featBonus;
                result.finalPayout         += featBonus;
                result.featuredDepthBonus   = featBonus;
            }
        }

        if (result.success && result.finalPayout > 0 && petMineYieldPct > 0) {
            const bonus = Math.round(result.finalPayout * petMineYieldPct / 100);
            if (bonus > 0) {
                user.balance              += bonus;
                user.mining.totalEarned   += bonus;
                user.mining.dailyCoins    += bonus;
                result.finalPayout        += bonus;
                result.petYieldBonus       = bonus;
                result.petYieldPct         = petMineYieldPct;
            }
        }

        // Wilderness district: +10% mine yield (clamped to daily hard cap)
        const wildernessActive = isDistrictActive(guildSettings, 'wilderness');
        if (result.success && result.finalPayout > 0 && wildernessActive) {
            const remaining = LIMITS.DAILY_HARD_CAP - user.mining.dailyCoins;
            const rawBonus  = Math.round(result.finalPayout * WILDERNESS_YIELD_BONUS);
            const bonus     = Math.max(0, Math.min(rawBonus, remaining));
            if (bonus > 0) {
                user.balance               += bonus;
                user.mining.totalEarned    += bonus;
                user.mining.dailyCoins     += bonus;
                result.finalPayout         += bonus;
                result.wildernessBonus      = bonus;
            }
        }

        // bestPayout must reflect what the player actually walked away with, so this
        // runs after the cave-in resolution and all yield bonuses above.
        if (result.success && result.finalPayout > user.mining.bestPayout) user.mining.bestPayout = result.finalPayout;

        updateMineQuestProgress(user, result, depthId);

        // Update the persistent mine map with this dig's result
        updateMineMap(user, result);

        await ensureQuests(user, guildSettings);
        const { completed: questsDone, nearComplete: questsNear } = await onMine(user, guildSettings);
        // Season pass daily missions listen for the same actions quests do.
        recordMissionProgress(user, 'mine', 1, guildSettings);
        if (result.success && result.finalPayout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.finalPayout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        // Rare companions are found, not bought: a legendary result is the only
        // thing that can turn one up. Rolled before the save below persists it.
        // Mirrors the keptRareFind predicate above: a cave-in the player fled leaves
        // result.success true while revoking the find, and an abandoned haul must not
        // hand out a companion either.
        const rarePetDrop = result.success && !result.caveInAbandoned
            ? tryGrantRarePet(user, 'mine', result.tier)
            : null;
        if (rarePetDrop) user.markModified('pets');

        const mineAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        // Hand the run's coin movement to an atomic `$inc` and take `balance` out
        // of the save. A path that reverses its own reward nets to zero and
        // issues no write.
        const balanceDelta = detachBalanceDelta(user, balanceAtLoad);

        let payoutOwed = 0;
        try {
            await user.save();
            mineCommitted = true;
            // Only after the save has landed: a credit applied before a save that
            // then failed would pay for a run the player could take again. The two
            // cannot be one write on a standalone mongod, so a credit that will
            // not land is recorded as owed and said out loud rather than logged
            // and forgotten.
            const payout = await commitBalanceDelta(User, balanceFilter, user, balanceDelta, {
                service: 'mine',
                jobName: 'minePayout',
                guildId: interaction.guild.id,
            });
            if (!payout.credited) payoutOwed = balanceDelta;
            if (mineAchievements.length) {
                announceAchievements(interaction.client, guildSettings, user, interaction.member, mineAchievements).catch(() => null);
            }
            notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseMineClaim();
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request conflicted with your mine. Please try `/mine dig` again.' });
            }
            console.error('[mine] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your mine. Please try again.' });
        }

        // Log big win, then await hourly leader update and re-fetch for accurate footer
        if (result.success && result.finalPayout > 0) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || ['legendary', 'event'].includes(result.tier)) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'mine', details: { itemName: result.ore?.name, rarity: result.tier }, client: interaction.client });
            }
            await tryUpdateHourlyWinner({ guildId: interaction.guild.id, category: 'mine', userId: interaction.user.id, username: interaction.user.username, value: result.finalPayout, details: result.ore ? `${result.ore.emoji ?? ''} ${result.ore.name} (${currency}${result.finalPayout.toLocaleString()})`.trim() : `${currency}${result.finalPayout.toLocaleString()}` }).catch(() => null);
        }
        const hourlyLeader = await getCurrentHourlyLeader(interaction.guild.id, 'mine').catch(() => null);

        const embed = buildMineEmbed(result, user, depth, pickaxe, currency, interaction.user);

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this haul could not be paid out just now and has been recorded as owed — the balance shown below does not include it. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }
        {
            const desc = embed.data.description ?? '';
            const lines = [`> ⛏️ *${finalIcons} — Vein depth ${veinDepth}/3 → ${chosenIntensity.emoji} ${chosenIntensity.name} (${chosenIntensity.multiplier}×)*`];
            if (result.caveIn && result.caveInEscaped) {
                lines.push(result.caveInBonusPaid > 0
                    ? `> 💥 *Cave-in! You blasted clear — ore saved, and the ${chosenIntensity.multiplier}× held.*`
                    : `> 💥 *Cave-in! You used a blast charge — ore saved.*`);
            }
            else if (result.caveIn) lines.push(`> 💥 *${randomFrom(MINE_CAVE_LINES)}*`);
            embed.setDescription(desc + '\n' + lines.join('\n'));
        }
        if (result.featuredDepthBonus > 0) {
            embed.addFields({ name: '🌟 Featured Depth Bonus', value: `+${result.featuredDepthBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`, inline: true });
        }
        if (result.petYieldBonus > 0) {
            embed.addFields({ name: '💎 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petMineYieldPct}% yield)`, inline: true });
        }
        if (result.wildernessBonus > 0) {
            embed.addFields({ name: '🌲 Wilderness District', value: `+${result.wildernessBonus.toLocaleString()} coins (+10% yield)`, inline: true });
        }

        // Hourly leader footer
        const leaderNote = hourlyLeader
            ? `🏆 Biggest dig this hour: ${hourlyLeader.username} — ${hourlyLeader.details ?? hourlyLeader.value.toLocaleString() + ' coins'}`
            : '🏆 No hourly leader yet — be the first!';
        const existingFooter = embed.data.footer?.text ?? '';
        embed.setFooter({ text: existingFooter ? `${existingFooter} · ${timeBand.emoji} ${timeBand.label} · ${leaderNote}` : `${timeBand.emoji} ${timeBand.label} · ${leaderNote}` });

        // Rare companion drop — announced prominently; this is the only way to get one.
        if (rarePetDrop) {
            embed.addFields({
                name: `${rarePetDrop.emoji} A Rare Companion Appears!`,
                value: `A wild **${rarePetDrop.name}** followed you home! It joined your pets at full hunger.\n`
                     + `Passive: **+${rarePetDrop.bonusPct}% ${rarePetDrop.bonusType.replace(/_/g, ' ')}** · Favourite food: \`${rarePetDrop.favoriteMaterial}\`\n`
                     + `*Name it with \`/pet rename\` and keep it fed with \`/pet feed\`.*`,
                inline: false,
            });
        }

        // Pet narrative: show active pet's personality flavor in description
        if (result.success) {
            const activePet = (user.pets || []).find(p => isPetActive(p));
            if (activePet) {
                const petDef = PET_DEFS[activePet.petId];
                const petName = activePet.name || petDef?.name || activePet.petId;
                const flavorFn = TRAIT_FLAVOR[activePet.personality]?.mine;
                if (flavorFn && petDef) {
                    const desc = embed.data.description ?? '';
                    embed.setDescription(desc + `\n> ${flavorFn(petName, petDef.emoji)}`);
                }
            }
        }

        // Staged loot reveal for rare+ drops
        await stagedLootReveal(interaction, result.success ? result.tier : null, embed);

        if (result.success && ['epic', 'legendary', 'event'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const announceTier = TIER_NUM[result.tier] ?? 4;
            const ANNOUNCE_COPY = {
                4: { color: '#9c27b0', title: '🔮 Epic Ore Unearthed!',      line: 'A rare find in these tunnels.' },
                5: { color: '#ff9800', title: '✨ Legendary Strike! ✨',      line: 'That vein runs deep — and dangerous.' },
                6: { color: '#e74c3c', title: '☄️ Primordial Strike! ☄️',    line: 'Ore like this is not supposed to exist. The whole server should know.' },
            };
            const copy = ANNOUNCE_COPY[announceTier] ?? ANNOUNCE_COPY[4];
            const announcementEmbed = new EmbedBuilder()
                .setColor(copy.color)
                .setTitle(copy.title)
                .setDescription(
                    `<@${interaction.user.id}> just unearthed ${result.ore.emoji} **${result.ore.name}** [${TIER_STARS[announceTier]}]\n` +
                    `at the **${depth.name}** depth.\n\n` +
                    copy.line
                )
                .setTimestamp();
            announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
        }

        // Catastrophic cave-in server announcement (Deep or Abyss intensity, pickaxe destroyed)
        if (result.caveIn && result.pickaxeBroke && chosenIntensity.level >= 4 && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const caveEmbed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('💥 Catastrophic Cave-in!')
                .setDescription(
                    `<@${interaction.user.id}> just suffered a **catastrophic cave-in** at Depth **${chosenIntensity.name}** (${depth.name})!\n` +
                    `Their **${pickaxe.name}** has been destroyed.\n\n` +
                    `*Others are warned: the tunnel grows less stable the deeper you go.*`
                )
                .setTimestamp();
            announceChannel.send({ embeds: [caveEmbed] }).catch(() => null);
        }
    } catch (err) {
        if (!mineCommitted) await releaseMineClaim();
        throw err;
    }
}

// ─── PRESTIGE ─────────────────────────────────────────────────────────────────
//
// The PRESTIGE_BONUSES table, the badge row and the "Prestige Bonuses" block on
// /mine profile have all been in place since the mine shipped, but nothing ever
// incremented mining.prestige — so Miner Level 50 was simply the end, and every
// bonus in that table was unreachable. This is the way through.

/** Formats one row of PRESTIGE_BONUSES as the lines a player sees. */
function prestigeBonusLines(bonus) {
    return [
        bonus.critBonus    > 0 ? `+${Math.round(bonus.critBonus * 100)}% crit chance`   : null,
        bonus.staminaBonus > 0 ? `+${bonus.staminaBonus} max stamina`                   : null,
        bonus.payoutBonus  > 0 ? `+${Math.round(bonus.payoutBonus * 100)}% all payouts` : null,
        bonus.rarityBonus  > 0 ? `+${Math.round(bonus.rarityBonus * 100)}% rarity boost`: null,
    ].filter(Boolean);
}

async function handlePrestige(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureMineData(user);

    const m        = user.mining;
    const prestige = m.prestige ?? 0;
    const badge    = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    if (prestige >= MAX_MINE_PRESTIGE) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`${badge} Maximum Prestige`)
                .setDescription(`You are a **P${prestige} Master Miner** — the deepest rank there is.`)
                .addFields({ name: 'Your Bonuses', value: prestigeBonusLines(PRESTIGE_BONUSES[prestige]).join('\n') || 'None' })
                .setTimestamp()],
        });
    }

    const nextBonus = PRESTIGE_BONUSES[prestige + 1];
    const nextBadge = PRESTIGE_BADGES[prestige + 1] ?? '';

    if (m.level < MAX_MINER_LEVEL) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle(`${badge} Miner Prestige — P${prestige}`)
                .setDescription(
                    `Reach **Miner Level ${MAX_MINER_LEVEL}** to ascend to ${nextBadge} **P${prestige + 1}**.\n` +
                    `You're Level **${m.level}**.`
                )
                .addFields(
                    { name: `${nextBadge} P${prestige + 1} would grant`, value: prestigeBonusLines(nextBonus).join('\n') || 'Nothing new', inline: true },
                    { name: 'Progress',  value: `${m.xp.toLocaleString()} / ${MINER_LEVELS[MAX_MINER_LEVEL - 1].xpRequired.toLocaleString()} XP`, inline: true },
                )
                .setFooter({ text: 'Prestige keeps your pickaxes, depths, materials and stats — only Miner Level and XP reset.' })
                .setTimestamp()],
            flags: MessageFlags.Ephemeral,
        });
    }

    // Losing the level also drops any synergy gated on it, so say so up front rather
    // than letting a miner discover their stamina pool shrank after ascending.
    const lostSynergies = getActiveSynergies(user)
        .filter(syn => (syn.requirements.mining ?? 0) > 1)
        .map(syn => `${syn.emoji} ${syn.name}`);

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${nextBadge} Ascend to Prestige ${prestige + 1}?`)
        .setDescription(
            `You've reached **Miner Level ${MAX_MINER_LEVEL}**. Ascending is permanent and cannot be undone.\n\n` +
            `**Resets:** Miner Level → 1, Miner XP → 0\n` +
            `**Keeps:** pickaxes, unlocked depths, materials, consumables, charges and every lifetime stat`
        )
        .addFields({ name: `${nextBadge} P${prestige + 1} bonuses`, value: prestigeBonusLines(nextBonus).join('\n') || 'Nothing new', inline: false });

    if (lostSynergies.length) {
        confirmEmbed.addFields({
            name: '⚠️ Synergies you will drop until you re-level',
            value: lostSynergies.join('\n'),
            inline: false,
        });
    }
    confirmEmbed.setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mineprestige_confirm').setLabel('Ascend').setStyle(ButtonStyle.Success).setEmoji('⛏️'),
        new ButtonBuilder().setCustomId('mineprestige_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const response = await interaction.reply({ embeds: [confirmEmbed], components: [row], withResponse: true });
    const reply = response.resource.message;
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    let actionPromise = null;
    collector.on('collect', btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }

        if (btn.customId === 'mineprestige_cancel') {
            collector.stop();
            return btn.update({ content: 'Ascension cancelled.', embeds: [], components: [] });
        }

        // Assigned before collector.stop(): stop() emits 'end' synchronously, so an
        // assignment after it would leave the handler below awaiting a null and let
        // the command — and the per-user mining lock with it — resolve while this
        // write was still in flight.
        actionPromise = (async () => {
            try {
                await btn.deferUpdate();

                // Nothing is written from the in-memory snapshot here. It was read
                // before a 30-second confirmation window during which a raid, a craft
                // or another dig may have moved this profile, and a save() would put
                // all of that back. The ascension is the conditional update alone.
                //
                // `data.prestige` is absent on profiles that predate the field, so a
                // first ascension has to match that shape too — ensureMineData only
                // defaulted it in memory.
                const rankMatches = prestige === 0
                    ? [{ 'data.prestige': 0 }, { 'data.prestige': { $exists: false } }, { 'data.prestige': null }]
                    : [{ 'data.prestige': prestige }];

                // Conditional so a second confirmation cannot ascend twice: the level
                // requirement and the prestige rank both have to still hold.
                const ascended = await GrindProfile.findOneAndUpdate(
                    {
                        userId: user.userId, guildId: user.guildId, system: 'mining',
                        'data.level': { $gte: MAX_MINER_LEVEL },
                        $or: rankMatches,
                    },
                    { $set: { 'data.prestige': prestige + 1, 'data.level': 1, 'data.xp': 0 } },
                    { new: true }
                ).catch(err => { console.error('[mine prestige] ascend error:', err); return null; });

                if (!ascended) {
                    return interaction.editReply({
                        content: 'Your miner changed while that confirmation was open — run `/mine prestige` again.',
                        embeds: [], components: [],
                    });
                }

                m.prestige = prestige + 1;
                m.level    = 1;
                m.xp       = 0;

                const embed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle(`${nextBadge} Prestige ${prestige + 1} — ${getLevelData(1).title} Again`)
                    .setDescription(
                        `You climb back to the surface, hand in your papers, and start over as a **P${prestige + 1}** miner.\n` +
                        `The tunnels remember you — everything you own came back up with you.`
                    )
                    .addFields(
                        { name: 'Permanent Bonuses', value: prestigeBonusLines(PRESTIGE_BONUSES[prestige + 1]).join('\n') || 'None', inline: true },
                        { name: 'Miner Level',       value: `**${MAX_MINER_LEVEL}** → **1**`, inline: true },
                        { name: 'Kept',              value: `${m.pickaxes.length} pickaxe(s) · ${m.unlockedDepths.length} depth(s)`, inline: true },
                    )
                    .setFooter({ text: prestige + 1 >= MAX_MINE_PRESTIGE
                        ? 'That is the deepest rank there is.'
                        : `Reach Miner Level ${MAX_MINER_LEVEL} again to ascend to P${prestige + 2}.` })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed], components: [] });
            } catch (err) {
                console.error('[mine prestige] error:', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
        })();

        collector.stop();
    });

    return new Promise(resolve => {
        collector.on('end', async (_, reason) => {
            if (reason === 'time') {
                interaction.editReply({ content: 'Ascension timed out.', embeds: [], components: [] }).catch(() => {});
            }
            if (actionPromise) await actionPromise.catch(() => {});
            resolve();
        });
    });
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: target.id, guildId: interaction.guild.id }),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);
    await attachGrind(userData);

    const currency = guildSettings?.economy?.currency ?? '💰';

    if (!userData) {
        return interaction.reply({
            content: isSelf
                ? "You haven't started mining yet! Buy a pickaxe with `/mine shop pickaxe` and use `/mine dig` to begin."
                : `${target.username} hasn't started mining yet.`,
            flags: MessageFlags.Ephemeral
        });
    }

    ensureMineData(userData);
    if (isSelf) applyStaminaRegen(userData);

    const m         = userData.mining;
    const levelData = getLevelData(m.level);
    const toNext    = xpToNextLevel(m.level, m.xp);
    const maxStam   = getMaxStamina(userData);
    const regenMs   = msUntilNextStamina(userData);
    const depth     = DEPTHS[m.activeDepth];
    const prestige  = m.prestige ?? 0;
    const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    const successRate = m.totalMines > 0
        ? `${Math.round((m.successfulMines / m.totalMines) * 100)}%`
        : 'N/A';

    const xpProgressBar = buildXpBar(m, toNext);
    const stamBar = '⚡'.repeat(m.stamina) + '▪️'.repeat(Math.max(0, maxStam - m.stamina));

    const buffs = [];
    if (m.activeMagnet)   buffs.push(`Magnet (${m.activeMagnetMinesLeft} mines)`);
    if (m.activeLamp)     buffs.push(`Lamp (${m.activeLampMinesLeft} mines)`);
    if (m.activeInstinct) buffs.push('Instinct (queued)');
    if (m.activeXpScroll) buffs.push('XP Scroll (queued)');

    const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#b5651d')
        .setTitle(`${badge} ${target.username}'s Miner Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '⛏️ Rank',
                value: `**${levelData.title}** (Level ${m.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                inline: true
            },
            {
                name: '⭐ Miner XP',
                value: toNext !== null
                    ? `${m.xp.toLocaleString()} / ${MINER_LEVELS[m.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpProgressBar}\n${toNext.toLocaleString()} to Level ${m.level + 1}`
                    : `${m.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true
            },
            {
                name: '🗺️ Active Depth',
                value: depth ? `${depth.emoji} ${depth.name}` : 'Unknown',
                inline: true
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${m.stamina}/${maxStam}${m.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
                inline: true
            },
            {
                name: '💰 Balance',
                value: `${currency}${userData.balance.toLocaleString()}`,
                inline: true
            },
            {
                name: '🔋 Active Buffs',
                value: buffs.length ? buffs.join('\n') : 'None',
                inline: true
            },
            {
                name: '📊 Mining Stats',
                value: [
                    `Total Mines:     **${m.totalMines.toLocaleString()}**`,
                    `Success Rate:    **${successRate}**`,
                    `Total Earned:    **${currency}${m.totalEarned.toLocaleString()}**`,
                    `Best Payout:     **${currency}${m.bestPayout.toLocaleString()}**`,
                    `Legendary Finds: **${m.legendaryFinds}**`,
                    `Event Finds:     **${m.eventFinds}**`
                ].join('\n'),
                inline: false
            }
        );

    if (prestige > 0) {
        embed.addFields({
            name: `${badge} Prestige Bonuses`,
            value: prestigeBonusLines(pBonus).join('\n') || 'None yet',
            inline: true
        });
    }

    const depthList = m.unlockedDepths.map(id => {
        const d = DEPTHS[id];
        return d ? `${d.emoji} ${d.name}` : id;
    }).join('\n');
    embed.addFields({ name: '🗺️ Unlocked Depths', value: depthList || 'Surface Quarry only', inline: true });

    // Cross-system synergies
    const activeSynergies = getActiveSynergies(userData);
    if (activeSynergies.length > 0) {
        embed.addFields({
            name: '🔗 Active Synergies',
            value: activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n'),
            inline: false
        });
    } else if (m.level >= 25) {
        embed.addFields({
            name: '🔗 Synergies',
            value: 'Reach combined level milestones across Hunt, Fish & Mine to unlock cross-system bonuses!',
            inline: false
        });
    }

    // Only nudge the player who can act on it; someone else's maxed miner just gets
    // the standing, and the daily-cap line stays a self-only stat either way.
    if (m.level >= MAX_MINER_LEVEL && prestige >= MAX_MINE_PRESTIGE) {
        embed.setFooter({ text: `${PRESTIGE_BADGES[MAX_MINE_PRESTIGE]} Fully prestiged Master Miner — nothing left to prove down there.` });
    } else if (isSelf && m.level >= MAX_MINER_LEVEL) {
        embed.setFooter({ text: `Max Miner Level — use /mine prestige to ascend to P${prestige + 1}` });
    } else if (m.level >= MAX_MINER_LEVEL) {
        embed.setFooter({ text: 'Max Miner Level' });
    } else if (isSelf) {
        embed.setFooter({ text: `Daily: ${m.dailyMines} mines · ${currency}${m.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

// ─── INV ──────────────────────────────────────────────────────────────────────

async function handleInv(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureMineData(user);
    const m = user.mining;

    if (sub === 'view') {
        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle(`⛏️ ${interaction.user.username}'s Mining Inventory`)
            .setTimestamp();

        if (!m.pickaxes.length) {
            embed.addFields({ name: '🪓 Pickaxes', value: 'None — buy one with `/mine shop pickaxe`', inline: false });
        } else {
            const lines = m.pickaxes.map((p, i) => {
                const isEquipped = i === m.equippedPickaxeIndex;
                const bar = durabilityBar(p.currentDurability, p.maxDurability);
                const upgradeStr = p.upgrade ? ` [${p.upgrade.replace(/_/g, ' ')}]` : '';
                return `**Slot ${i + 1}**${isEquipped ? ' *(equipped)*' : ''} — ${p.name}${upgradeStr} ${pickaxeStatusEmoji(p.status)}\n> ${bar} ${p.currentDurability}/${p.maxDurability}`;
            });
            // Nothing caps how many pickaxes a miner accumulates and each entry runs
            // ~85 characters, so a single field ran out of room around the twelfth one
            // and Discord rejected the whole embed. Spill into continuation fields —
            // but only so many: an embed also has a 6,000-character budget across all
            // of its fields, which unbounded spilling would eventually blow instead.
            const PICKAXE_FIELDS = 3;
            const fields = packFields('🪓 Pickaxes', lines);
            embed.addFields(...fields.slice(0, PICKAXE_FIELDS));
            if (fields.length > PICKAXE_FIELDS) {
                const shown = fields.slice(0, PICKAXE_FIELDS)
                    .reduce((n, f) => n + f.value.split('\n').length / 2, 0);
                embed.addFields({
                    name: '…and more',
                    value: `${Math.max(0, m.pickaxes.length - Math.round(shown))} further pickaxe(s) not shown — discard the dead ones with \`/mine inv discard\`.`,
                    inline: false
                });
            }

            const junk = m.pickaxes.filter(p => p.status === 'broken' || p.status === 'condemned').length;
            if (junk > 0) {
                embed.addFields({
                    name: '🗑️ Unusable',
                    value: `${junk} pickaxe${junk === 1 ? ' is' : 's are'} broken or condemned — clear ${junk === 1 ? 'it' : 'them'} out with \`/mine inv discard\`.`,
                    inline: false
                });
            }
        }

        const chargeLines = BLAST_PACKS.map(b => {
            const stock = m.charges[b.chargeType] ?? 0;
            return `${b.emoji} ${b.chargeType.replace(/_/g, ' ')}: **${stock}**`;
        }).filter((_, i) => (m.charges[BLAST_PACKS[i].chargeType] ?? 0) > 0);

        embed.addFields({
            name: '💥 Blast Charges',
            value: chargeLines.length ? chargeLines.join('\n') : 'None',
            inline: true
        });

        const consumableLines = Object.entries(m.consumables ?? {})
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => {
                const def = CONSUMABLES[id];
                return def ? `${def.emoji} ${def.name}: **${qty}**` : `${id}: **${qty}**`;
            });

        embed.addFields({
            name: '🎒 Consumables',
            value: consumableLines.length ? consumableLines.join('\n') : 'None',
            inline: true
        });

        const buffs = [];
        if (m.activeMagnet)   buffs.push(`🧲 ${m.activeMagnet.replace(/_/g, ' ')} (${m.activeMagnetMinesLeft} mines left)`);
        if (m.activeLamp)     buffs.push(`🪔 Miner's Lamp (${m.activeLampMinesLeft} mines left)`);
        if (m.activeInstinct) buffs.push(`🎯 Miner's Instinct (queued)`);
        if (m.activeXpScroll) buffs.push(`📜 XP Scroll (queued)`);
        embed.addFields({ name: '🔋 Active Buffs', value: buffs.length ? buffs.join('\n') : 'None', inline: false });

        const matLines = Object.entries(m.materials ?? {})
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);

        embed.addFields({
            name: '🪨 Materials',
            value: matLines.length ? matLines.join('\n') : 'None — find them by mining rare ores',
            inline: false
        });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'equip') {
        const slot = interaction.options.getInteger('slot') - 1;

        if (!m.pickaxes[slot]) {
            return interaction.reply({ content: `No pickaxe in slot ${slot + 1}.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxe = m.pickaxes[slot];
        if (pickaxe.status === 'broken') {
            return interaction.reply({ content: `**${pickaxe.name}** is broken and can't be equipped. Repair it first with \`/mine shop repair\`.`, flags: MessageFlags.Ephemeral });
        }

        m.equippedPickaxeIndex = slot;
        user.markModified('mining');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#b5651d')
                    .setTitle('⛏️ Pickaxe Equipped')
                    .setDescription(`You equipped **${pickaxe.name}**.`)
                    .addFields(
                        { name: 'Durability', value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                        { name: 'Status',     value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true },
                        { name: 'Upgrade',    value: pickaxe.upgrade ? pickaxe.upgrade.replace(/_/g, ' ') : 'None', inline: true }
                    )
                    .setTimestamp()
            ]
        });
    }

    if (sub === 'discard') {
        const index = interaction.options.getInteger('slot') - 1;

        if (index < 0 || index >= m.pickaxes.length) {
            return interaction.reply({
                content: `No pickaxe in slot ${index + 1}. You have ${m.pickaxes.length} pickaxe(s).`,
                flags: MessageFlags.Ephemeral
            });
        }

        const pickaxe = m.pickaxes[index];
        if (pickaxe.status !== 'broken' && pickaxe.status !== 'condemned') {
            return interaction.reply({
                content: `**${pickaxe.name}** is not broken or condemned. You can only discard unusable pickaxes.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Splicing shifts every later slot down by one, so the equipped index has to
        // move with it or the miner silently ends up wielding a different pickaxe.
        const wasEquipped = m.equippedPickaxeIndex === index;
        m.pickaxes.splice(index, 1);

        if (wasEquipped) {
            m.equippedPickaxeIndex = m.pickaxes.length > 0 ? 0 : -1;
        } else if (m.equippedPickaxeIndex > index) {
            m.equippedPickaxeIndex -= 1;
        }

        user.markModified('mining');
        await user.save();

        const nowEquipped = m.pickaxes[m.equippedPickaxeIndex];
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('🗑️ Pickaxe Discarded')
                    .setDescription(
                        `**${pickaxe.name}** has been discarded.` +
                        (wasEquipped && nowEquipped ? `\nYou are now wielding **${nowEquipped.name}**.` : '')
                    )
                    .setFooter({ text: m.pickaxes.length === 0
                        ? 'Buy a new pickaxe with /mine shop pickaxe'
                        : 'Use /mine inv view to see your remaining pickaxes' })
                    .setTimestamp()
            ]
        });
    }
}

// ─── QUESTS ───────────────────────────────────────────────────────────────────

async function handleQuests(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureMineData(user);
    assignDailyMineQuests(user);

    const now = Date.now();

    if (sub === 'view') {
        const mineQuests = user.quests.filter(q =>
            q.questId.startsWith('mq_') && q.expiresAt?.getTime() > now
        );

        if (!mineQuests.length) {
            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('📋 Daily Mine Quests')
                .setDescription('No active quests right now.\nUse `/mine dig` to start mining — quests will be assigned automatically!')
                .setFooter({ text: 'Quests are assigned in batches of 3 and last 24 hours' });
            return interaction.reply({ embeds: [embed] });
        }

        if (user.isModified()) {
            await user.save().catch(e => console.error('[minequests] save error:', e));
        }

        const lines = mineQuests.map(q => {
            const template = MINE_QUEST_TEMPLATES.find(t => t.id === q.questId);
            if (!template) return null;

            const isClaimed  = q.progress === -1;
            const isComplete = !!q.completedAt && !isClaimed;
            const progress   = isClaimed ? template.target : Math.min(q.progress, template.target);
            const bar        = buildProgressBar(progress, template.target);
            const timeLeft   = formatExpiry(q.expiresAt.getTime() - now);
            const rewardStr  = `${currency}${template.reward.coins.toLocaleString()} · ${template.reward.xp} Miner XP`;

            let statusLine;
            if (isClaimed)       statusLine = '✅ **Claimed**';
            else if (isComplete) statusLine = '🎁 **Ready to claim!** — Use `/mine quests claim`';
            else                 statusLine = `${bar} ${progress}/${template.target}`;

            return [
                `${template.emoji} **${template.name}**`,
                `> ${template.description}`,
                `> ${statusLine}`,
                `> Reward: ${rewardStr} · Expires: ${timeLeft}`
            ].join('\n');
        }).filter(Boolean);

        const readyCount = mineQuests.filter(q => q.completedAt && q.progress !== -1).length;

        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle('📋 Daily Mine Quests')
            .setDescription(lines.join('\n\n'))
            .setTimestamp();

        embed.setFooter({ text: readyCount > 0
            ? `${readyCount} quest(s) ready to claim! Use /mine quests claim`
            : 'Complete quests by mining • Claim rewards with /mine quests claim' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'claim') {
        if (user.isModified()) {
            await user.save().catch(e => console.error('[minequests] pre-claim save error:', e));
        }

        const questId  = interaction.options.getString('quest');
        const template = MINE_QUEST_TEMPLATES.find(t => t.id === questId);

        if (!template) {
            return interaction.reply({ content: 'Unknown quest.', flags: MessageFlags.Ephemeral });
        }

        const questEntry = user.quests.find(q =>
            q.questId === questId &&
            q.expiresAt?.getTime() > now
        );

        if (!questEntry) {
            return interaction.reply({
                content: `You don't have an active **${template.name}** quest. Go mining to get quests assigned!`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (questEntry.progress === -1) {
            return interaction.reply({
                content: `You already claimed **${template.name}**. Complete your other quests or wait for new ones!`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (!questEntry.completedAt) {
            const progress = Math.min(questEntry.progress, template.target);
            return interaction.reply({
                content: `**${template.name}** is not complete yet (${progress}/${template.target}). Keep mining!`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Same rule as everywhere else: the claim pays a delta, never a snapshot.
        const balanceAtLoad = user.balance ?? 0;
        user.balance += template.reward.coins;
        const lvResult = applyXp(user, template.reward.xp);

        questEntry.progress = -1;
        user.markModified('quests');
        try {
            await saveWithBalanceDelta(User, user, balanceAtLoad, {
                service: 'mine',
                jobName: 'questClaimCoins',
                guildId: interaction.guild.id,
            });
        } catch (err) {
            // Same reasoning as /hunt quests claim: a version conflict on this
            // document is ordinary, and an unanswered interaction is not.
            console.error('[minequests claim] save error:', err);
            return interaction.reply({ content: 'Something went wrong claiming that quest. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`${template.emoji} Quest Complete — ${template.name}!`)
            .setDescription(template.description)
            .addFields(
                { name: `${currency} Coins`,  value: `+${template.reward.coins.toLocaleString()}`,  inline: true },
                { name: '⭐ Miner XP',         value: `+${template.reward.xp}`,                     inline: true },
                { name: '💳 New Balance',       value: `${currency}${user.balance.toLocaleString()}`, inline: true }
            );

        if (lvResult.leveledUp) {
            const ld = getLevelData(lvResult.newLevel);
            embed.addFields({
                name:  '⬆️ Level Up!',
                value: `Miner Level **${lvResult.oldLevel}** → **${lvResult.newLevel}** (${ld.title})`,
                inline: false
            });
        }

        const liveQuests = user.quests.filter(q =>
            q.questId.startsWith('mq_') && q.expiresAt?.getTime() > now
        );
        const remaining = liveQuests.filter(q => q.progress !== -1).length;

        // A fresh batch is only assigned once the current one has expired — see the
        // guard in assign*Quests. Say when that is rather than implying that playing
        // again brings one sooner, which is what this footer used to promise.
        const nextSetIn = liveQuests.length
            ? formatExpiry(Math.min(...liveQuests.map(q => q.expiresAt.getTime())) - now)
            : null;

        embed.setFooter({ text: remaining > 0
            ? `${remaining} quest(s) remaining — use /mine quests view`
            : `All quests claimed! A fresh set arrives in ${nextSetIn ?? 'a few hours'}.` });
        embed.setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
}

// ─── SHOP ─────────────────────────────────────────────────────────────────────

async function handleShop(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureMineData(user);
    const m = user.mining;

    if (sub === 'list') {
        const pickaxeItems = PICKAXE_TIERS.map(p => ({
            imageId: `mine:${p.slug}`,
            name:    p.name,
            price:   p.cost,
            emoji:   p.emoji,
            badge:   `T${p.tier}`,
            subline: `${Math.round(p.successRate * 100)}% • +${Math.round(p.rarityBoost * 100)}% rare`
        }));
        const pickaxeList = PICKAXE_TIERS.map(p =>
            `${p.emoji} **${p.name}** — ${currency}${p.cost.toLocaleString()} · \`/mine shop pickaxe type:${p.slug}\``
        ).join('\n');

        const upgradeItems = Object.values(PICKAXE_UPGRADES).map(u => ({
            imageId: `mine:${u.id}`,
            name:    u.name,
            emoji:   u.emoji,
            subline: `${Math.round(u.costMultiplier * 100)}% of pickaxe`
        }));
        const upgradeList = Object.values(PICKAXE_UPGRADES).map(u =>
            `${u.emoji} **${u.name}** — *${u.description}* · \`/mine shop upgrade module:${u.id}\``
        ).join('\n');

        const blastItems = BLAST_PACKS.map(b => ({
            imageId: `mine:${b.id}`,
            name:    b.name,
            price:   b.cost,
            emoji:   b.emoji
        }));
        const blastList = BLAST_PACKS.map(b =>
            `${b.emoji} **${b.name}** — ${currency}${b.cost} · \`/mine shop buy item:${b.id}\``
        ).join('\n');

        const consumableItems = Object.values(CONSUMABLES).map(c => ({
            imageId: `mine:${c.id}`,
            name:    c.name,
            price:   c.cost,
            emoji:   c.emoji
        }));
        const consumableList = Object.values(CONSUMABLES).map(c =>
            `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/mine shop buy item:${c.id}\``
        ).join('\n');

        const depthItems = DEPTH_LIST.map(d => {
            const unlocked = m.unlockedDepths?.includes(d.id) ?? d.defaultUnlocked;
            const isActive = m.activeDepth === d.id;
            return {
                imageId: `mine:${d.id}`,
                name:    d.name,
                emoji:   d.emoji,
                badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${d.unlockLevel}`),
                subline: unlocked ? (isActive ? 'Currently mining' : 'Unlocked') : `${currency}${d.unlockCost.toLocaleString()}`
            };
        });
        const depthList = DEPTH_LIST.map(d => {
            const unlocked = m.unlockedDepths?.includes(d.id) ?? d.defaultUnlocked;
            const isActive = m.activeDepth === d.id;
            const status = unlocked
                ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
                : `🔒 Lv.${d.unlockLevel} / ${currency}${d.unlockCost.toLocaleString()}`;
            return `${d.emoji} **${d.name}** — ${status}`;
        }).join('\n');

        return runShopBrowse(interaction, {
            activity: 'mine',
            title:    'Mining Shop',
            currency,
            footer:   'pickaxe • upgrade • buy • use • repair • unlock',
            pages: [
                { id: 'pickaxes',    label: 'Pickaxes',    emoji: '🪓',  subtitle: 'Stronger picks bite deeper veins.',     items: pickaxeItems,    listText: pickaxeList    },
                { id: 'upgrades',    label: 'Upgrades',    emoji: '🔩',  subtitle: 'One module per pickaxe, permanent.',     items: upgradeItems,    listText: upgradeList    },
                { id: 'blasts',      label: 'Blast Charges', emoji: '💥', subtitle: 'Crack through stubborn rock.',          items: blastItems,      listText: blastList      },
                { id: 'consumables', label: 'Consumables', emoji: '🎒',  subtitle: 'Repairs, charms and quick boosts.',      items: consumableItems, listText: consumableList },
                { id: 'depths',      label: 'Depths',      emoji: '🗺️', subtitle: 'New depths, new ores.',                  items: depthItems,      listText: depthList      }
            ]
        });
    }

    if (sub === 'pickaxe') {
        const slug = interaction.options.getString('type');
        const autoEquip = interaction.options.getBoolean('equip') ?? true;
        const pickaxeData = PICKAXE_BY_SLUG[slug];

        if (!pickaxeData) return interaction.reply({ content: 'Unknown pickaxe type.', flags: MessageFlags.Ephemeral });

        if (user.balance < pickaxeData.cost) {
            return interaction.reply({
                content: `You need ${currency}${pickaxeData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const confirmEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle(`${pickaxeData.emoji} Purchase ${pickaxeData.name}?`)
            .addFields(
                { name: 'Cost',          value: `${currency}${pickaxeData.cost.toLocaleString()}`, inline: true },
                { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
                { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
                { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
                { name: 'Your Balance',  value: `${currency}${user.balance.toLocaleString()}`, inline: true }
            )
            .setFooter({ text: 'Confirmation expires in 30 seconds' });

        const pickaxeImg = await getItemImageAttachment(`mine:${pickaxeData.slug || pickaxeData.id}`).catch(() => null);
        if (pickaxeImg) confirmEmbed.setThumbnail(pickaxeImg.url);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('minepickaxe_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('minepickaxe_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
        );

        const confirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true };
        if (pickaxeImg) confirmPayload.files = [pickaxeImg.attachment];
        const response = await interaction.reply(confirmPayload);
        const reply = response.resource.message;
        const collector = reply.createMessageComponentCollector({ time: 30_000 });

        let actionPromise = null;
        collector.on('collect', btn => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
            }

            if (btn.customId === 'minepickaxe_cancel') {
                collector.stop();
                return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
            }

            actionPromise = (async () => {
            try {
                await btn.deferUpdate();

                const newPickaxe = {
                    name: pickaxeData.name,
                    tier: pickaxeData.tier,
                    slug: pickaxeData.slug,
                    currentDurability: pickaxeData.baseDurability,
                    maxDurability: pickaxeData.baseDurability,
                    baseDurability: pickaxeData.baseDurability,
                    repairCount: 0,
                    upgrade: null,
                    status: 'good',
                    acquiredAt: new Date()
                };

                const updated = await User.findOneAndUpdate(
                    { userId: user.userId, guildId: user.guildId, balance: { $gte: pickaxeData.cost } },
                    { $inc: { balance: -pickaxeData.cost } },
                    { new: true }
                );
                if (!updated) {
                    return interaction.editReply({ content: `Insufficient funds. You need ${currency}${pickaxeData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] });
                }

                await persistGrindIfNew(user, 'mining');
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    { userId: user.userId, guildId: user.guildId, system: 'mining' },
                    { $push: { 'data.pickaxes': newPickaxe } },
                    { new: true }
                ).catch(err => { console.error('[mineshop pickaxe] profile push error:', err); return null; });

                if (!profUpdated) {
                    await User.updateOne({ userId: user.userId, guildId: user.guildId }, { $inc: { balance: pickaxeData.cost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }

                m.pickaxes = profUpdated.data.pickaxes;
                const newIndex = m.pickaxes.length - 1;

                if (autoEquip) {
                    const oldIndex = m.equippedPickaxeIndex;
                    m.equippedPickaxeIndex = newIndex;
                    try {
                        await GrindProfile.updateOne(
                            { userId: user.userId, guildId: user.guildId, system: 'mining' },
                            { $set: { 'data.equippedPickaxeIndex': newIndex } }
                        );
                    } catch (err) {
                        console.error('[mineshop pickaxe] equip update error:', err);
                        m.equippedPickaxeIndex = oldIndex;
                    }
                }

                const equipped = m.equippedPickaxeIndex === newIndex;
                const embed = new EmbedBuilder()
                    .setColor('#b5651d')
                    .setTitle(`${pickaxeData.emoji} Pickaxe Purchased!`)
                    .setDescription(`You bought a **${pickaxeData.name}**!${equipped ? ' It has been equipped.' : ' Use `/mine inv equip` to equip it.'}`)
                    .addFields(
                        { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
                        { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
                        { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
                        { name: 'Balance',       value: `${currency}${updated.balance.toLocaleString()}`, inline: true }
                    )
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed], components: [] });
            } catch (err) {
                console.error('[mineshop pickaxe] purchase error:', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
            })();

            collector.stop();
        });

        return new Promise(resolve => {
            collector.on('end', async (_, reason) => {
                if (reason === 'time') {
                    interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
                }
                if (actionPromise) await actionPromise.catch(() => {});
                resolve();
            });
        });
    }

    if (sub === 'upgrade') {
        const moduleId = interaction.options.getString('module');
        const upgradeDef = PICKAXE_UPGRADES[moduleId];
        if (!upgradeDef) return interaction.reply({ content: 'Unknown upgrade module.', flags: MessageFlags.Ephemeral });

        if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
            return interaction.reply({ content: `You don't have a pickaxe equipped. Equip one with \`/mine inv equip\`.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxe = m.pickaxes[m.equippedPickaxeIndex];
        if (pickaxe.upgrade) {
            return interaction.reply({ content: `Your **${pickaxe.name}** already has the **${pickaxe.upgrade.replace(/_/g, ' ')}** upgrade installed. Each pickaxe can only have one upgrade.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
        const cost = Math.round(pickaxeData.cost * upgradeDef.costMultiplier);

        if (user.balance < cost) {
            return interaction.reply({ content: `This upgrade costs ${currency}${cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
        }

        await persistGrindIfNew(user, 'mining');
        const charged = await chargeBalance(interaction, cost);
        if (!charged) {
            return interaction.reply({ content: `This upgrade costs ${currency}${cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
        }
        // Take the authoritative balance and keep any later save off that path.
        user.balance = charged.balance;
        user.unmarkModified('balance');

        pickaxe.upgrade = moduleId;
        user.markModified('mining');
        try {
            await saveGrind(user, ['mining']);
        } catch (err) {
            console.error('[mineshop upgrade] save error:', err);
            pickaxe.upgrade = null;
            await refundBalance(interaction, cost);
            return interaction.reply({ content: 'Installing the upgrade failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
            .setDescription(`**${upgradeDef.name}** has been installed on your **${pickaxe.name}**.\n> ${upgradeDef.description}`)
            .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'buy') {
        const itemId  = interaction.options.getString('item');
        const qty     = interaction.options.getInteger('quantity') ?? 1;

        const consumableDef = CONSUMABLES[itemId];
        const blastDef      = BLAST_PACKS.find(b => b.id === itemId);
        const itemDef       = consumableDef || blastDef;

        if (!itemDef) return interaction.reply({ content: 'Unknown item.', flags: MessageFlags.Ephemeral });

        const totalCost = itemDef.cost * qty;
        if (user.balance < totalCost) {
            return interaction.reply({ content: `You need ${currency}${totalCost.toLocaleString()} for ${qty}× but only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
        }

        if (consumableDef) {
            const current = m.consumables[itemId] ?? 0;
            if (current + qty > consumableDef.maxStack) {
                return interaction.reply({ content: `You can only carry ${consumableDef.maxStack}× **${consumableDef.name}**. You already have ${current}.`, flags: MessageFlags.Ephemeral });
            }
        }

        const gainedLabel  = blastDef
            ? `${blastDef.quantity * qty}× ${blastDef.chargeType.replace(/_/g, ' ')}`
            : `${qty}× ${consumableDef.name}`;
        const currentStock = blastDef
            ? `${m.charges[blastDef.chargeType] ?? 0} in stock`
            : `${m.consumables[itemId] ?? 0}/${consumableDef.maxStack} in stock`;

        const confirmEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle(`${itemDef.emoji ?? '🛒'} Confirm Purchase`)
            .setDescription(itemDef.description ?? '')
            .addFields(
                { name: 'Item',         value: itemDef.name,                                  inline: true },
                { name: 'Quantity',     value: gainedLabel,                                   inline: true },
                { name: 'Total Cost',   value: `${currency}${totalCost.toLocaleString()}`,    inline: true },
                { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
                { name: 'Currently',    value: currentStock,                                   inline: true }
            )
            .setFooter({ text: 'Confirmation expires in 30 seconds' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('minebuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('minebuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
        );

        const response = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true });
        const reply = response.resource.message;
        const collector = reply.createMessageComponentCollector({ time: 30_000 });

        let actionPromise = null;
        collector.on('collect', btn => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
            }

            if (btn.customId === 'minebuy_cancel') {
                collector.stop();
                return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
            }

            actionPromise = (async () => {
            try {
                await btn.deferUpdate();

                await persistGrindIfNew(user, 'mining');
                const balanceUpdated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                    { $inc: { balance: -totalCost } },
                    { new: true }
                );
                if (!balanceUpdated) {
                    return interaction.editReply({ content: 'Insufficient funds. Please try again.', embeds: [], components: [] });
                }

                if (consumableDef) {
                    const consumableField = `data.consumables.${itemId}`;
                    const profUpdated = await GrindProfile.findOneAndUpdate(
                        {
                            userId:  interaction.user.id,
                            guildId: interaction.guild.id,
                            system:  'mining',
                            $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, qty] }, consumableDef.maxStack] }
                        },
                        { $inc: { [consumableField]: qty } },
                        { new: true }
                    ).catch(() => null);

                    if (!profUpdated) {
                        await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                        return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                    }
                    m.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? qty;
                } else {
                    const chargeField = `data.charges.${blastDef.chargeType}`;
                    const profUpdated = await GrindProfile.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id, system: 'mining' },
                        { $inc: { [chargeField]: blastDef.quantity * qty } },
                        { new: true }
                    ).catch(() => null);

                    if (!profUpdated) {
                        await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                        return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                    }
                    m.charges[blastDef.chargeType] = profUpdated.data?.charges?.[blastDef.chargeType] ?? (blastDef.quantity * qty);
                }

                const received = blastDef
                    ? `${blastDef.quantity * qty}× ${blastDef.chargeType.replace(/_/g, ' ')}`
                    : `${qty}× ${consumableDef.name}`;

                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('#2ecc71')
                            .setTitle('✅ Purchase Complete')
                            .setDescription(`Bought **${received}** for **${currency}${totalCost.toLocaleString()}**.`)
                            .addFields({ name: 'Balance', value: `${currency}${balanceUpdated.balance.toLocaleString()}`, inline: true })
                            .setTimestamp()
                    ],
                    components: []
                });
            } catch (err) {
                console.error('[mineshop buy] purchase error:', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
            })();

            collector.stop();
        });

        return new Promise(resolve => {
            collector.on('end', async (_, reason) => {
                if (reason === 'time') {
                    interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
                }
                if (actionPromise) await actionPromise.catch(() => {});
                resolve();
            });
        });
    }

    if (sub === 'use') {
        const itemId = interaction.options.getString('item');
        const result = activateConsumable(user, itemId);

        if (!result.success) {
            return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
        }

        await user.save();

        const def = resolveConsumableDef(itemId);
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                    .setDescription(def?.description ?? 'Consumable activated.')
                    .setTimestamp()
            ]
        });
    }

    if (sub === 'repair') {
        const method = interaction.options.getString('method');

        if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
            return interaction.reply({ content: `You don't have a pickaxe equipped.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

        if (method === 'shop') {
            // Price it before touching the pickaxe: applyRepair permanently degrades
            // max durability, so quoting first keeps a player who can't pay from
            // wearing their pickaxe down for nothing.
            const quote = quoteRepair(pickaxe, null);
            if (quote.error) return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });

            if (user.balance < quote.cost) {
                return interaction.reply({ content: `Repair costs ${currency}${quote.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
            }

            await persistGrindIfNew(user, 'mining');
            const charged = await chargeBalance(interaction, quote.cost);
            if (!charged) {
                return interaction.reply({ content: `Repair costs ${currency}${quote.cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
            }
            user.balance = charged.balance;
            user.unmarkModified('balance');

            const repairResult = applyRepair(pickaxe, null);
            user.markModified('mining');
            try {
                await saveGrind(user, ['mining']);
            } catch (err) {
                console.error('[mineshop repair] save error:', err);
                await refundBalance(interaction, quote.cost);
                return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('🔧 Pickaxe Repaired')
                .setDescription(`**${pickaxe.name}** repaired at the shop.`)
                .addFields(
                    { name: 'Durability',  value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                    { name: 'Status',      value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true },
                    { name: 'Cost',        value: `${currency}${repairResult.cost.toLocaleString()}`, inline: true },
                    { name: 'Balance',     value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                );

            if (repairResult.condemned) {
                embed.addFields({ name: '💀 Condemned', value: `After so many repairs, your **${pickaxe.name}** has been condemned. It cannot be repaired again. Time for a new one.`, inline: false });
            }
            embed.setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (method === 'kit_small' || method === 'kit_large') {
            const kitId = method === 'kit_small' ? 'repair_kit_small' : 'repair_kit_large';
            const kit   = CONSUMABLES[kitId];
            const stock = m.consumables[kitId] ?? 0;

            if (stock <= 0) {
                return interaction.reply({ content: `You don't have any **${kit.name}**. Buy one with \`/mine shop buy\`.`, flags: MessageFlags.Ephemeral });
            }

            if (isCondemned(pickaxe)) {
                return interaction.reply({ content: 'This pickaxe is condemned and cannot be repaired. Replace it with `/mine shop pickaxe`.', flags: MessageFlags.Ephemeral });
            }
            if (pickaxe.currentDurability >= pickaxe.maxDurability) {
                return interaction.reply({ content: 'Pickaxe is already at full durability.', flags: MessageFlags.Ephemeral });
            }

            m.consumables[kitId] -= 1;
            const restored = Math.min(kit.durabilityRestore, pickaxe.maxDurability - pickaxe.currentDurability);
            pickaxe.currentDurability = Math.min(pickaxe.maxDurability, pickaxe.currentDurability + kit.durabilityRestore);
            updatePickaxeStatus(pickaxe);
            user.markModified('mining');
            await user.save();

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#b5651d')
                        .setTitle(`${kit.emoji} Repair Kit Used`)
                        .setDescription(`Restored **${restored}** durability to **${pickaxe.name}**.`)
                        .addFields(
                            { name: 'Durability', value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                            { name: 'Status',     value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true }
                        )
                        .setTimestamp()
                ]
            });
        }
    }

    if (sub === 'unlock') {
        const depthId  = interaction.options.getString('depth');
        const depthDef = DEPTHS[depthId];

        if (!depthDef) return interaction.reply({ content: 'Unknown depth.', flags: MessageFlags.Ephemeral });
        if (depthDef.defaultUnlocked || m.unlockedDepths.includes(depthId)) {
            return interaction.reply({ content: `You've already unlocked **${depthDef.name}**.`, flags: MessageFlags.Ephemeral });
        }
        if (m.level < depthDef.unlockLevel) {
            return interaction.reply({ content: `You need Miner Level **${depthDef.unlockLevel}** to unlock **${depthDef.name}**. You're Level ${m.level}.`, flags: MessageFlags.Ephemeral });
        }
        if (user.balance < depthDef.unlockCost) {
            return interaction.reply({ content: `Unlocking **${depthDef.name}** costs ${currency}${depthDef.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
        }

        await persistGrindIfNew(user, 'mining');
        const charged = await chargeBalance(interaction, depthDef.unlockCost);
        if (!charged) {
            return interaction.reply({ content: `Unlocking **${depthDef.name}** costs ${currency}${depthDef.unlockCost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
        }
        user.balance = charged.balance;
        user.unmarkModified('balance');

        const priorDepth = m.activeDepth;
        m.unlockedDepths.push(depthId);
        m.activeDepth = depthId;
        user.markModified('mining');
        try {
            await saveGrind(user, ['mining']);
        } catch (err) {
            console.error('[mineshop unlock] save error:', err);
            m.unlockedDepths = m.unlockedDepths.filter(id => id !== depthId);
            m.activeDepth = priorDepth;
            await refundBalance(interaction, depthDef.unlockCost);
            return interaction.reply({ content: 'The unlock failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle(`${depthDef.emoji} Depth Unlocked!`)
            .setDescription(`**${depthDef.name}** is now accessible.\n> ${depthDef.description}`)
            .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
            .setFooter({ text: `Now set as your active depth — use /mine dig to start digging!` })
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }
}

// ─── EMBED BUILDERS / HELPERS ─────────────────────────────────────────────────

function buildMineEmbed(result, user, depth, pickaxe, currency, discordUser) {
    const m = user.mining;

    if (result.success) {
        const { ore, tier, finalPayout, isCrit, critMultiplier, specialDrop, xpEarned, levelUp, cappedByHard } = result;
        const color = isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        // At the hard cap finalPayout is already 0, so the old strikethrough rendered
        // as "~~0~~ (daily cap reached)" — it struck out the wrong number and never
        // told the player what the cap had actually cost them.
        const payoutDisplay = cappedByHard
            ? `~~${currency}${(result.forfeited ?? 0).toLocaleString()}~~ → **${currency}0**`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const tierNum  = TIER_NUM[tier] ?? 1;
        const isEvent  = tier === 'event';
        const isHeadline = tierNum >= 5;   // legendary and event both get the full treatment
        const ribbon = TIER_RIBBON(tierNum);
        const embedTitle = isHeadline
            ? (isEvent ? `☄️🌋 PRIMORDIAL STRIKE 🌋☄️` : `⛏️✨ LEGENDARY STRIKE ✨⛏️`)
            : `${ore.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${ore.name} ${isCrit ? '✨' : ''}`;
        const headlineLede = isEvent
            ? 'You broke into something that should not be down there.'
            : 'You struck something impossible in the deep.';
        const embedDesc = isHeadline
            ? `${ribbon}\n\n${headlineLede}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${ore.emoji}  **${ore.name}**  [${TIER_STARS[tierNum]}]\n  *${ore.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : `${ribbon}\n\n*${ore.flavor}*`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(embedTitle)
            .setDescription(embedDesc)
            .addFields(
                { name: 'Depth',    value: `${depth.emoji} ${depth.name}`,         inline: true },
                { name: 'Tier',     value: tierLabel,                               inline: true },
                { name: 'Reward',   value: payoutDisplay,                           inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit bonus)' : ''}`, inline: true },
                { name: 'Pickaxe',  value: `${pickaxe.name} ${pickaxeStatusEmoji(pickaxe.status)}\n${durabilityBar(pickaxe.currentDurability, pickaxe.maxDurability)} ${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                  inline: true }
            );

        // Every multiplicative factor that touched this haul, so the arithmetic on
        // screen reconciles. This used to list streak and crit, multiply just those
        // two, and then print the *final* payout — which also carried the intensity
        // multiplier (up to 3x), the featured depth, the pet, the district and the
        // Artificer bonus. Players saw "2.52x → +1,340" when the real stack was 5x.
        const mineMultEntries = [];
        let mineCombined = 1;
        const addMult = (emoji, label, factor) => {
            if (!(factor > 0) || Math.abs(factor - 1) < 0.005) return;
            mineMultEntries.push({ emoji, label });
            mineCombined *= factor;
        };

        const intensityMult = result.caveIn && !result.caveInBonusPaid ? 1 : (result.intensityLevel?.multiplier ?? 1);
        addMult('🔥', `${(result.streakMult ?? 1).toFixed(2)}x`, result.streakMult ?? 1);
        addMult('⚡', `${critMultiplier.toFixed(2)}x crit`, critMultiplier);
        addMult(result.intensityLevel?.emoji ?? '⛏️', `${intensityMult.toFixed(2)}x depth`, intensityMult);
        addMult('🌟', `${(1 + FEATURED_PAYOUT_BONUS).toFixed(2)}x featured`, result.featuredDepthBonus > 0 ? 1 + FEATURED_PAYOUT_BONUS : 1);
        addMult('💎', `${(1 + (result.petYieldPct ?? 0) / 100).toFixed(2)}x pet`, result.petYieldBonus > 0 ? 1 + (result.petYieldPct ?? 0) / 100 : 1);
        addMult('🌲', `${(1 + WILDERNESS_YIELD_BONUS).toFixed(2)}x district`, result.wildernessBonus > 0 ? 1 + WILDERNESS_YIELD_BONUS : 1);
        addMult('⚒️', `${(1 + (result.artificerRate ?? 0)).toFixed(2)}x artificer`, 1 + (result.artificerRate ?? 0));
        addMult('✨', '2.00x yield', result.gatheringYield ? 2 : 1);

        if (mineMultEntries.length > 0 && finalPayout > 0) {
            // What the stack itself contributed: the haul, less what a flat 1x roll of
            // the same ore would have paid.
            const stackGain = Math.max(0, finalPayout - Math.round(finalPayout / mineCombined));
            embed.addFields({ name: '📈 Multipliers', value: stackBar(mineMultEntries, mineCombined, stackGain, currency), inline: false });
        }

        if (result.gatheringYield) {
            const { label, emoji, chargesLeft } = result.gatheringYield;
            embed.addFields({
                name: `${emoji} ${label}`,
                value: `Payout doubled · ${chargesLeft > 0 ? `${chargesLeft} charge${chargesLeft === 1 ? '' : 's'} left` : '**last charge**'}`,
                inline: false,
            });
        }

        if (specialDrop) {
            embed.addFields({ name: '🪨 Material Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        }

        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Miner Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
        }

        if (result.expiredMagnet) embed.addFields({ name: '🧲 Magnet Expired', value: `Your ${result.expiredMagnet.replace(/_/g, ' ')} has worn off.`, inline: false });
        if (result.expiredLamp)   embed.addFields({ name: '🪔 Lamp Expired',    value: `Your miner's lamp has flickered out.`, inline: false });

        if (pickaxe.status === 'broken') {
            embed.addFields({ name: '⚠️ Pickaxe Broke!', value: `Your **${pickaxe.name}** has broken! Use \`/mine shop repair\` before mining again.`, inline: false });
        } else if (pickaxe.currentDurability <= Math.floor(pickaxe.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your **${pickaxe.name}** is nearly worn out (${pickaxe.currentDurability}/${pickaxe.maxDurability}). Repair soon!`, inline: false });
        }

        const throttleField = buildThrottleField(user, result, currency);
        if (throttleField) embed.addFields(throttleField);

        embed.addFields(
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`,   inline: true },
            { name: 'Miner XP',  value: buildXpLine(user),                               inline: true }
        );
        embed.setFooter({ text: `Cooldown: 30s • ${buildDailyProgressLine(user, currency)} • ${buildActiveConsumablesLine(user)}` });
        embed.setTimestamp();
        return embed;
    }

    const { failure, xpEarned, levelUp } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(`*${failure.message}*`)
        .addFields(
            { name: 'Depth',   value: `${depth.emoji} ${depth.name}`,  inline: true },
            { name: 'Reward',  value: 'Nothing',                        inline: true },
            { name: 'XP',      value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Pickaxe', value: `${pickaxe.name} ${pickaxeStatusEmoji(pickaxe.status)}\n${durabilityBar(pickaxe.currentDurability, pickaxe.maxDurability)} ${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
            {
                name: 'Stamina',
                value: result.staminaSpared
                    ? `${buildStaminaLine(user)}\n*Empty vein — no stamina spent*`
                    : buildStaminaLine(user),
                inline: true
            }
        );

    if ((user.mining.consecutiveFails ?? 0) > 0) {
        embed.addFields(buildPityStreakField(user.mining.consecutiveFails, LIMITS, PITY_COPY.mining));
    }

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Cave-in', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }

    if (result.collapseEvent) {
        embed.setColor('#8B0000');
        embed.addFields({ name: '💀 Catastrophic Collapse!', value: `The tunnel caved in around you — your **${result.collapseEvent.weaponName}** was completely destroyed! Use \`/mine shop repair\` to fix it.`, inline: false });
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Miner Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    if (pickaxe.status === 'broken' && !result.collapseEvent) {
        embed.addFields({ name: '❌ Pickaxe Broke!', value: `Your **${pickaxe.name}** has broken! Use \`/mine shop repair\` before mining again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /mine shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

/**
 * A field explaining whichever daily throttle is currently biting, or null when none
 * is. These are the three things that used to shrink a haul with nothing said: fatigue
 * past DIM_RETURNS_THRESHOLD_1, the halving past DAILY_SOFT_CAP, and the hard cap.
 */
function buildThrottleField(user, result, currency) {
    const m       = user.mining;
    const resetIn = msUntilDailyReset(user);
    const resetNote = resetIn == null ? '' : ` Resets in **${formatMs(resetIn)}**.`;

    if (result.cappedByHard) {
        return {
            name: '🛑 Daily Cap Reached',
            value: `You've earned the daily maximum of ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()}. `
                 + `This haul paid nothing.${resetNote}\nXP, materials and quest progress still count.`,
            inline: false,
        };
    }

    const notes = [];
    if (result.softCapped) {
        notes.push(`💰 Past ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} today — **payouts are halved** until the window resets.`);
    }
    if ((result.fatigueMult ?? 1) < 1) {
        notes.push(`😪 **${m.dailyMines}** digs today — **fatigue** has payouts at **${Math.round(result.fatigueMult * 100)}%**.`);
    }
    if (!notes.length) return null;

    if (result.forfeited > 0) {
        notes.push(`This dig gave up ${currency}${result.forfeited.toLocaleString()}.${resetNote}`);
    } else if (resetNote) {
        notes.push(resetNote.trim());
    }

    return { name: '⏳ Daily Throttle', value: notes.join('\n'), inline: false };
}

function buildFailureTitle(severityId) {
    return {
        clean_miss: '💨 Empty Vein!',
        rockfall:   '🪨 Rockfall!',
        stuck:      '🔧 Pickaxe Stuck!',
        cave_in:    '🕳️ Cave-in!'
    }[severityId] ?? '❌ Failed Mine';
}

function buildStaminaLine(user) {
    const m   = user.mining;
    const max = getMaxStamina(user);
    return `${m.stamina}/${max} ⚡`;
}

function buildXpLine(user) {
    const m      = user.mining;
    const toNext = xpToNextLevel(m.level, m.xp);
    if (toNext === null) return `${m.xp.toLocaleString()} XP (MAX)`;
    return `${m.xp.toLocaleString()} XP (${toNext} to Lv.${m.level + 1})`;
}

/** Running daily earnings against the soft cap — the number the throttles key off. */
function buildDailyProgressLine(user, currency) {
    const earned = user.mining.dailyCoins ?? 0;
    const compact = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`;
    return `Today: ${currency}${compact(earned)}/${compact(LIMITS.DAILY_SOFT_CAP)}`;
}

function buildActiveConsumablesLine(user) {
    const m = user.mining;
    const parts = [];
    if (m.activeMagnet)   parts.push(`Magnet (${m.activeMagnetMinesLeft} mines left)`);
    if (m.activeLamp)     parts.push(`Lamp (${m.activeLampMinesLeft} mines left)`);
    if (m.activeInstinct) parts.push(`Instinct (queued)`);
    if (m.activeXpScroll) parts.push(`XP Scroll (queued)`);
    return parts.length ? parts.join(' • ') : 'No active buffs';
}

function buildXpBar(m, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const currentLevelXp = MINER_LEVELS[m.level - 1]?.xpRequired ?? 0;
    const nextLevelXp    = MINER_LEVELS[m.level]?.xpRequired ?? 1;
    const denominator    = nextLevelXp - currentLevelXp;
    const progress       = denominator > 0 ? (m.xp - currentLevelXp) / denominator : 0;
    const filled         = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct            = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

function buildProgressBar(current, target, length = 10) {
    const filled = Math.min(length, Math.round((current / target) * length));
    return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}

function formatExpiry(ms) {
    if (ms <= 0) return 'expired';
    const hrs  = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
}

// ─── MAP ──────────────────────────────────────────────────────────────────────

async function handleMap(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    if (!user) {
        return interaction.reply({
            content: "You haven't started mining yet! Use `/mine dig` to begin.",
            flags: MessageFlags.Ephemeral
        });
    }
    await attachGrind(user);
    ensureMineData(user);
    const m = user.mining;

    const grid     = renderMineMap(user);
    const depth    = DEPTHS[m.activeDepth];
    const mapSize  = 10;
    const explored = (m.mineMap ?? []).filter(c => c !== 0).length;
    const total    = mapSize * mapSize;

    // Yield multiplier comes from the vein-reading rounds, not from miner level:
    // 0/3 correct pays 0.7× and 3/3 pays 2× (3× on a lucky break into the Abyss).
    const intensityHint = '0.7×–3.0×, set by your vein read';

    const raidableLines = getRaidableMaterials(user).map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);

    const embed = new EmbedBuilder()
        .setColor('#8B4513')
        .setTitle(`🗺️ ${interaction.user.username}'s Mine Map`)
        .setDescription(`\`\`\`\n${grid}\n\`\`\`\n` +
            `${depth ? `**Depth:** ${depth.emoji} ${depth.name}` : ''} | **Yield range:** ${intensityHint}`)
        .addFields(
            {
                name: '📊 Excavation Progress',
                value: `${explored}/${total} cells explored`,
                inline: true
            },
            {
                name: '📦 Exposed to Raiders',
                value: raidableLines.length
                    ? raidableLines.join('\n') + `\n*A raid takes up to ${RAID_MAX_PER_MATERIAL} of each — spend or craft them to shrink the pile.*`
                    : 'Nothing exposed — raiders can only reach materials you hold 2+ of.',
                inline: true
            },
            {
                name: '🔑 Legend',
                value: '🪨 Unexplored  ⬛ Excavated  💎 Ore Vein  💥 Cave-in  ⛏️ You',
                inline: false
            }
        )
        .setFooter({ text: 'Mine more to expand your map • Use /mine raid to steal from others' })
        .setTimestamp();

    const spareLocks = m.consumables?.mine_lock ?? 0;
    if (m.mineLockActive) {
        embed.addFields({ name: '🔒 Mine Lock', value: `Armed — the next raid on your mine bounces off it.${spareLocks > 0 ? `\n${spareLocks} spare in your bag.` : ''}`, inline: true });
    } else if (spareLocks > 0) {
        embed.addFields({ name: '🔓 Mine Lock', value: `${spareLocks} in your bag, none armed — use \`/mine shop use item:mine_lock\`.`, inline: true });
    }

    return interaction.reply({ embeds: [embed] });
}

// ─── RAID ─────────────────────────────────────────────────────────────────────

async function handleRaid(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser('target');
    if (targetUser.id === interaction.user.id) {
        return interaction.reply({ content: "You can't raid your own mine.", flags: MessageFlags.Ephemeral });
    }

    const [raider, defender] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        User.findOne({ userId: targetUser.id, guildId: interaction.guild.id })
    ]);
    await Promise.all([attachGrind(raider), attachGrind(defender)]);

    ensureMineData(raider);

    if (!defender) {
        return interaction.reply({
            content: `${targetUser.username} hasn't started mining yet — nothing to raid.`,
            flags: MessageFlags.Ephemeral
        });
    }
    ensureMineData(defender);

    // Raider cooldown
    const now = Date.now();
    if (raider.mining.lastRaidSent && now - raider.mining.lastRaidSent.getTime() < RAID_COOLDOWN_MS) {
        const nextAt = new Date(raider.mining.lastRaidSent.getTime() + RAID_COOLDOWN_MS);
        const remaining = formatMs(nextAt.getTime() - now);
        return interaction.reply({
            content: `You need to wait **${remaining}** before raiding again.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Defender shield (recently raided)
    if (defender.mining.lastRaidReceived && now - defender.mining.lastRaidReceived.getTime() < RAID_SHIELD_MS) {
        const shieldEnds = new Date(defender.mining.lastRaidReceived.getTime() + RAID_SHIELD_MS);
        const remaining  = formatMs(shieldEnds.getTime() - now);
        return interaction.reply({
            content: `**${targetUser.username}**'s mine is still recovering from a recent raid. Wait **${remaining}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Raider must have a pickaxe equipped
    const rm = raider.mining;
    if (rm.equippedPickaxeIndex < 0 || !rm.pickaxes[rm.equippedPickaxeIndex]) {
        return interaction.reply({
            content: "You need a pickaxe equipped to raid! Use `/mine inv equip`.",
            flags: MessageFlags.Ephemeral
        });
    }

    // Mine Lock: defender is protected. Consume atomically so two concurrent
    // raiders can't both read the lock as active and both bypass it.
    if (defender.mining.mineLockActive) {
        const lockConsumed = await GrindProfile.findOneAndUpdate(
            { userId: defender.userId, guildId: interaction.guild.id, system: 'mining', 'data.mineLockActive': true },
            { $set: { 'data.mineLockActive': false } },
            { new: true }
        ).catch(err => { console.error('[mine raid] lock consume error:', err); return null; });

        if (lockConsumed) {
            defender.mining.mineLockActive = false;
            raider.mining.lastRaidSent = new Date();
            raider.markModified('mining');
            await raider.save().catch(() => null);
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('🔒 Mine Lock Triggered!')
                    .setDescription(
                        `**${targetUser.username}**'s mine was protected by a **Mine Lock**.\n` +
                        `The lock absorbed your raid attempt and has now been consumed.`
                    )
                    .setTimestamp()
                ]
            });
        }
        // Lock was already consumed by a concurrent raid — fall through to normal raid resolution.
    }

    // Check if there's anything to steal
    if (!hasRaidableMaterials(defender)) {
        return interaction.reply({
            content: `**${targetUser.username}** has nothing worth raiding — no material they hold more than one of.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // The transfer below is a pair of $inc updates, but a grind profile is saved as a
    // whole `data` document (see utils/grindProfile) — so a defender part-way through
    // their own /mine dig would write their pre-raid snapshot straight back over the
    // debit, keeping their materials while the raider kept the credit. A dig holds
    // this lock for its entire interactive run, which is seconds wide, so take the
    // defender's lock for the transfer rather than racing it.
    //
    // tryAcquire never blocks, so two miners raiding each other simultaneously cannot
    // deadlock — one or both are simply turned away.
    const defenderLockKey = `grind:mine:${interaction.guild.id}:${defender.userId}`;
    const defenderLock    = await _lockAcquire(defenderLockKey, 30_000);
    if (!defenderLock) {
        return interaction.reply({
            content: `**${targetUser.username}** is down in the mine right now — you can't get in behind them. Try again in a moment.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // The haul, declared out here because the embed and the defender's DM below
    // both read it after the lock has been released.
    const stolen = {};

    try {

        // Execute the raid: move RAID_STEAL_MIN–RAID_STEAL_MAX of the defender's largest
        // material piles across to the raider. The same `data.materials` map is debited
        // and credited, so a raid transfers value rather than creating it.
        // Defender is updated first; the shield CAS ($or on lastRaidReceived) and
        // per-material $gte guards ensure only one raid commits atomically. Raider
        // update follows sequentially with a cooldown CAS to block duplicate commands.
        const stealFraction = RAID_STEAL_MIN + Math.random() * (RAID_STEAL_MAX - RAID_STEAL_MIN);
        const defenderInc = {};
        const raiderInc   = {};

        for (const { matId, take } of planRaidHaul(defender, stealFraction)) {
            stolen[matId] = take;
            defenderInc[`data.materials.${matId}`] = -take;
            raiderInc[`data.materials.${matId}`]   = take;
        }

        // Make sure the raider's mining profile exists before the conditional commit below
        await persistGrindIfNew(raider, 'mining');

        // Condition: the defender still holds every material being taken; defender not
        // under active shield. Without the $gte guards a raid racing a craft could push
        // a material stock negative.
        const defenderCond = { userId: defender.userId, guildId: interaction.guild.id, system: 'mining' };
        for (const [matId, take] of Object.entries(stolen)) {
            defenderCond[`data.materials.${matId}`] = { $gte: take };
        }
        defenderCond.$or = [
            { 'data.lastRaidReceived': null },
            { 'data.lastRaidReceived': { $lte: new Date(Date.now() - RAID_SHIELD_MS) } },
        ];

        const defenderResult = await GrindProfile.findOneAndUpdate(
            defenderCond,
            { $inc: defenderInc, $set: { 'data.lastRaidReceived': new Date() } }
        ).catch(err => { console.error('[mine raid] defender save error:', err); return null; });

        if (!defenderResult) {
            return interaction.reply({
                content: `**${targetUser.username}**'s stock shifted before you got in — nothing left to take. Try again shortly.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // The credit half of the transfer. Its result cannot be discarded: the debit
        // above has already landed, and there is no transaction to tie the two together
        // on a standalone mongod. If the credit does not land — the cooldown CAS lost a
        // race, or the write errored — the materials would simply cease to exist while
        // both players were told the raid succeeded. Put them back instead.
        const credited = await GrindProfile.findOneAndUpdate(
            {
                userId: raider.userId,
                guildId: interaction.guild.id,
                system: 'mining',
                $or: [
                    { 'data.lastRaidSent': null },
                    { 'data.lastRaidSent': { $lte: new Date(Date.now() - RAID_COOLDOWN_MS) } },
                ],
            },
            { $inc: raiderInc, $set: { 'data.lastRaidSent': new Date() } }
        ).catch(err => { console.error('[mine raid] raider save error:', err); return null; });

        if (!credited) {
            // Compensate: hand the defender's materials back and restore the raid shield
            // to what it was, so a failed raid does not leave them sheltered for an hour
            // over a raid that never happened.
            const rollback = {};
            for (const [matId, take] of Object.entries(stolen)) rollback[`data.materials.${matId}`] = take;
            await GrindProfile.updateOne(
                { userId: defender.userId, guildId: interaction.guild.id, system: 'mining' },
                { $inc: rollback, $set: { 'data.lastRaidReceived': defenderResult.data?.lastRaidReceived ?? null } }
            ).catch(err => console.error('[mine raid] rollback failed — defender owed:', Object.keys(stolen).join(','), err));

            return interaction.reply({
                content: 'Your raid was interrupted — nothing was taken, and nothing was lost. Try again in a moment.',
                flags: MessageFlags.Ephemeral
            });
        }

    } finally {
        await _lockRelease(defenderLockKey, defenderLock);
    }

    const stolenLines = Object.entries(stolen).map(([id, qty]) => `• ${MATERIAL_NAMES[id] ?? id} ×${qty}`).join('\n');
    const stolenCount = Object.values(stolen).reduce((sum, qty) => sum + qty, 0);

    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('⚔️ Mine Raided!')
        .setDescription(
            `You broke into **${targetUser.username}**'s mine and made off with **${stolenCount}** material${stolenCount === 1 ? '' : 's'}!\n\n` +
            `**Stolen:**\n${stolenLines}\n\n` +
            `*These are now yours to craft with.*`
        )
        .setFooter({ text: `${targetUser.username} now has a 1-hour raid shield • Use /mine map to see what of yours is exposed` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // Notify defender if possible
    const dmEmbed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle('⚠️ Your Mine Was Raided!')
        .setDescription(
            `**${interaction.user.username}** broke into your mine on **${interaction.guild.name}** ` +
            `and stole **${stolenCount}** of your crafting material${stolenCount === 1 ? '' : 's'}!\n\n` +
            `**Lost:**\n${stolenLines}\n\n` +
            `Get a **Mine Lock** (\`/mine shop buy item:mine_lock\` or \`/craft make mine_lock_from_obsidian\`) ` +
            `and arm it with \`/mine shop use item:mine_lock\` to block the next raid.`
        )
        .setTimestamp();
    targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
}


// ── Per-user action lock ──────────────────────────────────────────────────────
// Mining mutates the user document with read-modify-write saves, so concurrent
// /mine invocations from the same user can race stamina, daily caps, and drops.
// Serialize them: one mining action at a time per user.
const { tryAcquire: _lockAcquire, release: _lockRelease } = require('../../utils/activeGameLock');
const _mineExecute = module.exports.execute;
module.exports.execute = async function (interaction) {
    const lockKey   = `grind:mine:${interaction.guild?.id}:${interaction.user.id}`;
    const lockToken = await _lockAcquire(lockKey, 120_000);
    if (!lockToken) {
        return interaction.reply({
            content: '⛏️ You already have a mining action in progress — finish it first.',
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
    }
    try {
        return await _mineExecute(interaction);
    } finally {
        await _lockRelease(lockKey, lockToken);
    }
};
