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
 * `recordMissionProgress` for callers that never hold a saved user document.
 *
 * Crime, quiz, casino and duels all move coins with targeted atomic updates and
 * deliberately never call `doc.save()` — a save writes `balance` as an absolute
 * `$set` of a number read seconds earlier and would erase anything that landed
 * in between. So this reads the mission fields, advances them, and writes back
 * *only* those two paths. Nothing it touches can collide with a balance update.
 *
 * @returns {Promise<Array<object>>} the missions that completed on this call
 */
async function advanceMissions(Model, filter, event, amount = 1, guildSettings = null) {
    if (guildSettings && !guildSettings?.season?.enabled) return [];
    const doc = await Model.findOne(filter).catch(() => null);
    if (!doc) return [];

    const before   = JSON.stringify(doc.seasonMissions ?? null);
    const finished = recordMissionProgress(doc, event, amount);
    const after    = JSON.stringify(doc.seasonMissions ?? null);
    // A fresh daily set counts as a change even when this event advanced nothing.
    if (before === after) return finished;

    await Model.updateOne(filter, {
        $set: {
            seasonMissions:     doc.seasonMissions,
            seasonMissionsDate: doc.seasonMissionsDate,
        },
    }).catch(err => console.error('[seasonMissions] write failed:', err));

    return finished;
}

module.exports = { ensureMissions, recordMissionProgress, advanceMissions, missionDayStart };
