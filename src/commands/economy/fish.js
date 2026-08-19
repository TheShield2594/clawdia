'use strict';

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle, MessageFlags
} = require('discord.js');
const User  = require('../../models/User');
const { attachGrind, persistGrindIfNew } = require('../../utils/grindProfile');
const { isVersionError } = require('../../utils/versionRetry');
const { detachBalanceDelta, applyBalanceDelta } = require('../../utils/balanceDelta');
const GrindProfile = require('../../models/GrindProfile');
const Guild = require('../../models/Guild');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse }          = require('../../utils/shopBrowse');
const {
    LOCATIONS, LOCATION_LIST, TIER_COLORS, LIMITS, ROD_BY_TIER,
    ROD_UPGRADES, MATERIAL_NAMES, BAIT_PACKS, CONSUMABLES,
    ROD_TIERS, ROD_BY_SLUG,
    FISHER_LEVELS, PRESTIGE_BONUSES,
    FISH_QUEST_TEMPLATES, FISH_CRAFT_RECIPES,
    BOSS_TYPES
} = require('../../data/fishData');
const { MATERIAL_NAMES: HUNT_MATERIAL_NAMES } = require('../../data/huntData');
const { getPityBonus, buildPityStreakField, PITY_COPY } = require('../../utils/pityBonus');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const {
    ensureFishingData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    calculateSuccessChance,
    executeCast,
    resolveBossEncounter,
    rollBossType,
    assignDailyFishQuests,
    updateFishQuestProgress,
    formatMs,
    rodStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel,
    activateConsumable,
    quoteRepair,
    applyRepair,
    applyPayoutModifiers,
    updateRodStatus,
    applyXp
} = require('../../services/fishService');
const { getCurrentWeather } = require('../../services/weatherService');
const { FISH_TRAITS, TIME_OF_DAY_BONUSES, getTimeOfDay } = require('../../data/fishData');
const { ensureHuntData } = require('../../services/huntService');
const { TIER_NUM, TIER_RIBBON } = require('../../data/materialRarity');
const { randomFrom, FISH_MISS_POOL } = require('../../utils/copyLines');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { stackBar } = require('../../utils/rewardReveal');
const { submitCatch: submitTournamentCatch, startTournament, getActiveTournament, buildLeaderboardEmbed, endTournament, buildWinnersEmbed, announceTournamentEnd } = require('../../services/tournamentService');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS, FEATURED_RARE_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { tryUpdateHourlyWinner, getCurrentHourlyLeader } = require('../../utils/hourlyWinner');
const { isDistrictActive } = require('../../services/districtService');
const { ensureQuests, onFish, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { getActiveSynergies } = require('../../services/synergyService');
const { hasActiveEvent, getEventCrossSystemType } = require('../../services/seasonalEventService');
const { refundEffectCharge } = require('../../services/effectsService');

// Rarity score for hourly fish competition (rarest catch wins)
const WILDERNESS_YIELD_BONUS = 0.10;

const FISH_TIER_SCORE = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, event: 6 };

const LOCATION_CHOICES = LOCATION_LIST.map(l => ({ name: l.name, value: l.id }));

const SHOP_CHOICES = [
    ...BAIT_PACKS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost} coins`, value: p.id })),
    ...Object.values(CONSUMABLES).map(c => ({ name: `${c.emoji} ${c.name} — ${c.cost} coins`, value: c.id }))
];

const USE_CHOICES = Object.values(CONSUMABLES)
    .filter(c => c.type !== 'repair')
    .map(c => ({ name: `${c.emoji} ${c.name}`, value: c.id }));

const ROD_CHOICES     = ROD_TIERS.map(r => ({ name: `${r.emoji} ${r.name} (${r.cost.toLocaleString()} coins)`, value: r.slug }));
const UPGRADE_CHOICES = Object.values(ROD_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES  = LOCATION_LIST.filter(l => !l.defaultUnlocked).map(l => ({ name: `${l.emoji} ${l.name}`, value: l.id }));

const RECIPE_CHOICES = Object.values(FISH_CRAFT_RECIPES).map(r => ({ name: r.name, value: r.id }));

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

const MAX_PRESTIGE = PRESTIGE_BONUSES.length - 1;

const PRESTIGE_LABELS = [
    null,
    '🥉 Bronze Angler',
    '🥈 Silver Angler',
    '🥇 Gold Angler',
    '🏆 Champion Angler',
    '💎 Diamond Angler'
];

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fish')
        .setDescription('Fishing: cast lines, manage gear, shop, craft, quests, locations, and prestige.')
        .addSubcommand(sub =>
            sub.setName('cast')
                .setDescription('Cast your line and catch fish. 1 stamina per cast. Cooldown: 45s.')
                .addStringOption(o =>
                    o.setName('location')
                        .setDescription('Location to fish at (defaults to your active location).')
                        .setRequired(false)
                        .addChoices(...LOCATION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's fishing profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Reset your fisher level for permanent prestige bonuses (requires Level 50)'))
        .addSubcommand(sub =>
            sub.setName('records')
                .setDescription('View the server\'s all-time fishing world records'))
        .addSubcommandGroup(group =>
            group.setName('inv')
                .setDescription('View and manage your fishing inventory')
                .addSubcommand(sub =>
                    sub.setName('rods')
                        .setDescription('View your fishing rods'))
                .addSubcommand(sub =>
                    sub.setName('equip')
                        .setDescription('Equip a rod by its inventory number')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Rod number from /fish inv rods')
                                .setMinValue(1)
                                .setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('bait')
                        .setDescription('View your bait and consumable stock'))
                .addSubcommand(sub =>
                    sub.setName('materials')
                        .setDescription('View your crafting materials')))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily fishing quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View your active daily fishing quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Quest number to claim')
                                .setMinValue(1)
                                .setRequired(true))))
        .addSubcommandGroup(group =>
            group.setName('shop')
                .setDescription('Browse and purchase fishing gear, bait, and supplies')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse everything available in the fishing shop'))
                .addSubcommand(sub =>
                    sub.setName('rod')
                        .setDescription('Buy a new fishing rod')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which rod to buy')
                                .setRequired(true)
                                .addChoices(...ROD_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('upgrade')
                        .setDescription('Install an upgrade on your equipped rod (one per rod, permanent)')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which upgrade to install')
                                .setRequired(true)
                                .addChoices(...UPGRADE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('buy')
                        .setDescription('Purchase bait packs or consumables')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Item to buy')
                                .setRequired(true)
                                .addChoices(...SHOP_CHOICES))
                        .addIntegerOption(o =>
                            o.setName('quantity')
                                .setDescription('How many to buy (default 1; bait packs are per-pack)')
                                .setMinValue(1)
                                .setMaxValue(10)
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('use')
                        .setDescription('Activate a consumable (bait / luck / xp scroll / energy drink)')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Which consumable to activate')
                                .setRequired(true)
                                .addChoices(...USE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('repair')
                        .setDescription('Repair your equipped rod at the shop or use a repair kit')
                        .addStringOption(o =>
                            o.setName('method')
                                .setDescription('Repair method')
                                .setRequired(true)
                                .addChoices(
                                    { name: '🔧 Shop Repair — costs coins, slightly degrades max durability', value: 'shop' },
                                    { name: '🪛 Repair Kit — free from inventory, no degradation',           value: 'kit' }
                                ))
                        .addStringOption(o =>
                            o.setName('kit')
                                .setDescription('Kit size to use (kit method only)')
                                .setRequired(false)
                                .addChoices(
                                    { name: 'Small Repair Kit (+20 durability)', value: 'repair_kit_small' },
                                    { name: 'Large Repair Kit (+50 durability)', value: 'repair_kit_large' }
                                ))
                        .addIntegerOption(o =>
                            o.setName('amount')
                                .setDescription('Durability to restore at shop (default: full repair)')
                                .setMinValue(1)
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('unlock')
                        .setDescription('Unlock a new fishing location')
                        .addStringOption(o =>
                            o.setName('location')
                                .setDescription('Location to unlock')
                                .setRequired(true)
                                .addChoices(...UNLOCK_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('craft')
                .setDescription('Craft items from fishing (and hunting) materials')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse all available fishing crafting recipes'))
                .addSubcommand(sub =>
                    sub.setName('make')
                        .setDescription('Craft an item from your materials')
                        .addStringOption(o =>
                            o.setName('recipe')
                                .setDescription('Recipe to craft')
                                .setRequired(true)
                                .addChoices(...RECIPE_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('location')
                .setDescription('View and switch your active fishing location')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View all fishing locations and their requirements'))
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Switch to an unlocked location')
                        .addStringOption(o =>
                            o.setName('location')
                                .setDescription('Location to fish at')
                                .setRequired(true)
                                .addChoices(...LOCATION_LIST.map(l => ({ name: `${l.emoji} ${l.name}`, value: l.id }))))))
        .addSubcommandGroup(group =>
            group.setName('tournament')
                .setDescription('Fishing tournament commands')
                .addSubcommand(sub =>
                    sub.setName('status')
                        .setDescription('View the current tournament leaderboard'))
                .addSubcommand(sub =>
                    sub.setName('start')
                        .setDescription('Start a fishing tournament (admin only)')
                        .addIntegerOption(o =>
                            o.setName('duration')
                                .setDescription('Tournament duration in minutes (default 60)')
                                .setMinValue(15)
                                .setMaxValue(180)
                                .setRequired(false))
                        .addIntegerOption(o =>
                            o.setName('prize_pool')
                                .setDescription('Starting prize pool (coins to seed)')
                                .setMinValue(0)
                                .setRequired(false))
                        .addIntegerOption(o =>
                            o.setName('entry_fee')
                                .setDescription('Entry fee per participant (0 = free)')
                                .setMinValue(0)
                                .setRequired(false)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'cast')     return handleCast(interaction);
            if (sub === 'profile')  return handleProfile(interaction);
            if (sub === 'prestige') return handlePrestige(interaction);
            if (sub === 'records')  return handleRecords(interaction);
            return;
        }

        if (group === 'inv')         return handleInv(interaction, sub);
        if (group === 'quests')      return handleQuests(interaction, sub);
        if (group === 'shop')        return handleShop(interaction, sub);
        if (group === 'craft')       return handleCraft(interaction, sub);
        if (group === 'location')    return handleLocation(interaction, sub);
        if (group === 'tournament')  return handleTournament(interaction, sub);
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
        .setTitle('🌫️ Something stirs beneath the surface...')
        .setDescription('━━━━━━━━━━━━━━━\n*The water shimmers. Something extraordinary is here.*\n━━━━━━━━━━━━━━━');

    if (tierNum === 3) {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
    } else {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
        const midColor = tierNum === 4 ? '#9c27b0' : '#ff9800';
        const midTitle = tierNum === 4 ? '🔮 Something exceptional breaks the surface...' : '⚡ The line pulls taut with impossible force...';
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
                .setDescription('━━━━━━━━━━━━━━━\n*The ocean holds its breath. This catch defies all odds.*\n━━━━━━━━━━━━━━━');
            await interaction.editReply({ embeds: [fanfareEmbed] });
            await wait(1500);
        }
    }
    await interaction.editReply({ embeds: [finalEmbed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAST
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCast(interaction) {
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
    ensureFishingData(user);
    ensureHuntData(user);
    applyStaminaRegen(user);
    applyDailyReset(user);
    assignDailyFishQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[fish] pre-check save error:', e));
    }

    const f = user.fishing;

    // ── Location resolution ────────────────────────────────────────────
    const requestedLoc = interaction.options.getString('location');
    const locationId   = requestedLoc ?? f.activeLocation;
    const location     = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: `Unknown location. Use \`/fish location list\` to see available spots.`, flags: MessageFlags.Ephemeral });
    }
    if (!f.unlockedLocations.includes(locationId)) {
        return interaction.reply({
            content: `You haven't unlocked **${location.name}** yet. Use \`/fish shop unlock\` to unlock it.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need to be Fisher Level **${location.unlockLevel}** to fish at **${location.name}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // ── Injury cooldown ────────────────────────────────────────────────
    if (f.injuryUntil && Date.now() < f.injuryUntil.getTime()) {
        const nextAt = new Date(f.injuryUntil.getTime());
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🤕 Drying Off',
                description: "You're still recovering from your last mishap.\nThe fish will be there when you're back.",
                color: '#1e6fa5',
                nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    // ── Cast cooldown check (read-only; claimed atomically after preflight) ──
    if (f.lastCast && Date.now() - f.lastCast.getTime() < LIMITS.CAST_COOLDOWN_MS) {
        const nextAt = new Date(f.lastCast.getTime() + LIMITS.CAST_COOLDOWN_MS);
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🎣 Line Still Settling',
                description: 'Give your line a moment before the next cast.\nPatience is half of fishing.',
                color: '#1e6fa5',
                nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    // ── Stamina check ──────────────────────────────────────────────────
    if (f.stamina <= 0) {
        const regenMs   = msUntilNextStamina(user);
        const nextAt    = new Date(Date.now() + regenMs);
        // Surfaces the fail-streak pity that actually exists, using the shared
        // curve so this never drifts from what calculateSuccessChance applies.
        // There is no rare-catch pity — sinceRare is a stat, not a guarantee,
        // so it is reported as one.
        const sinceRare  = f.sinceRare ?? 0;
        const pityBonus  = getPityBonus(f.consecutiveFails ?? 0, LIMITS);
        const pityBits   = [];
        if (pityBonus > 0) {
            pityBits.push(`🎯 ${f.consecutiveFails} ${PITY_COPY.fishing.streakNoun} • +${Math.round(pityBonus * 100)}% success on your next cast`);
        }
        if (sinceRare >= 5) pityBits.push(`🐟 ${sinceRare} casts since your last Rare+ catch`);
        const pityStat = pityBits.length ? pityBits.join('\n') : null;
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Too Tired to Cast',
                description: "You've worn yourself out on the water.\nBuy an **Energy Drink** from `/fish shop` to speed up recovery.",
                color: '#1e6fa5',
                nextAt,
                pityStat,
                nextRewardPreview: `Full stamina = ${getMaxStamina(user)} casts · Boss fights can start on any Rare or better catch`,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    // ── Rod check ─────────────────────────────────────────────────────
    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({
            content: `You don't have a rod equipped! Buy one with \`/fish shop rod\` and equip it with \`/fish inv equip 1\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const rod = f.rods[f.equippedRodIndex];

    if (rod.status === 'broken' || rod.currentDurability <= 0) {
        return interaction.reply({
            content: `Your **${rod.name}** is broken! Repair it with \`/fish shop repair\` or buy a new one with \`/fish shop rod\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // ── Bait check (read-only; the stock is spent after the claim below) ──
    const rodData = ROD_BY_TIER[rod.tier];
    if (rodData.requiresBait && (f.bait[rodData.baitType] ?? 0) <= 0) {
        return interaction.reply({
            content: `You're out of **${rodData.baitType.replace(/_/g, ' ')}**! Buy more with \`/fish shop\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Atomically claim the cooldown slot now that all preflight checks have passed —
    // lastCast is set the moment the cast is actually accepted, not earlier, so a
    // failed precheck (stamina/rod/bait) never burns the cooldown. The same guard
    // still prevents two concurrent /fish casts from both slipping through.
    //
    // The claim targets GrindProfile, not User: fishing state lives in its own
    // collection (see src/models/User.js), so a User-level guard would match every
    // document on the missing `fishing` field and never reject anything.
    const fishClaimNow = new Date();
    const fishCooldownFloor = new Date(fishClaimNow.getTime() - LIMITS.CAST_COOLDOWN_MS);
    const priorLastCast = f.lastCast ?? null;
    await persistGrindIfNew(user, 'fishing');
    const fishClaimQuery = { userId: interaction.user.id, guildId: interaction.guild.id, system: 'fishing' };
    const claimedFish = await GrindProfile.findOneAndUpdate(
        {
            ...fishClaimQuery,
            $or: [{ 'data.lastCast': null }, { 'data.lastCast': { $lte: fishCooldownFloor } }],
        },
        { $set: { 'data.lastCast': fishClaimNow } },
        { new: true },
    );

    if (!claimedFish) {
        // Losing the claim means another cast already took the slot, so the
        // in-memory snapshot is stale — read the winning timestamp back so the
        // countdown reflects the cast that actually happened. If that read fails,
        // fall back to now rather than the snapshot: reaching the claim at all
        // means the snapshot was already past the cooldown floor, so it would
        // render a countdown in the past and tell the player they can cast again.
        const current = await GrindProfile.findOne(fishClaimQuery).catch(() => null);
        const lastAt  = current?.data?.lastCast ?? fishClaimNow;
        const nextAt  = new Date(new Date(lastAt).getTime() + LIMITS.CAST_COOLDOWN_MS);
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🎣 Line Still Settling',
                description: 'Give your line a moment before the next cast.\nPatience is half of fishing.',
                color: '#1e6fa5',
                nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }
    f.lastCast = fishClaimNow;

    // The claim is a real write now, so a cast that dies before its result is
    // saved would otherwise cost the player a full cooldown for nothing. Hand the
    // slot back — but only while it is still ours, so a newer claim isn't undone.
    const releaseFishClaim = () => GrindProfile.updateOne(
        { ...fishClaimQuery, 'data.lastCast': fishClaimNow },
        { $set: { 'data.lastCast': priorLastCast } },
    ).catch(() => null);

    // Everything between here and the save can still fail — a Discord API error
    // while collecting the reel-in prompts, a service throwing — and until the
    // result is persisted the player has nothing to show for the cooldown they
    // just paid for. Hand the slot back on the way out unless the cast committed.
    let castCommitted = false;

    // Everything below runs across the bite delay and the reel-in prompt — up to
    // ~8 seconds during which the player can spend coins somewhere else. The
    // cast's own coin movement is collected as a delta against this reading and
    // applied as an atomic `$inc` at the save, so `save()` never writes an
    // absolute balance read before that window. See src/utils/balanceDelta.js.
    const balanceAtLoad = user.balance ?? 0;
    const balanceFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

    try {

        // Bait comes out only once the cooldown slot is ours, so a lost race never
        // costs the player a bait.
        if (rodData.requiresBait) {
            f.bait[rodData.baitType] = (f.bait[rodData.baitType] ?? 0) - 1;
            user.markModified('fishing');
        }

        const featured          = getDailyFeatured(interaction.guild.id);
        const isFeaturedSpot    = locationId === featured.fishSpot.id;
        const timeBand          = getTimeBand();

        await interaction.deferReply();

        // ── Cast & Wait for Bite ──────────────────────────────────────────────────
        // Common/Uncommon: passive (no button). Rare: optional single button (3s) — miss
        // downgrades to Uncommon payout. Epic: required (3s). Legendary: required (2s).
        const delay      = ms => new Promise(r => setTimeout(r, ms));
        const authorOpts = { name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) };
        const featuredNote = isFeaturedSpot ? `\n\n🌟 **Featured Spot!** +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout & +${Math.round(FEATURED_RARE_BONUS * 100)}% rare chance active.` : '';

        const luringEmbed = new EmbedBuilder()
            .setColor(isFeaturedSpot ? '#FFD700' : '#4169E1')
            .setTitle('🎣 Cast!')
            .setDescription(`*Your lure hits the water with a satisfying plop…*\n\n🎣 **Lure in water… watching for a bite…**${featuredNote}`)
            .setAuthor(authorOpts);
        await interaction.editReply({ embeds: [luringEmbed], components: [] });
        const reelMsg = await interaction.fetchReply();
        await delay(2000 + Math.floor(Math.random() * 3001));

        // Fish/Shark pet: +5%/+15% yield (only if hunger >= 30)
        const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, isPetActive, TRAIT_FLAVOR, tryGrantRarePet } = require('../../services/petService');
        const petFishYieldPct = getTotalBonus(user.pets || [], 'fish_yield');

        const marketplaceActive = isDistrictActive(guildSettings, 'marketplace');

        // Snapshot pre-cast reward state so we can reverse it if the fish escapes
        const preCastBalance          = user.balance;
        const preCastTotalEarned      = user.fishing.totalEarned;
        const preCastDailyCoins       = user.fishing.dailyCoins;
        const preCastSuccessful       = user.fishing.successfulCasts;
        const preCastXp               = user.fishing.xp;
        const preCastLevel            = user.fishing.level;
        const preCastLegendaryCatches = user.fishing.legendaryCatches;
        const preCastEventCatches     = user.fishing.eventCatches;
        const preCastBestPayout       = user.fishing.bestPayout;
        const preCastConsecutiveFails = user.fishing.consecutiveFails ?? 0;
        const preCastMaterials        = JSON.parse(JSON.stringify(user.fishing.materials ?? {}));
        const preCastPersonalBest = user.fishing.personalBest
            ? JSON.parse(JSON.stringify(user.fishing.personalBest))
            : null;
        const preCastWeeklyRecord = user.fishing.weeklyRecord
            ? JSON.parse(JSON.stringify(user.fishing.weeklyRecord))
            : null;

        let reelResult = null; // { caught: bool, label: string, icon: string }

        const result = executeCast(user, locationId, { reactionFactor: 1.0, marketplaceActive, username: interaction.user.username });

        // ── Rarity-Gated Reel-In ──────────────────────────────────────────────────
        if (result.success && result.catchType === 'fish' && ['rare', 'epic', 'legendary'].includes(result.tier)) {
            const REEL_TIERS = {
                legendary: { window: 2000, required: true,  color: '#FFD700', emoji: '⚡', label: 'LEGENDARY CATCH — REEL IT IN!',  tagline: 'Once-in-a-lifetime — don\'t let it go!' },
                epic:      { window: 3000, required: true,  color: '#9b59b6', emoji: '🔥', label: 'EPIC CATCH — HOLD THE LINE!',    tagline: 'A rare fighter — keep the tension!' },
                rare:      { window: 3000, required: false, color: '#3498db', emoji: '🎣', label: 'You feel a bite! Reel In?',      tagline: 'Hit the button to land it, or it slips to Uncommon.' },
            };
            const cfg   = REEL_TIERS[result.tier];
            const reelId = `reel_${interaction.id}`;

            const biteEmbed = new EmbedBuilder()
                .setColor(cfg.color)
                .setTitle(`${cfg.emoji} ${cfg.label}`)
                .setDescription(
                    `*A **${result.fish.name}** is on the line!*\n\n` +
                    `${cfg.tagline}\n\n` +
                    (cfg.required
                        ? `⚠️ **Press within ${cfg.window / 1000}s or it escapes!**`
                        : `💡 **Optional** — miss it and you still get an Uncommon catch.`)
                )
                .setAuthor(authorOpts);
            const reelRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(reelId)
                    .setLabel(`🎣 Reel In! (${cfg.window / 1000}s)`)
                    .setStyle(cfg.required ? ButtonStyle.Danger : ButtonStyle.Primary)
            );
            await interaction.editReply({ embeds: [biteEmbed], components: [reelRow] });

            const reelPressed = await new Promise(resolve => {
                const col = reelMsg.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id && i.customId === reelId,
                    time: cfg.window,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(true); });
                col.on('end', (_, reason) => { if (reason !== 'limit') resolve(false); });
            });

            if (!reelPressed) {
                if (cfg.required) {
                    // Reverse all reward mutations — fish escapes, only stamina and rod durability are spent
                    user.balance                   = preCastBalance;
                    user.fishing.totalEarned       = preCastTotalEarned;
                    user.fishing.dailyCoins        = preCastDailyCoins;
                    user.fishing.successfulCasts   = preCastSuccessful;
                    user.fishing.xp                = preCastXp;
                    user.fishing.level             = preCastLevel;
                    user.fishing.legendaryCatches  = preCastLegendaryCatches;
                    user.fishing.eventCatches      = preCastEventCatches;
                    user.fishing.bestPayout        = preCastBestPayout;
                    user.fishing.materials         = preCastMaterials;
                    if (preCastPersonalBest !== null) user.fishing.personalBest = preCastPersonalBest;
                    if (preCastWeeklyRecord !== null) user.fishing.weeklyRecord = preCastWeeklyRecord;
                    // executeCast zeroed the fail streak on the successful roll; the
                    // fish was never landed, so restore it and count this as the miss
                    // it was — otherwise a required reel-in miss hands back pity progress.
                    user.fishing.consecutiveFails = preCastConsecutiveFails + 1;
                    // The doubled-yield charge paid for a payout that is being reversed.
                    if (result.gatherEffectConsumed) refundEffectCharge(user, result.gatherEffectConsumed);
                    user.markModified('fishing');
                    result.success      = false;
                    result.finalPayout  = 0;
                    result.rawPayout    = 0;
                    result.xpEarned     = 0;
                    result.levelUp      = null;
                    result.specialDrop  = null;
                    result.escaped      = true;
                    reelResult = { caught: false, icon: '💨', label: `${result.tier} fish escaped!` };

                    const durLine = result.durabilityLost > 0 ? ` Rod took ${result.durabilityLost} durability damage.` : '';
                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor('#888888')
                            .setTitle('💨 It Got Away!')
                            .setDescription(`*The ${result.fish.name} snapped the line and vanished into the depths.*\n\nStamina spent — nothing to show for it.${durLine}`)
                            .setAuthor(authorOpts)],
                        components: [],
                    });
                    await delay(1200);
                } else {
                    // Rare optional miss — downgrade payout by ~65% to simulate Uncommon yield
                    const reduction = Math.round(result.finalPayout * 0.65);
                    result.finalPayout              -= reduction;
                    result.rawPayout                -= reduction;
                    user.balance                    -= reduction;
                    user.fishing.totalEarned        -= reduction;
                    user.fishing.dailyCoins         -= reduction;
                    result.tier = 'uncommon';
                    reelResult = { caught: true, icon: '😬', label: 'Rare slipped — Uncommon catch instead' };

                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor('#aaaaaa')
                            .setTitle('😬 Slipped Away Partially…')
                            .setDescription(`*The ${result.fish.name} struggled free but you still pulled something in.*\n\nCatch downgraded to Uncommon.`)
                            .setAuthor(authorOpts)],
                        components: [],
                    });
                    await delay(800);
                }
            } else {
                const tierLabel = result.tier.charAt(0).toUpperCase() + result.tier.slice(1);
                reelResult = { caught: true, icon: cfg.required ? '🏆' : '✅', label: `${tierLabel} catch secured!` };
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor(cfg.color)
                        .setTitle(`${reelResult.icon} ${reelResult.label}`)
                        .setDescription('*Reeling it in…*')
                        .setAuthor(authorOpts)],
                    components: [],
                });
                await delay(600);
            }
        }
        // ─────────────────────────────────────────────────────────────────────────

        // Pity counter: reset on rare+ success, increment otherwise
        if (result.success && ['rare', 'epic', 'legendary', 'event'].includes(result.tier)) {
            user.fishing.sinceRare = 0;
        } else {
            user.fishing.sinceRare = (user.fishing.sinceRare ?? 0) + 1;
        }

        if (result.success && result.finalPayout > 0 && petFishYieldPct > 0) {
            const bonus = Math.round(result.finalPayout * petFishYieldPct / 100);
            if (bonus > 0) {
                user.balance              += bonus;
                user.fishing.totalEarned  += bonus;
                user.fishing.dailyCoins   += bonus;
                result.finalPayout        += bonus;
                result.petYieldBonus       = bonus;
            }
        }

        // Featured spot bonus: +25% payout
        if (result.success && result.finalPayout > 0 && isFeaturedSpot) {
            const featBonus = Math.round(result.finalPayout * FEATURED_PAYOUT_BONUS);
            if (featBonus > 0) {
                user.balance                += featBonus;
                user.fishing.totalEarned    += featBonus;
                user.fishing.dailyCoins     += featBonus;
                result.finalPayout          += featBonus;
                result.featuredSpotBonus     = featBonus;
            }
        }
        // Wilderness district: +10% fish yield (clamped to daily hard cap)
        const wildernessActive = isDistrictActive(guildSettings, 'wilderness');
        if (result.success && result.finalPayout > 0 && wildernessActive) {
            const remaining = LIMITS.DAILY_HARD_CAP - user.fishing.dailyCoins;
            const rawBonus  = Math.round(result.finalPayout * WILDERNESS_YIELD_BONUS);
            const bonus     = Math.max(0, Math.min(rawBonus, remaining));
            if (bonus > 0) {
                user.balance               += bonus;
                user.fishing.totalEarned   += bonus;
                user.fishing.dailyCoins    += bonus;
                result.finalPayout         += bonus;
                result.wildernessBonus      = bonus;
            }
        }
        if (result.success && result.finalPayout > user.fishing.bestPayout) user.fishing.bestPayout = result.finalPayout;

        // Winter Hunt cross-system bonus: fishing at Misty Lake drops arctic hunt materials
        let winterHuntMaterial = null;
        if (result.success && getEventCrossSystemType(guildSettings) === 'winter_hunt' && locationId === 'lake') {
            const ARCTIC_MATERIALS = ['arctic_fox_pelt', 'snowy_feather', 'thick_hide', 'polar_claw', 'mammoth_tusk'];
            const roll = Math.random();
            if (roll < 0.40) {
                const matId = ARCTIC_MATERIALS[Math.floor(Math.random() * ARCTIC_MATERIALS.length)];
                user.hunt.materials[matId] = (user.hunt.materials[matId] ?? 0) + 1;
                user.markModified('hunt');
                winterHuntMaterial = matId;
            }
        }

        updateFishQuestProgress(user, result, locationId);
        await ensureQuests(user, guildSettings);
        const { completed: questsDone, nearComplete: questsNear } = await onFish(user, guildSettings);
        if (result.success && result.finalPayout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.finalPayout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        // Rare companions are found, not bought: a legendary result is the only
        // thing that can turn one up. Rolled before the save below persists it.
        const rarePetDrop = result.success ? tryGrantRarePet(user, 'fish', result.tier) : null;
        if (rarePetDrop) user.markModified('pets');

        const fishAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        // Hand the cast's coin movement to an atomic `$inc` and take `balance`
        // out of the save. An escape reverses its own mutations, so that path
        // simply produces a delta of zero and issues no write.
        const balanceDelta = detachBalanceDelta(user, balanceAtLoad);

        try {
            await user.save();
            castCommitted = true;
            // Only after the save has landed: a credit applied before a save that
            // then failed would pay for a cast the player could take again.
            await applyBalanceDelta(User, balanceFilter, user, balanceDelta)
                .catch(err => console.error('[fish] payout $inc failed:', err));
            if (fishAchievements.length) {
                announceAchievements(interaction.client, guildSettings, user, interaction.member, fishAchievements).catch(() => null);
            }
            notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseFishClaim();
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request conflicted. Please try `/fish cast` again.' });
            }
            console.error('[fish] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your catch. Please try again.' });
        }

        // Submit to active tournament if fish catch (not junk/treasure)
        if (result.success && result.catchType === 'fish' && result.fish && result.finalPayout > 0) {
            submitTournamentCatch(interaction.guild.id, {
                userId:    interaction.user.id,
                username:  interaction.user.username,
                fishName:  result.fish.name,
                fishEmoji: result.fish.emoji ?? '🐟',
                tier:      result.tier,
                score:     result.finalPayout
            }).catch(() => null);
        }

        // Track world records (heaviest catch per fish species in the server)
        if (result.success && result.catchType === 'fish' && result.fish && result.weightLbs > 0) {
            checkAndUpdateWorldRecord(interaction.guild.id, {
                fish:     result.fish.name,
                weight:   result.weightLbs,
                userId:   interaction.user.id,
                username: interaction.user.username,
            }).catch(() => null);
        }

        // Await hourly winner update then re-fetch for accurate footer
        if (result.success) {
            const tierScore = FISH_TIER_SCORE[result.tier] ?? 0;
            if (tierScore > 0 && result.fish) {
                await tryUpdateHourlyWinner({ guildId: interaction.guild.id, category: 'fish', userId: interaction.user.id, username: interaction.user.username, value: tierScore, details: `${result.fish.emoji ?? ''} ${result.fish.name} (${result.tier})`.trim() }).catch(() => null);
            }
        }
        const hourlyLeader = await getCurrentHourlyLeader(interaction.guild.id, 'fish').catch(() => null);

        // Fish escaped — already showed escape embed; just save stamina/cooldown and return
        if (result.escaped) {
            await user.save().catch(err => console.error('[fish] escape save error:', err));
            return;
        }

        const embed = buildCastEmbed(result, user, location, rod, currency, interaction.user);

        if (result.petYieldBonus > 0) {
            embed.addFields({ name: '🐠 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petFishYieldPct}% yield)`, inline: true });
        }
        if (result.featuredSpotBonus > 0) {
            embed.addFields({ name: '🌟 Featured Spot Bonus', value: `+${result.featuredSpotBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`, inline: true });
        }
        if (result.wildernessBonus > 0) {
            embed.addFields({ name: '🌲 Wilderness District', value: `+${result.wildernessBonus.toLocaleString()} coins (+10% yield)`, inline: true });
        }
        if (winterHuntMaterial) {
            const matName = HUNT_MATERIAL_NAMES[winterHuntMaterial] ?? winterHuntMaterial;
            embed.addFields({ name: '❄️ Winter Hunt Event', value: `+1 ${matName} (hunt material found in icy waters!)`, inline: true });
        }

        // Hourly leader footer
        let leaderNote;
        if (hourlyLeader) {
            leaderNote = `🏆 Rarest this hour: ${hourlyLeader.username} — ${hourlyLeader.details ?? 'N/A'}`;
        } else {
            leaderNote = '🏆 No hourly leader yet — be the first!';
        }
        const existingFooter = embed.data.footer?.text ?? '';
        embed.setFooter({ text: existingFooter ? `${existingFooter} · ${timeBand.emoji} ${timeBand.label} · ${leaderNote}` : `${timeBand.emoji} ${timeBand.label} · ${leaderNote}` });

        // Annotate embed with rarity reel-in result
        if (reelResult) {
            const desc = embed.data.description ?? '';
            embed.setDescription(desc + `\n> ${reelResult.icon} *${reelResult.label}*`);
        }

        // Boss encounter — multi-phase fight
        if (result.bossEncounter) {
            const bossType     = rollBossType();
            const choicesMade  = [];
            const phaseCount   = bossType.phases.length;

            const buildBossPhaseEmbed = (phaseIndex, prevResults) => {
                const phase      = bossType.phases[phaseIndex];
                const integrity  = 3 - prevResults.filter(p => !p.correct && p.chosen !== 'safe').length;
                const intBar     = '❤️'.repeat(integrity) + '🖤'.repeat(3 - integrity);
                const histLines  = prevResults.map((p, i) => {
                    const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
                    return `Phase ${i + 1}: ${icon}`;
                }).join('  ');

                return new EmbedBuilder()
                    .setColor('#1C0A00')
                    .setTitle(`${bossType.emoji} ${bossType.name} — Phase ${phaseIndex + 1}/${phaseCount}`)
                    .setDescription(
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `  ${result.bossEncounter.fish.emoji}  **${result.bossEncounter.fish.name}**\n` +
                        `  Line Integrity: ${intBar}\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `${phase.hint}\n\n` +
                        (histLines ? `${histLines}\n\n` : '') +
                        `**Choose your response — NOW:**`
                    )
                    .setFooter({ text: `⏱️ 30 seconds per phase • Outcomes: 3/3=Full legendary payout | 2/3=Rare | 1/3=Common | 0/3=Nothing` });
            };

            const buildPhaseRow = (phaseIndex) => {
                const phase   = bossType.phases[phaseIndex];
                const choices = phase.choices;
                return new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('boss_match').setLabel(choices.match.label).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('boss_hold').setLabel(choices.hold.label).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('boss_safe').setLabel(choices.safe.label).setStyle(ButtonStyle.Secondary)
                );
            };

            const validIds = ['boss_match', 'boss_hold', 'boss_safe'];
            const idToKey  = { boss_match: 'match', boss_hold: 'hold', boss_safe: 'safe' };

            // Phase 1
            await interaction.editReply({ embeds: [embed, buildBossPhaseEmbed(0, [])], components: [buildPhaseRow(0)] });

            const runPhase = async (phaseIndex, prevResults, prevBtn) => {
                const responder  = prevBtn ?? interaction;
                const fetchReply = prevBtn ? await prevBtn.fetchReply() : await interaction.fetchReply();

                return new Promise(resolve => {
                    const collector = fetchReply.createMessageComponentCollector({
                        filter: i => i.user.id === interaction.user.id && validIds.includes(i.customId),
                        time: 30_000, max: 1
                    });
                    collector.on('collect', async btn => {
                        const chosen    = idToKey[btn.customId];
                        const phase     = bossType.phases[phaseIndex];
                        const correct   = chosen === phase.correct;
                        const results   = [...prevResults, { correct, chosen, correctChoice: phase.correct }];
                        choicesMade.push(chosen);

                        if (phaseIndex < phaseCount - 1) {
                            // More phases ahead
                            await btn.update({ embeds: [embed, buildBossPhaseEmbed(phaseIndex + 1, results)], components: [buildPhaseRow(phaseIndex + 1)] });
                            resolve({ btn, results });
                        } else {
                            resolve({ btn, results, done: true });
                        }
                    });
                    collector.on('end', (collected, reason) => {
                        if (reason === 'time' && collected.size === 0) {
                            // Timeout — treat as safe choice for remaining phases
                            resolve({ btn: null, results: prevResults, timedOut: true });
                        }
                    });
                });
            };

            // Run all 3 phases sequentially
            let state = { btn: null, results: [], done: false, timedOut: false };
            for (let i = 0; i < phaseCount; i++) {
                state = await runPhase(i, state.results, state.btn);
                if (state.timedOut) {
                    const timeoutEmbed = new EmbedBuilder()
                        .setColor('#1C0A00')
                        .setTitle(`${bossType.emoji} ${bossType.name} Slipped Away`)
                        .setDescription(`⏱️ *You hesitated too long — the ${bossType.name} broke free before you could respond.*\n\nThe base catch above still counts; no bonus boss payout was earned.`);
                    interaction.editReply({ embeds: [embed, timeoutEmbed], components: [] }).catch(() => {});
                    return;
                }
            }

            // Resolve outcome
            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            await attachGrind(freshUser);
            ensureFishingData(freshUser);
            const bossResult = resolveBossEncounter(freshUser, result.bossEncounter.fish, result.bossEncounter.tier, choicesMade, bossType);

            let bossQuestsDone = [], bossQuestsNear = [];
            if (bossResult.bonusPayout > 0) {
                const bossLocation = LOCATIONS[freshUser.fishing.activeLocation] ?? location;
                const { adjustedPayout } = applyPayoutModifiers(freshUser, bossResult.bonusPayout, bossLocation);
                bossResult.bonusPayout = adjustedPayout;
                freshUser.balance                 += adjustedPayout;
                freshUser.fishing.totalEarned     += adjustedPayout;
                freshUser.fishing.dailyCoins      += adjustedPayout;
                if (adjustedPayout > freshUser.fishing.bestPayout) freshUser.fishing.bestPayout = adjustedPayout;

                await ensureQuests(freshUser, guildSettings);
                const earn = await onEconomyEarn(freshUser, guildSettings, adjustedPayout);
                bossQuestsDone = earn.completed;
                bossQuestsNear = earn.nearComplete;
            }
            freshUser.markModified('fishing');
            try {
                await freshUser.save();
                if (bossQuestsDone.length || bossQuestsNear.length) {
                    notifyQuestComplete(guildSettings, interaction.member, bossQuestsDone, interaction.channel, freshUser).catch(() => null);
                    notifyQuestNearComplete(guildSettings, interaction.member, bossQuestsNear, interaction.channel).catch(() => null);
                }
            } catch (saveErr) {
                console.error('[fish boss] save error:', saveErr);
                return state.btn.update({ content: 'Something went wrong saving your boss result. Please try again.', embeds: [], components: [] });
            }

            if (bossResult.bonusPayout > 0) {
                const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
                if (bossResult.bonusPayout >= bigWinThreshold) {
                    logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: bossResult.bonusPayout, source: 'fish', details: { itemName: result.bossEncounter.fish.name, rarity: 'boss' }, client: interaction.client });
                }
                // Submit boss win to active tournament with multiplier bonus
                const tournamentScore = Math.round(bossResult.bonusPayout * (bossResult.tournamentMultiplier ?? 1));
                submitTournamentCatch(interaction.guild.id, {
                    userId:    interaction.user.id,
                    username:  interaction.user.username,
                    fishName:  result.bossEncounter.fish.name,
                    fishEmoji: result.bossEncounter.fish.emoji ?? '🐉',
                    tier:      result.bossEncounter.tier,
                    score:     tournamentScore,
                    isBossKill: ['perfect', 'win'].includes(bossResult.outcome)
                }).catch(() => null);
            }

            const phaseScoreLine = bossResult.phaseResults.map((p, i) => {
                const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
                return `Phase ${i + 1}: ${icon}`;
            }).join('  ');

            const outcomeColors = { perfect: '#FFD700', win: '#2ecc71', survived: '#3498db', escaped: '#1C0A00' };
            const outcomeTitles = {
                perfect:  `🏆 ${result.bossEncounter.fish.emoji} PERFECT — ${bossType.name} Mastered!`,
                win:      `✅ ${result.bossEncounter.fish.emoji} ${bossType.name} Subdued`,
                survived: `😓 ${result.bossEncounter.fish.emoji} Barely Survived`,
                escaped:  `💀 ${result.bossEncounter.fish.emoji} ${bossType.name} Escaped!`
            };

            const bossResultEmbed = new EmbedBuilder()
                .setColor(outcomeColors[bossResult.outcome] ?? '#95a5a6')
                .setTitle(outcomeTitles[bossResult.outcome] ?? '❓ Boss Result')
                .setDescription(`${phaseScoreLine}\n\n${bossResult.message}`)
                .addFields(
                    { name: 'Score',        value: `${bossResult.correctCount}/3 correct`, inline: true },
                    { name: 'Bonus Payout', value: bossResult.bonusPayout > 0 ? `${currency}${bossResult.bonusPayout.toLocaleString()}` : 'None', inline: true },
                    { name: 'Rod Damage',   value: `-${bossResult.durabilityLost} durability`, inline: true }
                )
                .setTimestamp();

            await state.btn.update({ embeds: [embed, bossResultEmbed], components: [] });
            return;
        }

        // Non-boss path: log big win after all payouts finalized
        if (result.success) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || result.tier === 'legendary') {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'fish', details: { itemName: result.fish?.name, rarity: result.tier }, client: interaction.client });
            }
        }

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
        if (result.success && result.catchType !== 'junk') {
            const activePet = (user.pets || []).find(p => isPetActive(p));
            if (activePet) {
                const petDef = PET_DEFS[activePet.petId];
                const petName = activePet.name || petDef?.name || activePet.petId;
                const flavorFn = TRAIT_FLAVOR[activePet.personality]?.fish;
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
                .setTitle(isLeg ? '✨ Legendary Catch! ✨' : '🔮 Epic Catch!')
                .setDescription(
                    `<@${interaction.user.id}> just pulled ${result.fish.emoji} **${result.fish.name}** [${isLeg ? '⭐⭐⭐⭐⭐' : '⭐⭐⭐⭐'}]\n` +
                    `while fishing in the **${location.name}**.\n\n` +
                    (isLeg ? `That's incredibly rare.` : `A remarkable catch.`)
                )
                .setTimestamp();
            announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
        }
    } catch (err) {
        if (!castCommitted) await releaseFishClaim();
        throw err;
    }
}

// ─── EMBED BUILDER ────────────────────────────────────────────────────────────

function buildCastEmbed(result, user, location, rod, currency, discordUser) {
    const f = user.fishing;

    if (result.success) {
        const { catchType, finalPayout, xpEarned, levelUp, cappedByHard } = result;

        if (catchType === 'junk') {
            const junk = result.junkItem;
            const embed = new EmbedBuilder()
                .setColor(TIER_COLORS.junk)
                .setTitle(`${junk.emoji} ${junk.name}`)
                .setDescription(
                    finalPayout > 0
                        ? `You reeled in **junk** — a ${junk.name}. Sold for **${currency}${finalPayout}**.`
                        : `You reeled in **junk** — a ${junk.name}. Worth nothing.`
                )
                .addFields(
                    { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
                    { name: 'Reward',   value: finalPayout > 0 ? `${currency}${finalPayout}` : 'Nothing', inline: true },
                    { name: 'XP',       value: `+${xpEarned} XP`, inline: true },
                    { name: 'Rod',      value: buildRodLine(rod), inline: true },
                    { name: 'Stamina',  value: buildStaminaLine(user), inline: true }
                )
                .setFooter({ text: buildFooter(user) })
                .setTimestamp();
            if (levelUp) embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp) });
            return embed;
        }

        if (catchType === 'treasure') {
            const treasure = result.treasureItem;
            const embed = new EmbedBuilder()
                .setColor(TIER_COLORS.treasure)
                .setTitle(`${treasure.emoji} ${treasure.name} — Treasure!`)
                .setDescription(`You pulled up **${treasure.name}** from the depths! Sold for **${currency}${finalPayout.toLocaleString()}**.`)
                .addFields(
                    { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
                    { name: 'Reward',   value: `**${currency}${finalPayout.toLocaleString()}**`, inline: true },
                    { name: 'XP',       value: `+${xpEarned} XP`, inline: true },
                    { name: 'Rod',      value: buildRodLine(rod), inline: true },
                    { name: 'Stamina',  value: buildStaminaLine(user), inline: true }
                )
                .setFooter({ text: buildFooter(user) })
                .setTimestamp();
            if (levelUp)       embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp), inline: false });
            if (cappedByHard)  embed.addFields({ name: '⚠️ Daily Cap', value: 'Daily coin limit reached. Rewards reduced.', inline: false });
            return embed;
        }

        // Fish catch
        const { fish, tier, isCrit, critMultiplier, sizeLabel, specialDrop } = result;
        const color      = isCrit ? '#FFD700' : TIER_COLORS[tier];
        const tierLabel  = tier.charAt(0).toUpperCase() + tier.slice(1);
        const weightStr  = result.weightLbs > 0 ? ` (${result.weightLbs} lbs)` : '';
        const sizeStr    = sizeLabel ? ` [${sizeLabel}${weightStr}]` : '';
        const payDisplay = cappedByHard
            ? `~~${currency}${finalPayout}~~ (daily cap)`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const isLegendary = tier === 'legendary';
        const isEvent     = tier === 'event';
        const isEpic      = tier === 'epic';
        const ribbon = TIER_RIBBON(TIER_NUM[tier] ?? 1);

        // Weather banner — surfaced only when active weather gives a bonus at this location
        const weather      = getCurrentWeather();
        const weatherNote  = buildWeatherNote(weather, location.id);
        const weatherBanner = weatherNote ? `> ${weatherNote}\n\n` : '';

        // Tier-specific title decoration — each rarity bracket has a distinct visual signature
        const embedTitle = isLegendary
            ? `🌊✨ LEGENDARY CATCH ✨🌊`
            : isCrit
            ? `${fish.emoji} ✨ CRITICAL! ${fish.name}${sizeStr} ✨`
            : isEvent
            ? `🌟 ${fish.emoji} ${fish.name}${sizeStr} 🌟`
            : isEpic
            ? `⚡ ${fish.emoji} ${fish.name}${sizeStr} ⚡`
            : `${fish.emoji} ${fish.name}${sizeStr}`;

        // Tier-specific description — escalates in drama with rarity
        const embedDesc = isLegendary
            ? `${weatherBanner}${ribbon}\n\nYou pulled something impossible from the deep.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${fish.emoji}  **${fish.name}**${sizeStr}  [⭐⭐⭐⭐⭐]\n  *${fish.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : isEvent
            ? `${weatherBanner}${ribbon}\n\nSomething that shouldn't exist rises from below.\n\n*${fish.flavor}*`
            : isEpic
            ? `${weatherBanner}${ribbon}\n\nAn exceptional catch that tests every fibre of your rod.\n\n*${fish.flavor}*`
            : `${weatherBanner}${ribbon}\n\n*${fish.flavor}*`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(embedTitle)
            .setDescription(embedDesc)
            .addFields(
                { name: 'Location', value: `${location.emoji} ${location.name}`,    inline: true },
                { name: 'Tier',     value: tierLabel,                                inline: true },
                { name: 'Reward',   value: payDisplay,                               inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit)' : ''}`, inline: true },
                { name: 'Rod',      value: buildRodLine(rod),                        inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                   inline: true }
            );

        const fishMultEntries = [];
        if ((result.streakMult ?? 1) > 1.0) fishMultEntries.push({ emoji: '🔥', label: `${(result.streakMult).toFixed(2)}x` });
        if (isCrit)                          fishMultEntries.push({ emoji: '⚡', label: `${critMultiplier.toFixed(2)}x crit` });
        if (fishMultEntries.length > 0) {
            const fishCombined  = (result.streakMult ?? 1) * critMultiplier;
            const preBonusPayout = finalPayout - (result.petYieldBonus ?? 0) - (result.featuredSpotBonus ?? 0) - (result.wildernessBonus ?? 0);
            embed.addFields({ name: '📈 Multipliers', value: stackBar(fishMultEntries, fishCombined, Math.max(0, preBonusPayout), currency), inline: false });
        }

        // Fish traits display
        if (result.traitEffects?.length) {
            const traitLines = result.traitEffects.map(t => {
                const def = FISH_TRAITS[t];
                return def ? `• **${t}** — ${def.description}` : `• ${t}`;
            });
            embed.addFields({ name: '🧬 Traits', value: traitLines.join('\n'), inline: false });
        }
        if (result.venomousDrain) embed.addFields({ name: '☠️ Venomous!', value: 'The fish stung you — extra stamina drained!', inline: true });

        // Personal best
        if (result.isPersonalBest && result.weightLbs > 0) {
            embed.addFields({ name: '🏆 New Personal Best!', value: `${fish.name} — ${result.weightLbs} lbs!`, inline: false });
        }

        if (specialDrop) embed.addFields({ name: '🎁 Material Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        if (levelUp) embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp), inline: false });
        if (result.expiredBait) embed.addFields({ name: '🐟 Bait Expired', value: `Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`, inline: false });

        if (rod.status === 'broken') {
            embed.addFields({ name: '❌ Rod Broke!', value: `Your **${rod.name}** has broken! Use \`/fish shop repair\` before casting again.`, inline: false });
        } else if (rod.currentDurability <= Math.floor(rod.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your rod is nearly worn out (${rod.currentDurability}/${rod.maxDurability}). Repair soon!`, inline: false });
        }

        embed.addFields(
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Fisher XP', value: buildXpLine(user), inline: true }
        );
        embed.setFooter({ text: buildFooter(user) });
        embed.setTimestamp();
        return embed;
    }

    // ── Trait escape ──────────────────────────────────────────────────────
    if (result.traitEscape) {
        const { fish } = result.traitEscape;
        const escEmbed = new EmbedBuilder()
            .setColor('#e67e22')
            .setTitle(`😤 ${fish.emoji} ${fish.name} Escaped!`)
            .setDescription(`*${result.failure?.message ?? 'The fish slipped free.'}*`)
            .addFields(
                { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
                { name: 'Trait',    value: `🧬 ${result.traitEscape.trait}`,      inline: true },
                { name: 'Rod',      value: buildRodLine(rod),                     inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                inline: true }
            )
            .setFooter({ text: buildFooter(user) })
            .setTimestamp();
        return escEmbed;
    }

    // ── Failure embed ──────────────────────────────────────────────────────
    const { failure, xpEarned, levelUp } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(`*${failure.message}*`)
        .addFields(
            { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
            { name: 'Reward',   value: 'Nothing',                             inline: true },
            { name: 'XP',       value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Rod',      value: buildRodLine(rod),                     inline: true },
            {
                name: 'Stamina',
                value: result.staminaSpared
                    ? `${buildStaminaLine(user)}\n*Slack line — no stamina spent*`
                    : buildStaminaLine(user),
                inline: true
            }
        );

    if ((user.fishing.consecutiveFails ?? 0) > 0) {
        embed.addFields(buildPityStreakField(user.fishing.consecutiveFails, LIMITS, PITY_COPY.fishing));
    }

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Soaked!', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }
    if (levelUp) embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp), inline: false });
    if (rod.status === 'broken') {
        embed.addFields({ name: '❌ Rod Broke!', value: `Your **${rod.name}** has broken! Use \`/fish shop repair\` before casting again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /fish shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildFailureTitle(severityId) {
    return {
        line_slack: '💨 Nothing Biting...',
        spooked:    '😰 Spooked!',
        line_snap:  '💥 Line Snapped!',
        fell_in:    '💦 Fell In!'
    }[severityId] ?? '❌ Failed Cast';
}

function buildRodLine(rod) {
    return `${rod.name} ${rodStatusEmoji(rod.status)}\n${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`;
}

function buildStaminaLine(user) {
    const max = getMaxStamina(user);
    return `${user.fishing.stamina}/${max} ⚡`;
}

function buildXpLine(user) {
    const f      = user.fishing;
    const toNext = xpToNextLevel(f.level, f.xp);
    if (toNext === null) return `${f.xp.toLocaleString()} XP (MAX)`;
    return `${f.xp.toLocaleString()} XP (${toNext} to Lv.${f.level + 1})`;
}

function buildLevelUpLine(levelUp) {
    const ld = getLevelData(levelUp.newLevel);
    return `Fisher Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`;
}

function buildFooter(user) {
    const f = user.fishing;
    const parts = [`Cooldown: 45s`];
    if (f.activeBait)  parts.push(`Bait (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)  parts.push(`Luck (queued)`);
    if (f.activeXpScroll) parts.push(`XP Scroll (queued)`);

    const weather = getCurrentWeather();
    const tod     = getTimeOfDay();
    const todData = TIME_OF_DAY_BONUSES[tod];
    parts.push(`${weather.emoji} ${weather.name}`);
    if (todData) parts.push(todData.description);

    return parts.join(' • ');
}

// Returns a one-line weather effect note when the weather grants a bonus at the given location.
// Returns null when the current weather has no effect at this location.
function buildWeatherNote(weather, locationId) {
    const bonus = weather.locationBonus?.[locationId];
    if (!bonus) return null;
    if (bonus.rareChance)      return `${weather.emoji} **${weather.name}** — fish are biting harder *(+rare chance)*`;
    if (bonus.legendaryChance) return `${weather.emoji} **${weather.name}** — something stirs beneath the surface *(+legendary chance)*`;
    if (bonus.epicChance)      return `${weather.emoji} **${weather.name}** — ocean predators are active in this weather *(+epic chance)*`;
    if (bonus.mythicalChance)  return `${weather.emoji} **${weather.name}** — ancient creatures are drawn upward by the light *(+event chance)*`;
    if (bonus.junkMod)         return `${weather.emoji} **${weather.name}** — fish have retreated from the heat *(junk chance up)*`;
    return `${weather.emoji} **${weather.name}**`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

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
                ? "You haven't started fishing yet! Buy a rod with `/fish shop rod` and use `/fish cast` to begin."
                : `${target.username} hasn't started fishing yet.`,
            flags: MessageFlags.Ephemeral
        });
    }

    ensureFishingData(userData);
    if (isSelf) applyStaminaRegen(userData);

    const f         = userData.fishing;
    const levelData = getLevelData(f.level);
    const toNext    = xpToNextLevel(f.level, f.xp);
    const maxStam   = getMaxStamina(userData);
    const regenMs   = msUntilNextStamina(userData);
    const location  = LOCATIONS[f.activeLocation];
    const prestige  = f.prestige ?? 0;
    const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    const successRate = f.totalCasts > 0
        ? `${Math.round((f.successfulCasts / f.totalCasts) * 100)}%`
        : 'N/A';

    const xpBar   = buildXpBar(f, toNext);
    const stamBar = '⚡'.repeat(f.stamina) + '▪️'.repeat(Math.max(0, maxStam - f.stamina));

    const buffs = [];
    if (f.activeBait)    buffs.push(`Bait (${f.activeBaitCastsLeft} casts)`);
    if (f.activeLuck)    buffs.push('Luck (queued)');
    if (f.activeXpScroll) buffs.push('XP Scroll (queued)');

    const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#3498db')
        .setTitle(`${badge} ${target.username}'s Fishing Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '🏆 Rank',
                value: `**${levelData.title}** (Level ${f.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                inline: true
            },
            {
                name: '⭐ Fisher XP',
                value: toNext !== null
                    ? `${f.xp.toLocaleString()} / ${FISHER_LEVELS[f.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpBar}\n${toNext.toLocaleString()} to Level ${f.level + 1}`
                    : `${f.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true
            },
            {
                name: '📍 Active Location',
                value: location ? `${location.emoji} ${location.name}` : 'Unknown',
                inline: true
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${f.stamina}/${maxStam}${f.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
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
                name: '📊 Fishing Stats',
                value: [
                    `Total Casts:       **${f.totalCasts.toLocaleString()}**`,
                    `Success Rate:      **${successRate}**`,
                    `Total Earned:      **${currency}${f.totalEarned.toLocaleString()}**`,
                    `Best Payout:       **${currency}${f.bestPayout.toLocaleString()}**`,
                    `Legendary Catches: **${f.legendaryCatches}**`,
                    `Event Catches:     **${f.eventCatches}**`
                ].join('\n'),
                inline: false
            }
        );

    if (prestige > 0) {
        embed.addFields({
            name: `${badge} Prestige Bonuses`,
            value: [
                pBonus.critBonus    > 0 ? `+${Math.round(pBonus.critBonus    * 100)}% crit chance`  : null,
                pBonus.staminaBonus > 0 ? `+${pBonus.staminaBonus} max stamina`                      : null,
                pBonus.payoutBonus  > 0 ? `+${Math.round(pBonus.payoutBonus  * 100)}% all payouts`   : null,
                pBonus.rarityBonus  > 0 ? `+${Math.round(pBonus.rarityBonus  * 100)}% rarity boost`  : null
            ].filter(Boolean).join('\n') || 'None yet',
            inline: true
        });
    }

    const locationList = f.unlockedLocations.map(id => {
        const loc = LOCATIONS[id];
        return loc ? `${loc.emoji} ${loc.name}` : id;
    }).join('\n');
    embed.addFields({ name: '🗺️ Unlocked Locations', value: locationList || 'Quiet Pond only', inline: true });

    if (f.trophies?.length) {
        embed.addFields({ name: '🏆 Trophies', value: f.trophies.join(', '), inline: true });
    }

    // Cross-system synergies
    const activeSynergies = getActiveSynergies(userData);
    if (activeSynergies.length > 0) {
        embed.addFields({
            name: '🔗 Active Synergies',
            value: activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n'),
            inline: false
        });
    } else if (f.level >= 25) {
        embed.addFields({
            name: '🔗 Synergies',
            value: 'Reach combined level milestones across Hunt, Fish & Mine to unlock cross-system bonuses! Use `/synergies` to see details.',
            inline: false
        });
    }

    if (prestige === 0 && f.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /fish prestige to reset and unlock new bonuses.' });
    } else if (isSelf) {
        embed.setFooter({ text: `Daily: ${f.dailyCasts} casts · ${currency}${f.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

function buildXpBar(f, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const nextLevelXp = FISHER_LEVELS[f.level]?.xpRequired ?? 1;
    const progress    = nextLevelXp > 0 ? Math.min(1, f.xp / nextLevelXp) : 0;
    const filled      = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct         = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESTIGE
// ═══════════════════════════════════════════════════════════════════════════════

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
    ensureFishingData(user);
    const f = user.fishing;

    if (f.level < 50) {
        return interaction.reply({
            content: `You need Fisher Level **50** to prestige. You are currently Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const currentPrestige = f.prestige ?? 0;
    if (currentPrestige >= MAX_PRESTIGE) {
        return interaction.reply({
            content: `You have already reached the maximum prestige (**P${MAX_PRESTIGE} — Diamond Angler**). You are a true legend of the sea! 💎`,
            flags: MessageFlags.Ephemeral
        });
    }

    const nextPrestige   = currentPrestige + 1;
    const currentBonuses = PRESTIGE_BONUSES[currentPrestige];
    const nextBonuses    = PRESTIGE_BONUSES[nextPrestige];

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle('⚠️ Fishing Prestige Confirmation')
        .setDescription(
            `You are about to prestige from **P${currentPrestige}** → **P${nextPrestige}** (${PRESTIGE_LABELS[nextPrestige]}).\n\n` +
            `**Your fisher level and XP will reset to 1.**\n` +
            `Rods, bait, materials, balance, location unlocks, and trophies are all kept.`
        )
        .addFields(
            { name: `Current Bonuses (P${currentPrestige})`, value: formatPrestigeBonuses(currentBonuses), inline: true },
            { name: `New Bonuses (P${nextPrestige})`,        value: formatPrestigeBonuses(nextBonuses),    inline: true }
        )
        .setFooter({ text: 'This action cannot be undone! You have 30 seconds to confirm.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('fishprestige_confirm')
            .setLabel('Prestige Now!')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('fishprestige_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });

    const collector = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id &&
                     ['fishprestige_confirm', 'fishprestige_cancel'].includes(i.customId),
        time:   30_000,
        max:    1
    });

    collector.on('collect', async i => {
        if (i.customId === 'fishprestige_cancel') {
            await i.update({ content: 'Prestige cancelled.', embeds: [], components: [] });
            return;
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);
        const ff = freshUser.fishing;

        if (ff.level < 50 || (ff.prestige ?? 0) >= MAX_PRESTIGE) {
            await i.update({
                content: 'Prestige conditions are no longer met (level changed, or already prestiged).',
                embeds: [], components: []
            });
            return;
        }

        ff.prestige = (ff.prestige ?? 0) + 1;
        ff.level    = 1;
        ff.xp       = 0;

        if (!Array.isArray(ff.trophies)) ff.trophies = [];
        const trophy = PRESTIGE_LABELS[ff.prestige];
        if (trophy && !ff.trophies.includes(trophy)) {
            ff.trophies.push(trophy);
        }

        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishprestige] save error:', err);
            await i.update({ content: 'Something went wrong saving your prestige. Please try again.', embeds: [], components: [] });
            return;
        }

        // Check grand prestige after successful fish prestige
        checkGrandPrestige(i.client, freshUser, interaction.guild, interaction.guildId).catch(() => null);

        const resultEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle(`✨ Fishing Prestige ${ff.prestige} Achieved!`)
            .setDescription(
                `You are now **${PRESTIGE_LABELS[ff.prestige]}**!\n\n` +
                `Your fisher level has been reset to **1**. Prove yourself again from the water's edge.`
            )
            .addFields(
                { name: 'Prestige Bonuses', value: formatPrestigeBonuses(PRESTIGE_BONUSES[ff.prestige]), inline: false },
                { name: '🏆 Trophy Earned', value: trophy,                                                inline: true  },
                { name: '⚡ Max Stamina',   value: `${getMaxStamina(freshUser)}`,                         inline: true  }
            )
            .setFooter({ text: 'Use /fish profile to see your updated stats' })
            .setTimestamp();

        await i.update({ embeds: [resultEmbed], components: [] });
    });

    collector.on('end', collected => {
        if (collected.size === 0) {
            interaction.editReply({ content: 'Prestige timed out. No changes were made.', embeds: [], components: [] })
                .catch(() => {});
        }
    });
}

function formatPrestigeBonuses(bonus) {
    const lines = [];
    if (bonus.critBonus    > 0) lines.push(`+${Math.round(bonus.critBonus    * 100)}% crit chance`);
    if (bonus.staminaBonus > 0) lines.push(`+${bonus.staminaBonus} max stamina`);
    if (bonus.payoutBonus  > 0) lines.push(`+${Math.round(bonus.payoutBonus  * 100)}% all payouts`);
    if (bonus.rarityBonus  > 0) lines.push(`+${Math.round(bonus.rarityBonus  * 100)}% rarity boost`);
    return lines.length ? lines.join('\n') : 'None';
}

// ═══════════════════════════════════════════════════════════════════════════════
// INV
// ═══════════════════════════════════════════════════════════════════════════════

async function handleInv(interaction, sub) {
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
    ensureFishingData(user);
    applyStaminaRegen(user);

    switch (sub) {
        case 'rods':      return showRods(interaction, user);
        case 'equip':     return equipRod(interaction, user);
        case 'bait':      return showBait(interaction, user, currency);
        case 'materials': return showMaterials(interaction, user);
    }
}

async function showRods(interaction, user) {
    const f = user.fishing;

    if (!f.rods.length) {
        return interaction.reply({ content: `You don't own any rods yet. Buy one with \`/fish shop rod\`.`, flags: MessageFlags.Ephemeral });
    }

    const lines = f.rods.map((rod, i) => {
        const equipped   = i === f.equippedRodIndex ? ' **[EQUIPPED]**' : '';
        const statusEmoji = rodStatusEmoji(rod.status);
        const bar         = durabilityBar(rod.currentDurability, rod.maxDurability, 8);
        const upgradeStr  = rod.upgrade ? ` | ${ROD_UPGRADES[rod.upgrade]?.emoji ?? ''} ${rod.upgrade.replace(/_/g, ' ')}` : '';
        return `**${i + 1}.** ${rod.name}${equipped}\n   ${statusEmoji} ${bar} ${rod.currentDurability}/${rod.maxDurability}${upgradeStr}`;
    });

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`🎣 ${interaction.user.username}'s Rods`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Use /fish inv equip <number> to equip a rod • /fish shop repair to repair' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function equipRod(interaction, user) {
    const f      = user.fishing;
    const number = interaction.options.getInteger('number');
    const index  = number - 1;

    if (index < 0 || index >= f.rods.length) {
        return interaction.reply({ content: `Invalid rod number. You have **${f.rods.length}** rod(s).`, flags: MessageFlags.Ephemeral });
    }

    const rod = f.rods[index];
    if (rod.status === 'broken') {
        return interaction.reply({ content: `Your **${rod.name}** is broken and cannot be equipped. Repair it first with \`/fish shop repair\`.`, flags: MessageFlags.Ephemeral });
    }

    f.equippedRodIndex = index;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishinv equip] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('✅ Rod Equipped')
                .setDescription(`You equipped **${rod.name}** (Slot ${number}).`)
                .addFields({ name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: true })
                .setTimestamp()
        ]
    });
}

async function showBait(interaction, user, currency) {
    const f = user.fishing;

    const baitLines = Object.entries(f.bait ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([type, qty]) => {
            const pack = BAIT_PACKS.find(b => b.baitType === type);
            return `${pack?.emoji ?? '🪱'} **${type.replace(/_/g, ' ')}**: ${qty}`;
        });

    const consumableLines = Object.entries(f.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            return `${def?.emoji ?? '📦'} **${def?.name ?? id}**: ${qty}`;
        });

    const activeLines = [];
    if (f.activeBait) {
        const activeDef = CONSUMABLES[f.activeBait];
        const activeName = activeDef?.name ?? f.activeBait.replace(/_/g, ' ');
        activeLines.push(`${activeDef?.emoji ?? '🐟'} ${activeName} active (${f.activeBaitCastsLeft} casts left)`);
    }
    if (f.activeLuck)    activeLines.push(`🍀 Angler's Luck queued`);
    if (f.activeXpScroll) activeLines.push(`📜 XP Scroll queued`);

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎒 ${interaction.user.username}'s Fishing Supplies`)
        .addFields(
            { name: '🪱 Bait Stock', value: baitLines.length ? baitLines.join('\n') : 'None', inline: false },
            { name: '🧪 Consumables', value: consumableLines.length ? consumableLines.join('\n') : 'None', inline: false },
            { name: '⚡ Active Buffs', value: activeLines.length ? activeLines.join('\n') : 'None', inline: false }
        )
        .setFooter({ text: 'Use /fish shop to buy supplies • /use <item> to activate consumables' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function showMaterials(interaction, user) {
    const f = user.fishing;
    const matLines = Object.entries(f.materials ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}**: ${qty}`);

    const huntMats = user.hunt?.materials ?? {};
    const huntMatLines = ['rabbits_foot', 'feather'].map(id => {
        const qty = huntMats[id] ?? 0;
        if (!qty) return null;
        return `• **${id.replace(/_/g, ' ')}** (hunt): ${qty}`;
    }).filter(Boolean);

    const embed = new EmbedBuilder()
        .setColor('#95a5a6')
        .setTitle(`🪨 ${interaction.user.username}'s Fishing Materials`)
        .addFields(
            { name: 'Fishing Materials', value: matLines.length ? matLines.join('\n') : 'None yet — catch fish for material drops!', inline: false }
        );

    if (huntMatLines.length) {
        embed.addFields({ name: 'Hunt Materials (cross-system)', value: huntMatLines.join('\n'), inline: false });
    }

    embed.setFooter({ text: 'Materials are used in crafting recipes. Use /fish craft list to see what you can make.' });
    embed.setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTS
// ═══════════════════════════════════════════════════════════════════════════════

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
    ensureFishingData(user);
    assignDailyFishQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[fishquests] pre-save error:', e));
    }

    if (sub === 'view') return showQuests(interaction, user, currency);
    return claimQuest(interaction, user, currency);
}

async function showQuests(interaction, user, currency) {
    const now         = Date.now();
    const fishQuests  = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    if (!fishQuests.length) {
        return interaction.reply({ content: 'No fishing quests assigned yet. Use `/fish cast` to start fishing!', flags: MessageFlags.Ephemeral });
    }

    const lines = fishQuests.map((q, i) => {
        const template  = FISH_QUEST_TEMPLATES.find(t => t.id === q.questId);
        if (!template) return null;

        const isClaimed   = q.progress === -1;
        const isCompleted = q.completedAt && !isClaimed;
        const progress    = isClaimed ? template.target : Math.min(q.progress, template.target);
        const bar         = buildQuestProgressBar(progress, template.target, 10);
        const rewardStr   = `${currency}${template.reward.coins} + ${template.reward.xp} XP`;
        const expiresIn   = formatMs(q.expiresAt.getTime() - now);

        const statusIcon  = isClaimed ? '✅' : isCompleted ? '🎁' : '⏳';
        return [
            `**${i + 1}.** ${template.emoji} **${template.name}** ${statusIcon}`,
            `   ${template.description}`,
            `   ${bar} ${progress}/${template.target}`,
            `   Reward: ${rewardStr}${isClaimed ? ' (claimed)' : isCompleted ? ' — **/fish quests claim ' + (i + 1) + '**' : ''}`,
            `   Expires in: ${expiresIn}`
        ].join('\n');
    }).filter(Boolean);

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎣 ${interaction.user.username}'s Daily Fishing Quests`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Quests refresh every 24h after all are completed or claimed' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function claimQuest(interaction, user, currency) {
    const now        = Date.now();
    const number     = interaction.options.getInteger('number');
    const fishQuests = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    const questEntry = fishQuests[number - 1];
    if (!questEntry) {
        return interaction.reply({ content: `No quest at slot #${number}. Use \`/fish quests view\` to see your quests.`, flags: MessageFlags.Ephemeral });
    }

    const template = FISH_QUEST_TEMPLATES.find(t => t.id === questEntry.questId);
    if (!template) {
        return interaction.reply({ content: 'Quest data not found.', flags: MessageFlags.Ephemeral });
    }

    if (questEntry.progress === -1) {
        return interaction.reply({ content: `**${template.name}** has already been claimed.`, flags: MessageFlags.Ephemeral });
    }
    if (!questEntry.completedAt) {
        const progress = Math.min(questEntry.progress, template.target);
        return interaction.reply({
            content: `**${template.name}** is not complete yet. Progress: **${progress}/${template.target}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const oldLevel      = user.fishing.level;
    user.balance       += template.reward.coins;
    questEntry.progress = -1;

    const lvResult = applyXp(user, template.reward.xp);
    const leveledUp = lvResult.leveledUp;

    user.markModified('quests');
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishquests claim] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${template.emoji} Quest Reward Claimed!`)
        .setDescription(`**${template.name}** completed!`)
        .addFields(
            { name: 'Coins Earned', value: `${currency}${template.reward.coins.toLocaleString()}`, inline: true },
            { name: 'XP Earned',   value: `+${template.reward.xp} Fishing XP`,                   inline: true },
            { name: 'Balance',     value: `${currency}${user.balance.toLocaleString()}`,           inline: true }
        )
        .setTimestamp();

    if (leveledUp) {
        const ld = getLevelData(lvResult.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Fisher Level **${oldLevel}** → **${lvResult.newLevel}** (${ld.title})`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

function buildQuestProgressBar(current, total, length) {
    const filled = Math.min(length, Math.max(0, Math.round((current / Math.max(1, total)) * length)));
    return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP
// ═══════════════════════════════════════════════════════════════════════════════

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
    ensureFishingData(user);

    switch (sub) {
        case 'list':    return showShopList(interaction, user, currency);
        case 'rod':     return handleBuyRod(interaction, user, currency);
        case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
        case 'buy':     return handleBuy(interaction, user, currency);
        case 'use':     return handleUse(interaction, user);
        case 'repair':  return handleRepair(interaction, user, currency);
        case 'unlock':  return handleUnlock(interaction, user, currency);
    }
}

async function showShopList(interaction, user, currency) {
    const f = user.fishing;

    const rodItems = ROD_TIERS.map(r => ({
        imageId: `fish:${r.slug}`,
        name:    r.name,
        price:   r.cost,
        emoji:   r.emoji,
        badge:   `T${r.tier}`
    }));
    const rodList = ROD_TIERS.map(r =>
        `${r.emoji} **T${r.tier} ${r.name}** — ${currency}${r.cost.toLocaleString()} · \`/fish shop rod type:${r.slug}\``
    ).join('\n');

    const upgradeItems = Object.values(ROD_UPGRADES).map(u => ({
        imageId: `fish:${u.id}`,
        name:    u.name,
        emoji:   u.emoji,
        subline: `~${Math.round(u.costMultiplier * 100)}% of rod`
    }));
    const upgradeList = Object.values(ROD_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — *${u.description}* · \`/fish shop upgrade type:${u.id}\``
    ).join('\n');

    const baitItems = BAIT_PACKS.map(p => ({
        imageId: `fish:${p.id}`,
        name:    p.name,
        price:   p.cost,
        emoji:   p.emoji
    }));
    const baitList = BAIT_PACKS.map(p =>
        `${p.emoji} **${p.name}** — ${currency}${p.cost} · \`/fish shop buy item:${p.id}\``
    ).join('\n');

    const consumableItems = Object.values(CONSUMABLES).map(c => ({
        imageId: `fish:${c.id}`,
        name:    c.name,
        price:   c.cost,
        emoji:   c.emoji
    }));
    const consumableList = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/fish shop buy item:${c.id}\``
    ).join('\n');

    const locationItems = LOCATION_LIST.map(loc => {
        const unlocked = f.unlockedLocations.includes(loc.id);
        const isActive = f.activeLocation === loc.id;
        return {
            imageId: `fish:${loc.id}`,
            name:    loc.name,
            emoji:   loc.emoji,
            badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${loc.unlockLevel}`),
            subline: unlocked ? (isActive ? 'Currently fishing' : 'Unlocked') : (loc.unlockCost > 0 ? `${currency}${loc.unlockCost.toLocaleString()}` : 'Free')
        };
    });
    const locationList = LOCATION_LIST.map(loc => {
        const unlocked = f.unlockedLocations.includes(loc.id);
        const isActive = f.activeLocation === loc.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${loc.unlockLevel}${loc.unlockCost > 0 ? ` / ${currency}${loc.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${loc.emoji} **${loc.name}** — ${status}`;
    }).join('\n');

    return runShopBrowse(interaction, {
        activity: 'fish',
        title:    'Fishing Shop',
        currency,
        footer:   'rod • upgrade • buy • use • repair • unlock',
        pages: [
            { id: 'rods',        label: 'Rods',        emoji: '🎣',  subtitle: 'Better rods, better catches.',           items: rodItems,        listText: rodList        },
            { id: 'upgrades',    label: 'Upgrades',    emoji: '🔧',  subtitle: 'One module per rod, permanent.',         items: upgradeItems,    listText: upgradeList    },
            { id: 'bait',        label: 'Bait',        emoji: '🪱',  subtitle: 'The right bait pulls the right fish.',   items: baitItems,       listText: baitList       },
            { id: 'consumables', label: 'Consumables', emoji: '🧪',  subtitle: 'Luck, XP and quick boosts.',             items: consumableItems, listText: consumableList },
            { id: 'locations',   label: 'Locations',   emoji: '🗺️', subtitle: 'New waters, new species.',                items: locationItems,   listText: locationList   }
        ]
    });
}

async function handleBuyRod(interaction, user, currency) {
    const slug    = interaction.options.getString('type');
    const rodData = ROD_BY_SLUG[slug];

    if (!rodData) {
        return interaction.reply({ content: 'Unknown rod type.', flags: MessageFlags.Ephemeral });
    }
    if (user.balance < rodData.cost) {
        return interaction.reply({
            content: `You need **${currency}${rodData.cost.toLocaleString()}** to buy the **${rodData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`${rodData.emoji} Purchase ${rodData.name}?`)
        .setDescription(rodData.description)
        .addFields(
            { name: 'Cost',         value: `${currency}${rodData.cost.toLocaleString()}`,                                               inline: true },
            { name: 'Durability',   value: `${rodData.baseDurability}`,                                                                  inline: true },
            { name: 'Success Rate', value: `${Math.round(rodData.successRate * 100)}%`,                                                  inline: true },
            { name: 'Rarity Boost', value: rodData.rarityBoost > 0 ? `+${Math.round(rodData.rarityBoost * 100)}%` : 'None',             inline: true },
            { name: 'Bait Type',    value: rodData.requiresBait ? rodData.baitType.replace(/_/g, ' ') : 'No bait needed',               inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`,                                               inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const rodImg = await getItemImageAttachment(`fish:${rodData.slug || rodData.id}`).catch(() => null);
    if (rodImg) confirmEmbed.setThumbnail(rodImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buyrod_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buyrod_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const fishConfirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true };
    if (rodImg) fishConfirmPayload.files = [rodImg.attachment];
    const reply = await interaction.reply(fishConfirmPayload);
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'buyrod_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);

        if (freshUser.balance < rodData.cost) {
            return btn.update({ content: `Insufficient funds. You need ${currency}${rodData.cost.toLocaleString()}.`, embeds: [], components: [] });
        }

        freshUser.balance -= rodData.cost;
        freshUser.fishing.rods.push({
            name:              rodData.name,
            tier:              rodData.tier,
            slug:              rodData.slug,
            currentDurability: rodData.baseDurability,
            maxDurability:     rodData.baseDurability,
            baseDurability:    rodData.baseDurability,
            repairCount:       0,
            upgrade:           null,
            status:            'good'
        });
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishshop rod] save error:', err);
            return btn.update({ content: 'Something went wrong. Please try again.', embeds: [], components: [] });
        }

        const rodIndex = freshUser.fishing.rods.length;
        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${rodData.emoji} ${rodData.name} Purchased!`)
                    .setDescription(`You now own a **${rodData.name}**. Equip it with \`/fish inv equip ${rodIndex}\`.`)
                    .addFields(
                        { name: 'Spent',   value: `${currency}${rodData.cost.toLocaleString()}`,      inline: true },
                        { name: 'Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true }
                    )
            ],
            components: []
        });
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function handleBuyUpgrade(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Use \`/fish inv equip\` first.`, flags: MessageFlags.Ephemeral });
    }

    const upgradeId  = interaction.options.getString('type');
    const upgradeDef = ROD_UPGRADES[upgradeId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade.', flags: MessageFlags.Ephemeral });
    }

    const targetRodIndex = f.equippedRodIndex;
    const rod     = f.rods[targetRodIndex];
    const rodData = ROD_BY_TIER[rod.tier];
    const cost    = Math.round(rodData.cost * upgradeDef.costMultiplier);

    if (rod.upgrade) {
        return interaction.reply({
            content: `Your **${rod.name}** already has the **${rod.upgrade.replace(/_/g, ' ')}** upgrade. Each rod can only hold one upgrade.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need **${currency}${cost.toLocaleString()}** to install **${upgradeDef.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle(`${upgradeDef.emoji} Install ${upgradeDef.name}?`)
        .setDescription(`Installing on **${rod.name}**\n${upgradeDef.description}`)
        .addFields(
            { name: 'Cost',         value: `${currency}${cost.toLocaleString()}`,      inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
        )
        .setFooter({ text: 'One upgrade per rod. This cannot be removed.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('upgrade_confirm').setLabel('Install').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('upgrade_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'upgrade_cancel') {
            return btn.update({ content: 'Installation cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);

        if (freshUser.balance < cost) {
            return btn.update({ content: 'Insufficient funds.', embeds: [], components: [] });
        }

        const freshRod = freshUser.fishing.rods[targetRodIndex];
        if (!freshRod) {
            return btn.update({ content: 'That rod is no longer in your inventory.', embeds: [], components: [] });
        }
        if (freshRod.upgrade) {
            return btn.update({ content: `**${freshRod.name}** already has an upgrade installed.`, embeds: [], components: [] });
        }

        freshUser.balance -= cost;
        freshRod.upgrade   = upgradeId;
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishshop upgrade] save error:', err);
            return btn.update({ content: 'Something went wrong. Please try again.', embeds: [], components: [] });
        }

        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${upgradeDef.emoji} ${upgradeDef.name} Installed!`)
                    .setDescription(`**${freshRod.name}** now has **${upgradeDef.name}** installed permanently.`)
                    .addFields(
                        { name: 'Effect',  value: upgradeDef.description,                       inline: true },
                        { name: 'Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true }
                    )
            ],
            components: []
        });
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Installation timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const f        = user.fishing;

    const baitPack   = BAIT_PACKS.find(p => p.id === itemId);
    const consumable = baitPack ? null : CONSUMABLES[itemId];
    const itemDef    = baitPack ?? consumable;

    if (!itemDef) {
        return interaction.reply({ content: 'Unknown item.', flags: MessageFlags.Ephemeral });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need **${currency}${totalCost.toLocaleString()}** for ${quantity}× **${itemDef.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    if (baitPack) {
        const totalBait = (f.bait[baitPack.baitType] ?? 0) + baitPack.quantity * quantity;
        if (totalBait > 200) {
            return interaction.reply({ content: `You can't carry more than 200 of that bait type.`, flags: MessageFlags.Ephemeral });
        }
    } else {
        const currentQty = f.consumables[itemId] ?? 0;
        if (currentQty + quantity > (consumable.maxStack ?? 99)) {
            return interaction.reply({ content: `You can only carry ${consumable.maxStack} **${consumable.name}** at a time.`, flags: MessageFlags.Ephemeral });
        }
    }

    const gainedLabel = baitPack
        ? `${baitPack.quantity * quantity} ${baitPack.baitType.replace(/_/g, ' ')}`
        : `${quantity}× ${consumable.name}`;
    const currentStock = baitPack
        ? `${f.bait[baitPack.baitType] ?? 0} in stock`
        : `${f.consumables[itemId] ?? 0}/${consumable.maxStack ?? 99} in stock`;

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${itemDef.emoji} Confirm Purchase`)
        .setDescription(itemDef.description ?? '')
        .addFields(
            { name: 'Item',         value: itemDef.name,                                 inline: true },
            { name: 'Quantity',     value: gainedLabel,                                  inline: true },
            { name: 'Total Cost',   value: `${currency}${totalCost.toLocaleString()}`,   inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Currently',    value: currentStock,                                  inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fishbuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('fishbuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'fishbuy_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();

            if (baitPack) {
                const baitField = `data.bait.${baitPack.baitType}`;
                const addedQty  = baitPack.quantity * quantity;

                await persistGrindIfNew(user, 'fishing');
                const updated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                    { $inc: { balance: -totalCost } },
                    { new: true }
                );
                if (!updated) {
                    return interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
                }

                const profUpdated = await GrindProfile.findOneAndUpdate(
                    {
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        system:  'fishing',
                        $expr: { $lte: [{ $add: [{ $ifNull: [`$${baitField}`, 0] }, addedQty] }, 200] }
                    },
                    { $inc: { [baitField]: addedQty } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }

                f.bait[baitPack.baitType] = profUpdated.data?.bait?.[baitPack.baitType] ?? addedQty;
                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('#2ecc71')
                            .setTitle(`${baitPack.emoji} Purchased!`)
                            .setDescription(`Bought **${quantity}× ${baitPack.name}** (+${addedQty} ${baitPack.baitType.replace(/_/g, ' ')}).`)
                            .addFields(
                                { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,                           inline: true },
                                { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`,                      inline: true },
                                { name: 'Stock',   value: `${f.bait[baitPack.baitType]} ${baitPack.baitType.replace(/_/g, ' ')}`, inline: true }
                            )
                            .setTimestamp()
                    ],
                    components: []
                });
            }

            // consumable path
            const consumableField = `data.consumables.${itemId}`;
            const stackCap        = consumable.maxStack ?? 99;

            await persistGrindIfNew(user, 'fishing');
            const updated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost } },
                { new: true }
            );
            if (!updated) {
                return interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
            }

            const profUpdated = await GrindProfile.findOneAndUpdate(
                {
                    userId:  interaction.user.id,
                    guildId: interaction.guild.id,
                    system:  'fishing',
                    $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, stackCap] }
                },
                { $inc: { [consumableField]: quantity } },
                { new: true }
            ).catch(() => null);

            if (!profUpdated) {
                await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
            }

            f.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? quantity;

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#2ecc71')
                        .setTitle(`${consumable.emoji} Purchased!`)
                        .setDescription(`Bought **${quantity}× ${consumable.name}**.`)
                        .addFields(
                            { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,   inline: true },
                            { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`, inline: true },
                            { name: 'Stock',   value: `${f.consumables[itemId]} owned`,              inline: true }
                        )
                        .setFooter({ text: `Use /fish shop use ${consumable.id} to activate it` })
                        .setTimestamp()
                ],
                components: []
            });
        } catch (err) {
            console.error('[fishshop buy] purchase error:', err);
            interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const result = activateConsumable(user, itemId);

    if (!result.success) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop use] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const def = CONSUMABLES[itemId];
    const f   = user.fishing;

    const statusLines = [];
    if (f.activeBait)     statusLines.push(`🐟 ${f.activeBait.replace(/_/g, ' ')} active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)     statusLines.push(`🍀 Angler's Luck queued for next cast`);
    if (f.activeXpScroll) statusLines.push(`📜 XP Scroll queued for next cast`);

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#9b59b6')
                .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                .setDescription(`*${def?.description ?? 'Effect applied.'}*`)
                .addFields({ name: 'Active Buffs', value: statusLines.length ? statusLines.join('\n') : 'None' })
                .setTimestamp()
        ]
    });
}

async function handleRepair(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Buy one with \`/fish shop rod\`.`, flags: MessageFlags.Ephemeral });
    }

    const rod    = f.rods[f.equippedRodIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', flags: MessageFlags.Ephemeral });
        }

        const kitStock   = f.consumables[kitId] ?? 0;
        const kitRestore = kitId === 'repair_kit_small' ? 20 : 50;
        const kitName    = kitId === 'repair_kit_small' ? 'Small Repair Kit' : 'Large Repair Kit';

        if (kitStock <= 0) {
            return interaction.reply({ content: `You don't have any **${kitName}**. Buy one with \`/fish shop buy\`.`, flags: MessageFlags.Ephemeral });
        }
        if (rod.status === 'condemned') {
            return interaction.reply({ content: 'This rod is condemned and cannot be repaired.', flags: MessageFlags.Ephemeral });
        }
        if (rod.currentDurability >= rod.maxDurability && rod.status !== 'broken') {
            return interaction.reply({ content: 'Your rod is already at full durability.', flags: MessageFlags.Ephemeral });
        }

        const restored = Math.min(kitRestore, rod.maxDurability - rod.currentDurability);
        rod.currentDurability = Math.min(rod.maxDurability, rod.currentDurability + restored);
        updateRodStatus(rod);
        f.consumables[kitId] -= 1;
        user.markModified('fishing');

        try {
            await user.save();
        } catch (err) {
            console.error('[fishshop repair kit] save error:', err);
            return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
        }

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${kitId === 'repair_kit_small' ? '🔧' : '🔨'} ${kitName} Used`)
                    .addFields(
                        { name: 'Rod',       value: rod.name,                                                                               inline: true },
                        { name: 'Restored',  value: `+${restored} durability`,                                                              inline: true },
                        { name: 'Remaining', value: `${kitStock - 1} kit(s) left`,                                                          inline: true },
                        { name: 'Durability',value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
                        { name: 'Status',    value: `${rodStatusEmoji(rod.status)} ${rod.status}`,                                          inline: true }
                    )
                    .setFooter({ text: 'Repair kits do not degrade max durability.' })
                    .setTimestamp()
            ]
        });
    }

    const requestedAmount = interaction.options.getInteger('amount') ?? null;

    // Price the repair before committing — applying it permanently degrades the
    // rod's max durability, which must not happen on a quote the player can't buy.
    const quote = quoteRepair(rod, requestedAmount);
    if (quote.error) {
        return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });
    }
    if (user.balance < quote.cost) {
        return interaction.reply({
            content: `Repairing **${quote.restoredAmount}** durability costs **${currency}${quote.cost.toLocaleString()}**. You only have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const result = applyRepair(rod, requestedAmount);
    user.balance -= result.cost;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop repair shop] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle('🔧 Rod Repaired')
        .addFields(
            { name: 'Rod',        value: rod.name,                                                                               inline: true },
            { name: 'Restored',   value: `+${result.restoredAmount} durability`,                                                 inline: true },
            { name: 'Cost',       value: `${currency}${result.cost.toLocaleString()}`,                                           inline: true },
            { name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
            { name: 'Status',     value: `${rodStatusEmoji(rod.status)} ${rod.status}`,                                          inline: true },
            { name: 'Balance',    value: `${currency}${user.balance.toLocaleString()}`,                                          inline: true }
        )
        .setTimestamp();

    if (result.condemned) {
        embed.setColor('#e74c3c');
        embed.addFields({ name: '⚠️ Condemned', value: 'This rod has been repaired too many times and cannot be repaired again. Consider buying a new one with `/fish shop rod`.', inline: false });
    } else {
        embed.addFields({ name: 'ℹ️ Note', value: `Max durability slightly reduced to ${rod.maxDurability} after this repair.`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

async function handleUnlock(interaction, user, currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', flags: MessageFlags.Ephemeral });
    }
    if (f.unlockedLocations.includes(locationId)) {
        return interaction.reply({ content: `**${location.name}** is already unlocked.`, flags: MessageFlags.Ephemeral });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to unlock **${location.name}**. You are Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < location.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${location.name}** costs **${currency}${location.unlockCost.toLocaleString()}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Phase 1: claim the unlock on the fishing profile (level gate + not-yet-unlocked)
    await persistGrindIfNew(user, 'fishing');
    const profUpdated = await GrindProfile.findOneAndUpdate(
        {
            userId:  interaction.user.id,
            guildId: interaction.guild.id,
            system:  'fishing',
            'data.level': { $gte: location.unlockLevel },
            'data.unlockedLocations': { $ne: locationId }
        },
        {
            $addToSet: { 'data.unlockedLocations': locationId },
            $set:      { 'data.activeLocation': locationId }
        },
        { new: true }
    ).catch(() => null);

    if (!profUpdated) {
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', flags: MessageFlags.Ephemeral });
    }

    // Phase 2: charge the unlock cost; roll the unlock back if the debit fails
    const updated = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: location.unlockCost } },
        { $inc: { balance: -location.unlockCost } },
        { new: true }
    );

    if (!updated) {
        await GrindProfile.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id, system: 'fishing' },
            { $pull: { 'data.unlockedLocations': locationId }, $set: { 'data.activeLocation': user.fishing.activeLocation } }
        ).catch(() => {});
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', flags: MessageFlags.Ephemeral });
    }

    // Sync the in-memory profile so a later save doesn't clobber the unlock
    user.fishing.unlockedLocations = profUpdated.data.unlockedLocations;
    user.fishing.activeLocation    = locationId;

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`🗺️ ${location.emoji} ${location.name} Unlocked!`)
                .setDescription(location.description)
                .addFields(
                    { name: 'Cost Paid', value: location.unlockCost > 0 ? `${currency}${location.unlockCost.toLocaleString()}` : 'Free', inline: true },
                    { name: 'Balance',   value: `${currency}${updated.balance.toLocaleString()}`,                                          inline: true },
                    { name: 'Status',    value: 'Now your active location!',                                                              inline: true }
                )
                .setFooter({ text: 'Use /fish cast to start catching from this location • Switch anytime with /fish location set' })
                .setTimestamp()
        ]
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRAFT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCraft(interaction, sub) {
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
    ensureFishingData(user);
    ensureHuntData(user);
    const f = user.fishing;
    const h = user.hunt;

    if (sub === 'list') {
        const lines = Object.values(FISH_CRAFT_RECIPES).map(r => {
            const ingredientStr = r.ingredients
                .map(ing => {
                    const name = getCraftMaterialName(ing.material, ing.source);
                    const tag  = ing.source === 'hunt' ? ' *(hunt)*' : '';
                    return `${name}${tag} ×${ing.qty}`;
                })
                .join(', ');

            const canCraft = r.ingredients.every(ing =>
                getCraftMaterialStock(ing.material, ing.source, h, f) >= ing.qty
            );
            const uniqueDone = r.unique && r.output.id === 'luckyHook' && f.luckyHook;
            const status = uniqueDone ? '✅ **[OWNED]**' : canCraft ? '✅' : '❌';

            return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
        });

        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🎣 Fishing Crafting Recipes')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: '✅ = you can craft now  •  Use /fish craft make <recipe> to craft  •  /fish inv materials to check stock' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'make') {
        const recipeId = interaction.options.getString('recipe');
        const recipe   = FISH_CRAFT_RECIPES[recipeId];

        if (!recipe) {
            return interaction.reply({
                content: 'Unknown recipe. Use `/fish craft list` to see available recipes.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (recipe.unique && recipe.output.id === 'luckyHook' && f.luckyHook) {
            return interaction.reply({
                content: 'You already have the **🎣 Lucky Hook** upgrade!',
                flags: MessageFlags.Ephemeral
            });
        }

        if (recipe.output.type === 'consumable' || recipe.output.type === 'dual_stamina') {
            const def          = CONSUMABLES[recipe.output.id];
            const currentStock = f.consumables[recipe.output.id] ?? 0;
            const qty          = recipe.output.qty ?? 1;
            if (def && currentStock + qty > def.maxStack) {
                return interaction.reply({
                    content: `You can only hold **${def.maxStack}× ${def.name}** (you have ${currentStock}). ` +
                             `Free up space before crafting more.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        const missing = recipe.ingredients
            .filter(ing => getCraftMaterialStock(ing.material, ing.source, h, f) < ing.qty)
            .map(ing => {
                const have = getCraftMaterialStock(ing.material, ing.source, h, f);
                const name = getCraftMaterialName(ing.material, ing.source);
                const tag  = ing.source === 'hunt' ? ' (hunt material)' : '';
                return `**${name}${tag}** (need ${ing.qty}, have ${have})`;
            });

        if (missing.length) {
            return interaction.reply({
                content: `You are missing the following materials:\n${missing.join('\n')}`,
                flags: MessageFlags.Ephemeral
            });
        }

        for (const ing of recipe.ingredients) {
            if (ing.source === 'hunt') {
                h.materials[ing.material] -= ing.qty;
            } else {
                f.materials[ing.material] -= ing.qty;
            }
        }

        let outputDesc = '';
        if (recipe.output.type === 'consumable') {
            const qty = recipe.output.qty ?? 1;
            f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
            const def = CONSUMABLES[recipe.output.id];
            outputDesc = `${def?.emoji ?? '📦'} **${qty}× ${def?.name ?? recipe.output.id}**`;
        } else if (recipe.output.type === 'dual_stamina') {
            const qty = recipe.output.qty ?? 1;
            f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
            const def = CONSUMABLES[recipe.output.id];
            outputDesc = `${def?.emoji ?? '⚗️'} **${qty}× ${def?.name ?? recipe.output.id}** — use with \`/use\` to restore stamina in both systems`;
        } else if (recipe.output.type === 'permanent') {
            if (recipe.output.id === 'luckyHook') {
                f.luckyHook = true;
                outputDesc = '🎣 **Lucky Hook** — permanently +1% critical catch chance!';
            }
        }

        const huntModified = recipe.ingredients.some(ing => ing.source === 'hunt');
        if (huntModified) user.markModified('hunt');
        user.markModified('fishing');
        await user.save();

        const usedLines = recipe.ingredients.map(ing => {
            const remaining = getCraftMaterialStock(ing.material, ing.source, h, f);
            const name      = getCraftMaterialName(ing.material, ing.source);
            const tag       = ing.source === 'hunt' ? ' *(hunt)*' : '';
            return `• ${name}${tag} ×${ing.qty}  (remaining: ${remaining})`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`${recipe.emoji} Crafted: ${recipe.name}`)
            .setDescription(`You crafted ${outputDesc}!`)
            .addFields({ name: 'Materials Consumed', value: usedLines, inline: false })
            .setFooter({ text: 'Use /fish inv materials to check your remaining stock' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
}

function getCraftMaterialName(materialId, source) {
    if (source === 'hunt') return HUNT_MATERIAL_NAMES[materialId] ?? materialId;
    return MATERIAL_NAMES[materialId] ?? materialId;
}

function getCraftMaterialStock(materialId, source, h, f) {
    if (source === 'hunt') return h.materials[materialId] ?? 0;
    return f.materials[materialId] ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLocation(interaction, sub) {
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
    ensureFishingData(user);

    switch (sub) {
        case 'list': return showLocationList(interaction, user, currency);
        case 'set':  return setLocation(interaction, user, currency);
    }
}

async function showLocationList(interaction, user, currency) {
    const f = user.fishing;

    const locationLines = LOCATION_LIST.map(loc => {
        const isUnlocked = f.unlockedLocations.includes(loc.id);
        const isActive   = f.activeLocation === loc.id;
        const tierStr    = formatTierWeights(loc.tierWeights);
        const status     = isActive ? ' **[ACTIVE]**' : isUnlocked ? ' ✅' : ` 🔒 Lv.${loc.unlockLevel}${loc.unlockCost > 0 ? ` / ${currency}${loc.unlockCost.toLocaleString()}` : ''}`;

        return [
            `${loc.emoji} **${loc.name}**${status}`,
            `   ${loc.description}`,
            `   Tiers: ${tierStr}`,
            `   Junk: ${Math.round(loc.junkChance * 100)}% | Treasure: ${Math.round(loc.treasureChance * 100)}%${loc.payoutBonus > 0 ? ` | Payout +${Math.round(loc.payoutBonus * 100)}%` : ''}`
        ].join('\n');
    });

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle('🗺️ Fishing Locations')
        .setDescription(locationLines.join('\n\n'))
        .setFooter({ text: 'Unlock new locations with /fish shop unlock • Switch with /fish location set' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function setLocation(interaction, user, currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', flags: MessageFlags.Ephemeral });
    }
    if (!f.unlockedLocations.includes(locationId)) {
        return interaction.reply({
            content: `**${location.name}** is locked. Unlock it with \`/fish shop unlock\`.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to fish at **${location.name}**. You are Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    f.activeLocation = locationId;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[location set] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`📍 Location Changed`)
                .setDescription(`You are now fishing at **${location.emoji} ${location.name}**.`)
                .addFields({ name: 'About', value: location.description, inline: false })
                .setTimestamp()
        ]
    });
}

function formatTierWeights(weights) {
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    return Object.entries(weights)
        .filter(([, w]) => w > 0)
        .map(([tier, w]) => `${tier} ${Math.round((w / total) * 100)}%`)
        .join(', ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTournament(interaction, sub) {
    if (sub === 'status') return handleTournamentStatus(interaction);
    if (sub === 'start')  return handleTournamentStart(interaction);
}

async function handleTournamentStatus(interaction) {
    await interaction.deferReply();
    const tournament = await getActiveTournament(interaction.guild.id);
    if (!tournament) {
        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#95a5a6')
                    .setTitle('🎣 No Active Tournament')
                    .setDescription('There is no fishing tournament running right now.\n\nAdmins can start one with `/fish tournament start`.')
                    .setTimestamp()
            ]
        });
    }

    // Auto-end if expired
    if (new Date() > tournament.endsAt) {
        const ended = await endTournament(tournament._id);
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const currency = guildSettings?.economy?.currency ?? '💰';
        const announceChannelId = ended.announceChannelId ?? guildSettings?.economy?.announcementChannelId ?? null;
        announceTournamentEnd(interaction.client, ended, interaction.guild.id, announceChannelId).catch(() => null);
        return interaction.editReply({ embeds: [buildWinnersEmbed(ended, currency)] });
    }

    return interaction.editReply({ embeds: [buildLeaderboardEmbed(tournament)] });
}

async function handleTournamentStart(interaction) {
    const member = interaction.guild.members.cache.get(interaction.user.id);
    if (!member?.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '❌ You need the **Manage Server** permission to start a tournament.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    const durationMins = interaction.options.getInteger('duration') ?? 60;
    const seedAmount   = interaction.options.getInteger('prize_pool') ?? 0;
    const entryFee     = interaction.options.getInteger('entry_fee') ?? 0;
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const announceChannelId = guildSettings?.economy?.announcementChannelId ?? null;

    let tournament;
    try {
        tournament = await startTournament(interaction.guild.id, {
            durationMs: durationMins * 60_000,
            seedAmount,
            entryFee,
            announceChannelId
        });
    } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const announceEmbed = new EmbedBuilder()
        .setColor('#1e90ff')
        .setTitle('🎣 A Fishing Tournament Has Begun!')
        .setDescription(
            `**Duration:** ${durationMins} minutes\n` +
            `**Ends:** <t:${Math.floor(tournament.endsAt.getTime() / 1000)}:R>\n` +
            `**Goal:** Catch the highest-value single fish!\n` +
            (entryFee > 0 ? `**Entry Fee:** ${currency}${entryFee.toLocaleString()} (auto-deducted on first catch)\n` : `**Entry:** Free\n`) +
            (seedAmount > 0 ? `**Prize Pool:** ${currency}${seedAmount.toLocaleString()} to start\n` : '') +
            `\nUse \`/fish cast\` to participate. Use \`/fish tournament status\` to see the live leaderboard!\n\n` +
            `🐉 **Tip:** Boss encounters during the tournament give a score multiplier!`
        )
        .setTimestamp();

    // Announce in the announcement channel if configured
    if (announceChannelId) {
        const ch = interaction.guild.channels.cache.get(announceChannelId);
        if (ch?.isTextBased()) {
            ch.send({ embeds: [announceEmbed] }).catch(() => null);
        }
    }

    return interaction.editReply({ embeds: [announceEmbed] });
}

// ─── World Records ────────────────────────────────────────────────────────────
async function checkAndUpdateWorldRecord(guildId, { fish, weight, userId, username }) {
    const existing = await Guild.findOne(
        { guildId, 'fishingWorldRecords.fish': fish },
        { 'fishingWorldRecords.$': 1 }
    ).lean().catch(() => null);

    const existingRecord = existing?.fishingWorldRecords?.[0];
    if (existingRecord && existingRecord.weight >= weight) return;

    if (existingRecord) {
        await Guild.updateOne(
            { guildId, 'fishingWorldRecords.fish': fish },
            { $set: { 'fishingWorldRecords.$.weight': weight, 'fishingWorldRecords.$.userId': userId, 'fishingWorldRecords.$.username': username, 'fishingWorldRecords.$.date': new Date() } }
        ).catch(() => {});
    } else {
        await Guild.updateOne(
            { guildId },
            { $push: { fishingWorldRecords: { fish, weight, userId, username, date: new Date() } } }
        ).catch(() => {});
    }
}

async function handleRecords(interaction) {
    await interaction.deferReply();

    const guildDoc = await Guild.findOne({ guildId: interaction.guild.id }, 'fishingWorldRecords').lean().catch(() => null);
    const records  = (guildDoc?.fishingWorldRecords ?? [])
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 15);

    if (!records.length) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🐟 Server Fishing Records')
                .setDescription('No records yet — start fishing to claim the top spot!')
                .setTimestamp()]
        });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = records.map((r, i) => {
        const medal = medals[i] ?? `**${i + 1}.**`;
        const date  = r.date ? `<t:${Math.floor(new Date(r.date).getTime() / 1000)}:d>` : '';
        return `${medal} **${r.fish}** — ${r.weight} lbs — <@${r.userId}>${date ? ` — ${date}` : ''}`;
    });

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor('#1e90ff')
            .setTitle('🐟 Server Fishing Records')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Heaviest catch per species · Records never reset' })
            .setTimestamp()]
    });
}

// ─── Grand Prestige Check ─────────────────────────────────────────────────────
const GRAND_PRESTIGE_DIAMOND = 5;
const GRAND_PRESTIGE_LEVELS = [
    { level: 1, title: '⚜️ Grand Master',  badge: '⚜️', description: 'Diamond Prestige in all three skill tracks' },
    { level: 2, title: '🌌 Ascendant',     badge: '🌌', description: 'Grand Master + ultimate dedication' },
    { level: 3, title: '👑 Sovereign',     badge: '👑', description: 'The pinnacle of mastery — server-first' },
];

async function checkGrandPrestige(client, user, guild, guildId) {
    const huntDiamond  = (user.hunt?.prestige ?? 0)    >= GRAND_PRESTIGE_DIAMOND;
    const fishDiamond  = (user.fishing?.prestige ?? 0) >= GRAND_PRESTIGE_DIAMOND;
    const mineDiamond  = (user.mining?.prestige ?? 0)  >= GRAND_PRESTIGE_DIAMOND;
    const allDiamond   = huntDiamond && fishDiamond && mineDiamond;

    if (!allDiamond) return;

    const currentLevel = user.grandPrestige?.level ?? 0;
    if (currentLevel >= 1) return; // already achieved Grand Master or higher

    await User.updateOne(
        { userId: user.userId, guildId },
        { $set: { 'grandPrestige.level': 1, 'grandPrestige.awardedAt': new Date() } }
    ).catch(() => {});

    // Broadcast to economy channel
    const guildSettings = await Guild.findOne({ guildId }, 'economy accountPrestige').lean().catch(() => null);
    const announceChannelId = guildSettings?.accountPrestige?.announceChannelId
        ?? guildSettings?.economy?.announcementChannelId
        ?? null;

    if (announceChannelId && client) {
        const broadcastEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('⚜️ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ⚜️')
            .setDescription(
                `**GRAND MASTER ACHIEVED!**\n\n` +
                `<@${user.userId}> has reached **Diamond Prestige** in all three skill tracks!\n\n` +
                `🏹 Diamond Hunter · 🎣 Diamond Angler · ⛏️ Diamond Miner\n\n` +
                `*The rarest achievement in this server.*`
            )
            .setTimestamp();
        try {
            const g  = guild ?? await client.guilds.fetch(guildId).catch(() => null);
            const ch = g?.channels?.cache?.get(announceChannelId);
            if (ch?.isTextBased?.()) ch.send({ embeds: [broadcastEmbed] }).catch(() => {});
        } catch { /* non-critical */ }
    }
}

// ── Per-user action lock ──────────────────────────────────────────────────────
// Fishing mutates the user document with read-modify-write saves, so concurrent
// /fish invocations from the same user can race stamina, daily caps, and drops.
// Serialize them: one fishing action at a time per user.
const { tryAcquire: _lockAcquire, release: _lockRelease } = require('../../utils/activeGameLock');
const _fishExecute = module.exports.execute;
module.exports.execute = async function (interaction) {
    const lockKey   = `grind:fish:${interaction.guild?.id}:${interaction.user.id}`;
    const lockToken = _lockAcquire(lockKey, 120_000);
    if (!lockToken) {
        return interaction.reply({
            content: '🎣 You already have a fishing action in progress — finish it first.',
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
    }
    try {
        return await _fishExecute(interaction);
    } finally {
        _lockRelease(lockKey, lockToken);
    }
};
