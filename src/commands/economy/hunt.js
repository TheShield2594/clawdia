'use strict';

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    ZONES, ZONE_LIST, TIER_COLORS, LIMITS, WEAPON_BY_TIER,
    CONSUMABLES, AMMO_PACKS,
    WEAPON_TIERS, WEAPON_BY_SLUG, WEAPON_UPGRADES,
    HUNTER_LEVELS, PRESTIGE_BONUSES, HUNT_QUEST_TEMPLATES,
    ANIMAL_TRAITS
} = require('../../data/huntData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const {
    ensureHuntData,
    applyStaminaRegen,
    applyDailyReset,
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
    applyXp
} = require('../../services/huntService');

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

const MATERIAL_NAMES = {
    rabbits_foot:      "Rabbit's Foot",     acorn_cache:     'Acorn Cache',
    feather:           'Feather',            down_feather:    'Down Feather',
    antler_fragment:   'Antler Fragment',    tusk_shard:      'Tusk Shard',
    badger_pelt:       'Badger Pelt',        beaver_pelt:     'Beaver Pelt',
    coyote_fang:       'Coyote Fang',        wolf_pelt:       'Wolf Pelt',
    elk_antler:        'Grand Antler',       lynx_fang:       'Lynx Fang',
    eagle_talon:       'Eagle Talon',        mountain_horn:   'Mountain Horn',
    bear_claw:         'Bear Claw',          moose_rack:      'Moose Rack',
    lion_tooth:        "Lion's Tooth",       wolverine_fur:   'Wolverine Fur',
    spirit_pelt:       'Spirit Pelt',        megaloceros_crown:'Megaloceros Crown',
    golden_fur:        'Golden Fur',         spirit_essence:  'Spirit Essence',
    ancient_claw:      'Ancient Claw',       thunderfeather:  'Thunderfeather',
    spectral_bone:     'Spectral Bone',      bandit_mask:     'Bandit Mask'
};

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

// ═══════════════════════════════════════════════════════════════════════════════
// START (was /hunt)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeStart(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );

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
        return interaction.reply({ content: `Unknown zone \`${zoneId}\`. Use \`/hunt zone list\` to see available zones.`, ephemeral: true });
    }
    if (!h.unlockedZones.includes(zoneId)) {
        return interaction.reply({
            content: `You haven't unlocked **${zone.name}** yet. Use \`/hunt shop unlock\` to unlock it.`,
            ephemeral: true
        });
    }
    if (h.level < zone.unlockLevel) {
        return interaction.reply({
            content: `You need to be Hunter Level **${zone.unlockLevel}** to hunt in **${zone.name}**.`,
            ephemeral: true
        });
    }

    if (h.injuryUntil && Date.now() < h.injuryUntil.getTime()) {
        const remaining = h.injuryUntil.getTime() - Date.now();
        return interaction.reply({
            content: `You're injured and need to rest. Back in action in **${formatMs(remaining)}**.`,
            ephemeral: true
        });
    }

    if (h.lastHunt && Date.now() - h.lastHunt.getTime() < LIMITS.HUNT_COOLDOWN_MS) {
        const remaining = LIMITS.HUNT_COOLDOWN_MS - (Date.now() - h.lastHunt.getTime());
        return interaction.reply({
            content: `You need to catch your breath. Ready again in **${formatMs(remaining)}**.`,
            ephemeral: true
        });
    }

    if (h.stamina <= 0) {
        const regenMs = msUntilNextStamina(user);
        return interaction.reply({
            content: `You're exhausted! Stamina regens in **${formatMs(regenMs)}**. Buy a Stamina Tonic from \`/hunt shop\` to recover faster.`,
            ephemeral: true
        });
    }

    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({
            content: `You don't have a weapon equipped! Buy one with \`/hunt shop weapon\` and equip it with \`/hunt inv equip 1\`.`,
            ephemeral: true
        });
    }

    const weapon = h.weapons[h.equippedWeaponIndex];

    if (weapon.status === 'broken' || weapon.currentDurability <= 0) {
        return interaction.reply({
            content: `Your **${weapon.name}** is broken! Repair it with \`/hunt shop repair\` or buy a new one with \`/hunt shop weapon\`.`,
            ephemeral: true
        });
    }

    const weaponData = WEAPON_BY_TIER[weapon.tier];
    if (weaponData.requiresAmmo) {
        const ammoStock = h.ammo[weaponData.ammoType] ?? 0;
        if (ammoStock <= 0) {
            return interaction.reply({
                content: `You're out of **${weaponData.ammoType.replace(/_/g, ' ')}**! Buy more with \`/hunt shop buy\`.`,
                ephemeral: true
            });
        }
        h.ammo[weaponData.ammoType] = ammoStock - 1;
        user.markModified('hunt');
    }

    await interaction.deferReply();

    const result = executeHunt(user, zoneId);
    updateHuntQuestProgress(user, result, zoneId);

    const huntAchievements = await checkAndAward(user, guildSettings).catch(() => []);

    try {
        await user.save();
        if (huntAchievements.length) {
            announceAchievements(interaction.client, guildSettings, user, interaction.member, huntAchievements).catch(() => null);
        }
    } catch (err) {
        if (err.name === 'VersionError') {
            return interaction.editReply({ content: 'A simultaneous request conflicted with your hunt. Please try `/hunt start` again.' });
        }
        console.error('[hunt] save error:', err);
        return interaction.editReply({ content: 'Something went wrong saving your hunt. Please try again.' });
    }

    const embed = buildHuntEmbed(result, user, zone, weapon, currency, interaction.user);
    await interaction.editReply({ embeds: [embed] });
}

function buildHuntEmbed(result, user, zone, weapon, currency, discordUser) {
    const h = user.hunt;

    if (result.success) {
        const { animal, tier, traits, finalPayout, isCrit, critMultiplier, specialDrop, xpEarned, levelUp, cappedByHard, traitEffects } = result;
        const color = isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const payoutDisplay = cappedByHard ? `~~${currency}${finalPayout}~~ (daily cap reached)` : `**${currency}${finalPayout.toLocaleString()}**`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${animal.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${animal.name} ${isCrit ? '✨' : ''}`)
            .setDescription(`*${animal.flavor}*`)
            .addFields(
                { name: 'Zone',     value: `${zone.emoji} ${zone.name}`,         inline: true },
                { name: 'Tier',     value: `${tierLabel}`,                        inline: true },
                { name: 'Reward',   value: payoutDisplay,                         inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit bonus)' : ''}`, inline: true },
                { name: 'Weapon',   value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                inline: true }
            );

        if (isCrit) {
            embed.addFields({ name: 'Crit Multiplier', value: `×${critMultiplier}`, inline: true });
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

        if (specialDrop) {
            embed.addFields({ name: '🎁 Special Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        }

        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
        }

        if (result.expiredBait)  embed.addFields({ name: '🪱 Bait Expired', value: `Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`, inline: false });
        if (result.expiredCharm) embed.addFields({ name: '🍀 Charm Expired', value: `Your luck charm has worn off.`, inline: false });

        if (weapon.status === 'broken') {
            embed.addFields({ name: '⚠️ Weapon Broke!', value: `Your **${weapon.name}** has broken! Use \`/hunt shop repair\` before hunting again.`, inline: false });
        } else if (weapon.currentDurability <= Math.floor(weapon.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your **${weapon.name}** is nearly worn out (${weapon.currentDurability}/${weapon.maxDurability}). Repair soon!`, inline: false });
        }

        const balanceLine = `${currency}${user.balance.toLocaleString()}`;
        const xpLine = buildXpLine(user);
        embed.addFields({ name: 'Balance', value: balanceLine, inline: true }, { name: 'Hunter XP', value: xpLine, inline: true });
        embed.setFooter({ text: `Cooldown: 45s • ${buildActiveConsumablesLine(user)}` });
        embed.setTimestamp();
        return embed;
    }

    const { failure, xpEarned, levelUp, animal: failAnimal, traits: failTraits, traitEffects: failTraitEffects } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(failAnimal ? `*Encountered: ${failAnimal.emoji} **${failAnimal.name}***\n${failure.message}` : `*${failure.message}*`)
        .addFields(
            { name: 'Zone',    value: `${zone.emoji} ${zone.name}`,  inline: true },
            { name: 'Reward',  value: 'Nothing',                      inline: true },
            { name: 'XP',      value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Weapon',  value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
            { name: 'Stamina', value: buildStaminaLine(user), inline: true }
        );

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
            embed.addFields({ name: '💀 Severe Injury!', value: `The encounter was catastrophic — your **${result.deathEvent.weaponName}** was completely destroyed! Use \`/hunt shop repair\` to fix it.`, inline: false });
        }
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    if (weapon.status === 'broken' && !result.deathEvent) {
        embed.addFields({ name: '❌ Weapon Broke!', value: `Your **${weapon.name}** has broken! Use \`/hunt shop repair\` before hunting again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /hunt shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildFailureTitle(severityId) {
    return { clean_miss: '💨 Miss!', spooked: '😰 Spooked!', jammed: '🔧 Jammed!', injured: '🤕 Injured!' }[severityId] ?? '❌ Failed Hunt';
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

    const currency = guildSettings?.economy?.currency ?? '💰';

    if (!userData) {
        return interaction.reply({
            content: isSelf
                ? "You haven't started hunting yet! Buy a weapon with `/hunt shop weapon` and use `/hunt start` to begin."
                : `${target.username} hasn't started hunting yet.`,
            ephemeral: true
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
        embed.addFields({ name: '🏆 Trophies', value: h.trophies.join(', '), inline: true });
    }

    if (prestige === 0 && h.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /hunt prestige to reset and unlock new bonuses.' });
    } else if (isSelf) {
        embed.setFooter({ text: `Daily: ${h.dailyHunts} hunts · ${currency}${h.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
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
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    ensureHuntData(user);
    const h = user.hunt;

    if (h.level < 50) {
        return interaction.reply({
            content: `You need Hunter Level **50** to prestige. You are currently Level **${h.level}**.`,
            ephemeral: true
        });
    }

    const currentPrestige = h.prestige ?? 0;
    if (currentPrestige >= MAX_PRESTIGE) {
        return interaction.reply({
            content: `You have already reached the maximum prestige (**P${MAX_PRESTIGE} — Diamond**). You are a true legend! 💎`,
            ephemeral: true
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

async function executeInv(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    ensureHuntData(user);
    const h = user.hunt;

    if (sub === 'weapons') {
        if (!h.weapons.length) {
            return interaction.reply({
                content: "You don't own any weapons! Buy one with `/hunt shop weapon`.",
                ephemeral: true
            });
        }

        const lines = h.weapons.map((w, i) => {
            const isEquipped = i === h.equippedWeaponIndex;
            const wd         = WEAPON_BY_TIER[w.tier];
            const statusIcon = weaponStatusEmoji(w.status);
            const bar        = durabilityBar(w.currentDurability, w.maxDurability, 12);
            const upgrade    = w.upgrade ? `[${w.upgrade.replace(/_/g, ' ')}]` : '';
            const equipped   = isEquipped ? ' **[EQUIPPED]**' : '';
            return [
                `**#${i + 1} — ${wd?.emoji ?? '🔫'} ${w.name}**${equipped}`,
                `> ${statusIcon} ${w.status.toUpperCase()} · ${bar} ${w.currentDurability}/${w.maxDurability} dur`,
                `> Repairs: ${w.repairCount} · Max: ${w.maxDurability}/${w.baseDurability} · ${upgrade || 'No upgrade'}`
            ].join('\n');
        });

        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🔫 Your Weapons')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: 'Use /hunt inv equip <#> to change weapon • /hunt shop repair to restore durability • /hunt shop upgrade for modules' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'equip') {
        const num    = interaction.options.getInteger('number');
        const index  = num - 1;

        if (index < 0 || index >= h.weapons.length) {
            return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s). Use \`/hunt inv weapons\` to see them.`, ephemeral: true });
        }

        const weapon = h.weapons[index];
        if (weapon.status === 'broken') {
            return interaction.reply({ content: `**${weapon.name}** is broken and cannot be equipped. Repair it first with \`/hunt shop repair\`.`, ephemeral: true });
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
            ['iron_shot',       '🔶', 'Iron Shot        (T2 Iron Rifle)'],
            ['steel_shot',      '⚫', 'Steel Shot       (T3 Steel Rifle)'],
            ['composite_round', '🔵', 'Composite Round  (T4 Composite Rifle)'],
            ['titanium_round',  '💎', 'Titanium Round   (T5 Titanium Rifle)']
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

        const embed = new EmbedBuilder()
            .setColor('#1abc9c')
            .setTitle('🪨 Crafting Materials')
            .setDescription(entries.length ? entries.join('\n') : 'No materials yet. Hunt rare+ animals to find special drops!');

        if (!entries.length) {
            embed.setFooter({ text: 'Tip: Use bait from /hunt shop to boost rare animal chances' });
        }

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'discard') {
        const num   = interaction.options.getInteger('number');
        const index = num - 1;

        if (index < 0 || index >= h.weapons.length) {
            return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s).`, ephemeral: true });
        }

        const weapon = h.weapons[index];
        if (weapon.status !== 'broken' && weapon.status !== 'condemned') {
            return interaction.reply({
                content: `**${weapon.name}** is not broken or condemned. You can only discard unusable weapons.`,
                ephemeral: true
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
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
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
            return interaction.reply({ content: 'Unknown quest.', ephemeral: true });
        }

        const questEntry = user.quests.find(q =>
            q.questId === questId &&
            q.expiresAt?.getTime() > now
        );

        if (!questEntry) {
            return interaction.reply({
                content: `You don't have an active **${template.name}** quest. Go hunting to get quests assigned!`,
                ephemeral: true
            });
        }

        if (questEntry.progress === -1) {
            return interaction.reply({
                content: `You already claimed **${template.name}**. Complete your other quests or wait for new ones!`,
                ephemeral: true
            });
        }

        if (!questEntry.completedAt) {
            const progress = Math.min(questEntry.progress, template.target);
            return interaction.reply({
                content: `**${template.name}** is not complete yet (${progress}/${template.target}). Keep hunting!`,
                ephemeral: true
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

        const remaining = user.quests.filter(q =>
            q.questId.startsWith('hq_') &&
            q.expiresAt?.getTime() > now &&
            q.progress !== -1
        ).length;

        embed.setFooter({ text: remaining > 0
            ? `${remaining} quest(s) remaining — use /hunt quests view`
            : 'All quests claimed! Hunt again to receive a fresh set.' });
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
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
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

async function showShopList(interaction, user, currency) {
    const h = user.hunt;

    const weaponSection = WEAPON_TIERS.map(w => {
        const ammo = w.requiresAmmo ? `${w.ammoType.replace(/_/g, ' ')} (${currency}${w.ammoCost}/hunt)` : 'None';
        return `**T${w.tier} ${w.emoji} ${w.name}** — ${currency}${w.cost.toLocaleString()}\n   Success: ${Math.round(w.successRate * 100)}% | Rarity: +${Math.round(w.rarityBoost * 100)}% | Ammo: ${ammo}`;
    }).join('\n');

    const upgradeSection = Object.values(WEAPON_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — ~${Math.round(u.costMultiplier * 100)}% of weapon price\n   *${u.description}*`
    ).join('\n');

    const ammoSection = AMMO_PACKS.map(a =>
        `${a.emoji} **${a.name}** — ${currency}${a.cost}\n   *${a.description}*`
    ).join('\n');

    const consumableSection = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost}\n   *${c.description}*`
    ).join('\n');

    const zoneSection = ZONE_LIST.map(zone => {
        const unlocked = h.unlockedZones.includes(zone.id);
        const isActive = h.activeZone === zone.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${zone.unlockLevel}${zone.unlockCost > 0 ? ` / ${currency}${zone.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${zone.emoji} **${zone.name}** — ${status}\n   *${zone.description}*`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle('🏪 Hunt Shop')
        .addFields(
            { name: '🔫 Weapons',                        value: weaponSection,     inline: false },
            { name: '🔧 Weapon Upgrades (1 per weapon)', value: upgradeSection,    inline: false },
            { name: '🔶 Ammunition',                     value: ammoSection,       inline: false },
            { name: '🧪 Consumables',                    value: consumableSection, inline: false },
            { name: '🗺️ Zones',                          value: zoneSection,       inline: false }
        )
        .setFooter({ text: '/hunt shop weapon • /hunt shop upgrade • /hunt shop buy • /hunt shop use • /hunt shop repair • /hunt shop unlock' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function handleBuyWeapon(interaction, user, currency) {
    const slug       = interaction.options.getString('type');
    const autoEquip  = interaction.options.getBoolean('equip') ?? true;
    const weaponData = WEAPON_BY_SLUG[slug];

    if (!weaponData) {
        return interaction.reply({ content: 'Unknown weapon type.', ephemeral: true });
    }
    if (user.balance < weaponData.cost) {
        return interaction.reply({
            content: `You need **${currency}${weaponData.cost.toLocaleString()}** to buy the **${weaponData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
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

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buygun_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buygun_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', ephemeral: true });
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
        { $inc: { balance: -weaponData.cost }, $push: { 'hunt.weapons': newWeapon } },
        { new: true }
    );

    if (!updated) {
        const reply = { content: `Insufficient funds. You need ${currency}${weaponData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    const h = updated.hunt;
    const newIndex = h.weapons.length - 1;

    if (autoEquip) {
        const oldIndex = h.equippedWeaponIndex;
        h.equippedWeaponIndex = newIndex;
        try {
            await User.updateOne(
                { userId: user.userId, guildId: user.guildId },
                { $set: { 'hunt.equippedWeaponIndex': newIndex } }
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
        return interaction.reply({ content: 'Unknown upgrade module.', ephemeral: true });
    }

    const h = user.hunt;
    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Equip a weapon first with `/hunt inv equip`.', ephemeral: true });
    }

    const weapon     = h.weapons[h.equippedWeaponIndex];
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    const cost       = Math.round(weaponData.cost * upgradeDef.costMultiplier);

    if (weapon.upgrade) {
        return interaction.reply({
            content: `Your **${weapon.name}** already has a **${weapon.upgrade.replace(/_/g, ' ')}** installed. Each weapon supports only one upgrade.`,
            ephemeral: true
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need ${currency}${cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    user.balance   -= cost;
    weapon.upgrade  = moduleId;
    user.markModified('hunt');
    await user.save();

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
        return interaction.reply({ content: 'Unknown item. Use `/hunt shop list` to see available items.', ephemeral: true });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need ${currency}${totalCost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    if (consumableDef) {
        const currentStock = h.consumables[itemId] ?? 0;
        if (currentStock + quantity > consumableDef.maxStack) {
            return interaction.reply({
                content: `You can only hold **${consumableDef.maxStack}× ${consumableDef.name}** at once (you have ${currentStock}).`,
                ephemeral: true
            });
        }
        user.balance          -= totalCost;
        h.consumables[itemId]  = currentStock + quantity;
    } else {
        const ammoType   = ammoDef.ammoType;
        const gained     = ammoDef.quantity * quantity;
        user.balance    -= totalCost;
        h.ammo[ammoType] = (h.ammo[ammoType] ?? 0) + gained;
    }

    user.markModified('hunt');
    await user.save();

    const isAmmo   = !!ammoDef;
    const gained   = isAmmo ? `${ammoDef.quantity * quantity} rounds` : `${quantity}× ${consumableDef.name}`;
    const ammoNote = isAmmo ? `\nAmmo stock for **${ammoDef.ammoType.replace(/_/g, ' ')}**: ${h.ammo[ammoDef.ammoType]}` : '';

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${itemDef.emoji} Purchase Successful`)
        .setDescription(`You bought **${gained}** for ${currency}${totalCost.toLocaleString()}.${ammoNote}`)
        .addFields(
            { name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'In Stock',    value: isAmmo
                ? `${h.ammo[ammoDef.ammoType]} ${ammoDef.ammoType.replace(/_/g, ' ')}`
                : `${h.consumables[itemId]}× ${consumableDef.name}`, inline: true }
        );

    if (!isAmmo && ACTIVATABLE.includes(itemId)) {
        embed.setFooter({ text: `Activate with /hunt shop use ${itemId}` });
    }

    return interaction.reply({ embeds: [embed] });
}

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const { success, error } = activateConsumable(user, itemId);

    if (!success) {
        return interaction.reply({ content: error, ephemeral: true });
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
        return interaction.reply({ content: 'No weapon equipped. Buy one with `/hunt shop weapon` first.', ephemeral: true });
    }

    const weapon = h.weapons[h.equippedWeaponIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', ephemeral: true });
        }

        const kitDef = CONSUMABLES[kitId];
        const stock  = h.consumables[kitId] ?? 0;

        if (stock <= 0) {
            return interaction.reply({
                content: `You don't have any **${kitDef.name}**. Buy them with \`/hunt shop buy\`.`,
                ephemeral: true
            });
        }
        if (weapon.status === 'condemned') {
            return interaction.reply({ content: 'This weapon is condemned and cannot be repaired. Replace it with `/hunt shop weapon`.', ephemeral: true });
        }
        if (weapon.currentDurability >= weapon.maxDurability) {
            return interaction.reply({ content: `Your **${weapon.name}** is already at full durability.`, ephemeral: true });
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

    if (weapon.status === 'condemned') {
        return interaction.reply({ content: 'This weapon is **condemned** and cannot be repaired. Replace it with `/hunt shop weapon`.', ephemeral: true });
    }
    if (weapon.currentDurability >= weapon.maxDurability && weapon.status !== 'broken') {
        return interaction.reply({ content: `Your **${weapon.name}** is already at full durability (${weapon.currentDurability}/${weapon.maxDurability}).`, ephemeral: true });
    }

    const needed     = weapon.maxDurability - weapon.currentDurability;
    let requestedAmt = interaction.options.getInteger('amount');
    if (!requestedAmt || requestedAmt > needed) requestedAmt = needed;
    requestedAmt = Math.ceil(requestedAmt / 20) * 20;

    const result = applyRepair(weapon, requestedAmt);

    if (result.error) {
        return interaction.reply({ content: result.error, ephemeral: true });
    }
    if (user.balance < result.cost) {
        return interaction.reply({
            content: `Repair costs ${currency}${result.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    user.balance -= result.cost;
    user.markModified('hunt');
    await user.save();

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
        return interaction.reply({ content: 'Unknown zone.', ephemeral: true });
    }
    if (zone.defaultUnlocked || h.unlockedZones.includes(zoneId)) {
        return interaction.reply({ content: `**${zone.name}** is already unlocked.`, ephemeral: true });
    }
    if (h.level < zone.unlockLevel) {
        return interaction.reply({
            content: `You need Hunter Level **${zone.unlockLevel}** to unlock **${zone.name}**. You're Level ${h.level}.`,
            ephemeral: true
        });
    }
    if (user.balance < zone.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    user.balance      -= zone.unlockCost;
    h.unlockedZones.push(zoneId);
    user.markModified('hunt');
    await user.save();

    const tierStr = Object.entries(zone.tierWeights)
        .filter(([, w]) => w > 0)
        .map(([t, w]) => `${t}: ${w}%`)
        .join(' · ');

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`${zone.emoji} Zone Unlocked: ${zone.name}!`)
                .setDescription(zone.description)
                .addFields(
                    { name: 'Loot Table',   value: tierStr,                                                                                                        inline: false },
                    { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty',                    inline: true },
                    { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard',                                 inline: true },
                    { name: 'Unlock Cost',  value: `${currency}${zone.unlockCost.toLocaleString()}`,                                                              inline: true },
                    { name: 'New Balance',  value: `${currency}${user.balance.toLocaleString()}`,                                                                  inline: true }
                )
                .setFooter({ text: `Switch to it with /hunt zone set ${zoneId}` })
        ]
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZONE (was /huntzone)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeZone(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
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
            return interaction.reply({ content: 'Unknown zone.', ephemeral: true });
        }
        if (!h.unlockedZones.includes(zoneId)) {
            return interaction.reply({
                content: `**${zone.name}** is locked. Unlock it with \`/hunt shop unlock\`.`,
                ephemeral: true
            });
        }
        if (h.level < zone.unlockLevel) {
            return interaction.reply({
                content: `You need Hunter Level **${zone.unlockLevel}** to hunt in **${zone.name}**. You're currently Level ${h.level}.`,
                ephemeral: true
            });
        }
        if (h.activeZone === zoneId) {
            return interaction.reply({ content: `You're already hunting in **${zone.name}**.`, ephemeral: true });
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
