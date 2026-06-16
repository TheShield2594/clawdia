'use strict';

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const User  = require('../../models/User');
const { attachGrind, persistGrindIfNew } = require('../../utils/grindProfile');
const GrindProfile = require('../../models/GrindProfile');
const Guild = require('../../models/Guild');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse }          = require('../../utils/shopBrowse');
const {
    ZONES, ZONE_LIST, TIER_COLORS, LIMITS, WEAPON_BY_TIER,
    CONSUMABLES, AMMO_PACKS,
    WEAPON_TIERS, WEAPON_BY_SLUG, WEAPON_UPGRADES,
    HUNTER_LEVELS, PRESTIGE_BONUSES, HUNT_QUEST_TEMPLATES,
    ANIMAL_TRAITS
} = require('../../data/huntData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { TIER_NUM, TIER_RIBBON } = require('../../data/materialRarity');
const { randomFrom, HUNT_EMPTY_LINES } = require('../../utils/copyLines');
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
    applyXp,
    rollApexType,
    resolveApexEncounter,
    applyPayoutModifiers
} = require('../../services/huntService');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { stackBar } = require('../../utils/rewardReveal');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS, FEATURED_RARE_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { tryUpdateHourlyWinner, getCurrentHourlyLeader } = require('../../utils/hourlyWinner');
const { isDistrictActive } = require('../../services/districtService');
const { ensureQuests, onHunt, notifyQuestComplete, notifyQuestNearComplete } = require('../../services/questService');
const { getActiveSynergies } = require('../../services/synergyService');

const WILDERNESS_YIELD_BONUS = 0.10;

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
        const midColor = tierNum === 4 ? '#9c27b0' : '#ff9800';
        const midTitle = tierNum === 4 ? '🔮 Something exceptional emerges...' : '⚡ The air crackles with power...';
        const midTierLabel = tierNum === 4 ? 'EPIC' : 'LEGENDARY';
        const midEmbed = new EmbedBuilder()
            .setColor(midColor)
            .setTitle(midTitle)
            .setDescription(`━━━━━━━━━━━━━━━\n❓❓❓  **${midTierLabel}**  ❓❓❓\n━━━━━━━━━━━━━━━`);
        await interaction.editReply({ embeds: [midEmbed] });
        await wait(1500);
        if (tierNum === 5) {
            // Stage 3 — legendary fanfare
            const fanfareEmbed = new EmbedBuilder()
                .setColor('#ff9800')
                .setTitle('⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡')
                .setDescription('━━━━━━━━━━━━━━━\n*The air crackles. This is once in a lifetime.*\n━━━━━━━━━━━━━━━');
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
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
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
        const nextAt = new Date(h.lastHunt.getTime() + LIMITS.HUNT_COOLDOWN_MS);
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🫁 Catching Your Breath',
                description: 'You just came back from a hunt.\nGive it a moment before heading back out.',
                color: '#5a8a3c',
                nextAt,
            })],
            ephemeral: true,
        });
    }

    if (h.stamina <= 0) {
        const regenMs = msUntilNextStamina(user);
        const nextAt  = new Date(Date.now() + regenMs);
        const sinceRare = h.sinceRare ?? 0;
        const pityStat  = sinceRare >= 5
            ? `🎯 ${sinceRare} hunts since last Rare+ • next rare guaranteed around hunt ~50`
            : null;
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Out of Stamina',
                description: "You've pushed yourself to the limit.\nRest up — the wilderness will wait.\nBuy a **Stamina Tonic** from `/hunt shop` to recover faster.",
                color: '#5a8a3c',
                nextAt,
                pityStat,
                nextRewardPreview: 'Full stamina = 10 hunts · Rare+ drops guaranteed by hunt ~50',
            })],
            ephemeral: true,
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

    // ── Stealth Approach + Precision Aim ─────────────────────────────────────
    // Phase 1 — Stealth: player reads a behaviour hint and picks the right approach.
    //   Correct  → stealthBonus = +0.25 success chance, common→uncommon upgrade ~30%
    //   Partial  → stealthBonus = +0.05 (safe but suboptimal)
    //   Wrong    → stealthBonus = −0.10 (spooked the animal)
    //   Timeout  → stealthBonus = 0
    // Phase 2 — Aim: a single quick timing window for the shot.
    //   Perfect (<0.8s) → aimBonus = +0.18 crit chance
    //   Good    (<2.5s) → aimBonus = +0.08 crit chance
    //   Timeout         → aimBonus = 0

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
        // Show "target in sights" then after a short wait show the FIRE! button.
        const aimWaitMs = 1000 + Math.floor(Math.random() * 1001);
        const aimSightsEmbed = new EmbedBuilder()
            .setColor('#8B0000')
            .setTitle('🎯 Target in Sights…')
            .setDescription('*Hold your breath… wait for the right moment…*')
            .setFooter({ text: 'Ready your shot — don\'t fire too early.' });
        await interaction.editReply({ embeds: [aimSightsEmbed], components: [] });
        await delay(aimWaitMs);

        const fireId  = `hunt_fire_${interaction.id}`;
        const aimEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('💥 FIRE!')
            .setDescription('**Take the shot — NOW!**');
        const aimRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(fireId).setLabel('🔫 Fire!').setStyle(ButtonStyle.Danger)
        );
        await interaction.editReply({ embeds: [aimEmbed], components: [aimRow] });
        const aimTime = Date.now();

        const shotMs = await new Promise(resolve => {
            const col = huntMsg.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id && i.customId === fireId,
                time: 2500,
                max: 1,
            });
            col.on('collect', async i => { await i.deferUpdate(); resolve(Date.now() - aimTime); });
            col.on('end',     (_, reason) => { if (reason !== 'limit') resolve(null); });
        });

        if (shotMs !== null && shotMs < 800) {
            aimBonus = 0.18;
        } else if (shotMs !== null) {
            aimBonus = 0.08;
        }

        const aimResultEmbed = new EmbedBuilder()
            .setColor(aimBonus >= 0.18 ? '#FFD700' : aimBonus > 0 ? '#00CC66' : '#888888')
            .setTitle(aimBonus >= 0.18 ? '🎯 Perfect Shot!' : aimBonus > 0 ? '✅ Clean Shot!' : '⏰ Shot rushed…')
            .setDescription(
                aimBonus >= 0.18 ? `Textbook precision. **+18% crit chance** this hunt.` :
                aimBonus > 0     ? `Solid hit. **+8% crit chance** this hunt.` :
                                   `You hesitated on the trigger. No aim bonus this hunt.`
            );
        await interaction.editReply({ embeds: [aimResultEmbed], components: [] });
        await delay(600);

    } else {
        await interaction.deferReply();
    }

    // Wolf pet: +10% coin yield; Eagle pet: +15% XP (only if hunger >= 30)
    const { getTotalBonus, PET_DEFINITIONS: PET_DEFS, STARVING_THRESHOLD: PET_STARVE, TRAIT_FLAVOR } = require('../../services/petService');
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
        const bonus = Math.round(result.finalPayout * petYieldPct / 100);
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
            result.xpEarned      += xpBonus;
            result.petXpBonus     = xpBonus;
        }
    }

    // Featured zone bonus: +25% payout
    if (result.success && result.finalPayout > 0 && isFeaturedZone) {
        const featBonus = Math.round(result.finalPayout * FEATURED_PAYOUT_BONUS);
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

    const huntAchievements = await checkAndAward(user, guildSettings).catch(() => []);

    try {
        await user.save();
        if (huntAchievements.length) {
            announceAchievements(interaction.client, guildSettings, user, interaction.member, huntAchievements).catch(() => null);
        }
        notifyQuestComplete(guildSettings, interaction.member, questsDone, interaction.channel, user).catch(() => null);
        notifyQuestNearComplete(guildSettings, interaction.member, questsNear, interaction.channel).catch(() => null);
    } catch (err) {
        if (err.name === 'VersionError') {
            return interaction.editReply({ content: 'A simultaneous request conflicted with your hunt. Please try `/hunt start` again.' });
        }
        console.error('[hunt] save error:', err);
        return interaction.editReply({ content: 'Something went wrong saving your hunt. Please try again.' });
    }

    // Log big win, then await hourly leader update and re-fetch for accurate footer
    if (result.success && result.finalPayout > 0) {
        const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
        if (result.finalPayout >= bigWinThreshold || result.tier === 'legendary') {
            logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.finalPayout, source: 'hunt', details: result.animal ? `${result.animal.name} [${result.tier}]` : null });
        }
        await tryUpdateHourlyWinner({ guildId: interaction.guild.id, category: 'hunt', userId: interaction.user.id, username: interaction.user.username, value: result.finalPayout, details: result.animal ? `${result.animal.emoji} ${result.animal.name} (${currency}${result.finalPayout.toLocaleString()})` : null }).catch(() => null);
    }
    const hourlyLeader = await getCurrentHourlyLeader(interaction.guild.id, 'hunt').catch(() => null);

    const timeBand = getTimeBand();
    const embed = buildHuntEmbed(result, user, zone, weapon, currency, interaction.user);
    {
        const desc = embed.data.description ?? '';
        const lines = [];
        if (stealthBonus > 0.10) lines.push(`> 🤫 *Perfect approach — +25% success, chance of better prey*`);
        else if (stealthBonus > 0) lines.push(`> 🌿 *Decent approach — +5% success*`);
        else if (stealthBonus < 0) lines.push(`> 🔊 *Spooked the animal — −10% success*`);
        if (aimBonus >= 0.18) lines.push(`> 🎯 *Perfect shot — +18% crit chance*`);
        else if (aimBonus > 0) lines.push(`> ✅ *Clean shot — +8% crit chance*`);
        if (lines.length) embed.setDescription(desc + '\n' + lines.join('\n'));
    }
    if (result.petYieldBonus > 0) {
        embed.addFields({ name: '🐺 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petYieldPct}% yield)`, inline: true });
    }
    if (result.petXpBonus > 0) {
        embed.addFields({ name: '🦅 Pet XP Bonus', value: `+${result.petXpBonus} XP (${petXpPct}%)`, inline: true });
    }
    if (result.featuredZoneBonus > 0) {
        embed.addFields({ name: '🌟 Featured Zone Bonus', value: `+${result.featuredZoneBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`, inline: true });
    }
    if (result.wildernessBonus > 0) {
        embed.addFields({ name: '🌲 Wilderness District', value: `+${result.wildernessBonus.toLocaleString()} coins (+10% yield)`, inline: true });
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

    // Pet narrative: show active pet's personality flavor in description
    if (result.success) {
        const activePet = (user.pets || []).find(p => p.hunger >= PET_STARVE);
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

    // Staged loot reveal for rare+ drops
    await stagedLootReveal(interaction, result.success ? result.tier : null, embed);

    if (result.success && ['epic', 'legendary'].includes(result.tier) && guildSettings?.economy?.announceRareDrops !== false) {
        const announceChannelId = guildSettings?.economy?.announcementChannelId;
        const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
        const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
        const isLeg = result.tier === 'legendary';
        const announcementEmbed = new EmbedBuilder()
            .setColor(isLeg ? '#ff9800' : '#9c27b0')
            .setTitle(isLeg ? '✨ Legendary Trophy! ✨' : '🔮 Epic Find!')
            .setDescription(
                `<@${interaction.user.id}> just brought down ${result.animal.emoji} **${result.animal.name}** [${isLeg ? '⭐⭐⭐⭐⭐' : '⭐⭐⭐⭐'}]\n` +
                `deep in the **${zone.name}**.\n\n` +
                (isLeg ? `Only a handful of hunters have ever managed that.` : `A rare moment in the wild.`)
            )
            .setTimestamp();
        announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
    }

    // ── Apex encounter — multi-phase showdown (mirrors the fishing boss UI) ──
    if (result.apexEncounter) {
        const apexType    = rollApexType();
        const choicesMade = [];
        const phaseCount  = apexType.phases.length;

        const buildApexPhaseEmbed = (phaseIndex, prevResults) => {
            const phase  = apexType.phases[phaseIndex];
            const nerve  = 3 - prevResults.filter(p => !p.correct && p.chosen !== 'safe').length;
            const nerveBar  = '❤️'.repeat(nerve) + '🖤'.repeat(3 - nerve);
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
                .setFooter({ text: `⏱️ 30 seconds per phase • Outcomes: 3/3=1.5x bonus | 2/3=1x | 1/3=0.4x | 0/3=Nothing` });
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
        const apexResult = resolveApexEncounter(freshUser, result.apexEncounter.animal, result.apexEncounter.tier, choicesMade, apexType);

        if (apexResult.bonusPayout > 0) {
            const apexZone = ZONES[freshUser.hunt.activeZone] ?? zone;
            const { adjustedPayout } = applyPayoutModifiers(freshUser, apexResult.bonusPayout, apexZone);
            apexResult.bonusPayout = adjustedPayout;
            freshUser.balance          += adjustedPayout;
            freshUser.hunt.totalEarned += adjustedPayout;
            freshUser.hunt.dailyCoins  += adjustedPayout;
            if (adjustedPayout > freshUser.hunt.bestPayout) freshUser.hunt.bestPayout = adjustedPayout;
        }
        freshUser.markModified('hunt');
        try {
            await freshUser.save();
        } catch (saveErr) {
            console.error('[hunt apex] save error:', saveErr);
            return state.btn.update({ content: 'Something went wrong saving your apex result — the encounter is lost and cannot be retried. Your original hunt rewards were already saved.', embeds: [], components: [] }).catch(() => {});
        }

        if (apexResult.bonusPayout > 0) {
            const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
            if (apexResult.bonusPayout >= bigWinThreshold) {
                logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: apexResult.bonusPayout, source: 'hunt', details: `${result.apexEncounter.animal.emoji ?? ''} ${result.apexEncounter.animal.name} [apex]`.trim() });
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

        await state.btn.update({ embeds: [embed, apexEmbed], components: [] }).catch(() => {});
        return;
    }
}

function buildHuntEmbed(result, user, zone, weapon, currency, discordUser) {
    const h = user.hunt;

    if (result.success) {
        const { animal, tier, traits, finalPayout, isCrit, critMultiplier, trophyQuality, specialDrop, xpEarned, levelUp, cappedByHard, traitEffects } = result;
        const color = isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const payoutDisplay = cappedByHard ? `~~${currency}${finalPayout}~~ (daily cap reached)` : `**${currency}${finalPayout.toLocaleString()}**`;

        const qualityLabel = trophyQuality
            ? `${trophyQuality.emoji} **${trophyQuality.label}** (×${trophyQuality.multiplier.toFixed(2)})`
            : '—';

        const isLegendary = tier === 'legendary';
        const ribbon = TIER_RIBBON(TIER_NUM[tier] ?? 1);
        const embedTitle = isLegendary
            ? `🌟✨ LEGENDARY FIND ✨🌟`
            : `${animal.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${trophyQuality ? trophyQuality.label + ' ' : ''}${animal.name}${isCrit ? ' ✨' : ''}`;
        const embedDesc = isLegendary
            ? `${ribbon}\n\nYou found something impossible in the wild.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${animal.emoji}  **${animal.name}**  [⭐⭐⭐⭐⭐]\n  *${animal.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
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

        const sinceRareNow = user.hunt.sinceRare ?? 0;
        if (sinceRareNow >= 5) embed.addFields(buildPityField(user));

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

    const sinceRareNow = user.hunt.sinceRare ?? 0;
    if (sinceRareNow >= 5) embed.addFields(buildPityField(user));

    embed.setFooter({ text: 'Tip: Use consumables from /hunt shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildFailureTitle(severityId) {
    return { clean_miss: '💨 Miss!', spooked: '😰 Spooked!', jammed: '🔧 Jammed!', injured: '🤕 Injured!' }[severityId] ?? '❌ Failed Hunt';
}

function buildPityField(user) {
    const sinceRare  = user.hunt.sinceRare ?? 0;
    const threshold  = LIMITS.RARE_PITY_GUARANTEE;
    const filled     = Math.min(sinceRare, threshold);
    const barLen     = 16;
    const filledLen  = Math.round((filled / threshold) * barLen);
    const bar        = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);

    let heat, label;
    if (sinceRare >= threshold) {
        heat  = '⚡';
        label = `**GUARANTEED NEXT HUNT**`;
    } else if (sinceRare >= 41) {
        heat  = '🔥';
        label = `Getting hot — ~${threshold - sinceRare} more`;
    } else if (sinceRare >= 26) {
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
    await attachGrind(user);
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
    await attachGrind(user);
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

async function showShopList(interaction, user, currency) {
    const h = user.hunt;

    const weaponItems = WEAPON_TIERS.map(w => ({
        imageId: `hunt:${w.slug}`,
        name:    w.name,
        price:   w.cost,
        emoji:   w.emoji,
        badge:   `T${w.tier}`,
        subline: `${Math.round(w.successRate * 100)}% • +${Math.round(w.rarityBoost * 100)}% rare`
    }));
    const weaponList = WEAPON_TIERS.map(w =>
        `${w.emoji} **${w.name}** — ${currency}${w.cost.toLocaleString()} · \`/hunt shop weapon type:${w.slug}\``
    ).join('\n');

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

    const weaponImg = await getItemImageAttachment(`hunt:${weaponData.slug || weaponData.id}`).catch(() => null);
    if (weaponImg) confirmEmbed.setThumbnail(weaponImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buygun_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buygun_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const huntConfirmPayload = { embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true };
    if (weaponImg) huntConfirmPayload.files = [weaponImg.attachment];
    const reply = await interaction.reply(huntConfirmPayload);
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

    const isAmmo       = !!ammoDef;
    const currentStock = isAmmo
        ? (h.ammo[ammoDef.ammoType] ?? 0)
        : (h.consumables[itemId] ?? 0);

    if (consumableDef) {
        if (currentStock + quantity > consumableDef.maxStack) {
            return interaction.reply({
                content: `You can only hold **${consumableDef.maxStack}× ${consumableDef.name}** at once (you have ${currentStock}).`,
                ephemeral: true
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

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', ephemeral: true });
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

// ── Per-user action lock ──────────────────────────────────────────────────────
// Hunting mutates the user document with read-modify-write saves, so concurrent
// /hunt invocations from the same user can race stamina, daily caps, and drops.
// Serialize them: one hunting action at a time per user.
const { tryAcquire: _lockAcquire, release: _lockRelease } = require('../../utils/activeGameLock');
const _huntExecute = module.exports.execute;
module.exports.execute = async function (interaction) {
    const lockKey   = `grind:hunt:${interaction.guild?.id}:${interaction.user.id}`;
    const lockToken = _lockAcquire(lockKey, 120_000);
    if (!lockToken) {
        return interaction.reply({
            content: '🏹 You already have a hunting action in progress — finish it first.',
            ephemeral: true,
        }).catch(() => {});
    }
    try {
        return await _huntExecute(interaction);
    } finally {
        _lockRelease(lockKey, lockToken);
    }
};
