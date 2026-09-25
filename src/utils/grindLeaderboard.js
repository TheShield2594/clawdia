'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const GrindProfile = require('../models/GrindProfile');
const WeeklyChampion = require('../models/WeeklyChampion');
const COLORS = require('../utils/embedColors');
const {
    getCurrentWeekKey,
    getWeeklyChampionStandings,
    WEEKLY_CATEGORY_LABELS,
    WEEKLY_CATEGORY_ORDER,
} = require('./weeklyChampion');
const { avatarUrlOf, displayNameOf } = require('./leaderboardCard');

// The four grind tracks the README calls "far and away the largest part" of the
// bot, none of which had a board before #1016. Each maps a `/leaderboard type`
// choice onto the two vocabularies these live in: `category` is what
// WeeklyChampion (the live race) calls it, `system` is what GrindProfile (the
// all-time progression) calls it. They are deliberately different words, so the
// translation lives here in one place rather than being open-coded per query.
const GRIND_TRACKS = {
    hunting:   { category: 'hunt',    system: 'hunt',        name: 'Hunting',   emoji: '🏹' },
    fishing:   { category: 'fish',    system: 'fishing',     name: 'Fishing',   emoji: '🎣' },
    mining:    { category: 'mine',    system: 'mining',      name: 'Mining',    emoji: '⛏️' },
    exploring: { category: 'explore', system: 'exploration', name: 'Exploring', emoji: '🧭' },
};

// Only these grind reads are bounded index scans (limit 10 / a handful of
// rewarded rows), but a mis-typed sort or a missing index would silently fall
// back to a collection scan, so every query below caps its server time. The
// board fails loudly rather than dragging the database.
const QUERY_TIMEOUT_MS = 5_000;

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━━';

function medal(i) {
    return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
}

/**
 * Resolve display tags for a list of ids in one round of parallel fetches, the
 * way `/leaderboard`'s other boards do. A member the API cannot resolve yields
 * null and the caller falls back to a stored name or a mention rather than
 * dropping the row — a champion who has since left the server is still a
 * champion.
 */
async function fetchTags(client, ids) {
    return Promise.all(ids.map(id => client.users.fetch(id).catch(() => null)));
}

/** "over 37 runs" — the same note the weekly announcement appends. */
function runNote(runs) {
    return runs > 1 ? ` over ${runs.toLocaleString()} runs` : '';
}

/** One board row for the picture card (utils/leaderboardCard). */
function cardEntry(interaction, rank, userId, user, fallbackName, fields) {
    return {
        rank,
        name: displayNameOf(user) ?? fallbackName ?? 'Unknown',
        avatarUrl: avatarUrlOf(user),
        you: userId === interaction.user.id,
        ...fields,
    };
}

/** The caller's own row for the picture card, drawn under the board when they are off it. */
function callerEntry(interaction, rank, fields) {
    return {
        rank,
        name: interaction.member?.displayName ?? displayNameOf(interaction.user) ?? 'You',
        avatarUrl: avatarUrlOf(interaction.user),
        ...fields,
    };
}

/**
 * The live weekly race for one track: the same standings, in the same order,
 * that Monday's sweep will crown from (both read `getWeeklyChampionStandings`).
 * Shows the caller's own rank and how far they are from first so the race is
 * something to watch between Mondays rather than something to learn about after.
 */
async function buildWeekBoard(interaction, track) {
    const guildId = interaction.guild.id;
    const meta = WEEKLY_CATEGORY_LABELS[track.category] ?? { unit: 'points' };
    const unit = meta.unit;

    const rows = await getWeeklyChampionStandings(guildId, track.category, { limit: 10 });
    if (rows.length === 0) {
        return {
            content: `No ${track.name.toLowerCase()} runs counted yet this week — be the first to make the board!`,
            flags: MessageFlags.Ephemeral,
        };
    }

    const tags = await fetchTags(interaction.client, rows.map(r => r.userId));
    let description = `Top 10 this week by ${unit}\n\n`;
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const name = tags[i]?.tag ?? row.username ?? `<@${row.userId}>`;
        description += `${medal(i)} ${name} — **${(row.total ?? 0).toLocaleString()} ${unit}**${runNote(row.runs ?? 0)}\n`;
        entries.push(cardEntry(interaction, i + 1, row.userId, tags[i], row.username, {
            value: `${(row.total ?? 0).toLocaleString('en-US')} ${unit}`,
            detail: (row.runs ?? 0) > 1 ? `${row.runs.toLocaleString('en-US')} runs` : null,
            score: row.total ?? 0,
        }));
    }

    // Caller's own standing. Rank counts rows with a strictly higher total,
    // which the `{ guildId, week, category, total: -1 }` index serves; a runs
    // tie-break would change at most the caller's neighbours, not the number
    // members care about — how far off the lead they are.
    const week = getCurrentWeekKey();
    const callerRow = await WeeklyChampion
        .findOne({ guildId, week, category: track.category, userId: interaction.user.id })
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean();
    const callerTotal = callerRow?.total ?? 0;
    const leaderTotal = rows[0].total ?? 0;
    const ahead = await WeeklyChampion.countDocuments({
        guildId, week, category: track.category, total: { $gt: callerTotal },
    }).maxTimeMS(QUERY_TIMEOUT_MS);
    const callerRank = ahead + 1;
    const gap = leaderTotal - callerTotal;
    const standing = callerRank === 1 && callerTotal > 0
        ? '👑 leading the race'
        : gap > 0
            ? `${gap.toLocaleString()} ${unit} behind first`
            : 'no runs counted yet';
    const callerLine = `\n${DIVIDER}\n📍 You: **#${callerRank}** — ${callerTotal.toLocaleString()} ${unit} (${standing})`;

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`${track.emoji} ${track.name} — This Week's Race — ${interaction.guild.name}`)
        .setDescription(description + callerLine)
        .setFooter({ text: 'Live standings. The leader on Monday is crowned Champion of the Week.' })
        .setTimestamp();
    const card = {
        theme: track.category,
        kicker: interaction.guild.name,
        title: `${track.name} — This Week's Race`,
        subtitle: `Top 10 this week by ${unit}`,
        entries,
        you: callerEntry(interaction, callerRank, { value: `${callerTotal.toLocaleString('en-US')} ${unit}`, detail: standing.replace(/^👑 /, ''), score: callerTotal }),
        footer: 'The leader on Monday is crowned Champion of the Week.',
    };
    return { embeds: [embed], card };
}

/**
 * The all-time board for one track: highest track level first, lifetime coins
 * (`data.totalEarned`) as the tiebreak — a bounded index scan on
 * `{ guildId, system, data.level: -1, data.totalEarned: -1 }`, never a full
 * collection sort (#1016, and #922 on cases).
 */
async function buildAllTimeBoard(interaction, track) {
    const guildId = interaction.guild.id;
    const projection = { userId: 1, 'data.level': 1, 'data.totalEarned': 1, 'data.prestige': 1 };

    const rows = await GrindProfile
        .find({ guildId, system: track.system }, projection)
        .sort({ 'data.level': -1, 'data.totalEarned': -1 })
        .limit(10)
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean();
    if (rows.length === 0) {
        return {
            content: `No ${track.name.toLowerCase()} profiles yet — try \`/${track.system === 'exploration' ? 'explore' : track.system === 'fishing' ? 'fish' : track.system === 'mining' ? 'mine' : 'hunt'}\` to get started!`,
            flags: MessageFlags.Ephemeral,
        };
    }

    const tags = await fetchTags(interaction.client, rows.map(r => r.userId));
    let description = 'Top 10 all-time by level\n\n';
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const data = rows[i].data ?? {};
        const name = tags[i]?.tag ?? `<@${rows[i].userId}>`;
        const prestige = (data.prestige ?? 0) > 0 ? ` ✨P${data.prestige}` : '';
        const earned = (data.totalEarned ?? 0).toLocaleString();
        description += `${medal(i)} ${name} — Level ${data.level ?? 0}${prestige} (${earned} coins earned)\n`;
        entries.push(cardEntry(interaction, i + 1, rows[i].userId, tags[i], null, {
            value: `Level ${data.level ?? 0}${(data.prestige ?? 0) > 0 ? ` · P${data.prestige}` : ''}`,
            detail: `${(data.totalEarned ?? 0).toLocaleString('en-US')} coins earned`,
            score: data.level ?? 0,
        }));
    }

    // Caller's rank by the same two-key order the board sorts on, so "#12" agrees
    // with where they would appear if the board were longer.
    const callerProfile = await GrindProfile
        .findOne({ guildId, userId: interaction.user.id, system: track.system }, projection)
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean();
    let callerLine = '';
    let you = null;
    if (callerProfile) {
        const cLevel = callerProfile.data?.level ?? 0;
        const cEarned = callerProfile.data?.totalEarned ?? 0;
        const ahead = await GrindProfile.countDocuments({
            guildId, system: track.system,
            $or: [
                { 'data.level': { $gt: cLevel } },
                { 'data.level': cLevel, 'data.totalEarned': { $gt: cEarned } },
            ],
        }).maxTimeMS(QUERY_TIMEOUT_MS);
        callerLine = `\n${DIVIDER}\n📍 You: **#${ahead + 1}** — Level ${cLevel} (${cEarned.toLocaleString()} coins earned)`;
        you = callerEntry(interaction, ahead + 1, {
            value: `Level ${cLevel}`, detail: `${cEarned.toLocaleString('en-US')} coins earned`, score: cLevel,
        });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`${track.emoji} ${track.name} — All-Time — ${interaction.guild.name}`)
        .setDescription(description + callerLine)
        .setTimestamp();
    const card = {
        theme: track.category,
        kicker: interaction.guild.name,
        title: `${track.name} — All-Time`,
        subtitle: 'Top 10 all-time by level, then coins earned',
        entries,
        you,
    };
    return { embeds: [embed], card };
}

/**
 * A grind-track board. `period` is 'week' (the live race) or 'all-time' (level
 * then lifetime coins). Returns a reply payload; the command owns the single
 * reply and its error handling. A board with rows also carries `card`, the
 * picture card's options (utils/leaderboardCard), which the command draws
 * above the text — it is not a reply field, so it is taken off before sending.
 */
async function buildGrindBoard(interaction, type, period) {
    const track = GRIND_TRACKS[type];
    if (!track) throw new Error(`unknown grind track: ${type}`);
    return period === 'week'
        ? buildWeekBoard(interaction, track)
        : buildAllTimeBoard(interaction, track);
}

/**
 * The Hall of Champions: past weekly winners per track, most recent week first.
 *
 * Reads the `rewarded: true` rows the sweep stamps on each crowned winner —
 * served by a partial index over just those rows, so it is a bounded scan of a
 * handful of documents rather than the whole accumulator collection. Those rows
 * carry WeeklyChampion's 21-day TTL, so the hall is a rolling window of the last
 * few weeks, not an eternal archive — which is what "from WeeklyChampion" buys.
 */
async function buildChampionsHall(interaction) {
    const guildId = interaction.guild.id;

    const winners = await WeeklyChampion
        .find({ guildId, rewarded: true })
        .sort({ week: -1 })
        .limit(24)
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean();
    if (winners.length === 0) {
        return {
            content: 'No champions have been crowned yet — the first winners are announced next Monday. Hunt, fish, mine and explore all week to compete!',
            flags: MessageFlags.Ephemeral,
        };
    }

    // Group by week (already in descending order), then order each week's tracks
    // the same way the announcement does.
    const byWeek = new Map();
    for (const w of winners) {
        if (!byWeek.has(w.week)) byWeek.set(w.week, []);
        byWeek.get(w.week).push(w);
    }

    const sections = [];
    for (const [week, rows] of byWeek) {
        rows.sort((a, b) => WEEKLY_CATEGORY_ORDER.indexOf(a.category) - WEEKLY_CATEGORY_ORDER.indexOf(b.category));
        const lines = rows.map(w => {
            const meta = WEEKLY_CATEGORY_LABELS[w.category];
            if (!meta) return null;
            return `${meta.emoji} **${meta.title}** — <@${w.userId}> (${w.username}) · ` +
                `${(w.total ?? 0).toLocaleString()} ${meta.unit}${runNote(w.runs ?? 0)}`;
        }).filter(Boolean);
        if (lines.length) sections.push(`__Week ${week}__\n${lines.join('\n')}`);
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`👑 Hall of Champions — ${interaction.guild.name}`)
        .setDescription(sections.join('\n\n'))
        .setFooter({ text: 'Past weekly champions. New winners crowned every Monday.' })
        .setTimestamp();
    return { embeds: [embed] };
}

module.exports = {
    GRIND_TRACKS,
    buildGrindBoard,
    buildChampionsHall,
};
