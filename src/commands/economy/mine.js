'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { attachGrind, persistGrindIfNew } = require('../../utils/grindProfile');
const GrindProfile = require('../../models/GrindProfile');
const Guild = require('../../models/Guild');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse }          = require('../../utils/shopBrowse');
const {
    DEPTHS, DEPTH_LIST, TIER_COLORS, LIMITS, PICKAXE_BY_TIER,
    MATERIAL_NAMES, CONSUMABLES, BLAST_PACKS,
    PICKAXE_TIERS, PICKAXE_BY_SLUG, PICKAXE_UPGRADES,
    MINER_LEVELS, PRESTIGE_BONUSES, MINE_QUEST_TEMPLATES,
    RAID_COOLDOWN_MS, RAID_SHIELD_MS, RAID_STEAL_MIN, RAID_STEAL_MAX
} = require('../../data/mineData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { TIER_NUM, TIER_RIBBON } = require('../../data/materialRarity');
const { randomFrom, MINE_CAVE_LINES } = require('../../utils/copyLines');
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
    applyRepair,
    updatePickaxeStatus,
    applyXp,
    updateMineMap,
    renderMineMap,
    getOreStashSummary,
    isOreStashEmpty,
    activateMineLock
} = require('../../services/mineService');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { stackBar } = require('../../utils/rewardReveal');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { tryUpdateHourlyWinner, getCurrentHourlyLeader } = require('../../utils/hourlyWinner');
const { isDistrictActive } = require('../../services/districtService');
const { ensureQuests, onMine, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { getActiveSynergies } = require('../../services/synergyService');
const { CROSS_CONSUMABLES } = require('../../data/crossSystemData');

const WILDERNESS_YIELD_BONUS = 0.10;

// Resolve a consumable's display metadata from the mine shop or cross-system registry.
function resolveConsumableDef(id) {
    return CONSUMABLES[id] ?? CROSS_CONSUMABLES[id] ?? null;
}

const DEPTH_CHOICES    = DEPTH_LIST.map(d => ({ name: d.name, value: d.id }));
const PICKAXE_CHOICES  = PICKAXE_TIERS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost.toLocaleString()} coins`, value: p.slug }));
const ALL_ITEMS        = [...Object.values(CONSUMABLES), ...BLAST_PACKS];
const ITEM_CHOICES     = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const ACTIVATABLE      = ['ore_magnet', 'premium_magnet', 'miners_lamp', 'miners_instinct', 'xp_scroll', 'energy_tonic', 'reinforced_trap'];
const UPGRADE_CHOICES  = Object.values(PICKAXE_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES   = DEPTH_LIST.filter(d => !d.defaultUnlocked).map(d => ({ name: `${d.emoji} ${d.name}`, value: d.id }));

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

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
            sub.setName('map')
                .setDescription('View your persistent mine map — see every cell you have excavated.'))
        .addSubcommand(sub =>
            sub.setName('raid')
                .setDescription('Raid another miner\'s mine and steal unprocessed ore (requires pickaxe equipped)')
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
        const midColor = tierNum === 4 ? '#9c27b0' : '#ff9800';
        const midTitle = tierNum === 4 ? '🔮 A rare vein reveals itself...' : '⚡ The tunnel fills with an impossible glow...';
        const midTierLabel = tierNum === 4 ? 'EPIC' : 'LEGENDARY';
        const midEmbed = new EmbedBuilder()
            .setColor(midColor)
            .setTitle(midTitle)
            .setDescription(`━━━━━━━━━━━━━━━\n❓❓❓  **${midTierLabel}**  ❓❓❓\n━━━━━━━━━━━━━━━`);
        await interaction.editReply({ embeds: [midEmbed] });
        await wait(1500);
        if (tierNum === 5) {
            const fanfareEmbed = new EmbedBuilder()
                .setColor('#ff9800')
                .setTitle('⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡')
                .setDescription('━━━━━━━━━━━━━━━\n*Miners dream of this their whole careers.*\n━━━━━━━━━━━━━━━');
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
    if (!m.unlockedDepths.includes(depthId)) {
        return interaction.reply({
            content: `You haven't unlocked **${depth.name}** yet. Use \`/mine shop unlock\` to unlock it.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (m.level < depth.unlockLevel) {
        return interaction.reply({
            content: `You need to be Miner Level **${depth.unlockLevel}** to mine in **${depth.name}**.`,
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
        const sinceRare = m.sinceRare ?? 0;
        const depthHint = m.stamina >= 5
            ? 'Tip: Deep intensity (💎) doubles your yield — try it when stamina is full'
            : null;
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '⛏️ Catching Your Breath',
                description: 'You just came up from a dig.\nTake a short break before heading back down.',
                color: '#b5651d',
                nextAt,
                nextRewardPreview: depthHint ?? 'Next dig: Abyss tier multiplies your payout by 3×',
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (m.stamina <= 0) {
        const regenMs   = msUntilNextStamina(user);
        const nextAt    = new Date(Date.now() + regenMs);
        const sinceRare = m.sinceRare ?? 0;
        const pityStat  = sinceRare >= 5
            ? `🎯 ${sinceRare} mines since last Rare+ material • rare guaranteed around mine ~40`
            : null;
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Out of Stamina',
                description: "You've dug yourself to exhaustion.\nBuy an **Energy Tonic** from `/mine shop` to recover faster.",
                color: '#b5651d',
                nextAt,
                pityStat,
                nextRewardPreview: 'Full stamina + Deep intensity = best rare material odds',
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

    const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
    if (pickaxeData.requiresCharge) {
        const chargeStock = m.charges[pickaxeData.chargeType] ?? 0;
        if (chargeStock <= 0) {
            return interaction.reply({
                content: `You're out of **${pickaxeData.chargeType.replace(/_/g, ' ')}**! Buy more with \`/mine shop buy\`.`,
                flags: MessageFlags.Ephemeral
            });
        }
        m.charges[pickaxeData.chargeType] = chargeStock - 1;
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
    const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, STARVING_THRESHOLD: PET_STARVE, TRAIT_FLAVOR } = require('../../services/petService');
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
                `⚡ **Ore at stake:** ${(result.caveInPayout ?? 0).toLocaleString()} coins\n\n` +
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
            result.caveInEscaped = true;
        } else {
            // Abandon: reverse the payout and any tier-find counters executeMine already booked
            if (result.caveInPayout) {
                user.balance       -= result.caveInPayout;
                m.totalEarned      -= result.caveInPayout;
                m.dailyCoins       -= result.caveInPayout;
                result.finalPayout  = 0;
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
    if (result.success && result.finalPayout > 0) {
        const earn = await onEconomyEarn(user, guildSettings, result.finalPayout);
        questsDone.push(...earn.completed);
        questsNear.push(...earn.nearComplete);
    }

    const mineAchievements = await checkAndAward(user, guildSettings).catch(() => []);

    try {
        await user.save();
        if (mineAchievements.length) {
            announceAchievements(interaction.client, guildSettings, user, interaction.member, mineAchievements).catch(() => null);
        }
        notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
        notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
    } catch (err) {
        if (err.name === 'VersionError') {
            return interaction.editReply({ content: 'A simultaneous request conflicted with your mine. Please try `/mine dig` again.' });
        }
        console.error('[mine] save error:', err);
        return interaction.editReply({ content: 'Something went wrong saving your mine. Please try again.' });
    }

    // Log big win, then await hourly leader update and re-fetch for accurate footer
    if (result.success && result.finalPayout > 0) {
        const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
        if (result.finalPayout >= bigWinThreshold || result.tier === 'legendary') {
            logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'mine', details: { itemName: result.ore?.name, rarity: result.tier }, client: interaction.client });
        }
        await tryUpdateHourlyWinner({ guildId: interaction.guild.id, category: 'mine', userId: interaction.user.id, username: interaction.user.username, value: result.finalPayout, details: result.ore ? `${result.ore.emoji ?? ''} ${result.ore.name} (${currency}${result.finalPayout.toLocaleString()})`.trim() : `${currency}${result.finalPayout.toLocaleString()}` }).catch(() => null);
    }
    const hourlyLeader = await getCurrentHourlyLeader(interaction.guild.id, 'mine').catch(() => null);

    const embed = buildMineEmbed(result, user, depth, pickaxe, currency, interaction.user);
    {
        const desc = embed.data.description ?? '';
        const lines = [`> ⛏️ *${finalIcons} — Vein depth ${veinDepth}/3 → ${chosenIntensity.emoji} ${chosenIntensity.name} (${chosenIntensity.multiplier}×)*`];
        if (result.caveIn && result.caveInEscaped) lines.push(`> 💥 *Cave-in! You used a blast charge — ore saved.*`);
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

    // Pet narrative: show active pet's personality flavor in description
    if (result.success) {
        const activePet = (user.pets || []).find(p => p.hunger >= PET_STARVE);
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

    if (result.success && ['epic', 'legendary'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
        const announceChannelId = guildSettings?.economy?.announcementChannelId;
        const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
        const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
        const isLeg = result.tier === 'legendary';
        const announcementEmbed = new EmbedBuilder()
            .setColor(isLeg ? '#ff9800' : '#9c27b0')
            .setTitle(isLeg ? '✨ Legendary Strike! ✨' : '🔮 Epic Ore Unearthed!')
            .setDescription(
                `<@${interaction.user.id}> just unearthed ${result.ore.emoji} **${result.ore.name}** [${isLeg ? '⭐⭐⭐⭐⭐' : '⭐⭐⭐⭐'}]\n` +
                `at the **${depth.name}** depth.\n\n` +
                (isLeg ? `That vein runs deep — and dangerous.` : `A rare find in these tunnels.`)
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
            value: [
                pBonus.critBonus    > 0 ? `+${Math.round(pBonus.critBonus    * 100)}% crit chance`  : null,
                pBonus.staminaBonus > 0 ? `+${pBonus.staminaBonus} max stamina`                     : null,
                pBonus.payoutBonus  > 0 ? `+${Math.round(pBonus.payoutBonus  * 100)}% all payouts`   : null,
                pBonus.rarityBonus  > 0 ? `+${Math.round(pBonus.rarityBonus  * 100)}% rarity boost`  : null
            ].filter(Boolean).join('\n') || 'None yet',
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

    if (prestige === 0 && m.level >= 50) {
        embed.setFooter({ text: 'Max level reached!' });
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
            embed.addFields({ name: '🪓 Pickaxes', value: lines.join('\n'), inline: false });
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

        user.balance += template.reward.coins;
        const lvResult = applyXp(user, template.reward.xp);

        questEntry.progress = -1;
        user.markModified('quests');
        await user.save();

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

        const remaining = user.quests.filter(q =>
            q.questId.startsWith('mq_') &&
            q.expiresAt?.getTime() > now &&
            q.progress !== -1
        ).length;

        embed.setFooter({ text: remaining > 0
            ? `${remaining} quest(s) remaining — use /mine quests view`
            : 'All quests claimed! Mine again to receive a fresh set.' });
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
            collector.stop();

            if (btn.customId === 'minepickaxe_cancel') {
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

        user.balance -= cost;
        pickaxe.upgrade = moduleId;
        user.markModified('mining');
        await user.save();

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
            collector.stop();

            if (btn.customId === 'minebuy_cancel') {
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
            const repairResult = applyRepair(pickaxe, null);
            if (repairResult.error) return interaction.reply({ content: repairResult.error, flags: MessageFlags.Ephemeral });

            if (user.balance < repairResult.cost) {
                return interaction.reply({ content: `Repair costs ${currency}${repairResult.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
            }

            user.balance -= repairResult.cost;
            user.markModified('mining');
            await user.save();

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

            if (pickaxe.status === 'condemned') {
                return interaction.reply({ content: 'This pickaxe is condemned and cannot be repaired.', flags: MessageFlags.Ephemeral });
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

        user.balance -= depthDef.unlockCost;
        m.unlockedDepths.push(depthId);
        m.activeDepth = depthId;
        user.markModified('mining');
        await user.save();

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
        const payoutDisplay = cappedByHard ? `~~${currency}${finalPayout}~~ (daily cap reached)` : `**${currency}${finalPayout.toLocaleString()}**`;

        const isLegendary = tier === 'legendary';
        const ribbon = TIER_RIBBON(TIER_NUM[tier] ?? 1);
        const embedTitle = isLegendary
            ? `⛏️✨ LEGENDARY STRIKE ✨⛏️`
            : `${ore.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${ore.name} ${isCrit ? '✨' : ''}`;
        const embedDesc = isLegendary
            ? `${ribbon}\n\nYou struck something impossible in the deep.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${ore.emoji}  **${ore.name}**  [⭐⭐⭐⭐⭐]\n  *${ore.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
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

        const mineMultEntries = [];
        if ((result.streakMult ?? 1) > 1.0) mineMultEntries.push({ emoji: '🔥', label: `${(result.streakMult).toFixed(2)}x` });
        if (isCrit)                          mineMultEntries.push({ emoji: '⚡', label: `${critMultiplier.toFixed(2)}x crit` });
        if (mineMultEntries.length > 0) {
            const mineCombined = (result.streakMult ?? 1) * critMultiplier;
            embed.addFields({ name: '📈 Multipliers', value: stackBar(mineMultEntries, mineCombined, finalPayout, currency), inline: false });
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

        embed.addFields(
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`,   inline: true },
            { name: 'Miner XP',  value: buildXpLine(user),                               inline: true }
        );
        embed.setFooter({ text: `Cooldown: 30s • ${buildActiveConsumablesLine(user)}` });
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
            { name: 'Stamina', value: buildStaminaLine(user), inline: true }
        );

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

    // Compute depth level proxy from miner level for the yield multiplier hint
    const intensityHint = m.level >= 40 ? '2.0×–3.0×' : m.level >= 20 ? '1.4×–2.0×' : '1.0×–1.4×';

    const stashLines = getOreStashSummary(user).map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);

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
                name: '📦 Unprocessed Ore Stash',
                value: stashLines.length
                    ? stashLines.join('\n') + '\n*Can be stolen by raiders!*'
                    : 'Empty — ore stash fills as you mine veins.',
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

    if (m.mineLockActive) {
        embed.addFields({ name: '🔒 Mine Lock', value: 'Active — your mine is protected from raiders.', inline: true });
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
    if (isOreStashEmpty(defender)) {
        return interaction.reply({
            content: `**${targetUser.username}**'s ore stash is empty — nothing worth raiding.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Execute the raid: steal RAID_STEAL_MIN–RAID_STEAL_MAX of each stash material.
    // Defender is updated first; the shield CAS ($or on lastRaidReceived) and
    // per-material $gte guards ensure only one raid commits atomically. Raider
    // update follows sequentially with a cooldown CAS to block duplicate commands.
    const stealFraction = RAID_STEAL_MIN + Math.random() * (RAID_STEAL_MAX - RAID_STEAL_MIN);
    const stolen      = {};
    const defenderInc = {};
    const raiderInc   = {};

    for (const [matId, qty] of Object.entries(defender.mining.oreStash ?? {})) {
        if (qty <= 0) continue;
        const take = Math.max(1, Math.floor(qty * stealFraction));
        stolen[matId] = take;
        defenderInc[`data.oreStash.${matId}`] = -take;
        raiderInc[`data.materials.${matId}`]  = take;
    }

    // Make sure the raider's mining profile exists before the conditional commit below
    await persistGrindIfNew(raider, 'mining');

    // Condition: each stolen material still exists; defender not under active shield.
    const defenderCond = { userId: defender.userId, guildId: interaction.guild.id, system: 'mining' };
    for (const [matId, take] of Object.entries(stolen)) {
        defenderCond[`data.oreStash.${matId}`] = { $gte: take };
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
            content: `**${targetUser.username}**'s ore stash was already raided — nothing left to take.`,
            flags: MessageFlags.Ephemeral
        });
    }

    await GrindProfile.findOneAndUpdate(
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
    ).catch(err => console.error('[mine raid] raider save error:', err));

    const stolenLines = Object.entries(stolen).map(([id, qty]) => `• ${MATERIAL_NAMES[id] ?? id} ×${qty}`).join('\n');
    const pct = Math.round(stealFraction * 100);

    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('⚔️ Mine Raided!')
        .setDescription(
            `You broke into **${targetUser.username}**'s mine and made off with **${pct}%** of their ore stash!\n\n` +
            `**Stolen:**\n${stolenLines}`
        )
        .setFooter({ text: `${targetUser.username} now has a 1-hour raid shield • Use /mine map to see your stash` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // Notify defender if possible
    const dmEmbed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle('⚠️ Your Mine Was Raided!')
        .setDescription(
            `**${interaction.user.username}** broke into your mine on **${interaction.guild.name}** ` +
            `and stole **${pct}%** of your ore stash!\n\n` +
            `**Lost:**\n${stolenLines}\n\n` +
            `Craft a **Mine Lock** (\`/craft make mine_lock_from_obsidian\`) to protect yourself next time.`
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
    const lockToken = _lockAcquire(lockKey, 120_000);
    if (!lockToken) {
        return interaction.reply({
            content: '⛏️ You already have a mining action in progress — finish it first.',
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
    }
    try {
        return await _mineExecute(interaction);
    } finally {
        _lockRelease(lockKey, lockToken);
    }
};
