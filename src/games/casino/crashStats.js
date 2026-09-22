'use strict';

// `/casino crash`'s leaderboard: the weekly and all-time best cash-out
// multipliers on each player's document, and the embed that ranks them.
//
// Split out of crash.js in the economy audit's twelfth pass (#873), which found
// the week-rollover write losing a player's best multiplier to a concurrent
// cash-out, so the write could be tested without driving a whole round.

const { EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const COLORS = require('../../utils/embedColors');
const { multLabel } = require('./crashCurve');

function getCurrentWeekStart() {
    const now  = new Date();
    const day  = now.getUTCDay(); // 0 = Sun
    const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1); // shift to Monday
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), diff));
}

async function updateCrashStats(userId, guildId, multiplier, username) {
    const weekStart = getCurrentWeekStart();

    // Same-week path: atomically raise weekBest and allTimeBest without reading first.
    const raiseThisWeek = () => User.updateOne(
        { userId, guildId, 'crashStats.weekStart': { $gte: weekStart } },
        {
            $max: { 'crashStats.weekBest': multiplier, 'crashStats.allTimeBest': multiplier },
            ...(username && { $set: { 'crashStats.username': username } }),
        }
    );

    const sameWeek = await raiseThisWeek()
        .catch(err => { console.error('[crash] weekly best update failed:', err); return null; });

    if (sameWeek?.matchedCount === 0) {
        // Week rollover or first record: reset weekBest/weekStart, still $max allTimeBest.
        const rolled = await User.updateOne(
            {
                userId, guildId,
                $or: [
                    { 'crashStats.weekStart': { $lt: weekStart } },
                    { 'crashStats.weekStart': null },
                ],
            },
            {
                $set: {
                    'crashStats.weekBest':  multiplier,
                    'crashStats.weekStart': weekStart,
                    ...(username && { 'crashStats.username': username }),
                },
                $max: { 'crashStats.allTimeBest': multiplier },
            }
        ).catch(err => { console.error('[crash] weekRollover update failed:', err); return null; });

        // A concurrent cash-out that also hit the rollover path may have won the
        // conditional $or race and set weekStart already, so the update above
        // matched nothing. That writer has put the week on this week, so the
        // same-week $max now matches — and it raises weekBest as well as
        // allTimeBest. Falling back to allTimeBest alone, as this once did,
        // dropped the week's best whenever the loser of the race was the
        // higher of the two multipliers: a player in two lobbies' rounds on a
        // Monday could cash out at 20× and be ranked on the 1.5× beside it.
        if (rolled?.matchedCount === 0) {
            await raiseThisWeek()
                .catch(err => console.error('[crash] weekly best retry failed:', err));
        }
    }
}

async function buildWeeklyLeaderboard(guildId, _client) {
    const weekStart = getCurrentWeekStart();

    const topUsers = await User.find({
        guildId,
        'crashStats.weekStart': { $gte: weekStart },
        'crashStats.weekBest':  { $gt: 0 },
    })
        .sort({ 'crashStats.weekBest': -1 })
        .limit(10)
        .lean()
        .catch(() => []);

    if (topUsers.length === 0) {
        return new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle('💥 Crash — Weekly Multiplier Leaderboard')
            .setDescription('No crash cash-outs recorded this week yet. Be the first!')
            .setFooter({ text: 'Resets every Monday at midnight UTC' });
    }

    const lines = [];
    for (let i = 0; i < topUsers.length; i++) {
        const u        = topUsers[i];
        const medal    = ['🥇','🥈','🥉'][i] ?? `**${i + 1}.**`;
        const username = u.crashStats.username ?? u.userId;
        lines.push(`${medal} **${username}** — ${multLabel(u.crashStats.weekBest)}`);
    }

    return new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle('💥 Crash — Weekly Multiplier Leaderboard')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Week of ${weekStart.toDateString()} · Resets every Monday` })
        .setTimestamp();
}

module.exports = { getCurrentWeekStart, updateCrashStats, buildWeeklyLeaderboard };
