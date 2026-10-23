'use strict';

/**
 * The `/season leaderboard` and `/syndicate leaderboard` boards.
 *
 * They live here rather than in their commands for the reason
 * utils/grindLeaderboard does: both command files are over the command-file
 * size cap and frozen there, and each board now carries a picture card
 * (utils/leaderboardCard) as well as its text. Each builder returns a reply
 * payload — with `card`, the picture card's options, when the board has rows —
 * and the command sends it through `replyBoard`.
 *
 * @module utils/economyLeaderboards
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../models/User');
const Syndicate = require('../models/Syndicate');
const COLORS = require('./embedColors');
const { getGuildSettings } = require('./guildSettingsCache');
const { seasonLabel } = require('./seasonLabel');
const { avatarUrlOf, displayNameOf } = require('./leaderboardCard');

/** Discord users for a list of ids, fetched together; null where one cannot be resolved. */
function fetchUsers(interaction, ids) {
    return Promise.all(ids.map(id => interaction.client.users.fetch(id).catch(() => null)));
}

/** The current economy season's top ten by season coins. */
async function buildSeasonBoard(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    const currentSeason = guildSettings?.currentSeason;

    if (!currentSeason?.id) {
        return { content: 'No active economy season on this server.', flags: MessageFlags.Ephemeral };
    }

    const topUsers = await User.find({ guildId: interaction.guild.id })
        .sort({ seasonCoins: -1 })
        .limit(10)
        .select('userId seasonCoins');

    if (topUsers.length === 0) {
        return { content: 'No season data yet.', flags: MessageFlags.Ephemeral };
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const lines = topUsers.map((u, i) =>
        `${medals[i] ?? `${i + 1}.`} <@${u.userId}> — **${(u.seasonCoins ?? 0).toLocaleString()}** ${currency}`
    );

    const endsAt = currentSeason.endsAt
        ? `<t:${Math.floor(new Date(currentSeason.endsAt).getTime() / 1000)}:R>`
        : '*No end date*';

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`📊 Season Leaderboard — ${seasonLabel(currentSeason)}`)
        .setDescription(lines.join('\n'))
        .addFields({ name: '⏰ Season Ends', value: endsAt, inline: true })
        .setFooter({ text: 'Only season coins earned this season count — wallet is never reset!' })
        .setTimestamp();

    const members = await fetchUsers(interaction, topUsers.map(u => u.userId));
    const card = {
        theme: 'board',
        kicker: interaction.guild.name,
        title: 'Season Leaderboard',
        subtitle: seasonLabel(currentSeason),
        entries: topUsers.map((u, i) => ({
            rank: i + 1,
            name: displayNameOf(members[i]) ?? 'Unknown member',
            avatarUrl: avatarUrlOf(members[i]),
            value: `${(u.seasonCoins ?? 0).toLocaleString('en-US')} season coins`,
            score: u.seasonCoins ?? 0,
            you: u.userId === interaction.user.id,
        })),
        footer: 'Only season coins earned this season count — the wallet is never reset.',
    };
    return { embeds: [embed], card };
}

/** The server's syndicates by lifetime earnings, each drawn under its leader's avatar. */
async function buildSyndicateBoard(interaction, guildDoc) {
    const currency = guildDoc?.economy?.currency ?? '💰';
    const top = await Syndicate.find({ guildId: interaction.guild.id })
        .sort({ lifetimeEarnings: -1 })
        .limit(10)
        .lean();

    if (!top.length) {
        return { content: 'No syndicates have been founded on this server yet.', flags: MessageFlags.Ephemeral };
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = top.map((syn, i) => {
        const rank = medals[i] ?? `${i + 1}.`;
        const tag  = syn.tag ? ` [${syn.tag}]` : '';
        return `${rank} **${syn.name}**${tag} — ${currency}${(syn.lifetimeEarnings || 0).toLocaleString()} · ${syn.memberIds.length} members · Heat ${syn.heat || 0}`;
    });

    const embed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('🏆 Syndicate Leaderboard')
        .setDescription(lines.join('\n'))
        .setTimestamp();

    const leaders = await fetchUsers(interaction, top.map(syn => syn.leaderId));
    const card = {
        theme: 'syndicate',
        kicker: interaction.guild.name,
        title: 'Syndicate Leaderboard',
        subtitle: 'Top 10 by lifetime earnings',
        entries: top.map((syn, i) => ({
            rank: i + 1,
            name: syn.tag ? `${syn.name} [${syn.tag}]` : syn.name,
            avatarUrl: avatarUrlOf(leaders[i]),
            value: `${(syn.lifetimeEarnings || 0).toLocaleString('en-US')} coins`,
            detail: [
                `${syn.memberIds.length} member${syn.memberIds.length !== 1 ? 's' : ''}`,
                `Heat ${syn.heat || 0}`,
                leaders[i] ? `led by ${displayNameOf(leaders[i])}` : null,
            ].filter(Boolean).join(' · '),
            score: syn.lifetimeEarnings || 0,
            you: (syn.memberIds ?? []).includes(interaction.user.id),
        })),
    };
    return { embeds: [embed], card };
}

module.exports = { buildSeasonBoard, buildSyndicateBoard };
