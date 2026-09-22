/**
 * Daily snapshots of the overview KPIs that have no event stream of their own
 * (#1076).
 *
 * The v5 overview strip gives Members a week-over-week delta and a 7-day
 * sparkline because joins and leaves are recorded as they happen
 * (`GuildAnalytics.memberEvents`, written by the guildMemberAdd/Remove events).
 * Economy active-users, AI request volume and the top member level are
 * aggregates instead — there is nothing to reconstruct their history from — so
 * they were shown as a bare point-in-time number.
 *
 * This job closes that gap the cheapest way that stays honest: once a day it
 * reads each guild's three current values and writes them as one dated row into
 * `GuildAnalytics.metricSnapshots`, capped at 90 days by the same `$slice` shape
 * memberEvents uses. The /stats route then hands the last 30 rows back and the
 * three tiles render the same delta chip + sparkline as Members. No back-fill:
 * a fresh guild simply shows the number until it has two days of history, which
 * is the graceful-degradation the strip already handles.
 *
 * Registered as a job in services/scheduler/index.js, which owns the cron
 * expression and runs it through runJob. Nothing here schedules itself (#611).
 *
 * @module services/analyticsSnapshotService
 */

const Guild = require('../models/Guild');
const GuildAnalytics = require('../models/GuildAnalytics');
const User = require('../models/User');
const { handlesGuild } = require('../utils/sharding');

// AI commands whose invocations count as "Ask Clawdia" requests. Kept in step
// with the aiCmds list the overview tile sums in public/panel-overview.js, so
// the snapshotted number and the live number are the same quantity.
const AI_COMMANDS = ['ask', 'ai', 'chat', 'aiask', 'clawdia'];

// One row per UTC day, capped so the array stays bounded like memberEvents.
// Ninety days is more than the strip reads (30) but leaves room for a longer
// series later without another migration.
const SNAPSHOT_CAP = 90;

// "Active" is activity in the last 7 days — the same window, and the same set
// of last-action fields, the /stats economy active-users count uses, so the
// snapshot trend and today's headline agree by construction.
const ACTIVE_WINDOW_MS = 7 * 864e5;

function activeUsersFilter(guildId) {
    const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
    return {
        guildId,
        $or: [
            { lastWork:  { $gte: since } },
            { lastDaily: { $gte: since } },
            { lastFish:  { $gte: since } },
            { lastMine:  { $gte: since } },
            { lastCrime: { $gte: since } },
            { lastHeist: { $gte: since } },
            { lastRob:   { $gte: since } }
        ]
    };
}

/**
 * Compute the three snapshot metrics for one guild.
 *
 * All three are trailing quantities as of now, so a day-over-day series of them
 * is an honest trend. AI request volume is the count of Ask-Clawdia commands in
 * the last 7 days — the same rolling window as economy active-users, and
 * bounded rather than the whole retained log: commandUsage keeps up to 3000
 * entries spanning many days, so counting all of them would report a cumulative
 * figure that only ever grows, not the week's volume. It is counted in the
 * aggregation (a `$size` over a `$filter`) rather than by hydrating the array
 * into the process. Economy active-users and top level come from the User
 * collection, the same two questions /stats already asks.
 *
 * @param {string} guildId
 * @returns {Promise<{economyActiveUsers: number, aiRequests: number, topLevel: number}>}
 */
async function computeSnapshot(guildId) {
    const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
    const [economyActiveUsers, topUser, aiAgg] = await Promise.all([
        User.countDocuments(activeUsersFilter(guildId)),
        User.findOne({ guildId }).select('level').sort({ level: -1, xp: -1 }).lean(),
        GuildAnalytics.aggregate([
            { $match: { guildId } },
            { $project: {
                aiRequests: {
                    $size: {
                        $filter: {
                            input: { $ifNull: ['$commandUsage', []] },
                            cond: { $and: [
                                { $in: ['$$this.command', AI_COMMANDS] },
                                { $gte: ['$$this.createdAt', since] }
                            ] }
                        }
                    }
                }
            } }
        ])
    ]);

    return {
        economyActiveUsers,
        aiRequests: aiAgg[0]?.aiRequests || 0,
        topLevel: topUser?.level || 0
    };
}

/**
 * Write today's row for one guild, overwriting it if the job already ran today.
 *
 * The two-step match-then-push is the shape guildMemberAdd's trackMemberEvent
 * uses: update today's entry in place when it exists, otherwise push a new one
 * and trim to SNAPSHOT_CAP. Overwriting rather than skipping makes the job
 * re-runnable within a day — a retry after a partial failure records fresh
 * values instead of a duplicate row — and the `$ne` guard keeps two runs racing
 * the push branch from both inserting.
 *
 * @param {string} guildId
 * @param {string} dateKey  YYYY-MM-DD (UTC)
 * @param {{economyActiveUsers: number, aiRequests: number, topLevel: number}} metrics
 */
async function writeSnapshot(guildId, dateKey, metrics) {
    const result = await GuildAnalytics.updateOne(
        { guildId, 'metricSnapshots.date': dateKey },
        { $set: {
            'metricSnapshots.$.economyActiveUsers': metrics.economyActiveUsers,
            'metricSnapshots.$.aiRequests': metrics.aiRequests,
            'metricSnapshots.$.topLevel': metrics.topLevel
        } }
    );
    if (result.matchedCount) return;

    await GuildAnalytics.updateOne(
        { guildId, 'metricSnapshots.date': { $ne: dateKey } },
        {
            $push: {
                metricSnapshots: {
                    $each: [{ date: dateKey, ...metrics }],
                    $slice: -SNAPSHOT_CAP
                }
            },
            $setOnInsert: { guildId }
        },
        { upsert: true }
    );
}

/**
 * Record one daily metric snapshot per guild this shard handles.
 *
 * Per-guild job (src/services/scheduler): the guild list spans the deployment,
 * so each shard filters it down to the guilds Discord routes to it before doing
 * any per-guild work. A failure on one guild is logged and does not stop the
 * rest; the job throws at the end if any failed so the run lands on /health.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function recordDailyMetricSnapshots(client) {
    const dateKey = new Date().toISOString().slice(0, 10);

    // Only guildId is read — the canonical set of guilds the bot is configured
    // for. The projection is the second argument, not a `.select()`, so the
    // collection scan never hydrates the Guild document's analytics arrays or
    // shop image Buffers (tests/guildScanProjection.test.js enforces this shape).
    const guilds = await Guild.find({}, 'guildId').lean();
    const mine = guilds.filter(g => handlesGuild(g.guildId, client));
    if (!mine.length) return;

    let failed = 0;
    for (const { guildId } of mine) {
        try {
            const metrics = await computeSnapshot(guildId);
            await writeSnapshot(guildId, dateKey, metrics);
        } catch (err) {
            failed += 1;
            console.error(`[scheduler] metric snapshot failed for guild ${guildId}:`, err.message);
        }
    }

    if (failed) {
        throw new Error(`${failed} of ${mine.length} metric snapshot(s) could not be recorded`);
    }
}

module.exports = {
    recordDailyMetricSnapshots,
    // Exported for unit testing.
    computeSnapshot,
    writeSnapshot,
    AI_COMMANDS,
    SNAPSHOT_CAP,
    ACTIVE_WINDOW_MS
};
