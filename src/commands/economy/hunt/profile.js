'use strict';

// /hunt profile, /hunt prestige and /hunt records: what the hunter has, what
// they have become, and where they stand against everyone else. The profile's
// shape — a carded overview plus tabs — is shared with /fish and /explore
// through utils/grindProfileView.js and utils/grindProfileCard.js.

const User = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { attachGrind } = require('../../../utils/grindProfile');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    ensureHuntData,
    applyStaminaRegen,
    getLevelData,
    getMaxStamina,
    msUntilNextStamina,
    formatMs,
    msUntilDailyReset
} = require('../../../services/huntService');
const {
    ZONES, ZONE_LIST, ANIMALS, TIER_COLORS, TROPHY_QUALITIES,
    PRESTIGE_BONUSES, HUNTER_LEVELS, FIELD_TROPHIES, LIMITS,
} = require('../../../data/huntData');
const { getActiveSynergies } = require('../../../services/synergyService');
const GrindProfile = require('../../../models/GrindProfile');
const { MAX_PRESTIGE, PRESTIGE_BADGES, PRESTIGE_LABELS } = require('./shared');
const { formatBonuses } = require('./embeds');
const { createGrindProfileCard, createGrindCollectionCard } = require('../../../utils/grindProfileCard');
const {
    buildTodayField: buildSharedTodayField, levelProgress, joinWithin, pagePayload, renderAttachment,
    sendProfileTabs, staminaLine, xpLine,
} = require('../../../utils/grindProfileView');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');
const { ascendGrind } = require('../../../utils/grindPrestige');
const { checkGrandPrestige } = require('../../../services/grandPrestigeService');

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE (was /huntprofile)
// ═══════════════════════════════════════════════════════════════════════════════

// Best grade first. Only Good or better is ever stored (huntService).
const GRADES = [
    { id: 'mythic',   badge: 'M', color: '#9b59b6' },
    { id: 'pristine', badge: 'P', color: '#3498db' },
    { id: 'good',     badge: 'G', color: '#2ecc71' },
];
const TIER_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'event'];
const TIER_LABELS = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', event: 'Mythical' };

const ANIMAL_BY_NAME = new Map(Object.values(ANIMALS).map(a => [a.name, a]));

/**
 * Read the stored trophy strings ("🟣 Mythic Woodpecker") into the best grade
 * held per species. A hunter who has a Good, a Pristine and a Mythic of the same
 * animal has one cabinet slot for it, and it is Mythic. Strings that are not a
 * species trophy — the prestige ribbons /hunt prestige adds — come back apart.
 *
 * @param {string[]} trophies
 * @returns {{bySpecies: Map<string, {animal: object, grade: object}>,
 *            gradeCounts: Record<string, number>, other: string[], total: number}}
 */
function readTrophies(trophies) {
    const bySpecies = new Map();
    const gradeCounts = { mythic: 0, pristine: 0, good: 0 };
    const other = [];
    let total = 0;

    for (const t of trophies ?? []) {
        const quality = TROPHY_QUALITIES.find(q => t.startsWith(`${q.emoji} ${q.label} `));
        const grade = quality && GRADES.find(g => g.id === quality.id);
        const animal = grade && ANIMAL_BY_NAME.get(t.slice(`${quality.emoji} ${quality.label} `.length));
        if (!animal) {
            other.push(t);
            continue;
        }
        total += 1;
        gradeCounts[grade.id] += 1;
        const held = bySpecies.get(animal.id);
        if (!held || GRADES.indexOf(grade) < GRADES.indexOf(held.grade)) {
            bySpecies.set(animal.id, { animal, grade });
        }
    }
    return { bySpecies, gradeCounts, other, total };
}

/** The shelf: best grade first, then the rarest animal. */
function bestTrophies(bySpecies, limit = 10) {
    return [...bySpecies.values()]
        .sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade)
            || TIER_ORDER.indexOf(b.animal.tier) - TIER_ORDER.indexOf(a.animal.tier))
        .slice(0, limit);
}

function gradeSummary(gradeCounts) {
    return `🟣 ${gradeCounts.mythic} · 🔷 ${gradeCounts.pristine} · 🟢 ${gradeCounts.good}`;
}

async function loadProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: target.id, guildId: interaction.guild.id }),
        getGuildSettings(interaction.guild.id)
    ]);
    await attachGrind(userData);
    return { target, isSelf, userData, currency: guildSettings?.economy?.currency ?? '💰' };
}

async function executeProfile(interaction) {
    const { target, isSelf, userData, currency } = await loadProfile(interaction);

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

    const cabinet = readTrophies(userData.hunt.trophies);
    const ctx = { interaction, target, isSelf, userData, currency, cabinet };

    return sendProfileTabs(interaction, [
        { id: 'overview', label: 'Overview', emoji: '🏹', build: () => buildOverviewPage(ctx) },
        { id: 'trophies', label: 'Trophies', emoji: '🏆', build: () => buildTrophyPage(ctx) },
        { id: 'progress', label: 'Progress', emoji: '🎖️', build: () => buildProgressPage(ctx) },
    ]);
}

function profileColor(prestige) {
    return prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#3498db';
}

async function buildOverviewPage({ target, isSelf, userData, currency, cabinet }) {
    const h         = userData.hunt;
    const levelData = getLevelData(h.level);
    const progress  = levelProgress(HUNTER_LEVELS, h.level, h.xp);
    const maxStam   = getMaxStamina(userData);
    const zone      = ZONES[h.activeZone];
    const prestige  = h.prestige ?? 0;
    const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';
    const species   = cabinet.bySpecies.size;
    const speciesTotal = Object.keys(ANIMALS).length;

    const successRate = h.totalHunts > 0
        ? `${Math.round((h.successfulHunts / h.totalHunts) * 100)}%`
        : 'N/A';

    const buffs = [];
    if (h.activeBait)     buffs.push(`Bait (${h.activeBaitHuntsLeft} hunts)`);
    if (h.activeCharm)    buffs.push(`Charm (${h.activeCharmHuntsLeft} hunts)`);
    if (h.activeFocus)    buffs.push('Focus (queued)');
    if (h.activeXpScroll) buffs.push('XP Scroll (queued)');

    const description = [
        `**${levelData.title}** · Level ${h.level}${zone ? ` · ${zone.emoji} ${zone.name}` : ''}`
            + (prestige > 0 ? ` · ${badge} P${prestige}` : ''),
        xpLine(progress, h.level),
        staminaLine(h.stamina, maxStam, msUntilNextStamina(userData), formatMs),
        buffs.length ? `🔋 ${buffs.join(' · ')}` : null,
    ].filter(Boolean).join('\n');

    const embed = new EmbedBuilder()
        .setColor(profileColor(prestige))
        .setTitle(`${badge ? `${badge} ` : ''}${target.username}'s Hunter Profile`)
        .setDescription(description)
        .addFields(
            {
                name: '📊 Record',
                value: [
                    `${h.totalHunts.toLocaleString()} hunts · ${successRate} success`,
                    `${currency}${h.totalEarned.toLocaleString()} earned · best ${currency}${h.bestPayout.toLocaleString()}`,
                    `${h.legendaryKills.toLocaleString()} legendary · ${h.eventKills.toLocaleString()} mythical`,
                ].join('\n'),
                inline: true
            },
            {
                name: '🏆 Trophy Cabinet',
                value: `${species}/${speciesTotal} species · ${cabinet.total} trophies\n${gradeSummary(cabinet.gradeCounts)}`,
                inline: true
            }
        );

    if (isSelf) embed.addFields(buildTodayField(userData, currency));

    if (prestige === 0 && h.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /hunt prestige to reset and unlock new bonuses.' });
    }

    const shelf = bestTrophies(cabinet.bySpecies);
    const card = await renderAttachment(() => createGrindProfileCard({
        activity:      'hunt',
        name:          target.username,
        avatarUrl:     target.displayAvatarURL({ extension: 'png', size: 256 }),
        rankTitle:     levelData.title,
        level:         h.level,
        prestige,
        prestigeLabel: prestige > 0 ? PRESTIGE_LABELS[Math.min(prestige, PRESTIGE_LABELS.length - 1)] : null,
        xp:            { total: h.xp, into: progress.into, span: progress.span },
        place:         zone ? { name: zone.name, iconId: `hunt:${zone.id}` } : null,
        stamina:       { current: h.stamina, max: maxStam },
        stats: [
            { label: 'Hunts',     value: h.totalHunts.toLocaleString('en-US') },
            { label: 'Success',   value: successRate },
            { label: 'Earned',    value: h.totalEarned.toLocaleString('en-US') },
            { label: 'Legendary', value: h.legendaryKills.toLocaleString('en-US') },
        ],
        shelfTitle: `Best trophies · ${species}/${speciesTotal} species`,
        shelf: shelf.map(({ animal, grade }) => ({
            iconId: `animal:${animal.id}`, name: animal.name, badge: grade.badge, badgeColor: grade.color,
        })),
        shelfEmpty: 'No trophies yet — a Good or better kill earns one.',
    }), 'hunt-profile.png',
        `Hunter profile card for ${target.username}: ${levelData.title}, level ${h.level}, `
        + `${progress.span == null ? 'max level' : `${Math.floor(progress.frac * 100)}% to level ${h.level + 1}`}, `
        + `${zone ? `hunting in ${zone.name}, ` : ''}stamina ${h.stamina} of ${maxStam}, `
        + `${h.totalHunts} hunts, ${successRate} success, ${h.legendaryKills} legendary. `
        + (shelf.length ? `Best trophies: ${shelf.map(s => `${s.grade.id} ${s.animal.name}`).join(', ')}.` : 'No trophies yet.'));

    return pagePayload(embed, card);
}

async function buildTrophyPage({ target, isSelf, userData, cabinet }) {
    const h = userData.hunt;
    const animals = Object.values(ANIMALS);
    const species = cabinet.bySpecies.size;

    const tierCounts = TIER_ORDER.map(tier => {
        const inTier = animals.filter(a => a.tier === tier);
        const got = inTier.filter(a => cabinet.bySpecies.has(a.id)).length;
        return inTier.length ? `${TIER_LABELS[tier]} ${got}/${inTier.length}` : null;
    }).filter(Boolean);

    // What is still out there where this hunter can already go — the gaps the
    // cabinet is asking them to fill, not the whole map's.
    const reachable = new Set(h.unlockedZones);
    const missing = animals
        .filter(a => !cabinet.bySpecies.has(a.id) && a.tier !== 'event'
            && (a.zones.includes('all') || a.zones.some(z => reachable.has(z))))
        .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`🏆 ${target.username}'s Trophy Cabinet`)
        .setDescription([
            `**${species} of ${animals.length} species** · ${cabinet.total} trophies in all`,
            gradeSummary(cabinet.gradeCounts),
            tierCounts.join(' · '),
        ].join('\n'))
        .setFooter({ text: 'A Good or better kill earns a trophy · the cabinet shows your best grade of each species' });

    if (missing.length) {
        embed.addFields({
            name: isSelf ? '🎯 Still to find in your zones' : '🎯 Still to find in their zones',
            value: joinWithin(missing.map(a => `${a.emoji} ${a.name}`), ' · ', 1024),
            inline: false,
        });
    }
    if (cabinet.other.length) {
        embed.addFields({ name: '🎗️ Ribbons', value: joinWithin(cabinet.other, '\n', 1024), inline: false });
    }

    const card = await renderAttachment(() => createGrindCollectionCard({
        activity: 'hunt',
        title:    `${target.username}'s Trophy Cabinet`,
        subtitle: `${species} of ${animals.length} species · ${cabinet.gradeCounts.mythic} mythic · `
                + `${cabinet.gradeCounts.pristine} pristine · ${cabinet.gradeCounts.good} good`,
        sections: TIER_ORDER.map(tier => ({
            label: TIER_LABELS[tier],
            color: TIER_COLORS[tier],
            entries: animals.filter(a => a.tier === tier).map(a => {
                const held = cabinet.bySpecies.get(a.id);
                return {
                    iconId: `animal:${a.id}`, name: a.name, owned: Boolean(held),
                    badge: held?.grade.badge, badgeColor: held?.grade.color,
                };
            }),
        })),
    }), 'hunt-trophies.png',
        `Trophy cabinet for ${target.username}: ${species} of ${animals.length} species. ${tierCounts.join(', ')}.`);

    return pagePayload(embed, card);
}

async function buildProgressPage({ target, userData }) {
    const h        = userData.hunt;
    const prestige = h.prestige ?? 0;
    const badge    = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';
    const pBonus   = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(profileColor(prestige))
        .setTitle(`🎖️ ${target.username}'s Hunting Progress`);

    embed.addFields({
        name: prestige > 0 ? `${badge} Prestige ${prestige} Bonuses` : '✨ Prestige',
        value: prestige > 0
            ? formatBonuses(pBonus)
            : `None yet — reach Level 50 and use \`/hunt prestige\` (Level ${h.level} now).`,
        inline: true,
    });

    embed.addFields({
        name: `🗺️ Zones (${h.unlockedZones.length}/${ZONE_LIST.length})`,
        value: ZONE_LIST.map(z => h.unlockedZones.includes(z.id)
            ? `${z.emoji} ${z.name}`
            : `🔒 ${z.name} · Lv ${z.unlockLevel}`).join('\n'),
        inline: true,
    });

    const upgrades = buildFieldTrophyField(h);
    embed.addFields(upgrades ?? {
        name: `🎖️ Permanent Upgrades (0/${Object.keys(FIELD_TROPHIES).length + 2})`,
        value: 'None yet — each zone hides one.',
        inline: false,
    });

    const activeSynergies = getActiveSynergies(userData);
    embed.addFields({
        name: '🔗 Synergies',
        value: activeSynergies.length
            ? activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n')
            : 'Reach combined level milestones across Hunt, Fish, Mine & Explore to unlock cross-system bonuses — see `/synergies`.',
        inline: false,
    });

    return pagePayload(embed, null);
}

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

// Takes the user rather than the hunt subdocument, like its siblings here and
// like the engine's msUntilDailyReset (#892).
function buildTodayField(user, currency) {
    const h = user.hunt ?? {};
    return buildSharedTodayField({
        coins:   h.dailyCoins ?? 0,
        actions: h.dailyHunts ?? 0,
        noun:    'hunts',
        limits:  LIMITS,
        resetMs: msUntilDailyReset(user),
        currency,
        formatMs,
    });
}

async function executePrestige(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
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
        .setColor(COLORS.WARN)
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
        filter: ownedBy(
            interaction.user.id,
            i => ['prestige_confirm', 'prestige_cancel'].includes(i.customId),
            "This isn't your prestige confirmation.",
        ),
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

        // One conditional update, not a save() of the profile read here (#873,
        // pass 20): this runs after execute has released the economy lock, so a
        // hunt mid-run could save over the prestige, or this over the hunt.
        const fromRank = fh.prestige ?? 0;
        const trophy   = PRESTIGE_LABELS[fromRank + 1];
        const ascended = await ascendGrind({
            userId: interaction.user.id, guildId: interaction.guild.id, system: 'hunt',
            minLevel: 50, fromRank, trophy,
        }).catch(err => { console.error('[hunt prestige] ascend error:', err); return null; });
        if (!ascended) {
            await i.update({
                content: 'Prestige conditions are no longer met (level changed, or already prestiged).',
                embeds: [], components: []
            });
            return;
        }
        fh.prestige = fromRank + 1;
        fh.level    = 1;
        fh.xp       = 0;

        checkGrandPrestige(i.client, interaction.user.id, interaction.guildId, interaction.guild);

        const resultEmbed = new EmbedBuilder()
            .setColor(COLORS.WARN)
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
// RECORDS — server-wide all-time hunting records
// ═══════════════════════════════════════════════════════════════════════════════

const RECORD_MEDALS = ['🥇', '🥈', '🥉'];

// A board query that cannot use its index or hits a degenerate plan should
// fail fast rather than hold the deferred reply open.
const RECORDS_QUERY_TIMEOUT_MS = 5_000;

async function topHuntersBy(guildId, sort, filter, fields, line, limit = 3) {
    const projection = { userId: 1 };
    for (const f of fields) projection[f] = 1;
    const profs = await GrindProfile.find({ guildId, system: 'hunt', ...filter }, projection)
        .sort(sort).limit(limit).maxTimeMS(RECORDS_QUERY_TIMEOUT_MS).lean();
    return profs.map((p, i) => `${RECORD_MEDALS[i] ?? `**${i + 1}.**`} <@${p.userId}> — ${line(p.data ?? {})}`).join('\n');
}

async function executeRecords(interaction) {
    await interaction.deferReply();
    const guildSettings = await getGuildSettings(interaction.guild.id).catch(() => null);
    const currency = guildSettings?.economy?.currency ?? '💰';
    const guildId  = interaction.guild.id;

    const describeBest = d => {
        const meta  = d.bestPayoutMeta;
        const base  = `**${currency}${(d.bestPayout ?? 0).toLocaleString()}**`;
        if (!meta?.animalName) return base;
        const zone     = ZONES[meta.zoneId];
        const tierName = meta.tier ? meta.tier.charAt(0).toUpperCase() + meta.tier.slice(1) : null;
        const parts = [
            `${meta.animalEmoji ?? ''} ${tierName ? `${tierName} ` : ''}${meta.animalName}`.trim(),
            zone ? `${zone.emoji} ${zone.name}` : null,
            meta.at ? `<t:${Math.floor(new Date(meta.at).getTime() / 1000)}:d>` : null,
        ].filter(Boolean);
        return `${base} · ${parts.join(' · ')}`;
    };

    const [bestPayout, legendary, mythical, veterans, volume, earned] = await Promise.all([
        topHuntersBy(guildId, { 'data.bestPayout': -1 },     { 'data.bestPayout':     { $gt: 0 } },
            ['data.bestPayout', 'data.bestPayoutMeta'], describeBest),
        topHuntersBy(guildId, { 'data.legendaryKills': -1 }, { 'data.legendaryKills': { $gt: 0 } },
            ['data.legendaryKills'], d => `**${d.legendaryKills.toLocaleString()}** legendary kills`),
        topHuntersBy(guildId, { 'data.eventKills': -1 },     { 'data.eventKills':     { $gt: 0 } },
            ['data.eventKills'], d => `**${d.eventKills.toLocaleString()}** mythical kills`),
        topHuntersBy(guildId, { 'data.prestige': -1, 'data.level': -1 }, { 'data.totalHunts': { $gt: 0 } },
            ['data.prestige', 'data.level'],
            d => `${(d.prestige ?? 0) > 0 ? `${PRESTIGE_BADGES[Math.min(d.prestige, PRESTIGE_BADGES.length - 1)]} P${d.prestige} · ` : ''}Level **${d.level ?? 1}**`),
        topHuntersBy(guildId, { 'data.totalHunts': -1 },  { 'data.totalHunts':  { $gt: 0 } },
            ['data.totalHunts'], d => `**${d.totalHunts.toLocaleString()}** hunts`),
        topHuntersBy(guildId, { 'data.totalEarned': -1 }, { 'data.totalEarned': { $gt: 0 } },
            ['data.totalEarned'], d => `**${currency}${d.totalEarned.toLocaleString()}** earned`),
    ]);

    if (!bestPayout && !volume) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#3b1f04')
                .setTitle('🏹 Server Hunting Records')
                .setDescription('No records yet — head out with `/hunt start` and claim the top spot!')
                .setTimestamp()],
        });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('🏹 Server Hunting Records')
        .setDescription('The all-time boards. The weekly champion race resets every Monday — these never do.')
        .setFooter({ text: 'Records never reset · Your own numbers live in /hunt profile' })
        .setTimestamp();

    if (bestPayout) embed.addFields({ name: '💰 Biggest Single Hunt',  value: bestPayout, inline: false });
    if (legendary)  embed.addFields({ name: '⚡ Legendary Hunters',    value: legendary,  inline: false });
    if (mythical)   embed.addFields({ name: '☄️ Mythical Hunters',     value: mythical,   inline: false });
    if (veterans)   embed.addFields({ name: '🎖️ Highest Rank',        value: veterans,   inline: false });
    if (volume)     embed.addFields({ name: '🏹 Most Hunts',           value: volume,     inline: false });
    if (earned)     embed.addFields({ name: '💵 Career Earnings',      value: earned,     inline: false });

    return interaction.editReply({ embeds: [embed] });
}

module.exports = {
    RECORDS_QUERY_TIMEOUT_MS,
    RECORD_MEDALS,
    bestTrophies,
    buildFieldTrophyField,
    buildTodayField,
    readTrophies,
    executePrestige,
    executeProfile,
    executeRecords,
    topHuntersBy,
};
