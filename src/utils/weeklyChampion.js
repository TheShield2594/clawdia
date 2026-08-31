'use strict';

const WeeklyChampion = require('../models/WeeklyChampion');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ISO-8601 week key for a moment, in UTC: 'YYYY-Www'.
 *
 * ISO weeks start on Monday, which is what the sweep's cron does too, so a week
 * bucket and the job that closes it agree on where the boundary is without
 * either having to know about the other.
 *
 * The year in the key is the ISO week-numbering year, not the calendar year:
 * 2027-01-01 is a Friday and belongs to `2026-W53`. Using the calendar year
 * there would give two different weeks the same key across a new year, which is
 * a shared row between two competitions and a double payout on the second.
 */
function weekKeyFor(date) {
    // Midnight UTC of the given day — the time of day never affects which week
    // it is, and dropping it keeps the arithmetic below on whole days.
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

    // The ISO week of a date is the week containing its Thursday, so shift to
    // that Thursday first and everything after it is a plain day count.
    const dayIndex = (day.getUTCDay() + 6) % 7;          // Mon=0 … Sun=6
    const thursday = new Date(day.getTime() + (3 - dayIndex) * 24 * 60 * 60 * 1000);

    const isoYear = thursday.getUTCFullYear();

    // Week 1 is the week containing 4 January, by the same Thursday rule.
    const jan4      = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Index = (jan4.getUTCDay() + 6) % 7;
    const week1Thu  = new Date(jan4.getTime() + (3 - jan4Index) * 24 * 60 * 60 * 1000);

    const week = 1 + Math.round((thursday.getTime() - week1Thu.getTime()) / WEEK_MS);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function getCurrentWeekKey() {
    return weekKeyFor(new Date());
}

/**
 * The week that just closed. Read by the Monday sweep, which runs minutes into
 * the new week, so "seven days ago" always lands inside the previous one
 * wherever in the week the job actually fires.
 */
function getPreviousWeekKey() {
    return weekKeyFor(new Date(Date.now() - WEEK_MS));
}

/**
 * Adds one qualifying run to a player's weekly total.
 *
 * The whole thing is one upsert, as a pipeline update, because `best` and
 * `bestDetails` have to move together: a `$max` on the number with a plain
 * `$set` on the string would leave a row claiming its best run was a Diamond
 * worth less than the number beside it. Every expression in the stage reads the
 * document as it was before the stage, so `bestDetails` compares against the
 * old `best` even though `best` is being replaced in the same breath.
 *
 * Callers pass a score, not a rank: coins for mine/hunt/explore, rarity tier
 * for fish. A non-positive or non-finite value is not a run — nothing is
 * written, so a blank walk or a failed hunt cannot pad a total by inflating
 * `runs`.
 */
async function addWeeklyChampionProgress({ guildId, category, userId, username, value, details = null }) {
    if (!Number.isFinite(value) || value <= 0) return;

    const week = getCurrentWeekKey();
    const filter = { guildId, week, category, userId };
    const update = [
        {
            $set: {
                username,
                total: { $add: [{ $ifNull: ['$total', 0] }, value] },
                runs:  { $add: [{ $ifNull: ['$runs',  0] }, 1] },
                best:  { $max: [{ $ifNull: ['$best',  0] }, value] },
                bestDetails: {
                    $cond: [
                        { $gt: [value, { $ifNull: ['$best', 0] }] },
                        details,
                        { $ifNull: ['$bestDetails', null] },
                    ],
                },
                rewarded:  { $ifNull: ['$rewarded', false] },
                createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
            },
        },
    ];

    // A duplicate key here means two of this player's runs raced to create the
    // same row and one lost the insert. The row exists now, so the retry is an
    // ordinary update and the increment lands — which is the point of retrying
    // rather than swallowing it: this is an accumulator, and a swallowed error
    // is a run that silently never counted.
    try {
        await WeeklyChampion.findOneAndUpdate(filter, update, { upsert: true, updatePipeline: true });
    } catch (err) {
        if (err.code !== 11000) {
            console.error('[weekly] progress update failed:', err.message);
            return;
        }
        try {
            await WeeklyChampion.findOneAndUpdate(filter, update, { upsert: true, updatePipeline: true });
        } catch (retryErr) {
            console.error('[weekly] progress update failed on retry:', retryErr.message);
        }
    }
}

/**
 * The player currently topping a category this week — what the command footers
 * show while the week is still running.
 */
async function getWeeklyChampionLeader(guildId, category) {
    return WeeklyChampion.findOne({ guildId, week: getCurrentWeekKey(), category })
        .sort({ total: -1, runs: -1 })
        .lean();
}

module.exports = {
    weekKeyFor,
    getCurrentWeekKey,
    getPreviousWeekKey,
    addWeeklyChampionProgress,
    getWeeklyChampionLeader,
};
