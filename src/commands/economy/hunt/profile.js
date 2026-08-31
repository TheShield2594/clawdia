'use strict';

// /hunt profile, /hunt prestige and /hunt records: what the hunter has, what
// they have become, and where they stand against everyone else.

const User = require('../../../models/User');
const Guild = require('../../../models/Guild');
const { attachGrind } = require('../../../utils/grindProfile');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    ensureHuntData,
    applyStaminaRegen,
    getLevelData,
    xpToNextLevel,
    getMaxStamina,
    msUntilNextStamina,
    formatMs,
    getDiminishingReturns,
    msUntilDailyReset
} = require('../../../services/huntService');
const { ZONES, PRESTIGE_BONUSES, HUNTER_LEVELS, FIELD_TROPHIES, LIMITS } = require('../../../data/huntData');
const { getActiveSynergies } = require('../../../services/synergyService');
const GrindProfile = require('../../../models/GrindProfile');
const { MAX_PRESTIGE, PRESTIGE_BADGES, PRESTIGE_LABELS } = require('./shared');
const { buildXpBar, formatBonuses } = require('./embeds');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');

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
            value: 'Reach combined level milestones across Hunt, Fish, Mine & Explore to unlock cross-system bonuses!',
            inline: false
        });
    }

    if (isSelf) embed.addFields(buildTodayField(userData, currency));

    if (prestige === 0 && h.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /hunt prestige to reset and unlock new bonuses.' });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
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

// Takes the user rather than the hunt subdocument, like its siblings here and
// like the engine's msUntilDailyReset (#892).
function buildTodayField(user, currency) {
    const h = user.hunt ?? {};

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
    lines.push(`🕛 Resets in ${formatMs(msUntilDailyReset(user))}`);

    return { name: '📅 Today', value: lines.join('\n'), inline: false };
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
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id }, 'economy').lean().catch(() => null);
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
            .setColor(COLORS.PRIZE)
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

module.exports = {
    GRAND_PRESTIGE_DIAMOND,
    RECORDS_QUERY_TIMEOUT_MS,
    RECORD_MEDALS,
    TROPHY_FIELD_BUDGET,
    TROPHY_RANK,
    buildFieldTrophyField,
    buildTodayField,
    buildTrophyField,
    checkGrandPrestige,
    executePrestige,
    executeProfile,
    executeRecords,
    topHuntersBy,
};
