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
const { detachBalanceDelta, commitBalanceDelta, saveWithBalanceDelta } = require('../../utils/balanceDelta');
const { chargeExact, refundCharge } = require('../../utils/balanceDebit');
const GrindProfile = require('../../models/GrindProfile');
const Guild = require('../../models/Guild');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse }          = require('../../utils/shopBrowse');
const {
    ZONES, ZONE_LIST, TIER_COLORS, LIMITS, WEAPON_BY_TIER,
    CONSUMABLES, AMMO_PACKS,
    WEAPON_TIERS, WEAPON_BY_SLUG, WEAPON_UPGRADES,
    HUNTER_LEVELS, PRESTIGE_BONUSES, HUNT_QUEST_TEMPLATES,
    ANIMAL_TRAITS, MATERIAL_NAMES, FIELD_TROPHIES
} = require('../../data/huntData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { TIER_NUM, TIER_RIBBON, TIER_STARS } = require('../../data/materialRarity');
const { randomFrom, HUNT_EMPTY_LINES } = require('../../utils/copyLines');
const {
    ensureHuntData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    executeHunt,
    assignDailyHuntQuests,
    updateHuntQuestProgress,
    formatMs,
    weaponStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel,
    activateConsumable,
    applyRepair,
    updateWeaponStatus,
    isCondemned,
    quoteRepair,
    applyXp,
    rollApexType,
    resolveApexEncounter,
    apexNerveAfter,
    apexNerveMax,
    getRarePityThreshold,
    getDiminishingReturns,
    applyPayoutModifiers
} = require('../../services/huntService');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { stackBar } = require('../../utils/rewardReveal');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS, FEATURED_RARE_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { tryUpdateHourlyWinner, getCurrentHourlyLeader } = require('../../utils/hourlyWinner');
const { isDistrictActive } = require('../../services/districtService');
const { ensureQuests, onHunt, onEconomyEarn, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { recordMissionProgress } = require('../../services/seasonMissionService');
const { getActiveSynergies } = require('../../services/synergyService');
const { buildPityStreakField, PITY_COPY } = require('../../utils/pityBonus');
const { chunkByLength } = require('../../utils/embedFields');
const { paginate } = require('../../utils/paginator');

// ── Aim phase timing ─────────────────────────────────────────────────────────
// How long the shot stays perfect once the window opens, and how long after
// that the trigger stays live at all.
//
// The window is wide on purpose, and timed from when the call reaches the
// screen rather than from when the wait elapsed. It has to be comfortably
// longer than the spread in players' round-trip times, or the grade goes back
// to measuring connection quality: a hunter on a 400ms connection spends about
// 650ms of the 900 on the wire and their own reaction, leaving a quarter of a
// second in hand. What separates a perfect shot from a late one is whether the
// player waited for the call, which is the same for everybody.
const AIM_WINDOW_MS = 900;
const AIM_LATE_MS   = 2500;

/**
 * Grades a shot by *when* it was fired relative to the window, and returns both
 * the crit bonus and the embed that reports it.
 *
 * @param {number|null} shotMs  ms from the sights appearing to the trigger,
 *                              or null if the trigger was never pulled
 * @param {number} openAtMs     ms from the sights appearing to the call landing
 *                              on screen — the moment the window opened
 */
function gradeShot(shotMs, openAtMs) {
    const grade =
        shotMs === null                    ? 'timeout' :
        shotMs < openAtMs                  ? 'early'   :
        shotMs <= openAtMs + AIM_WINDOW_MS ? 'perfect' :
                                             'late';

    const GRADES = {
        perfect: {
            bonus: 0.18, color: '#FFD700', title: '🎯 Perfect Shot!',
            body: 'You held it until the moment came. **+18% crit chance** this hunt.',
        },
        late: {
            bonus: 0.08, color: '#00CC66', title: '✅ Clean Shot!',
            body: 'A beat behind the call, but the shot landed. **+8% crit chance** this hunt.',
        },
        // A rushed shot costs rather than merely failing to pay: an early
        // trigger used to be impossible, so "don't fire too early" warned about
        // nothing. It is a real decision now, so it has a real price.
        early: {
            bonus: -0.05, color: '#FF6B6B', title: '💨 You rushed it!',
            body: 'You pulled before the shot lined up and the animal bolted at the noise. **−5% crit chance** this hunt.',
        },
        timeout: {
            bonus: 0, color: '#888888', title: '⏰ Never took the shot',
            body: 'The window closed with your finger still off the trigger. No aim bonus this hunt.',
        },
    };

    const { bonus, color, title, body } = GRADES[grade];
    return {
        grade,
        bonus,
        embed: () => new EmbedBuilder().setColor(color).setTitle(title).setDescription(body),
    };
}


const WILDERNESS_YIELD_BONUS = 0.10;

const walletOf = interaction => ({ userId: interaction.user.id, guildId: interaction.guild.id });

// One contract for both, shared with the other grind shops: the charge is a
// conditional update rather than `user.balance -= cost` followed by a save,
// because the loaded document's balance goes stale the moment any other
// command pays the player. See src/utils/balanceDebit.js.
const chargeBalance = (interaction, cost) => chargeExact(User, walletOf(interaction), cost);
const refundBalance = (interaction, cost) => refundCharge(User, walletOf(interaction), cost, 'huntshop');

// ─── STEALTH APPROACH OPTIONS (per zone) ─────────────────────────────────────
// Each zone has a hint about the animal's behaviour + 3 approach strategies.
// One approach is correct; correct = stealthBonus, wrong = noise penalty.

const ZONE_APPROACHES = {
    beginner_forest: {
        hint: 'A deer is grazing peacefully in a sun-dappled clearing, ears flicking at every sound.',
        options: [
            { id: 'undergrowth', label: '🌿 Creep through the undergrowth', stealthBonus: 0.25 },
            { id: 'sprint',      label: '🏃 Sprint straight in to close the gap', stealthBonus: -0.10 },
            { id: 'call',        label: '📢 Mimic a bird call to distract it', stealthBonus: 0.05 },
        ],
        correctId: 'undergrowth',
    },
    desert_wastes: {
        hint: 'A desert serpent basks motionless on a sun-warmed rock — utterly still, eyes open.',
        options: [
            { id: 'rock_crawl', label: '🪨 Crawl low between boulders', stealthBonus: 0.25 },
            { id: 'open_run',   label: '💨 Sprint across the open sand', stealthBonus: -0.10 },
            { id: 'shade_wait', label: '☁️ Wait for a cloud to pass over', stealthBonus: 0.05 },
        ],
        correctId: 'rock_crawl',
    },
    arctic_tundra: {
        hint: 'A white wolf moves in tight circles — it\'s caught a scent. One wrong step and it bolts.',
        options: [
            { id: 'downwind',   label: '💨 Circle downwind before closing in', stealthBonus: 0.25 },
            { id: 'upwind',     label: '🌬️ Walk directly into the wind toward it', stealthBonus: -0.10 },
            { id: 'white_out',  label: '🌨️ Use a snow squall as cover', stealthBonus: 0.05 },
        ],
        correctId: 'downwind',
    },
    murky_swamp: {
        hint: 'A large reptile floats just below the surface — only its eyes are visible.',
        options: [
            { id: 'wade_slow',  label: '🌊 Wade in slowly without splashing', stealthBonus: 0.25 },
            { id: 'throw_rock', label: '🪨 Throw a rock to distract it first', stealthBonus: -0.10 },
            { id: 'reed_hide',  label: '🌾 Hide in the reeds and wait for it to surface', stealthBonus: 0.05 },
        ],
        correctId: 'wade_slow',
    },
    legendary_peaks: {
        hint: 'An ancient creature roosts on a cliff ledge — its senses are preternatural.',
        options: [
            { id: 'cliff_path', label: '🧗 Climb the cliff path at dusk, shadow-side', stealthBonus: 0.25 },
            { id: 'direct',     label: '⚔️ Charge straight up the ridge', stealthBonus: -0.10 },
            { id: 'below',      label: '🎯 Position below and let it come to you', stealthBonus: 0.05 },
        ],
        correctId: 'cliff_path',
    },
};

// ─── SHARED CHOICE LISTS ──────────────────────────────────────────────────────

const ZONE_CHOICES    = ZONE_LIST.map(z => ({ name: z.name, value: z.id }));
const WEAPON_CHOICES  = WEAPON_TIERS.map(w => ({ name: `${w.emoji} ${w.name} — ${w.cost.toLocaleString()} coins`, value: w.slug }));
const ALL_ITEMS       = [...Object.values(CONSUMABLES), ...AMMO_PACKS];
const ITEM_CHOICES    = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const ACTIVATABLE     = ['basic_bait', 'premium_bait', 'luck_charm', 'hunters_focus', 'xp_scroll', 'stamina_tonic'];
const UPGRADE_CHOICES = Object.values(WEAPON_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES  = ZONE_LIST.filter(z => !z.defaultUnlocked).map(z => ({ name: `${z.emoji} ${z.name}`, value: z.id }));
const ZONE_SET_CHOICES = ZONE_LIST.map(z => ({ name: `${z.emoji} ${z.name}`, value: z.id }));

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];
const MAX_PRESTIGE = PRESTIGE_BONUSES.length - 1;
const PRESTIGE_LABELS = [
    null,
    '🥉 Bronze Prestige',
    '🥈 Silver Prestige',
    '🥇 Gold Prestige',
    '🏆 Champion Prestige',
    '💎 Diamond Prestige'
];

// ─── COMMAND DEFINITION ───────────────────────────────────────────────────────

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('hunt')
        .setDescription('Hunt animals, manage gear, quests, zones, and prestige — all in one place')
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Go on a hunt. Uses 1 stamina. 45s cooldown. Equip a weapon with /hunt inv equip.')
                .addStringOption(o =>
                    o.setName('zone')
                        .setDescription('Zone to hunt in (defaults to your active zone)')
                        .setRequired(false)
                        .addChoices(...ZONE_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's hunter profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Reset your hunter level for permanent prestige bonuses (requires Level 50)'))
        .addSubcommandGroup(group =>
            group.setName('inv')
                .setDescription('View and manage your hunt inventory')
                .addSubcommand(sub =>
                    sub.setName('weapons')
                        .setDescription('View your weapon collection'))
                .addSubcommand(sub =>
                    sub.setName('equip')
                        .setDescription('Equip a weapon by its inventory number')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Weapon number from /hunt inv weapons')
                                .setRequired(true)
                                .setMinValue(1)))
                .addSubcommand(sub =>
                    sub.setName('ammo')
                        .setDescription('View your ammo stocks'))
                .addSubcommand(sub =>
                    sub.setName('consumables')
                        .setDescription('View your consumables and active buffs'))
                .addSubcommand(sub =>
                    sub.setName('materials')
                        .setDescription('View your crafting materials'))
                .addSubcommand(sub =>
                    sub.setName('discard')
                        .setDescription('Discard a broken or condemned weapon')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Weapon number to discard')
                                .setRequired(true)
                                .setMinValue(1))))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily hunt quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('See your active daily hunt quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addStringOption(o =>
                            o.setName('quest')
                                .setDescription('Quest to claim')
                                .setRequired(true)
                                .addChoices(...HUNT_QUEST_TEMPLATES.map(t => ({ name: t.name, value: t.id }))))))
        .addSubcommandGroup(group =>
            group.setName('shop')
                .setDescription('Browse and purchase all hunting gear, ammo, and supplies')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse everything available in the hunting shop'))
                .addSubcommand(sub =>
                    sub.setName('weapon')
                        .setDescription('Buy a new hunting weapon')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which weapon to buy')
                                .setRequired(true)
                                .addChoices(...WEAPON_CHOICES))
                        .addBooleanOption(o =>
                            o.setName('equip')
                                .setDescription('Auto-equip after purchase (default: true)')
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('upgrade')
                        .setDescription('Install a module upgrade on your equipped weapon (one per weapon, permanent)')
                        .addStringOption(o =>
                            o.setName('module')
                                .setDescription('Upgrade module to install')
                                .setRequired(true)
                                .addChoices(...UPGRADE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('buy')
                        .setDescription('Purchase ammo packs or consumables')
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
                                .addChoices(...ACTIVATABLE.map(id => ({ name: CONSUMABLES[id].name, value: id })))))
                .addSubcommand(sub =>
                    sub.setName('repair')
                        .setDescription('Repair your equipped weapon at the shop or use a repair kit')
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
                                    { name: 'Small (+20 durability)', value: 'repair_kit_small' },
                                    { name: 'Large (+50 durability)', value: 'repair_kit_large' }
                                ))
                        .addIntegerOption(o =>
                            o.setName('amount')
                                .setDescription('Durability to restore at shop (default: full repair)')
                                .setRequired(false)
                                .setMinValue(20)))
                .addSubcommand(sub =>
                    sub.setName('unlock')
                        .setDescription('Unlock a new hunting zone')
                        .addStringOption(o =>
                            o.setName('zone')
                                .setDescription('Zone to unlock')
                                .setRequired(true)
                                .addChoices(...UNLOCK_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('zone')
                .setDescription('View and switch your active hunting zone')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View all zones and their unlock status'))
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Switch your active hunting zone')
                        .addStringOption(o =>
                            o.setName('zone')
                                .setDescription('Zone to switch to')
                                .setRequired(true)
                                .addChoices(...ZONE_SET_CHOICES)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'start')    return executeStart(interaction);
            if (sub === 'profile')  return executeProfile(interaction);
            if (sub === 'prestige') return executePrestige(interaction);
        }
        if (group === 'inv')    return executeInv(interaction, sub);
        if (group === 'quests') return executeQuests(interaction, sub);
        if (group === 'shop')   return executeShop(interaction, sub);
        if (group === 'zone')   return executeZone(interaction, sub);
    }
};

// ─── Staged loot reveal for rare+ drops ──────────────────────────────────────
// tier: 'common'|'uncommon'|'rare'|'epic'|'legendary'|'event'|null
async function stagedLootReveal(interaction, tier, finalEmbed) {
    const tierNum = TIER_NUM[tier] ?? 0;
    if (tierNum < 3) {
        await interaction.editReply({ embeds: [finalEmbed] });
        return;
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));

    const fogEmbed = new EmbedBuilder()
        .setColor('#4a4a4a')
        .setTitle('🌫️ Something stirs in the shadows...')
        .setDescription('━━━━━━━━━━━━━━━\n*The shadows shift. Something is here.*\n━━━━━━━━━━━━━━━');

    if (tierNum === 3) {
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
    } else {
        // Epic or Legendary: stage 1 — fog
        await interaction.editReply({ embeds: [fogEmbed] });
        await wait(1500);
        // Stage 2 — partial reveal
        const midColor = tierNum === 6 ? '#e74c3c' : tierNum === 4 ? '#9c27b0' : '#ff9800';
        const midTitle = tierNum === 6 ? '☄️ Every animal in the forest has gone silent...' : tierNum === 4 ? '🔮 Something exceptional emerges...' : '⚡ The air crackles with power...';
        const midTierLabel = tierNum === 6 ? 'EVENT' : tierNum === 4 ? 'EPIC' : 'LEGENDARY';
        const midEmbed = new EmbedBuilder()
            .setColor(midColor)
            .setTitle(midTitle)
            .setDescription(`━━━━━━━━━━━━━━━\n❓❓❓  **${midTierLabel}**  ❓❓❓\n━━━━━━━━━━━━━━━`);
        await interaction.editReply({ embeds: [midEmbed] });
        await wait(1500);
        if (tierNum >= 5) {
            // Stage 3 — legendary fanfare
            const isEvent = tierNum === 6;
            const fanfareEmbed = new EmbedBuilder()
                .setColor(isEvent ? '#e74c3c' : '#ff9800')
                .setTitle(isEvent ? '☄️ ⚡ 𝗠 𝗬 𝗧 𝗛 𝗜 𝗖 𝗔 𝗟 ⚡ ☄️' : '⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡')
                .setDescription(isEvent ? '━━━━━━━━━━━━━━━\n*Nothing like this has been seen in living memory.*\n━━━━━━━━━━━━━━━' : '━━━━━━━━━━━━━━━\n*The air crackles. This is once in a lifetime.*\n━━━━━━━━━━━━━━━');
            await interaction.editReply({ embeds: [fanfareEmbed] });
            await wait(1500);
        }
    }
    await interaction.editReply({ embeds: [finalEmbed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// START (was /hunt)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeStart(interaction) {
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
    ensureHuntData(user);
    applyStaminaRegen(user);
    applyDailyReset(user);
    assignDailyHuntQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[hunt] pre-check save error:', e));
    }

    const h = user.hunt;

    const requestedZone = interaction.options.getString('zone');
    const zoneId = requestedZone ?? h.activeZone;
    const zone   = ZONES[zoneId];

    if (!zone) {
        return interaction.reply({ content: `Unknown zone \`${zoneId}\`. Use \`/hunt zone list\` to see available zones.`, flags: MessageFlags.Ephemeral });
    }
    if (!h.unlockedZones.includes(zoneId)) {
        return interaction.reply({
            content: `You haven't unlocked **${zone.name}** yet. Use \`/hunt shop unlock\` to unlock it.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (h.level < zone.unlockLevel) {
        return interaction.reply({
            content: `You need to be Hunter Level **${zone.unlockLevel}** to hunt in **${zone.name}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    if (h.injuryUntil && Date.now() < h.injuryUntil.getTime()) {
        const remaining = h.injuryUntil.getTime() - Date.now();
        return interaction.reply({
            content: `You're injured and need to rest. Back in action in **${formatMs(remaining)}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // ── Hunt cooldown check (read-only; claimed atomically after preflight) ──
    if (h.lastHunt && Date.now() - h.lastHunt.getTime() < LIMITS.HUNT_COOLDOWN_MS) {
        const nextAt = new Date(h.lastHunt.getTime() + LIMITS.HUNT_COOLDOWN_MS);
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🫁 Catching Your Breath',
                description: 'You just came back from a hunt.\nGive it a moment before heading back out.',
                color: '#5a8a3c',
                nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (h.stamina <= 0) {
        const regenMs = msUntilNextStamina(user);
        const nextAt  = new Date(Date.now() + regenMs);
        const sinceRare = h.sinceRare ?? 0;
        const pityCap   = getRarePityThreshold(zone);
        const pityStat  = sinceRare >= 5
            ? `🎯 ${sinceRare} hunts since last Rare+ • guaranteed at ${pityCap} in ${zone.name}`
            : null;
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Out of Stamina',
                description: "You've pushed yourself to the limit.\nRest up — the wilderness will wait.\nBuy a **Stamina Tonic** from `/hunt shop` to recover faster.",
                color: '#5a8a3c',
                nextAt,
                pityStat,
                nextRewardPreview: `Full stamina = ${getMaxStamina(user)} hunts · Rare+ guaranteed after ${pityCap} dry hunts here`,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({
            content: `You don't have a weapon equipped! Buy one with \`/hunt shop weapon\` and equip it with \`/hunt inv equip 1\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const weapon = h.weapons[h.equippedWeaponIndex];

    if (weapon.status === 'broken' || weapon.currentDurability <= 0) {
        return interaction.reply({
            content: isCondemned(weapon)
                ? `Your **${weapon.name}** is broken beyond repair — too many shop repairs have worn it out. Buy a replacement with \`/hunt shop weapon\` and discard this one with \`/hunt inv discard\`.`
                : `Your **${weapon.name}** is broken! Repair it with \`/hunt shop repair\` or buy a new one with \`/hunt shop weapon\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const weaponData = WEAPON_BY_TIER[weapon.tier];
    if (weaponData.requiresAmmo && (h.ammo[weaponData.ammoType] ?? 0) <= 0) {
        return interaction.reply({
            content: `You're out of **${weaponData.ammoType.replace(/_/g, ' ')}**! Buy more with \`/hunt shop buy\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Atomically claim the cooldown slot now that all preflight checks have passed —
    // lastHunt is set the moment the hunt is actually accepted, not earlier, so a
    // failed precheck (stamina/weapon/ammo) never burns the cooldown. The same guard
    // still prevents two concurrent /hunt start calls from both slipping through.
    //
    // The claim targets GrindProfile, not User: hunt state lives in its own
    // collection (see src/models/User.js), so a User-level guard would match every
    // document on the missing `hunt` field and never reject anything.
    const huntClaimNow = new Date();
    const huntCooldownFloor = new Date(huntClaimNow.getTime() - LIMITS.HUNT_COOLDOWN_MS);
    const priorLastHunt = h.lastHunt ?? null;
    await persistGrindIfNew(user, 'hunt');
    const huntClaimQuery = { userId: interaction.user.id, guildId: interaction.guild.id, system: 'hunt' };
    const claimedHunt = await GrindProfile.findOneAndUpdate(
        {
            ...huntClaimQuery,
            $or: [{ 'data.lastHunt': null }, { 'data.lastHunt': { $lte: huntCooldownFloor } }],
        },
        { $set: { 'data.lastHunt': huntClaimNow } },
        { new: true },
    );

    if (!claimedHunt) {
        // Losing the claim means another hunt already took the slot, so the
        // in-memory snapshot is stale — read the winning timestamp back so the
        // countdown reflects the hunt that actually happened. If that read fails,
        // fall back to now rather than the snapshot: reaching the claim at all
        // means the snapshot was already past the cooldown floor, so it would
        // render a countdown in the past and tell the player they can hunt again.
        const current = await GrindProfile.findOne(huntClaimQuery).catch(() => null);
        const lastAt  = current?.data?.lastHunt ?? huntClaimNow;
        const nextAt  = new Date(new Date(lastAt).getTime() + LIMITS.HUNT_COOLDOWN_MS);
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🫁 Catching Your Breath',
                description: 'You just came back from a hunt.\nGive it a moment before heading back out.',
                color: '#5a8a3c',
                nextAt,
            })],
            flags: MessageFlags.Ephemeral,
        });
    }
    h.lastHunt = huntClaimNow;

    // The claim is a real write now, so a hunt that dies before its result is
    // saved would otherwise cost the player a full cooldown for nothing. Hand the
    // slot back — but only while it is still ours, so a newer claim isn't undone.
    const releaseHuntClaim = () => GrindProfile.updateOne(
        { ...huntClaimQuery, 'data.lastHunt': huntClaimNow },
        { $set: { 'data.lastHunt': priorLastHunt } },
    ).catch(() => null);

    // Everything between here and the save can still fail — a Discord API error
    // while collecting the approach prompts, a service throwing — and until the
    // result is persisted the player has nothing to show for the cooldown they
    // just paid for. Hand the slot back on the way out unless the hunt committed.
    let huntCommitted = false;

    // Everything below runs across the interactive prompts, during which the
    // player can spend coins elsewhere. The run's own coin movement is
    // collected as a delta against this reading and applied as an atomic
    // `$inc` at the save, so `save()` never writes an absolute balance read
    // before that window. See src/utils/balanceDelta.js.
    const balanceAtLoad = user.balance ?? 0;
    const balanceFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

    try {

        // Ammo comes out only once the cooldown slot is ours, so a lost race never
        // costs the player a round.
        if (weaponData.requiresAmmo) {
            h.ammo[weaponData.ammoType] = (h.ammo[weaponData.ammoType] ?? 0) - 1;
            user.markModified('hunt');
        }

        // ── Stealth Approach + Precision Aim ─────────────────────────────────────
        // Phase 1 — Stealth: player reads a behaviour hint and picks the right approach.
        //   Correct  → stealthBonus = +0.25 success chance, common→uncommon upgrade ~30%
        //   Partial  → stealthBonus = +0.05 (safe but suboptimal)
        //   Wrong    → stealthBonus = −0.10 (spooked the animal)
        //   Timeout  → stealthBonus = 0
        // Phase 2 — Aim: hold the shot until the target lines up, then fire.
        //   In the window  → aimBonus = +0.18 crit chance
        //   Late           → aimBonus = +0.08 crit chance
        //   Early          → aimBonus = −0.05 crit chance (rushed the shot)
        //   Timeout        → aimBonus = 0

        let stealthBonus = 0;
        let aimBonus     = 0;

        const approachData = ZONE_APPROACHES[zoneId];
        const delay = ms => new Promise(r => setTimeout(r, ms));

        if (approachData) {
            // Shuffle the 3 options
            const shuffled = [...approachData.options].sort(() => Math.random() - 0.5);

            const stealthEmbed = new EmbedBuilder()
                .setColor('#556B2F')
                .setTitle(`🌿 Approaching ${zone.emoji} ${zone.name}…`)
                .setDescription(
                    `*${approachData.hint}*\n\n` +
                    `**How do you close in on your prey?**\n` +
                    `Choose wisely — the animal will react to your approach.`
                )
                .setFooter({ text: 'You have 15 seconds — or the hunt begins without a stealth bonus.' });

            const stealthRow = new ActionRowBuilder().addComponents(
                ...shuffled.map(opt => new ButtonBuilder()
                    .setCustomId(`stealth_${opt.id}`)
                    .setLabel(opt.label)
                    .setStyle(ButtonStyle.Primary)
                )
            );

            await interaction.reply({ embeds: [stealthEmbed], components: [stealthRow] });
            const huntMsg = await interaction.fetchReply();

            const pickedId = await new Promise(resolve => {
                const col = huntMsg.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id && i.customId.startsWith('stealth_'),
                    time: 15_000,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(i.customId.replace('stealth_', '')); });
                col.on('end',     (_, reason) => { if (reason !== 'limit') resolve(null); });
            });

            const chosen = shuffled.find(o => o.id === pickedId);
            if (chosen) {
                const isCorrectChoice = pickedId === approachData.correctId;
                const isNeutralChoice = !isCorrectChoice && chosen.stealthBonus >= 0;
                // Probabilistic outcome: correct=80% success, neutral=50%, wrong=20%
                const successChance = isCorrectChoice ? 0.80 : isNeutralChoice ? 0.50 : 0.20;
                const approachSucceeded = Math.random() < successChance;
                if (approachSucceeded) {
                    stealthBonus = chosen.stealthBonus;
                } else {
                    // Correct/neutral failed: animal startled; wrong: already bad, just slightly worse
                    stealthBonus = isNeutralChoice ? 0 : -0.10;
                }
            }

            const isCorrect  = pickedId === approachData.correctId;
            const isTimeout  = pickedId === null;
            const chosenLabel = chosen?.label ?? '';
            const stealthResultEmbed = new EmbedBuilder()
                .setColor(
                    isTimeout ? '#888888' :
                    stealthBonus > 0 ? '#00FF7F' :
                    stealthBonus < 0 ? '#FF6B6B' : '#FFA500'
                )
                .setTitle(
                    isTimeout  ? '⏰ Hesitated too long…' :
                    isCorrect && stealthBonus > 0 ? '🤫 Perfect approach!' :
                    isCorrect && stealthBonus <= 0 ? '🐾 So close — it sensed you anyway…' :
                    stealthBonus > 0 ? '🤔 Decent approach…' :
                    stealthBonus < 0 ? '🔊 You spooked the animal!' :
                    '🤔 No harm done…'
                )
                .setDescription(
                    isTimeout
                        ? `You weighed your options too long — the window closed.\n\nNo stealth bonus this hunt.`
                        : isCorrect && stealthBonus > 0
                        ? `**${chosenLabel}**\n\n*You read the terrain perfectly. The animal froze for a moment — then relaxed. It never sensed you.*\n\n**+25% success chance** and a chance of better prey.`
                        : isCorrect && stealthBonus <= 0
                        ? `**${chosenLabel}**\n\n*The right call — but the animal picked up something off. A twig snapped, the wind shifted. No bonus this time.*\n\n**No stealth bonus.**`
                        : stealthBonus > 0
                        ? `**${chosenLabel}**\n\n*Not the ideal approach, but you kept your noise down. The animal stirred — then settled.*\n\n**+5% success chance.**`
                        : stealthBonus < 0
                        ? `**${chosenLabel}**\n\n*The animal heard you before you got within range. It fixed you with a stare — every advantage lost.*\n\n**−10% success chance** this hunt.`
                        : `**${chosenLabel}**\n\n*Could've gone worse. The animal wasn't alarmed, but you didn't gain any ground either.*\n\n**No stealth bonus.**`
                );

            await interaction.editReply({ embeds: [stealthResultEmbed], components: [] });
            await delay(800);

            // ── Aim Phase ──────────────────────────────────────────────────────────
            // The Fire button is attached with the "sights" embed, not after it,
            // so the shot can genuinely be taken early — which is what the
            // footer has always warned about. The button used to arrive only
            // once the wait had elapsed, so firing early was impossible and the
            // grade was decided purely by how fast the click came back: under
            // 800ms of round trip paid +18% crit, anything slower +8%. That
            // scored the player's connection, not their play, and paid at least
            // +8% for any click at all.
            //
            // Now the wait is the mechanic. The window opens at a random moment
            // the player cannot anticipate and stays open long enough that a
            // slow connection still comfortably clears it — so what separates
            // the outcomes is *when* you fire, not how fast the wire is.
            const aimWaitMs = 1000 + Math.floor(Math.random() * 1001);

            const fireId  = `hunt_fire_${interaction.id}`;
            const aimRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(fireId).setLabel('🔫 Fire!').setStyle(ButtonStyle.Danger)
            );
            const aimSightsEmbed = new EmbedBuilder()
                .setColor('#8B0000')
                .setTitle('🎯 Target in Sights…')
                .setDescription('*Hold your breath… wait for the shot to line up.*')
                .setFooter({ text: 'Fire when the shot is called — rush it and you spoil the shot.' });

            await interaction.editReply({ embeds: [aimSightsEmbed], components: [aimRow] });
            const aimTime = Date.now();

            let shotTaken = false;
            const shot = new Promise(resolve => {
                const col = huntMsg.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id && i.customId === fireId,
                    time: aimWaitMs + AIM_LATE_MS,
                    max: 1,
                });
                col.on('collect', async i => { await i.deferUpdate(); resolve(Date.now() - aimTime); });
                col.on('end',     (_, reason) => { if (reason !== 'limit') resolve(null); });
            }).then(ms => { shotTaken = ms !== null; return ms; });

            // Call the shot when the window opens — unless it has already been
            // taken, in which case editing to "FIRE!" would tell a player who
            // jumped the gun that they were right on time.
            //
            // The window is timed from when the call is actually on screen, not
            // from when the wait elapsed: the edit is a round trip of its own,
            // and charging it to the player would put the latency straight back
            // into the grade this phase exists to take it out of.
            let windowOpensAt = aimWaitMs;
            await Promise.race([shot, delay(aimWaitMs)]);
            if (!shotTaken) {
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('💥 FIRE!')
                        .setDescription('**Take the shot — NOW!**')],
                    components: [aimRow],
                });
                windowOpensAt = Date.now() - aimTime;
            }

            const shotMs = await shot;
            const aim    = gradeShot(shotMs, windowOpensAt);
            aimBonus     = aim.bonus;

            await interaction.editReply({ embeds: [aim.embed()], components: [] });
            await delay(600);

        } else {
            await interaction.deferReply();
        }

        // Wolf pet: +10% coin yield; Eagle pet: +15% XP (only if hunger >= 30)
        const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, isPetActive, TRAIT_FLAVOR, tryGrantRarePet } = require('../../services/petService');
        const petYieldPct = getTotalBonus(user.pets || [], 'hunt_yield');
        const petXpPct    = getTotalBonus(user.pets || [], 'hunt_xp');

        const featured       = getDailyFeatured(interaction.guild.id);
        const isFeaturedZone = zoneId === featured.huntZone.id;

        const marketplaceActive = isDistrictActive(guildSettings, 'marketplace');
        const result = executeHunt(user, zoneId, { stealthBonus, aimBonus, marketplaceActive });

        // Pity counter: reset on rare+ success, increment otherwise
        if (result.success && ['rare', 'epic', 'legendary', 'event'].includes(result.tier)) {
            user.hunt.sinceRare = 0;
        } else {
            user.hunt.sinceRare = (user.hunt.sinceRare ?? 0) + 1;
        }

        if (result.success && result.finalPayout > 0 && petYieldPct > 0) {
            const remaining = Math.max(0, LIMITS.DAILY_HARD_CAP - user.hunt.dailyCoins);
            const bonus = Math.min(Math.round(result.finalPayout * petYieldPct / 100), remaining);
            if (bonus > 0) {
                user.balance           += bonus;
                user.hunt.totalEarned  += bonus;
                user.hunt.dailyCoins   += bonus;
                result.finalPayout     += bonus;
                result.petYieldBonus    = bonus;
            }
        }
        if (result.success && result.xpEarned > 0 && petXpPct > 0) {
            const xpBonus = Math.round(result.xpEarned * petXpPct / 100);
            if (xpBonus > 0) {
                const petLevelUp = applyXp(user, xpBonus);
                result.xpEarned      += xpBonus;
                result.petXpBonus     = xpBonus;
                if (petLevelUp.leveledUp) {
                    // Fold into any level-up the base XP already produced so the embed
                    // reports one old → new span rather than two.
                    result.levelUp = {
                        oldLevel:  result.levelUp?.oldLevel ?? petLevelUp.oldLevel,
                        newLevel:  petLevelUp.newLevel,
                        leveledUp: true,
                    };
                }
            }
        }

        // Featured zone bonus: +25% payout
        if (result.success && result.finalPayout > 0 && isFeaturedZone) {
            const remaining = Math.max(0, LIMITS.DAILY_HARD_CAP - user.hunt.dailyCoins);
            const featBonus = Math.min(Math.round(result.finalPayout * FEATURED_PAYOUT_BONUS), remaining);
            if (featBonus > 0) {
                user.balance              += featBonus;
                user.hunt.totalEarned     += featBonus;
                user.hunt.dailyCoins      += featBonus;
                result.finalPayout        += featBonus;
                result.featuredZoneBonus   = featBonus;
            }
        }
        // Wilderness district: +10% hunt yield (clamped to daily hard cap)
        const wildernessActive = isDistrictActive(guildSettings, 'wilderness');
        if (result.success && result.finalPayout > 0 && wildernessActive) {
            const remaining = LIMITS.DAILY_HARD_CAP - user.hunt.dailyCoins;
            const rawBonus  = Math.round(result.finalPayout * WILDERNESS_YIELD_BONUS);
            const bonus     = Math.max(0, Math.min(rawBonus, remaining));
            if (bonus > 0) {
                user.balance           += bonus;
                user.hunt.totalEarned  += bonus;
                user.hunt.dailyCoins   += bonus;
                result.finalPayout     += bonus;
                result.wildernessBonus  = bonus;
            }
        }
        if (result.success && result.finalPayout > user.hunt.bestPayout) user.hunt.bestPayout = result.finalPayout;

        updateHuntQuestProgress(user, result, zoneId);
        await ensureQuests(user, guildSettings);
        const { completed: questsDone, nearComplete: questsNear } = await onHunt(user, guildSettings);
        // Season pass daily missions listen for the same actions quests do.
        recordMissionProgress(user, 'hunt', 1, guildSettings);
        if (result.success && result.finalPayout > 0) {
            const earn = await onEconomyEarn(user, guildSettings, result.finalPayout);
            questsDone.push(...earn.completed);
            questsNear.push(...earn.nearComplete);
        }

        // Rare companions are found, not bought: a legendary result is the only
        // thing that can turn one up. Rolled before the save below persists it.
        const rarePetDrop = result.success ? tryGrantRarePet(user, 'hunt', result.tier) : null;
        if (rarePetDrop) user.markModified('pets');

        const huntAchievements = await checkAndAward(user, guildSettings).catch(() => []);

        // Hand the run's coin movement to an atomic `$inc` and take `balance` out
        // of the save. A path that reverses its own reward nets to zero and
        // issues no write.
        const balanceDelta = detachBalanceDelta(user, balanceAtLoad);

        let payoutOwed = 0;
        try {
            await user.save();
            huntCommitted = true;
            // Only after the save has landed: a credit applied before a save that
            // then failed would pay for a run the player could take again. The two
            // cannot be one write on a standalone mongod, so a credit that will
            // not land is recorded as owed and said out loud rather than logged
            // and forgotten.
            const payout = await commitBalanceDelta(User, balanceFilter, user, balanceDelta, {
                service: 'hunt',
                jobName: 'huntPayout',
                guildId: interaction.guild.id,
            });
            if (!payout.credited) payoutOwed = balanceDelta;
            if (huntAchievements.length) {
                announceAchievements(interaction.client, guildSettings, user, interaction.member, huntAchievements).catch(() => null);
            }
            notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
            notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
        } catch (err) {
            // Nothing was saved, so give the cooldown slot back before telling them to retry.
            await releaseHuntClaim();
            if (isVersionError(err)) {
                return interaction.editReply({ content: 'A simultaneous request conflicted with your hunt. Please try `/hunt start` again.' });
            }
            console.error('[hunt] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your hunt. Please try again.' });
        }

        // Log big win, then await hourly leader update and re-fetch for accurate footer
        if (result.success && result.finalPayout > 0) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (result.finalPayout >= bigWinThreshold || ['legendary', 'event'].includes(result.tier)) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'hunt', details: { itemName: result.animal?.name, rarity: result.tier }, client: interaction.client });
            }
            await tryUpdateHourlyWinner({ guildId: interaction.guild.id, category: 'hunt', userId: interaction.user.id, username: interaction.user.username, value: result.finalPayout, details: result.animal ? `${result.animal.emoji} ${result.animal.name} (${currency}${result.finalPayout.toLocaleString()})` : null }).catch(() => null);
        }
        const hourlyLeader = await getCurrentHourlyLeader(interaction.guild.id, 'hunt').catch(() => null);

        const timeBand = getTimeBand();
        const embed = buildHuntEmbed(result, user, zone, weapon, currency, interaction.user);

        if (payoutOwed > 0) {
            embed.addFields({
                name: '⚠️ Payout Not Yet Credited',
                value: `The **${currency}${payoutOwed.toLocaleString()}** from this hunt could not be paid out just now and has been recorded as owed — the balance shown below does not include it. It will be applied once the problem clears; tell an admin if it does not.`,
            });
        }
        {
            const desc = embed.data.description ?? '';
            const lines = [];
            if (stealthBonus > 0.10) lines.push(`> 🤫 *Perfect approach — +25% success, chance of better prey*`);
            else if (stealthBonus > 0) lines.push(`> 🌿 *Decent approach — +5% success*`);
            else if (stealthBonus < 0) lines.push(`> 🔊 *Spooked the animal — −10% success*`);
            if (aimBonus >= 0.18) lines.push(`> 🎯 *Perfect shot — +18% crit chance*`);
            else if (aimBonus > 0) lines.push(`> ✅ *Clean shot — +8% crit chance*`);
            else if (aimBonus < 0) lines.push(`> 💨 *Rushed shot — −5% crit chance*`);
            if (lines.length) embed.setDescription(desc + '\n' + lines.join('\n'));
        }
        // One consolidated field rather than one per bonus: Discord caps an embed at
        // 25 fields, and giving each its own put a maximal hunt within one of the
        // limit. Grouping them also reads better — they are all the same idea.
        const bonusLines = buildBonusLines(result, petYieldPct, petXpPct);
        if (bonusLines.length) {
            embed.addFields({ name: '✨ Bonuses', value: bonusLines.join('\n'), inline: false });
        }

        // Hourly leader footer
        const leaderNote = hourlyLeader
            ? `🏆 Hourly leader: ${hourlyLeader.username} — ${hourlyLeader.details ?? hourlyLeader.value.toLocaleString() + ' coins'}`
            : '🏆 No hourly leader yet — be the first!';
        const footerBase = `${timeBand.emoji} ${timeBand.label}`;
        const currentFooter = embed.data.footer?.text ?? '';
        embed.setFooter({ text: currentFooter ? `${currentFooter} · ${footerBase} · ${leaderNote}` : `${footerBase} · ${leaderNote}` });

        if (isFeaturedZone) {
            const desc = embed.data.description ?? '';
            embed.setDescription(desc + `\n> 🌟 *Featured Zone: ${zone.emoji} ${zone.name} — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout bonus active!*`);
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
        if (result.success) {
            const activePet = (user.pets || []).find(p => isPetActive(p));
            if (activePet) {
                const petDef = PET_DEFS[activePet.petId];
                const petName = activePet.name || petDef?.name || activePet.petId;
                const flavorFn = TRAIT_FLAVOR[activePet.personality]?.hunt;
                if (flavorFn && petDef) {
                    const desc = embed.data.description ?? '';
                    embed.setDescription(desc + `\n> ${flavorFn(petName, petDef.emoji)}`);
                }
            }
        }

        // Discord rejects an embed with more than 25 fields. A maximal hunt — crit,
        // traits, trait effects, special drop, booster proc, level-up, both buffs
        // expiring, weapon warning, pity, plus the pet / featured-zone / district
        // bonuses — now reaches 24. Trim rather than lose the whole result embed to
        // an exception if another field is added later.
        if (embed.data.fields && embed.data.fields.length > 25) {
            embed.data.fields.length = 25;
        }

        // Staged loot reveal for rare+ drops
        await stagedLootReveal(interaction, result.success ? result.tier : null, embed);

        if (result.success && ['epic', 'legendary', 'event'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId;
            const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
            const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
            const announceTier = TIER_NUM[result.tier] ?? 4;
            const ANNOUNCE_COPY = {
                4: { color: '#9c27b0', title: '🔮 Epic Find!',              line: 'A rare moment in the wild.' },
                5: { color: '#ff9800', title: '✨ Legendary Trophy! ✨',     line: 'Only a handful of hunters have ever managed that.' },
                6: { color: '#e74c3c', title: '☄️ Mythical Quarry! ☄️',     line: 'Nothing like it has been seen in living memory.' },
            };
            const copy = ANNOUNCE_COPY[announceTier] ?? ANNOUNCE_COPY[4];
            const announcementEmbed = new EmbedBuilder()
                .setColor(copy.color)
                .setTitle(copy.title)
                .setDescription(
                    `<@${interaction.user.id}> just brought down ${result.animal.emoji} **${result.animal.name}** [${TIER_STARS[announceTier]}]\n` +
                    `deep in the **${zone.name}**.\n\n` +
                    copy.line
                )
                .setTimestamp();
            announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
        }

        // ── Apex encounter — multi-phase showdown (mirrors the fishing boss UI) ──
        if (result.apexEncounter) {
            // Pin the weapon that was actually equipped for this encounter so durability
            // loss can't land on a different weapon if the player re-equips mid-flow.
            const apexWeaponIndex = user.hunt.equippedWeaponIndex;
            const apexType    = rollApexType();
            const choicesMade = [];
            const phaseCount  = apexType.phases.length;

            const buildApexPhaseEmbed = (phaseIndex, prevResults) => {
                const phase  = apexType.phases[phaseIndex];
                const nerveMax  = apexNerveMax(user);
                const nerve     = apexNerveAfter(prevResults, user);
                const nerveBar  = '❤️'.repeat(nerve) + '🖤'.repeat(nerveMax - nerve);
                const histLines = prevResults.map((p, i) => {
                    const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
                    return `Phase ${i + 1}: ${icon}`;
                }).join('  ');

                return new EmbedBuilder()
                    .setColor('#3b1f04')
                    .setTitle(`${apexType.emoji} ${apexType.name} — Phase ${phaseIndex + 1}/${phaseCount}`)
                    .setDescription(
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `  ${result.apexEncounter.animal.emoji}  The pack leader of your **${result.apexEncounter.animal.name}** appears!\n` +
                        `  Nerve: ${nerveBar}\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `${phase.hint}\n\n` +
                        (histLines ? `${histLines}\n\n` : '') +
                        `**Choose your move — NOW:**`
                    )
                    .setFooter({ text: `⏱️ 30 seconds per phase • 3/3=1.5x bonus | 2/3=1x | 1/3=0.4x • A wrong read costs 2 nerve — at 0 it escapes. Backing off is safe but never counts.` });
            };

            const buildPhaseRow = (phaseIndex) => {
                const choices = apexType.phases[phaseIndex].choices;
                return new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('apex_match').setLabel(choices.match.label).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('apex_hold').setLabel(choices.hold.label).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('apex_safe').setLabel(choices.safe.label).setStyle(ButtonStyle.Secondary)
                );
            };

            const validIds = ['apex_match', 'apex_hold', 'apex_safe'];
            const idToKey  = { apex_match: 'match', apex_hold: 'hold', apex_safe: 'safe' };

            await interaction.editReply({ embeds: [embed, buildApexPhaseEmbed(0, [])], components: [buildPhaseRow(0)] });

            const runPhase = async (phaseIndex, prevResults, prevBtn) => {
                const fetchReply = prevBtn ? await prevBtn.fetchReply() : await interaction.fetchReply();
                return new Promise(resolve => {
                    const collector = fetchReply.createMessageComponentCollector({
                        filter: i => i.user.id === interaction.user.id && validIds.includes(i.customId),
                        time: 30_000, max: 1
                    });
                    collector.on('collect', async btn => {
                        const chosen  = idToKey[btn.customId];
                        const phase   = apexType.phases[phaseIndex];
                        const correct = chosen === phase.correct;
                        const results = [...prevResults, { correct, chosen, correctChoice: phase.correct }];
                        choicesMade.push(chosen);

                        if (phaseIndex < phaseCount - 1) {
                            await btn.update({ embeds: [embed, buildApexPhaseEmbed(phaseIndex + 1, results)], components: [buildPhaseRow(phaseIndex + 1)] });
                            resolve({ btn, results });
                        } else {
                            resolve({ btn, results, done: true });
                        }
                    });
                    collector.on('end', (collected, reason) => {
                        if (reason === 'time' && collected.size === 0) {
                            resolve({ btn: null, results: prevResults, timedOut: true });
                        }
                    });
                });
            };

            let state = { btn: null, results: [], done: false, timedOut: false };
            for (let i = 0; i < phaseCount; i++) {
                state = await runPhase(i, state.results, state.btn);
                if (state.timedOut) {
                    const timeoutEmbed = new EmbedBuilder()
                        .setColor('#3b1f04')
                        .setTitle(`💨 ${apexType.emoji} The ${apexType.name} Escaped`)
                        .setDescription('You hesitated too long — it melted back into the wild. No bonus this time.')
                        .setTimestamp();
                    interaction.editReply({ embeds: [embed, timeoutEmbed], components: [] }).catch(() => {});
                    return;
                }
            }

            // Resolve outcome on a fresh user document
            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            if (!freshUser) {
                console.error(`[hunt apex] user document vanished mid-encounter — user=${interaction.user.id} guild=${interaction.guild.id}`);
                return state.btn.update({ content: 'Something went wrong resolving the encounter — your hunt rewards were already saved.', embeds: [embed], components: [] }).catch(() => {});
            }
            await attachGrind(freshUser);
            ensureHuntData(freshUser);
            const apexResult = resolveApexEncounter(freshUser, result.apexEncounter.animal, result.apexEncounter.tier, choicesMade, apexType, apexWeaponIndex);

            // The reload above is already seconds old by the time the fight
            // resolves, and `save()` writes `balance` as an absolute `$set` — so
            // the bonus is applied as its own `$inc` and `balance` stays out of
            // the save, exactly as the hunt itself does.
            const apexBalanceAtLoad = freshUser.balance ?? 0;

            let apexQuestsDone = [], apexQuestsNear = [];
            if (apexResult.bonusPayout > 0) {
                const apexZone = ZONES[freshUser.hunt.activeZone] ?? zone;
                // The apex fight is part of this hunt, so it rides on the gathering
                // charge the kill already spent rather than burning a second one —
                // otherwise a booster drains fastest on exactly the rare kills that
                // trigger an apex in the first place.
                const { adjustedPayout } = applyPayoutModifiers(freshUser, apexResult.bonusPayout, apexZone, {
                    reuseGatheringYield: !!result.gatheringYield,
                });
                apexResult.bonusPayout = adjustedPayout;
                freshUser.balance          += adjustedPayout;
                freshUser.hunt.totalEarned += adjustedPayout;
                freshUser.hunt.dailyCoins  += adjustedPayout;
                if (adjustedPayout > freshUser.hunt.bestPayout) freshUser.hunt.bestPayout = adjustedPayout;

                await ensureQuests(freshUser, guildSettings);
                const earn = await onEconomyEarn(freshUser, guildSettings, adjustedPayout);
                apexQuestsDone = earn.completed;
                apexQuestsNear = earn.nearComplete;
            }
            freshUser.markModified('hunt');
            let apexPayoutOwed = 0;
            try {
                // Same contract as the hunt's own payout: a credit that would not
                // land is recorded as owed, and has to be said out loud rather
                // than rendered as a bonus the player was paid.
                const apexPaid = await saveWithBalanceDelta(User, freshUser, apexBalanceAtLoad, {
                    service: 'hunt',
                    jobName: 'apexBonusPayout',
                    guildId: interaction.guild.id,
                });
                if (!apexPaid.credited) apexPayoutOwed = apexResult.bonusPayout;
                if (apexQuestsDone.length || apexQuestsNear.length) {
                    notifyQuestComplete(guildSettings, interaction.member, apexQuestsDone, interaction.channel, freshUser).catch(() => null);
                    notifyQuestNearComplete(guildSettings, interaction.member, apexQuestsNear, interaction.channel).catch(() => null);
                }
            } catch (saveErr) {
                console.error('[hunt apex] save error:', saveErr);
                return state.btn.update({ content: 'Something went wrong saving your apex result — the encounter is lost and cannot be retried. Your original hunt rewards were already saved.', embeds: [], components: [] }).catch(() => {});
            }

            if (apexResult.bonusPayout > 0) {
                const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
                if (apexResult.bonusPayout >= bigWinThreshold) {
                    logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: apexResult.bonusPayout, source: 'hunt', details: { itemName: result.apexEncounter.animal.name, rarity: 'apex' }, client: interaction.client });
                }
            }

            const phaseScoreLine = apexResult.phaseResults.map((p, i) => {
                const icon = p.correct ? '✅' : p.chosen === 'safe' ? '🛡️' : '❌';
                return `Phase ${i + 1}: ${icon}`;
            }).join('  ');

            const outcomeColors = { perfect: '#FFD700', win: '#2ecc71', survived: '#3498db', escaped: '#3b1f04' };
            const outcomeTitles = {
                perfect:  `🏆 ${apexType.emoji} PERFECT — ${apexType.name} Brought Down!`,
                win:      `✅ ${apexType.emoji} ${apexType.name} Defeated!`,
                survived: `😓 ${apexType.emoji} You Survived the ${apexType.name}`,
                escaped:  `💀 ${apexType.emoji} The ${apexType.name} Escaped`
            };

            const apexEmbed = new EmbedBuilder()
                .setColor(outcomeColors[apexResult.outcome])
                .setTitle(outcomeTitles[apexResult.outcome])
                .setDescription(
                    `${apexResult.message}\n\n${phaseScoreLine}\n\n` +
                    (apexResult.bonusPayout > 0
                        ? `💰 Bonus trophy: **+${currency}${apexResult.bonusPayout.toLocaleString()}**`
                        : '*No bonus this time — but you lived to tell the tale.*') +
                    `\n🔧 Weapon wear: -${apexResult.durabilityLost} durability`
                )
                .setTimestamp();

            if (apexPayoutOwed > 0) {
                apexEmbed.addFields({
                    name: '⚠️ Payout Not Yet Credited',
                    value: `The **${currency}${apexPayoutOwed.toLocaleString()}** bonus could not be paid out just now and has been recorded as owed — your balance does not include it yet. It will be applied once the problem clears; tell an admin if it does not.`,
                });
            }

            await state.btn.update({ embeds: [embed, apexEmbed], components: [] }).catch(() => {});
            return;
        }
    } catch (err) {
        if (!huntCommitted) await releaseHuntClaim();
        throw err;
    }
}

function buildHuntEmbed(result, user, zone, weapon, currency, discordUser) {
    const h = user.hunt;

    if (result.success) {
        const { animal, tier, traits, finalPayout, isCrit, critMultiplier, trophyQuality, specialDrop, xpEarned, levelUp, cappedByHard, traitEffects } = result;
        // An event catch keeps its own colour even on a critical: the tier is the
        // rarer fact of the two, and the title already announces it as one. Without
        // this a critical event drop rendered crit-gold under a MYTHICAL headline.
        const color = tier === 'event' ? TIER_COLORS.event : isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const payoutDisplay = cappedByHard
            ? `~~${currency}${(result.forfeitedPayout ?? 0).toLocaleString()}~~\n*Daily cap reached — resets in ${formatMs(msUntilDailyReset(h))}*`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const qualityLabel = trophyQuality
            ? `${trophyQuality.emoji} **${trophyQuality.label}** (×${trophyQuality.multiplier.toFixed(2)})`
            : '—';

        const tierNum    = TIER_NUM[tier] ?? 1;
        const isEvent    = tier === 'event';
        const isHeadline = tierNum >= 5;   // legendary and event both get the full treatment
        const ribbon = TIER_RIBBON(tierNum);
        const embedTitle = isHeadline
            ? (isEvent ? `☄️⚡ MYTHICAL FIND ⚡☄️` : `🌟✨ LEGENDARY FIND ✨🌟`)
            : `${animal.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${trophyQuality ? trophyQuality.label + ' ' : ''}${animal.name}${isCrit ? ' ✨' : ''}`;
        const headlineLede = isEvent
            ? 'Something walked out of the treeline that has no business existing.'
            : 'You found something impossible in the wild.';
        const embedDesc = isHeadline
            ? `${ribbon}\n\n${headlineLede}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${animal.emoji}  **${animal.name}**  [${TIER_STARS[tierNum]}]\n  *${animal.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : `${ribbon}\n\n*${animal.flavor}*`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(embedTitle)
            .setDescription(embedDesc)
            .addFields(
                { name: 'Zone',     value: `${zone.emoji} ${zone.name}`,         inline: true },
                { name: 'Tier',     value: `${tierLabel}`,                        inline: true },
                { name: 'Quality',  value: qualityLabel,                          inline: true },
                { name: 'Reward',   value: payoutDisplay,                         inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit bonus)' : ''}`, inline: true },
                { name: 'Weapon',   value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                inline: true }
            );

        const huntMultEntries = [];
        if ((result.streakMult ?? 1) > 1.0) huntMultEntries.push({ emoji: '🔥', label: `${(result.streakMult).toFixed(2)}x` });
        if (isCrit)                          huntMultEntries.push({ emoji: '⚡', label: `${critMultiplier.toFixed(2)}x crit` });
        if (trophyQuality && trophyQuality.multiplier > 1.0) huntMultEntries.push({ emoji: trophyQuality.emoji, label: `${trophyQuality.multiplier.toFixed(2)}x` });
        if (huntMultEntries.length > 0) {
            const combined = (result.streakMult ?? 1) * critMultiplier * (trophyQuality?.multiplier ?? 1);
            embed.addFields({ name: '📈 Multipliers', value: stackBar(huntMultEntries, combined, finalPayout, currency), inline: false });
        }

        if (traits && traits.length > 0) {
            const traitLine = traits.map(t => {
                const def = ANIMAL_TRAITS[t];
                return def ? `${def.emoji} **${def.name}**` : t;
            }).join('  ');
            embed.addFields({ name: '🧬 Traits', value: traitLine, inline: false });
        }

        if (traitEffects && traitEffects.length > 0) {
            const effectLines = traitEffects.map(e => `• ${e.msg}`).join('\n');
            embed.addFields({ name: '⚡ Trait Effects', value: effectLines, inline: false });
        }

        const dailyToll = buildDailyTollField(result, user, currency);
        if (dailyToll) embed.addFields(dailyToll);

        if (specialDrop) {
            embed.addFields({ name: '🎁 Special Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        }

        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
        }

        const expiredBuffs = [];
        if (result.expiredBait)  expiredBuffs.push(`🪱 Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`);
        if (result.expiredCharm) expiredBuffs.push(`🍀 Your luck charm has worn off.`);
        if (expiredBuffs.length) {
            embed.addFields({ name: 'Buffs Expired', value: expiredBuffs.join('\n'), inline: false });
        }

        if (weapon.status === 'broken') {
            embed.addFields({ name: '⚠️ Weapon Broke!', value: buildBrokenWeaponNote(weapon), inline: false });
        } else if (weapon.currentDurability <= Math.floor(weapon.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your **${weapon.name}** is nearly worn out (${weapon.currentDurability}/${weapon.maxDurability}). Repair soon!`, inline: false });
        }

        const balanceLine = `${currency}${user.balance.toLocaleString()}`;
        const xpLine = buildXpLine(user);
        embed.addFields({ name: 'Balance', value: balanceLine, inline: true }, { name: 'Hunter XP', value: xpLine, inline: true });

        const sinceRareNow = user.hunt.sinceRare ?? 0;
        if (sinceRareNow >= 5) embed.addFields(buildPityField(user, zone));

        embed.setFooter({ text: `Cooldown: 45s • ${buildActiveConsumablesLine(user)}` });
        embed.setTimestamp();
        return embed;
    }

    const { failure, xpEarned, levelUp, animal: failAnimal, traits: failTraits, traitEffects: failTraitEffects } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(failAnimal ? `*Encountered: ${failAnimal.emoji} **${failAnimal.name}***\n${failure.message}` : `*${failure.severity.id === 'clean_miss' ? randomFrom(HUNT_EMPTY_LINES) : failure.message}*`)
        .addFields(
            { name: 'Zone',    value: `${zone.emoji} ${zone.name}`,  inline: true },
            { name: 'Reward',  value: 'Nothing',                      inline: true },
            { name: 'XP',      value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Weapon',  value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
            {
                name: 'Stamina',
                value: result.staminaSpared
                    ? `${buildStaminaLine(user)}\n*Clean miss — no stamina spent*`
                    : buildStaminaLine(user),
                inline: true
            }
        );

    if ((user.hunt.consecutiveFails ?? 0) > 0) {
        embed.addFields(buildPityStreakField(user.hunt.consecutiveFails, LIMITS, PITY_COPY.hunt));
    }

    if (failTraits && failTraits.length > 0) {
        const traitLine = failTraits.map(t => {
            const def = ANIMAL_TRAITS[t];
            return def ? `${def.emoji} **${def.name}**` : t;
        }).join('  ');
        embed.addFields({ name: '🧬 Traits', value: traitLine, inline: false });
    }

    if (failTraitEffects && failTraitEffects.length > 0) {
        const effectLines = failTraitEffects.map(e => `• ${e.msg}`).join('\n');
        embed.addFields({ name: '⚡ Trait Effects', value: effectLines, inline: false });
    }

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Injured', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }

    if (result.deathEvent) {
        if (result.deathEvent.saved) {
            embed.setColor('#e67e22');
            embed.addFields({ name: '🛟 Lifesaver Activated!', value: `A severe injury would have destroyed your **${result.deathEvent.weaponName}**, but your Lifesaver absorbed it! (consumed)`, inline: false });
        } else {
            embed.setColor('#8B0000');
            embed.addFields({
                name: '💀 Severe Injury!',
                value: isCondemned(weapon)
                    ? `The encounter was catastrophic — your **${result.deathEvent.weaponName}** was wrecked outright, and it's condemned: too many shop repairs have worn it out, so it can't be fixed. Replace it with \`/hunt shop weapon\`.`
                    : `The encounter was catastrophic — your **${result.deathEvent.weaponName}** was wrecked outright! Use \`/hunt shop repair\` to fix it.`,
                inline: false
            });
        }
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    if (weapon.status === 'broken' && !result.deathEvent) {
        embed.addFields({ name: '❌ Weapon Broke!', value: buildBrokenWeaponNote(weapon), inline: false });
    }

    const sinceRareNow = user.hunt.sinceRare ?? 0;
    if (sinceRareNow >= 5) embed.addFields(buildPityField(user, zone));

    embed.setFooter({ text: 'Tip: Use consumables from /hunt shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

/**
 * Lines for the consolidated "✨ Bonuses" field — every extra that stacked on top
 * of the base payout, in the order they were applied.
 */
function buildBonusLines(result, petYieldPct, petXpPct) {
    const lines = [];

    if (result.gatheringYield) {
        const { label, emoji, chargesLeft } = result.gatheringYield;
        lines.push(`${emoji} **${label}** — payout doubled · ${
            chargesLeft > 0
                ? `${chargesLeft} charge${chargesLeft === 1 ? '' : 's'} left`
                : '**last charge**'
        }`);
    }
    if (result.petYieldBonus > 0) {
        lines.push(`🐺 **Pet** — +${result.petYieldBonus.toLocaleString()} coins (${petYieldPct}% yield)`);
    }
    if (result.petXpBonus > 0) {
        lines.push(`🦅 **Pet** — +${result.petXpBonus.toLocaleString()} XP (${petXpPct}%)`);
    }
    if (result.featuredZoneBonus > 0) {
        lines.push(`🌟 **Featured Zone** — +${result.featuredZoneBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`);
    }
    if (result.wildernessBonus > 0) {
        lines.push(`🌲 **Wilderness District** — +${result.wildernessBonus.toLocaleString()} coins (+${Math.round(WILDERNESS_YIELD_BONUS * 100)}% yield)`);
    }

    return lines;
}

/**
 * What the day's own limits took out of this payout, and when they lift.
 *
 * The soft cap halves every payout past 80k and diminishing returns cut it by up
 * to 45% more, so a heavy session's rewards could shrink by nearly three
 * quarters with nothing on screen to explain it — it read as bad luck, or as a
 * silent nerf. Only the hard cap ever said anything. Null when nothing bit.
 */
function buildDailyTollField(result, user, currency) {
    const report = result.dailyReport;
    if (!report || report.lostToDaily <= 0) return null;

    const h = user.hunt;
    const lines = [];

    if (report.dimReturns) {
        const pct = Math.round((1 - report.dimReturns.multiplier) * 100);
        lines.push(`📉 **Diminishing returns** −${pct}% · ${h.dailyHunts} hunts today (past ${report.dimReturns.threshold})`
            + (report.dimReturns.nextAt
                ? `\n> Drops again at ${report.dimReturns.nextAt} hunts.`
                : ''));
    }
    if (report.softCapped) {
        lines.push(`🪙 **Daily soft cap** −50% · past ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} earned today`);
    }
    if (report.headroomClamped) {
        lines.push(`🧱 **Hard cap in sight** — only ${currency}${Math.max(0, LIMITS.DAILY_HARD_CAP - h.dailyCoins).toLocaleString()} of headroom left`);
    }

    lines.push(`*Worth ${currency}${report.grossPayout.toLocaleString()} on a fresh day — ${currency}${report.lostToDaily.toLocaleString()} withheld. Resets in ${formatMs(msUntilDailyReset(h))}.*`);

    return { name: '⚖️ Daily Limits', value: lines.join('\n'), inline: false };
}

function buildBrokenWeaponNote(weapon) {
    return isCondemned(weapon)
        ? `Your **${weapon.name}** has broken, and it's condemned — too many shop repairs have worn it out, so it can't be fixed. Replace it with \`/hunt shop weapon\`.`
        : `Your **${weapon.name}** has broken! Use \`/hunt shop repair\` before hunting again.`;
}

function buildFailureTitle(severityId) {
    return { clean_miss: '💨 Miss!', spooked: '😰 Spooked!', jammed: '🔧 Jammed!', injured: '🤕 Injured!' }[severityId] ?? '❌ Failed Hunt';
}

// Heat bands as a fraction of the zone's own threshold — the numbers used to be
// hardcoded against a flat 50, which no longer holds now that each zone sets its
// own.
const PITY_HOT_FRACTION  = 0.80;
const PITY_WARM_FRACTION = 0.50;

function buildPityField(user, zone) {
    const sinceRare  = user.hunt.sinceRare ?? 0;
    const threshold  = getRarePityThreshold(zone);
    const filled     = Math.min(sinceRare, threshold);
    const barLen     = 16;
    const filledLen  = Math.round((filled / threshold) * barLen);
    const bar        = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);

    let heat, label;
    if (sinceRare >= threshold) {
        heat  = '⚡';
        label = `**GUARANTEED NEXT HUNT**`;
    } else if (sinceRare >= threshold * PITY_HOT_FRACTION) {
        heat  = '🔥';
        label = `Getting hot — ~${threshold - sinceRare} more`;
    } else if (sinceRare >= threshold * PITY_WARM_FRACTION) {
        heat  = '🌡️';
        label = `Warming up — ~${threshold - sinceRare} more`;
    } else {
        heat  = '❄️';
        label = `~${threshold - sinceRare} more for guaranteed Rare+`;
    }

    return { name: `${heat} Rare Pity: ${sinceRare}/${threshold}`, value: `\`${bar}\`\n${label}`, inline: false };
}

function buildStaminaLine(user) {
    const h   = user.hunt;
    const max = getMaxStamina(user);
    return `${h.stamina}/${max} ⚡`;
}

function buildXpLine(user) {
    const h   = user.hunt;
    const toNext = xpToNextLevel(h.level, h.xp);
    if (toNext === null) return `${h.xp.toLocaleString()} XP (MAX)`;
    return `${h.xp.toLocaleString()} XP (${toNext} to Lv.${h.level + 1})`;
}

function buildActiveConsumablesLine(user) {
    const h = user.hunt;
    const parts = [];
    if (h.activeBait)  parts.push(`Bait (${h.activeBaitHuntsLeft} hunts left)`);
    if (h.activeCharm) parts.push(`Charm (${h.activeCharmHuntsLeft} hunts left)`);
    if (h.activeFocus) parts.push(`Focus (queued)`);
    if (h.activeXpScroll) parts.push(`XP Scroll (queued)`);
    return parts.length ? parts.join(' • ') : 'No active buffs';
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE (was /huntprofile)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeProfile(interaction) {
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
                ? "You haven't started hunting yet! Buy a weapon with `/hunt shop weapon` and use `/hunt start` to begin."
                : `${target.username} hasn't started hunting yet.`,
            flags: MessageFlags.Ephemeral
        });
    }

    ensureHuntData(userData);
    if (isSelf) applyStaminaRegen(userData);

    const h        = userData.hunt;
    const levelData = getLevelData(h.level);
    const toNext   = xpToNextLevel(h.level, h.xp);
    const maxStam  = getMaxStamina(userData);
    const regenMs  = msUntilNextStamina(userData);
    const zone     = ZONES[h.activeZone];
    const prestige = h.prestige ?? 0;
    const badge    = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    const successRate = h.totalHunts > 0
        ? `${Math.round((h.successfulHunts / h.totalHunts) * 100)}%`
        : 'N/A';

    const xpProgressBar = buildXpBar(h, toNext);
    const stamBar = '⚡'.repeat(h.stamina) + '▪️'.repeat(Math.max(0, maxStam - h.stamina));

    const buffs = [];
    if (h.activeBait)    buffs.push(`Bait (${h.activeBaitHuntsLeft} hunts)`);
    if (h.activeCharm)   buffs.push(`Charm (${h.activeCharmHuntsLeft} hunts)`);
    if (h.activeFocus)   buffs.push('Focus (queued)');
    if (h.activeXpScroll) buffs.push('XP Scroll (queued)');

    const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#3498db')
        .setTitle(`${badge} ${target.username}'s Hunter Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '🏆 Rank',
                value: `**${levelData.title}** (Level ${h.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                inline: true
            },
            {
                name: '⭐ Hunter XP',
                value: toNext !== null
                    ? `${h.xp.toLocaleString()} / ${HUNTER_LEVELS[h.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpProgressBar}\n${toNext.toLocaleString()} to Level ${h.level + 1}`
                    : `${h.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true
            },
            {
                name: '🗺️ Active Zone',
                value: zone ? `${zone.emoji} ${zone.name}` : 'Unknown',
                inline: true
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${h.stamina}/${maxStam}${h.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
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
                name: '📊 Hunt Stats',
                value: [
                    `Total Hunts:    **${h.totalHunts.toLocaleString()}**`,
                    `Success Rate:   **${successRate}**`,
                    `Total Earned:   **${currency}${h.totalEarned.toLocaleString()}**`,
                    `Best Payout:    **${currency}${h.bestPayout.toLocaleString()}**`,
                    `Legendary Kills: **${h.legendaryKills}**`,
                    `Event Kills:    **${h.eventKills}**`
                ].join('\n'),
                inline: false
            }
        );

    if (prestige > 0) {
        embed.addFields({
            name: `${badge} Prestige Bonuses`,
            value: [
                pBonus.critBonus     > 0 ? `+${Math.round(pBonus.critBonus     * 100)}% crit chance`     : null,
                pBonus.staminaBonus  > 0 ? `+${pBonus.staminaBonus} max stamina`                         : null,
                pBonus.payoutBonus   > 0 ? `+${Math.round(pBonus.payoutBonus   * 100)}% all payouts`      : null,
                pBonus.rarityBonus   > 0 ? `+${Math.round(pBonus.rarityBonus   * 100)}% rarity boost`     : null
            ].filter(Boolean).join('\n') || 'None yet',
            inline: true
        });
    }

    const zoneList = h.unlockedZones.map(id => {
        const z = ZONES[id];
        return z ? `${z.emoji} ${z.name}` : id;
    }).join('\n');
    embed.addFields({ name: '🗺️ Unlocked Zones', value: zoneList || 'Beginner Forest only', inline: true });

    if (h.trophies?.length) {
        embed.addFields(buildTrophyField(h.trophies));
    }

    const fieldTrophies = buildFieldTrophyField(h);
    if (fieldTrophies) embed.addFields(fieldTrophies);

    // Cross-system synergies
    const activeSynergies = getActiveSynergies(userData);
    if (activeSynergies.length > 0) {
        embed.addFields({
            name: '🔗 Active Synergies',
            value: activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n'),
            inline: false
        });
    } else if (h.level >= 25) {
        embed.addFields({
            name: '🔗 Synergies',
            value: 'Reach combined level milestones across Hunt, Fish & Mine to unlock cross-system bonuses!',
            inline: false
        });
    }

    if (isSelf) embed.addFields(buildTodayField(h, currency));

    if (prestige === 0 && h.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /hunt prestige to reset and unlock new bonuses.' });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

/**
 * The trophy case, clamped to Discord's 1024-character field limit.
 *
 * Trophies accumulate forever and are never pruned, so a veteran hunter's list
 * outgrows the field and Discord rejects the whole profile embed — the command
 * stops working entirely at around 56 unique trophies. Show the best ones first
 * (mythic before pristine before good) and count the rest.
 */
/**
 * The permanent upgrades a hunter has earned — the progression that carries on
 * past Level 50 and Prestige 5. Null when they have none yet, so the profile
 * doesn't carry an empty field.
 */
function buildFieldTrophyField(h) {
    const owned = Object.entries(FIELD_TROPHIES)
        .filter(([flag]) => h[flag])
        .map(([, t]) => `${t.emoji} **${t.name}** — ${t.effect}`);

    if (h.luckyPaw)       owned.unshift('🐾 **Lucky Paw** — +1% critical hit chance');
    if (h.precisionScope) owned.unshift('🔭 **Precision Scope** — +2% rarity boost');
    if (!owned.length) return null;

    const total = Object.keys(FIELD_TROPHIES).length + 2;
    return {
        name:   `🎖️ Permanent Upgrades (${owned.length}/${total})`,
        value:  owned.join('\n'),
        inline: false,
    };
}

const TROPHY_RANK = { '🟣': 0, '🔷': 1, '🟢': 2 };
const TROPHY_FIELD_BUDGET = 1024;

function buildTrophyField(trophies) {
    const ranked = trophies.slice().sort((a, b) =>
        (TROPHY_RANK[a.slice(0, 2)] ?? 9) - (TROPHY_RANK[b.slice(0, 2)] ?? 9));

    const shown = [];
    let used = 0;
    for (const trophy of ranked) {
        // +2 for the ", " separator, and leave room for the "+N more" tail.
        const tail = `, +${ranked.length - shown.length} more`;
        if (used + trophy.length + 2 + tail.length > TROPHY_FIELD_BUDGET) break;
        used += trophy.length + (shown.length ? 2 : 0);
        shown.push(trophy);
    }

    const hidden = ranked.length - shown.length;
    return {
        name:   `🏆 Trophies (${ranked.length})`,
        value:  shown.join(', ') + (hidden > 0 ? `, +${hidden} more` : ''),
        inline: true,
    };
}

/**
 * Where today's earnings stand against the limits that quietly throttle them.
 *
 * The profile used to report only the hard cap, so a hunter had no way to see
 * the −50% soft cap or the diminishing-returns band coming before it landed.
 */
function buildTodayField(h, currency) {
    const dim   = getDiminishingReturns(h.dailyHunts ?? 0);
    const coins = h.dailyCoins ?? 0;

    const barLen    = 12;
    const filledLen = Math.min(barLen, Math.round((coins / LIMITS.DAILY_HARD_CAP) * barLen));
    const bar       = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);

    const lines = [
        `\`${bar}\` ${currency}${coins.toLocaleString()} / ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()}`,
        `🏹 ${(h.dailyHunts ?? 0).toLocaleString()} hunts · payout ×${dim.multiplier.toFixed(2)}`,
    ];

    if (dim.nextAt) {
        lines.push(`📉 Drops to ×${dim.nextMultiplier.toFixed(2)} at ${dim.nextAt} hunts`);
    }
    if (coins >= LIMITS.DAILY_SOFT_CAP) {
        lines.push(`🪙 Past the soft cap — payouts halved`);
    } else {
        lines.push(`🪙 Soft cap (−50%) at ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()}`);
    }
    lines.push(`🕛 Resets in ${formatMs(msUntilDailyReset(h))}`);

    return { name: '📅 Today', value: lines.join('\n'), inline: false };
}

function buildXpBar(h, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const currentLevelXp = HUNTER_LEVELS[h.level - 1]?.xpRequired ?? 0;
    const nextLevelXp    = HUNTER_LEVELS[h.level]?.xpRequired ?? 1;
    const denominator    = nextLevelXp - currentLevelXp;
    const progress       = denominator > 0 ? (h.xp - currentLevelXp) / denominator : 0;
    const filled         = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct            = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESTIGE (was /huntprestige)
// ═══════════════════════════════════════════════════════════════════════════════

function formatBonuses(bonus) {
    const lines = [];
    if (bonus.critBonus    > 0) lines.push(`+${Math.round(bonus.critBonus    * 100)}% crit chance`);
    if (bonus.staminaBonus > 0) lines.push(`+${bonus.staminaBonus} max stamina`);
    if (bonus.payoutBonus  > 0) lines.push(`+${Math.round(bonus.payoutBonus  * 100)}% all payouts`);
    if (bonus.rarityBonus  > 0) lines.push(`+${Math.round(bonus.rarityBonus  * 100)}% rarity boost`);
    return lines.length ? lines.join('\n') : 'None';
}

async function executePrestige(interaction) {
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
    ensureHuntData(user);
    const h = user.hunt;

    if (h.level < 50) {
        return interaction.reply({
            content: `You need Hunter Level **50** to prestige. You are currently Level **${h.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const currentPrestige = h.prestige ?? 0;
    if (currentPrestige >= MAX_PRESTIGE) {
        return interaction.reply({
            content: `You have already reached the maximum prestige (**P${MAX_PRESTIGE} — Diamond**). You are a true legend! 💎`,
            flags: MessageFlags.Ephemeral
        });
    }

    const nextPrestige    = currentPrestige + 1;
    const currentBonuses  = PRESTIGE_BONUSES[currentPrestige];
    const nextBonuses     = PRESTIGE_BONUSES[nextPrestige];

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle('⚠️ Prestige Confirmation')
        .setDescription(
            `You are about to prestige from **P${currentPrestige}** → **P${nextPrestige}** (${PRESTIGE_LABELS[nextPrestige]}).\n\n` +
            `**Your hunter level and XP will reset to 1.**\n` +
            `Weapons, ammo, materials, balance, zone unlocks, and trophies are all kept.`
        )
        .addFields(
            { name: `Current Bonuses (P${currentPrestige})`, value: formatBonuses(currentBonuses), inline: true },
            { name: `New Bonuses (P${nextPrestige})`,        value: formatBonuses(nextBonuses),    inline: true }
        )
        .setFooter({ text: 'This action cannot be undone! You have 30 seconds to confirm.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('prestige_confirm')
            .setLabel('Prestige Now!')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('prestige_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });

    const collector = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id &&
                     ['prestige_confirm', 'prestige_cancel'].includes(i.customId),
        time:   30_000,
        max:    1
    });

    collector.on('collect', async i => {
        if (i.customId === 'prestige_cancel') {
            await i.update({ content: 'Prestige cancelled.', embeds: [], components: [] });
            return;
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureHuntData(freshUser);
        const fh = freshUser.hunt;

        if (fh.level < 50 || (fh.prestige ?? 0) >= MAX_PRESTIGE) {
            await i.update({
                content: 'Prestige conditions are no longer met (level changed, or already prestiged).',
                embeds: [], components: []
            });
            return;
        }

        fh.prestige = (fh.prestige ?? 0) + 1;
        fh.level    = 1;
        fh.xp       = 0;

        if (!Array.isArray(fh.trophies)) fh.trophies = [];
        const trophy = PRESTIGE_LABELS[fh.prestige];
        if (trophy && !fh.trophies.includes(trophy)) {
            fh.trophies.push(trophy);
        }

        freshUser.markModified('hunt');
        await freshUser.save();

        // Check grand prestige after successful hunt prestige
        checkGrandPrestige(i.client, freshUser, interaction.guild, interaction.guildId).catch(() => null);

        const resultEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle(`✨ Prestige ${fh.prestige} Achieved!`)
            .setDescription(
                `You are now **${PRESTIGE_LABELS[fh.prestige]}**!\n\n` +
                `Your hunter level has been reset to **1**. Prove yourself again from the bottom.`
            )
            .addFields(
                { name: 'Prestige Bonuses', value: formatBonuses(PRESTIGE_BONUSES[fh.prestige]), inline: false },
                { name: '🏆 Trophy Earned', value: trophy,                                        inline: true  },
                { name: '⚡ Max Stamina',   value: `${getMaxStamina(freshUser)}`,                 inline: true  }
            )
            .setFooter({ text: 'Use /hunt profile to see your updated stats' })
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

// ═══════════════════════════════════════════════════════════════════════════════
// INV (was /huntinv)
// ═══════════════════════════════════════════════════════════════════════════════

const WEAPON_SEPARATOR = '\n\n';

/**
 * The weapon list, split into pages that each fit an embed description.
 *
 * This used to be one `lines.join('\n\n')` straight into `setDescription`. At
 * roughly 180 characters an entry that overflows Discord's 4096-character cap
 * at about 22 weapons, and the API rejects the whole embed — so the command
 * stopped working entirely for the player who owned the most. The same defect
 * broke `/hunt profile` at 56 trophies.
 *
 * Paged rather than trimmed, because the number in each heading is what
 * `/hunt inv equip <#>` and `/hunt inv discard <#>` take: a weapon cut off the
 * end of a `+N more` tail could never be equipped or thrown away again, and
 * `/hunt inv discard` only accepts broken or condemned weapons — so the pile a
 * trimmed list would hide is exactly the pile you cannot clear.
 *
 * Ordered equipped-first, then by tier descending, so page one is the one
 * worth reading. The displayed number stays the weapon's index in `h.weapons`,
 * which is what the other subcommands address it by.
 */
function buildWeaponPages(h) {
    const ordered = h.weapons
        .map((w, index) => ({ w, index }))
        .sort((a, b) => {
            if (a.index === h.equippedWeaponIndex) return -1;
            if (b.index === h.equippedWeaponIndex) return 1;
            return (b.w.tier ?? 0) - (a.w.tier ?? 0);
        });

    const lines = ordered.map(({ w, index }) => {
        const wd         = WEAPON_BY_TIER[w.tier];
        const statusIcon = weaponStatusEmoji(w.status);
        const bar        = durabilityBar(w.currentDurability, w.maxDurability, 12);
        const upgrade    = w.upgrade ? `[${w.upgrade.replace(/_/g, ' ')}]` : '';
        const equipped   = index === h.equippedWeaponIndex ? ' **[EQUIPPED]**' : '';
        return [
            `**#${index + 1} — ${wd?.emoji ?? '🔫'} ${w.name}**${equipped}`,
            `> ${statusIcon} ${w.status.toUpperCase()} · ${bar} ${w.currentDurability}/${w.maxDurability} dur`,
            `> Repairs: ${w.repairCount} · Max: ${w.maxDurability}/${w.baseDurability} · ${upgrade || 'No upgrade'}`
        ].join('\n');
    });

    // A page cap as well as a character budget: eight entries is a screenful,
    // and a list that fills 4096 characters before it pages is one nobody reads.
    return chunkByLength(lines, { separator: WEAPON_SEPARATOR, maxPerChunk: 8 });
}

async function executeInv(interaction, sub) {
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
    ensureHuntData(user);
    const h = user.hunt;

    if (sub === 'weapons') {
        if (!h.weapons.length) {
            return interaction.reply({
                content: "You don't own any weapons! Buy one with `/hunt shop weapon`.",
                flags: MessageFlags.Ephemeral
            });
        }

        const pages = buildWeaponPages(h).map((lines, page, all) => new EmbedBuilder()
            .setColor('#3498db')
            .setTitle(all.length > 1 ? `🔫 Your Weapons (${h.weapons.length})` : '🔫 Your Weapons')
            .setDescription(lines.join(WEAPON_SEPARATOR))
            .setFooter({ text: 'Use /hunt inv equip <#> to change weapon • /hunt shop repair to restore durability • /hunt shop upgrade for modules' }));

        return paginate(interaction, pages);
    }

    if (sub === 'equip') {
        const num    = interaction.options.getInteger('number');
        const index  = num - 1;

        if (index < 0 || index >= h.weapons.length) {
            return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s). Use \`/hunt inv weapons\` to see them.`, flags: MessageFlags.Ephemeral });
        }

        const weapon = h.weapons[index];
        if (weapon.status === 'broken') {
            return interaction.reply({ content: `**${weapon.name}** is broken and cannot be equipped. Repair it first with \`/hunt shop repair\`.`, flags: MessageFlags.Ephemeral });
        }

        h.equippedWeaponIndex = index;
        user.markModified('hunt');
        await user.save();

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle('⚔️ Weapon Equipped')
            .setDescription(`**${weapon.name}** is now equipped and ready for hunting.`)
            .addFields(
                { name: 'Durability', value: `${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                { name: 'Status',     value: weaponStatusEmoji(weapon.status) + ' ' + weapon.status, inline: true },
                { name: 'Upgrade',    value: weapon.upgrade ? weapon.upgrade.replace(/_/g, ' ') : 'None', inline: true }
            )
            .setFooter({ text: 'Use /hunt start to start hunting!' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'ammo') {
        const allAmmo = [
            ['iron_shot',       '🔶', 'Iron Shot        (T2–T3: Iron, Copper)'],
            ['steel_shot',      '⚫', 'Steel Shot       (T4–T5: Steel, Cobalt)'],
            ['composite_round', '🔵', 'Composite Round  (T6–T8: Gold, Platinum, Crimson)'],
            ['titanium_round',  '💎', 'Titanium Round   (T9–T12: Adamantine → Altair)']
        ];

        const lines = allAmmo.map(([type, emoji, label]) => {
            const qty = h.ammo[type] ?? 0;
            return `${emoji} **${label}**: ${qty} rounds`;
        });

        const equippedWeapon = h.equippedWeaponIndex >= 0 ? h.weapons[h.equippedWeaponIndex] : null;
        const currentAmmoType = equippedWeapon ? WEAPON_BY_TIER[equippedWeapon.tier]?.ammoType : null;
        const currentAmmo = currentAmmoType ? (h.ammo[currentAmmoType] ?? 0) : null;

        const embed = new EmbedBuilder()
            .setColor('#e67e22')
            .setTitle('🔶 Ammo Stocks')
            .setDescription(lines.join('\n'));

        if (currentAmmoType) {
            embed.addFields({ name: '🔫 Equipped Weapon Ammo', value: `${currentAmmoType.replace(/_/g, ' ')}: **${currentAmmo} rounds**` });
        }

        embed.setFooter({ text: 'Buy ammo with /hunt shop buy <ammo_pack>' });
        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'consumables') {
        const lines = Object.entries(h.consumables)
            .map(([id, qty]) => {
                const def = CONSUMABLES[id];
                if (!def || qty <= 0) return null;
                return `${def.emoji} **${def.name}** ×${qty} — ${def.description}`;
            })
            .filter(Boolean);

        const activeParts = [];
        if (h.activeBait)    activeParts.push(`🪱 **${h.activeBait.replace(/_/g, ' ')}** — ${h.activeBaitHuntsLeft} hunt(s) left`);
        if (h.activeCharm)   activeParts.push(`🍀 **${h.activeCharm.replace(/_/g, ' ')}** — ${h.activeCharmHuntsLeft} hunt(s) left`);
        if (h.activeFocus)   activeParts.push(`🎯 **Hunter's Focus** — queued for next hunt`);
        if (h.activeXpScroll) activeParts.push(`📜 **XP Scroll** — queued for next hunt`);

        const embed = new EmbedBuilder()
            .setColor('#9b59b6')
            .setTitle('🧪 Consumables')
            .addFields({ name: 'In Stock', value: lines.length ? lines.join('\n') : 'None', inline: false });

        if (activeParts.length) {
            embed.addFields({ name: '✅ Active Buffs', value: activeParts.join('\n'), inline: false });
        }

        embed.setFooter({ text: 'Buy from /hunt shop • Activate with /hunt shop use <item>' });
        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'materials') {
        const entries = Object.entries(h.materials)
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}** ×${qty}`);

        const footer = entries.length
            ? 'Every material feeds a recipe — see /craft list. Each zone ends in a permanent Field Trophy.'
            : 'Tip: Use bait from /hunt shop to boost rare animal chances';

        // Bounded by the 58 material ids to about 1,700 characters, so this
        // fits today — but it is the same join-and-hope shape the weapon list
        // broke on, and the material table only ever grows.
        const pages = entries.length
            ? chunkByLength(entries).map(lines => new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🪨 Crafting Materials')
                .setDescription(lines.join('\n'))
                .setFooter({ text: footer }))
            : [new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🪨 Crafting Materials')
                .setDescription('No materials yet. Hunt rare+ animals to find special drops!')
                .setFooter({ text: footer })];

        return paginate(interaction, pages);
    }

    if (sub === 'discard') {
        const num   = interaction.options.getInteger('number');
        const index = num - 1;

        if (index < 0 || index >= h.weapons.length) {
            return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s).`, flags: MessageFlags.Ephemeral });
        }

        const weapon = h.weapons[index];
        if (weapon.status !== 'broken' && weapon.status !== 'condemned') {
            return interaction.reply({
                content: `**${weapon.name}** is not broken or condemned. You can only discard unusable weapons.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const wasEquipped = h.equippedWeaponIndex === index;
        h.weapons.splice(index, 1);

        if (wasEquipped) {
            h.equippedWeaponIndex = h.weapons.length > 0 ? 0 : -1;
        } else if (h.equippedWeaponIndex > index) {
            h.equippedWeaponIndex -= 1;
        }

        user.markModified('hunt');
        await user.save();

        const embed = new EmbedBuilder()
            .setColor('#e74c3c')
            .setTitle('🗑️ Weapon Discarded')
            .setDescription(`**${weapon.name}** has been discarded.`)
            .setFooter({ text: h.weapons.length === 0 ? 'Buy a new weapon with /hunt shop weapon' : 'Use /hunt inv weapons to view remaining weapons' });

        return interaction.reply({ embeds: [embed] });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTS (was /huntquests)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeQuests(interaction, sub) {
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
    ensureHuntData(user);
    assignDailyHuntQuests(user);

    const now = Date.now();

    if (sub === 'view') {
        const huntQuests = user.quests.filter(q =>
            q.questId.startsWith('hq_') && q.expiresAt?.getTime() > now
        );

        if (!huntQuests.length) {
            const embed = new EmbedBuilder()
                .setColor('#e67e22')
                .setTitle('📋 Daily Hunt Quests')
                .setDescription('No active quests right now.\nUse `/hunt start` to go on a hunt — quests will be assigned automatically!')
                .setFooter({ text: 'Quests are assigned in batches of 3 and last 24 hours' });
            return interaction.reply({ embeds: [embed] });
        }

        if (user.isModified()) {
            await user.save().catch(e => console.error('[huntquests] save error:', e));
        }

        const lines = huntQuests.map(q => {
            const template = HUNT_QUEST_TEMPLATES.find(t => t.id === q.questId);
            if (!template) return null;

            const isClaimed   = q.progress === -1;
            const isComplete  = !!q.completedAt && !isClaimed;
            const progress    = isClaimed ? template.target : Math.min(q.progress, template.target);
            const bar         = buildProgressBar(progress, template.target);
            const timeLeft    = formatExpiry(q.expiresAt.getTime() - now);
            const rewardStr   = `${currency}${template.reward.coins.toLocaleString()} · ${template.reward.xp} Hunter XP`;

            let statusLine;
            if (isClaimed)       statusLine = '✅ **Claimed**';
            else if (isComplete) statusLine = '🎁 **Ready to claim!** — Use `/hunt quests claim`';
            else                 statusLine = `${bar} ${progress}/${template.target}`;

            return [
                `${template.emoji} **${template.name}**`,
                `> ${template.description}`,
                `> ${statusLine}`,
                `> Reward: ${rewardStr} · Expires: ${timeLeft}`
            ].join('\n');
        }).filter(Boolean);

        const readyCount = huntQuests.filter(q => q.completedAt && q.progress !== -1).length;

        const embed = new EmbedBuilder()
            .setColor('#e67e22')
            .setTitle('📋 Daily Hunt Quests')
            .setDescription(lines.join('\n\n'))
            .setTimestamp();

        if (readyCount > 0) {
            embed.setFooter({ text: `${readyCount} quest(s) ready to claim! Use /hunt quests claim` });
        } else {
            embed.setFooter({ text: 'Complete quests by hunting • Claim rewards with /hunt quests claim' });
        }

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'claim') {
        const questId  = interaction.options.getString('quest');
        const template = HUNT_QUEST_TEMPLATES.find(t => t.id === questId);

        if (!template) {
            return interaction.reply({ content: 'Unknown quest.', flags: MessageFlags.Ephemeral });
        }

        const questEntry = user.quests.find(q =>
            q.questId === questId &&
            q.expiresAt?.getTime() > now
        );

        if (!questEntry) {
            return interaction.reply({
                content: `You don't have an active **${template.name}** quest. Go hunting to get quests assigned!`,
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
                content: `**${template.name}** is not complete yet (${progress}/${template.target}). Keep hunting!`,
                flags: MessageFlags.Ephemeral
            });
        }

        // The claim's coins are applied as an `$inc` after the save. `save()`
        // writes `balance` as an absolute `$set`, which would put back the value
        // read at the top of the command and erase anything paid since.
        const balanceAtLoad = user.balance ?? 0;
        user.balance += template.reward.coins;
        const lvResult = applyXp(user, template.reward.xp);

        questEntry.progress = -1;
        user.markModified('quests');
        try {
            await saveWithBalanceDelta(User, user, balanceAtLoad, {
                service: 'hunt',
                jobName: 'questClaimCoins',
                guildId: interaction.guild.id,
            });
        } catch (err) {
            // The document was loaded at the top of the command and the message,
            // reaction and command handlers all write to it, so a version
            // conflict here is ordinary. Nothing was claimed; say so rather than
            // leaving the interaction unanswered.
            console.error('[huntquests claim] save error:', err);
            return interaction.reply({ content: 'Something went wrong claiming that quest. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`${template.emoji} Quest Complete — ${template.name}!`)
            .setDescription(template.description)
            .addFields(
                { name: `${currency} Coins`,  value: `+${template.reward.coins.toLocaleString()}`,           inline: true },
                { name: '⭐ Hunter XP',        value: `+${template.reward.xp}`,                               inline: true },
                { name: '💳 New Balance',      value: `${currency}${user.balance.toLocaleString()}`,          inline: true }
            );

        if (lvResult.leveledUp) {
            const ld = getLevelData(lvResult.newLevel);
            embed.addFields({
                name:  '⬆️ Level Up!',
                value: `Hunter Level **${lvResult.oldLevel}** → **${lvResult.newLevel}** (${ld.title})`,
                inline: false
            });
        }

        const liveQuests = user.quests.filter(q =>
            q.questId.startsWith('hq_') && q.expiresAt?.getTime() > now
        );
        const remaining = liveQuests.filter(q => q.progress !== -1).length;

        // A fresh batch is only assigned once the current one has expired — see the
        // guard in assign*Quests. Say when that is rather than implying that playing
        // again brings one sooner, which is what this footer used to promise.
        const nextSetIn = liveQuests.length
            ? formatExpiry(Math.min(...liveQuests.map(q => q.expiresAt.getTime())) - now)
            : null;

        embed.setFooter({ text: remaining > 0
            ? `${remaining} quest(s) remaining — use /hunt quests view`
            : `All quests claimed! A fresh set arrives in ${nextSetIn ?? 'a few hours'}.` });
        embed.setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
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

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP (was /huntshop)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeShop(interaction, sub) {
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
    ensureHuntData(user);

    switch (sub) {
        case 'list':    return showShopList(interaction, user, currency);
        case 'weapon':  return handleBuyWeapon(interaction, user, currency);
        case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
        case 'buy':     return handleBuy(interaction, user, currency);
        case 'use':     return handleUse(interaction, user);
        case 'repair':  return handleRepair(interaction, user, currency);
        case 'unlock':  return handleUnlock(interaction, user, currency);
    }
}

/**
 * How the top of the weapon ladder is priced, and why it says so out loud.
 *
 * Hunt income has a ceiling: payouts halve above `DAILY_SOFT_CAP` (80,000) and
 * stop entirely at `DAILY_HARD_CAP`. Measured against that ceiling, the last
 * few tiers cost more than hunting can plausibly produce — a T12 Altair Rifle
 * is 250 days of hunting at the soft cap, and a full repair on one is another
 * 80, of which it has about eight before the shop wears it out for good.
 *
 * The numbers are not wrong. Hunting is not the only thing that feeds a wallet
 * — casino, work, crime, heist and the rest all pay into the same balance, and
 * the daily caps are hunt-specific — so the top tiers are whole-economy
 * purchases by design. What was wrong is that nothing said so: a hunter looking
 * at the shop had no way to tell the ladder stops being hunt-funded partway up,
 * and could grind toward a number hunting cannot reach.
 *
 * Derived from the caps rather than hardcoded to a tier, so it stays true if
 * either the prices or the caps move.
 */
const CROSS_ECONOMY_DAYS = 30;

/** Days of hunting at the soft cap that `cost` represents. */
function huntingDaysFor(cost) {
    return cost / LIMITS.DAILY_SOFT_CAP;
}

/** Cost of taking a fresh weapon of this tier from empty back to full. */
function fullRepairCost(weapon) {
    return Math.ceil(weapon.baseDurability / 20) * weapon.repairCostPer20;
}

/** True for a weapon hunting alone cannot realistically pay for. */
function isCrossEconomyWeapon(weapon) {
    return huntingDaysFor(weapon.cost) > CROSS_ECONOMY_DAYS;
}

/** Rounded day count for display — "~250 days", never "249.9". */
function huntingDaysLabel(cost) {
    const days = huntingDaysFor(cost);
    return days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
}

async function showShopList(interaction, user, currency) {
    const h = user.hunt;

    const weaponItems = WEAPON_TIERS.map(w => ({
        imageId: `hunt:${w.slug}`,
        name:    w.name,
        price:   w.cost,
        emoji:   w.emoji,
        badge:   `T${w.tier}`,
        subline: `${Math.round(w.successRate * 100)}% • +${Math.round(w.rarityBoost * 100)}% rare`
            + (isCrossEconomyWeapon(w) ? ` • 🌐 ~${huntingDaysLabel(w.cost)}d of hunting` : '')
    }));
    const weaponLines = WEAPON_TIERS.map(w =>
        `${w.emoji} **${w.name}** — ${currency}${w.cost.toLocaleString()}`
        + (isCrossEconomyWeapon(w) ? ` 🌐` : '')
        + ` · \`/hunt shop weapon type:${w.slug}\``
    );
    // The legend goes in the embed description rather than the banner subtitle:
    // the banner is drawn with fillText on a canvas, which has no line breaks.
    if (WEAPON_TIERS.some(isCrossEconomyWeapon)) {
        weaponLines.push('', '🌐 *Costs more than hunting alone can fund — casino, work, crime and the rest all pay into the same wallet.*');
    }
    const weaponList = weaponLines.join('\n');

    const upgradeItems = Object.values(WEAPON_UPGRADES).map(u => ({
        imageId: `hunt:${u.id}`,
        name:    u.name,
        emoji:   u.emoji,
        subline: `~${Math.round(u.costMultiplier * 100)}% of weapon`
    }));
    const upgradeList = Object.values(WEAPON_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — *${u.description}* · \`/hunt shop upgrade module:${u.id}\``
    ).join('\n');

    const ammoItems = AMMO_PACKS.map(a => ({
        imageId: `hunt:${a.id}`,
        name:    a.name,
        price:   a.cost,
        emoji:   a.emoji
    }));
    const ammoList = AMMO_PACKS.map(a =>
        `${a.emoji} **${a.name}** — ${currency}${a.cost} · \`/hunt shop buy item:${a.id}\``
    ).join('\n');

    const consumableItems = Object.values(CONSUMABLES).map(c => ({
        imageId: `hunt:${c.id}`,
        name:    c.name,
        price:   c.cost,
        emoji:   c.emoji
    }));
    const consumableList = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/hunt shop buy item:${c.id}\``
    ).join('\n');

    const zoneItems = ZONE_LIST.map(z => {
        const unlocked = h.unlockedZones.includes(z.id);
        const isActive = h.activeZone === z.id;
        return {
            imageId: `hunt:${z.id}`,
            name:    z.name,
            emoji:   z.emoji,
            badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${z.unlockLevel}`),
            subline: unlocked ? (isActive ? 'Currently hunting' : 'Unlocked') : (z.unlockCost > 0 ? `${currency}${z.unlockCost.toLocaleString()}` : 'Free')
        };
    });
    const zoneList = ZONE_LIST.map(z => {
        const unlocked = h.unlockedZones.includes(z.id);
        const isActive = h.activeZone === z.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${z.unlockLevel}${z.unlockCost > 0 ? ` / ${currency}${z.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${z.emoji} **${z.name}** — ${status}`;
    }).join('\n');

    return runShopBrowse(interaction, {
        activity: 'hunt',
        title:    'Hunt Shop',
        currency,
        footer:   'weapon • upgrade • buy • use • repair • unlock',
        pages: [
            { id: 'weapons',     label: 'Weapons',     emoji: '🔫',  subtitle: 'Pick your tier — better gear, better trophies.', items: weaponItems,     listText: weaponList     },
            { id: 'upgrades',    label: 'Upgrades',    emoji: '🔧',  subtitle: 'One module per weapon, permanent.',                items: upgradeItems,    listText: upgradeList    },
            { id: 'ammo',        label: 'Ammunition',  emoji: '🔶',  subtitle: 'Keep your rifle fed.',                              items: ammoItems,       listText: ammoList       },
            { id: 'consumables', label: 'Consumables', emoji: '🧪',  subtitle: 'Bait, charms, repairs and more.',                   items: consumableItems, listText: consumableList },
            { id: 'zones',       label: 'Zones',       emoji: '🗺️', subtitle: 'New regions, new prey.',                            items: zoneItems,       listText: zoneList       }
        ]
    });
}

async function handleBuyWeapon(interaction, user, currency) {
    const slug       = interaction.options.getString('type');
    const autoEquip  = interaction.options.getBoolean('equip') ?? true;
    const weaponData = WEAPON_BY_SLUG[slug];

    if (!weaponData) {
        return interaction.reply({ content: 'Unknown weapon type.', flags: MessageFlags.Ephemeral });
    }
    if (user.balance < weaponData.cost) {
        return interaction.reply({
            content: `You need **${currency}${weaponData.cost.toLocaleString()}** to buy the **${weaponData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const ammoValue = weaponData.requiresAmmo
        ? `${weaponData.ammoType.replace(/_/g, ' ')} (${currency}${weaponData.ammoCost}/hunt)`
        : 'None required';

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${weaponData.emoji} Purchase ${weaponData.name}?`)
        .setDescription(weaponData.description)
        .addFields(
            { name: 'Cost',         value: `${currency}${weaponData.cost.toLocaleString()}`,                         inline: true },
            { name: 'Durability',   value: `${weaponData.baseDurability}`,                                            inline: true },
            { name: 'Success Rate', value: `${Math.round(weaponData.successRate * 100)}%`,                            inline: true },
            { name: 'Rarity Boost', value: weaponData.rarityBoost > 0 ? `+${Math.round(weaponData.rarityBoost * 100)}%` : 'None', inline: true },
            { name: 'Ammo',         value: ammoValue,                                                                 inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`,                             inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    // The one place a hunter commits to the number, so it is the place to say
    // what the number means. A weapon is a consumable — every shop repair drops
    // maxDurability by 10% of base, so the top tiers cost their purchase price
    // again several times over before they are condemned — and at the top of
    // the ladder none of it is fundable from hunting alone.
    if (isCrossEconomyWeapon(weaponData)) {
        const repair = fullRepairCost(weaponData);
        confirmEmbed.addFields({
            name: '🌐 A whole-economy purchase',
            value: [
                `Hunting is capped at ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} a day before payouts halve, so this is about **${huntingDaysLabel(weaponData.cost)} days** of hunting on its own.`,
                `A full repair runs ${currency}${repair.toLocaleString()} — another **${huntingDaysLabel(repair)} days** — and it has roughly eight before the wear condemns it.`,
                `It is priced for a wallet fed by everything you do: casino, work, crime, heists and the rest all pay into the same balance.`,
            ].join('\n'),
            inline: false,
        });
    }

    const weaponImg = await getItemImageAttachment(`hunt:${weaponData.slug || weaponData.id}`).catch(() => null);
    if (weaponImg) confirmEmbed.setThumbnail(weaponImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buygun_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buygun_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const huntConfirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true };
    if (weaponImg) huntConfirmPayload.files = [weaponImg.attachment];
    const reply = await interaction.reply(huntConfirmPayload);
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'buygun_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();
            await completePurchase(btn, user, weaponData, autoEquip, currency);
        } catch (err) {
            console.error('[huntshop weapon] purchase error:', err);
            btn.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function completePurchase(interactionOrBtn, user, weaponData, autoEquip, currency) {
    const newWeapon = {
        name:              weaponData.name,
        tier:              weaponData.tier,
        slug:              weaponData.slug,
        currentDurability: weaponData.baseDurability,
        maxDurability:     weaponData.baseDurability,
        baseDurability:    weaponData.baseDurability,
        repairCount:       0,
        upgrade:           null,
        status:            'good',
        acquiredAt:        new Date()
    };

    const updated = await User.findOneAndUpdate(
        { userId: user.userId, guildId: user.guildId, balance: { $gte: weaponData.cost } },
        { $inc: { balance: -weaponData.cost } },
        { new: true }
    );

    if (!updated) {
        const reply = { content: `Insufficient funds. You need ${currency}${weaponData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    await persistGrindIfNew(user, 'hunt');
    const profUpdated = await GrindProfile.findOneAndUpdate(
        { userId: user.userId, guildId: user.guildId, system: 'hunt' },
        { $push: { 'data.weapons': newWeapon } },
        { new: true }
    ).catch(err => { console.error('[huntshop weapon] profile push error:', err); return null; });

    if (!profUpdated) {
        // Refund the debit — the weapon was never granted
        await User.updateOne({ userId: user.userId, guildId: user.guildId }, { $inc: { balance: weaponData.cost } }).catch(() => {});
        const reply = { content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    // Sync the in-memory profile so any later save doesn't clobber the purchase
    user.hunt.weapons = profUpdated.data.weapons;
    const h = user.hunt;
    const newIndex = h.weapons.length - 1;

    if (autoEquip) {
        const oldIndex = h.equippedWeaponIndex;
        h.equippedWeaponIndex = newIndex;
        try {
            await GrindProfile.updateOne(
                { userId: user.userId, guildId: user.guildId, system: 'hunt' },
                { $set: { 'data.equippedWeaponIndex': newIndex } }
            );
        } catch (err) {
            console.error('[huntshop weapon] equip update error:', err);
            h.equippedWeaponIndex = oldIndex;
        }
    }

    const equipped = h.equippedWeaponIndex === newIndex;
    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${weaponData.emoji} ${weaponData.name} Purchased!`)
        .setDescription(weaponData.description)
        .addFields(
            { name: 'Durability',   value: `${weaponData.baseDurability}/${weaponData.baseDurability}`,                                                               inline: true },
            { name: 'Success Rate', value: `${Math.round(weaponData.successRate * 100)}%`,                                                                            inline: true },
            { name: 'Rarity Boost', value: `+${Math.round(weaponData.rarityBoost * 100)}%`,                                                                          inline: true },
            { name: 'Ammo',         value: weaponData.requiresAmmo ? `${weaponData.ammoType.replace(/_/g, ' ')} (${currency}${weaponData.ammoCost}/hunt)` : 'None required', inline: true },
            { name: 'Weapon #',     value: `#${newIndex + 1} in inventory`,                                                                                           inline: true },
            { name: 'Status',       value: equipped ? '✅ Equipped' : `Use \`/hunt inv equip ${newIndex + 1}\``,                                                       inline: true }
        )
        .addFields({ name: 'New Balance', value: `${currency}${updated.balance.toLocaleString()}` })
        .setFooter({ text: equipped ? 'Ready to hunt! Use /hunt start' : `Equip with /hunt inv equip ${newIndex + 1}` });

    const reply = { embeds: [embed], components: [] };
    if (interactionOrBtn.editReply) return interactionOrBtn.editReply(reply);
    return interactionOrBtn.update(reply);
}

async function handleBuyUpgrade(interaction, user, currency) {
    const moduleId   = interaction.options.getString('module');
    const upgradeDef = WEAPON_UPGRADES[moduleId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade module.', flags: MessageFlags.Ephemeral });
    }

    const h = user.hunt;
    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Equip a weapon first with `/hunt inv equip`.', flags: MessageFlags.Ephemeral });
    }

    const weapon     = h.weapons[h.equippedWeaponIndex];
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    const cost       = Math.round(weaponData.cost * upgradeDef.costMultiplier);

    if (weapon.upgrade) {
        return interaction.reply({
            content: `Your **${weapon.name}** already has a **${weapon.upgrade.replace(/_/g, ' ')}** installed. Each weapon supports only one upgrade.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need ${currency}${cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const charged = await chargeBalance(interaction, cost);
    if (!charged) {
        return interaction.reply({
            content: `This upgrade costs ${currency}${cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    // Take the authoritative balance and keep the save off that path.
    user.balance   = charged.balance;
    user.unmarkModified('balance');
    weapon.upgrade  = moduleId;
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[huntshop upgrade] save error:', err);
        weapon.upgrade = null;
        await refundBalance(interaction, cost);
        return interaction.reply({ content: 'Installing the upgrade failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
                .setDescription(`**${upgradeDef.name}** has been installed on your **${weapon.name}**.`)
                .addFields(
                    { name: 'Effect',      value: upgradeDef.description,                       inline: true },
                    { name: 'Cost',        value: `${currency}${cost.toLocaleString()}`,         inline: true },
                    { name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                )
                .setFooter({ text: 'Upgrade is permanently attached to this weapon instance.' })
        ]
    });
}

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const h        = user.hunt;

    const consumableDef = CONSUMABLES[itemId];
    const ammoDef       = AMMO_PACKS.find(a => a.id === itemId);
    const itemDef       = consumableDef ?? ammoDef;

    if (!itemDef) {
        return interaction.reply({ content: 'Unknown item. Use `/hunt shop list` to see available items.', flags: MessageFlags.Ephemeral });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need ${currency}${totalCost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const isAmmo       = !!ammoDef;
    const currentStock = isAmmo
        ? (h.ammo[ammoDef.ammoType] ?? 0)
        : (h.consumables[itemId] ?? 0);

    if (consumableDef) {
        if (currentStock + quantity > consumableDef.maxStack) {
            return interaction.reply({
                content: `You can only hold **${consumableDef.maxStack}× ${consumableDef.name}** at once (you have ${currentStock}).`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    const gainedLabel = isAmmo
        ? `${ammoDef.quantity * quantity} ${ammoDef.ammoType.replace(/_/g, ' ')} rounds`
        : `${quantity}× ${consumableDef.name}`;

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${itemDef.emoji} Confirm Purchase`)
        .setDescription(itemDef.description ?? '')
        .addFields(
            { name: 'Item',        value: itemDef.name,                                inline: true },
            { name: 'Quantity',    value: gainedLabel,                                 inline: true },
            { name: 'Total Cost',  value: `${currency}${totalCost.toLocaleString()}`,  inline: true },
            { name: 'Your Balance',value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Currently',   value: isAmmo
                ? `${currentStock} rounds in stock`
                : `${currentStock}/${consumableDef.maxStack} in stock`, inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('huntbuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('huntbuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'huntbuy_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();

            await persistGrindIfNew(user, 'hunt');
            const balanceUpdated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost } },
                { new: true }
            );
            if (!balanceUpdated) {
                return interaction.editReply({ content: 'Insufficient funds. Please try again.', embeds: [], components: [] });
            }

            let newStock;
            if (consumableDef) {
                const consumableField = `data.consumables.${itemId}`;
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    {
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        system:  'hunt',
                        $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, consumableDef.maxStack] }
                    },
                    { $inc: { [consumableField]: quantity } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }
                h.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? quantity;
                newStock = `${h.consumables[itemId]}× ${consumableDef.name}`;
            } else {
                const ammoField = `data.ammo.${ammoDef.ammoType}`;
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, system: 'hunt' },
                    { $inc: { [ammoField]: ammoDef.quantity * quantity } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }
                h.ammo[ammoDef.ammoType] = profUpdated.data?.ammo?.[ammoDef.ammoType] ?? (ammoDef.quantity * quantity);
                newStock = `${h.ammo[ammoDef.ammoType]} ${ammoDef.ammoType.replace(/_/g, ' ')}`;
            }

            const finalGained = isAmmo ? `${ammoDef.quantity * quantity} rounds` : `${quantity}× ${consumableDef.name}`;
            const ammoNote    = isAmmo ? `\nAmmo stock for **${ammoDef.ammoType.replace(/_/g, ' ')}**: ${h.ammo[ammoDef.ammoType]}` : '';

            const successEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${itemDef.emoji} Purchase Successful`)
                .setDescription(`You bought **${finalGained}** for ${currency}${totalCost.toLocaleString()}.${ammoNote}`)
                .addFields(
                    { name: 'New Balance', value: `${currency}${balanceUpdated.balance.toLocaleString()}`, inline: true },
                    { name: 'In Stock',    value: newStock, inline: true }
                );

            if (!isAmmo && ACTIVATABLE.includes(itemId)) {
                successEmbed.setFooter({ text: `Activate with /hunt shop use ${itemId}` });
            }

            await interaction.editReply({ embeds: [successEmbed], components: [] });
        } catch (err) {
            console.error('[huntshop buy] purchase error:', err);
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
    const { success, error } = activateConsumable(user, itemId);

    if (!success) {
        return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    }

    await user.save();

    const def = CONSUMABLES[itemId];
    const h   = user.hunt;
    let statusMsg = '';

    if (def.type === 'bait')                              statusMsg = `Active for **${h.activeBaitHuntsLeft}** hunts.`;
    if (def.type === 'charm')                             statusMsg = `Active for **${h.activeCharmHuntsLeft}** hunts.`;
    if (def.type === 'instant' && itemId === 'hunters_focus') statusMsg = `Will apply on your next hunt.`;
    if (def.type === 'instant' && itemId === 'xp_scroll') statusMsg = `Will apply on your next hunt.`;
    if (def.type === 'stamina')                           statusMsg = `Stamina: **${h.stamina}/${getMaxStamina(user)}** — restored ${def.staminaRestore} points.`;

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${def.emoji} ${def.name} Activated!`)
                .setDescription(`${def.description}\n${statusMsg}`)
                .setFooter({ text: 'Go hunt! Use /hunt start' })
        ]
    });
}

async function handleRepair(interaction, user, currency) {
    const h = user.hunt;

    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Buy one with `/hunt shop weapon` first.', flags: MessageFlags.Ephemeral });
    }

    const weapon = h.weapons[h.equippedWeaponIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', flags: MessageFlags.Ephemeral });
        }

        const kitDef = CONSUMABLES[kitId];
        const stock  = h.consumables[kitId] ?? 0;

        if (stock <= 0) {
            return interaction.reply({
                content: `You don't have any **${kitDef.name}**. Buy them with \`/hunt shop buy\`.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (isCondemned(weapon)) {
            return interaction.reply({ content: 'This weapon is condemned and cannot be repaired. Replace it with `/hunt shop weapon`.', flags: MessageFlags.Ephemeral });
        }
        if (weapon.currentDurability >= weapon.maxDurability) {
            return interaction.reply({ content: `Your **${weapon.name}** is already at full durability.`, flags: MessageFlags.Ephemeral });
        }

        const before = weapon.currentDurability;
        weapon.currentDurability = Math.min(weapon.maxDurability, weapon.currentDurability + kitDef.durabilityRestore);
        updateWeaponStatus(weapon);
        h.consumables[kitId] -= 1;
        user.markModified('hunt');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${kitDef.emoji} Repair Kit Used`)
                    .setDescription(`Your **${weapon.name}** has been field-repaired.`)
                    .addFields(
                        { name: 'Before',         value: `${before}/${weapon.maxDurability}`,                                                  inline: true },
                        { name: 'After',          value: `${weapon.currentDurability}/${weapon.maxDurability}`,                                 inline: true },
                        { name: 'Kits Remaining', value: `${h.consumables[kitId]} × ${kitDef.name}`,                                          inline: true },
                        { name: 'Durability Bar', value: `${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}` }
                    )
                    .setFooter({ text: 'Field repairs do not degrade max durability' })
            ]
        });
    }

    if (isCondemned(weapon)) {
        return interaction.reply({ content: 'This weapon is **condemned** and cannot be repaired. Replace it with `/hunt shop weapon`.', flags: MessageFlags.Ephemeral });
    }
    if (weapon.currentDurability >= weapon.maxDurability && weapon.status !== 'broken') {
        return interaction.reply({ content: `Your **${weapon.name}** is already at full durability (${weapon.currentDurability}/${weapon.maxDurability}).`, flags: MessageFlags.Ephemeral });
    }

    const needed     = weapon.maxDurability - weapon.currentDurability;
    let requestedAmt = interaction.options.getInteger('amount');
    if (!requestedAmt || requestedAmt > needed) requestedAmt = needed;
    requestedAmt = Math.ceil(requestedAmt / 20) * 20;

    // Price the repair before applying it — applyRepair degrades max durability and
    // bumps the repair count, and none of that should happen on a quote the player
    // can't afford.
    const quote = quoteRepair(weapon, requestedAmt);

    if (quote.error) {
        return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });
    }
    if (user.balance < quote.cost) {
        return interaction.reply({
            content: `Repair costs ${currency}${quote.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const result = applyRepair(weapon, requestedAmt);
    if (result.error) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }

    const chargedRepair = await chargeBalance(interaction, result.cost);
    if (!chargedRepair) {
        return interaction.reply({
            content: `Repair costs ${currency}${result.cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    user.balance = chargedRepair.balance;
    user.unmarkModified('balance');
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[huntshop repair] save error:', err);
        await refundBalance(interaction, result.cost);
        return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const statusIcon = weaponStatusEmoji(result.newStatus);
    const embed = new EmbedBuilder()
        .setColor(result.condemned ? '#e74c3c' : '#2ecc71')
        .setTitle('🔧 Weapon Repaired')
        .setDescription(`Your **${weapon.name}** has been repaired.`)
        .addFields(
            { name: 'Durability Restored', value: `+${result.restoredAmount}`,                             inline: true },
            { name: 'New Durability',       value: `${weapon.currentDurability}/${weapon.maxDurability}`,   inline: true },
            { name: 'Weapon Status',        value: `${statusIcon} ${result.newStatus}`,                     inline: true },
            { name: 'Repair Cost',          value: `${currency}${result.cost.toLocaleString()}`,            inline: true },
            { name: 'New Balance',          value: `${currency}${user.balance.toLocaleString()}`,           inline: true },
            { name: 'Repair Count',         value: `${weapon.repairCount} (max dur -10% per repair)`,      inline: true },
            { name: 'Durability Bar',       value: `${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}` }
        );

    if (result.condemned) {
        embed.addFields({ name: '⚠️ Condemned!', value: 'Max durability has dropped too low. This weapon **cannot be repaired again**. Consider replacing it with `/hunt shop weapon`.' });
    } else if (result.newStatus === 'degraded') {
        embed.addFields({ name: '⚠️ Degraded', value: 'Max durability is below 50% of original. Performance is reduced.' });
    }

    embed.setFooter({ text: 'Each shop repair permanently reduces max durability by 10% • Use repair kits to avoid degradation' });

    return interaction.reply({ embeds: [embed] });
}

async function handleUnlock(interaction, user, currency) {
    const h      = user.hunt;
    const zoneId = interaction.options.getString('zone');
    const zone   = ZONES[zoneId];

    if (!zone) {
        return interaction.reply({ content: 'Unknown zone.', flags: MessageFlags.Ephemeral });
    }
    if (zone.defaultUnlocked || h.unlockedZones.includes(zoneId)) {
        return interaction.reply({ content: `**${zone.name}** is already unlocked.`, flags: MessageFlags.Ephemeral });
    }
    if (h.level < zone.unlockLevel) {
        return interaction.reply({
            content: `You need Hunter Level **${zone.unlockLevel}** to unlock **${zone.name}**. You're Level ${h.level}.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < zone.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const chargedUnlock = await chargeBalance(interaction, zone.unlockCost);
    if (!chargedUnlock) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    user.balance = chargedUnlock.balance;
    user.unmarkModified('balance');
    h.unlockedZones.push(zoneId);
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[hunt unlock] save error:', err);
        h.unlockedZones = h.unlockedZones.filter(z => z !== zoneId);
        await refundBalance(interaction, zone.unlockCost);
        return interaction.reply({ content: 'Unlocking the zone failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const tierStr = Object.entries(zone.tierWeights)
        .filter(([, w]) => w > 0)
        .map(([t, w]) => `${t}: ${w}%`)
        .join(' · ');

    const materialStr = (zone.zoneMaterials ?? [])
        .map(id => MATERIAL_NAMES[id] ?? id)
        .join(' · ');

    const unlockEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${zone.emoji} Zone Unlocked: ${zone.name}!`)
        .setDescription(zone.description)
        .addFields(
            { name: 'Loot Table',   value: tierStr,                                                                                             inline: false },
            { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty',           inline: true },
            { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard',                        inline: true },
            { name: 'Unlock Cost',  value: `${currency}${zone.unlockCost.toLocaleString()}`,                                                     inline: true },
            { name: 'New Balance',  value: `${currency}${user.balance.toLocaleString()}`,                                                        inline: true }
        )
        .setFooter({ text: `Switch to it with /hunt zone set ${zoneId}` });

    if (materialStr) {
        unlockEmbed.addFields({ name: '🪨 Materials Found Here', value: materialStr, inline: false });
    }

    return interaction.reply({ embeds: [unlockEmbed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZONE (was /huntzone)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeZone(interaction, sub) {
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
    ensureHuntData(user);
    const h = user.hunt;

    if (sub === 'list') {
        const lines = ZONE_LIST.map(zone => {
            const unlocked = h.unlockedZones.includes(zone.id);
            const isActive = h.activeZone === zone.id;
            const tierStr  = Object.entries(zone.tierWeights)
                .filter(([, w]) => w > 0)
                .map(([t, w]) => `${t}: ${w}%`)
                .join(' · ');

            const statusLine = unlocked
                ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
                : `🔒 Level ${zone.unlockLevel}${zone.unlockCost > 0 ? ` · ${currency}${zone.unlockCost.toLocaleString()}` : ' · Free'}`;

            const diffStr = zone.difficultyMod !== 0 ? ` · ${Math.round(zone.difficultyMod * 100)}% success` : '';
            const payStr  = zone.payoutBonus > 0 ? ` · +${Math.round(zone.payoutBonus * 100)}% payout` : '';

            return `${zone.emoji} **${zone.name}** — ${statusLine}\n> ${zone.description}\n> Loot: ${tierStr}${diffStr}${payStr}`;
        });

        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🗺️ Hunting Zones')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: `Unlock new zones with /hunt shop unlock • Active zone: ${ZONES[h.activeZone]?.name ?? 'Unknown'} • Your level: ${h.level}` });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'set') {
        const zoneId = interaction.options.getString('zone');
        const zone   = ZONES[zoneId];

        if (!zone) {
            return interaction.reply({ content: 'Unknown zone.', flags: MessageFlags.Ephemeral });
        }
        if (!h.unlockedZones.includes(zoneId)) {
            return interaction.reply({
                content: `**${zone.name}** is locked. Unlock it with \`/hunt shop unlock\`.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (h.level < zone.unlockLevel) {
            return interaction.reply({
                content: `You need Hunter Level **${zone.unlockLevel}** to hunt in **${zone.name}**. You're currently Level ${h.level}.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (h.activeZone === zoneId) {
            return interaction.reply({ content: `You're already hunting in **${zone.name}**.`, flags: MessageFlags.Ephemeral });
        }

        const oldZone = ZONES[h.activeZone];
        h.activeZone  = zoneId;
        user.markModified('hunt');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle('🗺️ Zone Changed')
                    .setDescription(`Switched from **${oldZone?.emoji} ${oldZone?.name}** → **${zone.emoji} ${zone.name}**`)
                    .addFields(
                        { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty', inline: true },
                        { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard',              inline: true }
                    )
                    .setFooter({ text: 'Your next /hunt start will use this zone' })
            ]
        });
    }
}

// ─── Grand Prestige Check ─────────────────────────────────────────────────────
const GRAND_PRESTIGE_DIAMOND = 5;

async function checkGrandPrestige(client, user, guild, guildId) {
    const huntDiamond  = (user.hunt?.prestige ?? 0)    >= GRAND_PRESTIGE_DIAMOND;
    const fishDiamond  = (user.fishing?.prestige ?? 0) >= GRAND_PRESTIGE_DIAMOND;
    const mineDiamond  = (user.mining?.prestige ?? 0)  >= GRAND_PRESTIGE_DIAMOND;
    const allDiamond   = huntDiamond && fishDiamond && mineDiamond;

    if (!allDiamond) return;

    const currentLevel = user.grandPrestige?.level ?? 0;
    if (currentLevel >= 1) return;

    await User.updateOne(
        { userId: user.userId, guildId },
        { $set: { 'grandPrestige.level': 1, 'grandPrestige.awardedAt': new Date() } }
    ).catch(() => {});

    const guildSettings = await Guild.findOne({ guildId }, 'economy accountPrestige').lean().catch(() => null);
    const announceChannelId = guildSettings?.accountPrestige?.announceChannelId
        ?? guildSettings?.economy?.announcementChannelId
        ?? null;

    if (announceChannelId && client) {
        const { EmbedBuilder } = require('discord.js');
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

// Test hooks. The command loader only looks for `data` and `execute`
// (src/index.js), so extra exports are inert at runtime.
module.exports.__test__ = { buildHuntEmbed, buildBonusLines, buildTrophyField, buildFieldTrophyField, buildDailyTollField, buildTodayField, buildWeaponPages, WEAPON_SEPARATOR, gradeShot, AIM_WINDOW_MS, AIM_LATE_MS, isCrossEconomyWeapon, huntingDaysFor, huntingDaysLabel, fullRepairCost, CROSS_ECONOMY_DAYS };

// ── Per-user economy lock ─────────────────────────────────────────────────────
// Hunting mutates the user document with read-modify-write saves, so concurrent
// /hunt invocations from the same user can race stamina, daily caps, and drops.
// The lock key is the player rather than this command, so a hand of blackjack
// races the same document and contends for it too — see utils/economyLock.js.
const { withEconomyLock } = require('../../utils/economyLock');
module.exports.execute = withEconomyLock(module.exports.execute, { activity: 'hunt' });
