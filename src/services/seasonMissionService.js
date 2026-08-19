'use strict';

/**
 * Season pass daily missions — the part that makes them move.
 *
 * `generateDailyMissions()` has always handed out three missions a day, and
 * `/season` has always rendered them with a progress bar and a claim button.
 * Nothing ever wrote to `progress`. Every mission sat at 0/target until midnight
 * rolled it over for a fresh three that also never moved, and
 * `/season claim-mission` refused all of them for not being finished.
 *
 * This is the missing half: one call per player action, from the command that
 * performed it. Missions listening for that event advance; the ones that finish
 * come back so the caller can say so.
 *
 * The rollover lives here too, so a player who hasn't opened `/season` today
 * still gets credited — previously the only thing that dealt a fresh hand was
 * opening the menu, which meant acting before looking silently lost the progress.
 */

const { generateDailyMissions } = require('../data/seasonMissions');

/** Midnight UTC of the day `now` falls in — when a mission set expires. */
function missionDayStart(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Deal a fresh set of daily missions if the stored ones are from an earlier day.
 * Mutates `user` in memory; the caller is responsible for saving.
 *
 * @returns {boolean} true if a new set was dealt
 */
function ensureMissions(user, now = new Date()) {
    if (!user) return false;
    const today   = missionDayStart(now);
    const stamped = user.seasonMissionsDate ? new Date(user.seasonMissionsDate).getTime() : null;
    if (stamped !== null && stamped >= today.getTime() && Array.isArray(user.seasonMissions)) return false;

    user.seasonMissions     = generateDailyMissions();
    user.seasonMissionsDate = today;
    user.markModified('seasonMissions');
    user.markModified('seasonMissionsDate');
    return true;
}

/**
 * Advance every daily mission listening for `event`.
 *
 * Mutates `user` in memory and does not save — callers are already saving the
 * user document at the end of the action that triggered this, and a save here
 * would race the read-modify-write they are in the middle of.
 *
 * @param {object} user           - user document (season missions live on it)
 * @param {string} event          - mission event key, e.g. 'hunt' | 'explore'
 * @param {number} [amount]       - how much progress this action is worth
 * @param {object} [guildSettings]- when given, progress only accrues while the
 *                                  season pass is switched on for the guild
 * @returns {Array<object>} the missions that completed on this call
 */
function recordMissionProgress(user, event, amount = 1, guildSettings = null) {
    if (!user || !event) return [];
    if (guildSettings && !guildSettings?.season?.enabled) return [];
    const step = Math.floor(amount);
    if (!(step > 0)) return [];

    ensureMissions(user);

    const finished = [];
    let touched = false;
    for (const mission of user.seasonMissions ?? []) {
        if (mission.event !== event || mission.completed) continue;
        const target = mission.target ?? 0;
        mission.progress = Math.min(target, (mission.progress ?? 0) + step);
        touched = true;
        if (mission.progress >= target) {
            mission.completed = true;
            finished.push(mission);
        }
    }
    if (touched) user.markModified('seasonMissions');
    return finished;
}

/**
 * The mission-advancing half of `recordMissionProgress`, expressed as an
 * aggregation pipeline so Mongo applies it to whatever the document holds at
 * write time.
 *
 * The obvious implementation — read the array, mutate it, `$set` it back — loses
 * a race it is guaranteed to enter. Casino bets, crimes and quiz answers all
 * advance missions fire-and-forget, so two can be in flight at once and the
 * second write silently drops the first one's progress. Worse, `/season
 * claim-mission` marks a mission `claimed` with its own save: land that between
 * this read and this write and the flag is erased, and the same mission can be
 * claimed a second time for another payout.
 *
 * `$mergeObjects` touches only `progress` and `completed` on the missions
 * listening for this event, so `claimed` and every other field survive whatever
 * else is writing at the same moment.
 */
function missionAdvancePipeline(event, step) {
    return [{
        $set: {
            seasonMissions: {
                $map: {
                    input: { $ifNull: ['$seasonMissions', []] },
                    as: 'm',
                    in: {
                        $cond: [
                            { $and: [
                                { $eq: ['$$m.event', event] },
                                { $ne: ['$$m.completed', true] },
                            ] },
                            { $let: {
                                vars: { next: { $add: [{ $ifNull: ['$$m.progress', 0] }, step] } },
                                in: {
                                    $mergeObjects: ['$$m', {
                                        // min(next, target) and next >= target, in the
                                        // operators Mongo and the test evaluator share.
                                        progress:  { $cond: [{ $gt: ['$$next', '$$m.target'] }, '$$m.target', '$$next'] },
                                        completed: { $not: [{ $gt: ['$$m.target', '$$next'] }] },
                                    }],
                                },
                            } },
                            '$$m',
                        ],
                    },
                },
            },
        },
    }];
}

/**
 * `recordMissionProgress` for callers that never hold a saved user document.
 *
 * Crime, quiz, casino and duels all move coins with targeted atomic updates and
 * deliberately never call `doc.save()` — a save writes `balance` as an absolute
 * `$set` of a number read seconds earlier and would erase anything that landed
 * in between. So this advances the missions in place, server-side, and touches
 * no other field on the document.
 *
 * @returns {Promise<Array<object>>} the missions that completed on this call
 */
async function advanceMissions(Model, filter, event, amount = 1, guildSettings = null) {
    if (guildSettings && !guildSettings?.season?.enabled) return [];
    const step = Math.floor(amount);
    if (!(step > 0)) return [];

    // Deal today's hand first if the stored one has expired. Guarded on the
    // stored date so that concurrent callers can't each deal a different three.
    const today = missionDayStart();
    await Model.updateOne(
        {
            ...filter,
            $or: [
                { seasonMissionsDate: null },
                { seasonMissionsDate: { $exists: false } },
                { seasonMissionsDate: { $lt: today } },
            ],
        },
        { $set: { seasonMissions: generateDailyMissions(), seasonMissionsDate: today } },
    ).catch(err => console.error('[seasonMissions] rollover failed:', err));

    // `new: false` returns the pre-image, which is the only way to tell which
    // missions this call is the one to finish — the update itself is applied by
    // Mongo, so the post-image alone cannot say who got there first.
    const before = await Model.findOneAndUpdate(filter, missionAdvancePipeline(event, step), { new: false })
        .catch(err => {
            console.error('[seasonMissions] write failed:', err);
            return null;
        });
    if (!before) return [];

    return (before.seasonMissions ?? []).filter(m =>
        m.event === event
        && m.completed !== true
        && ((m.progress ?? 0) + step) >= (m.target ?? 0));
}

module.exports = { ensureMissions, recordMissionProgress, advanceMissions, missionAdvancePipeline, missionDayStart };
