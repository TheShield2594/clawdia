'use strict';

// A grind prestige as one conditional update (#873, pass 20).
//
// `/mine prestige` already ascended this way. `/hunt` and `/fish` re-read the
// player at confirm time, reset level and XP on that copy, pushed the trophy,
// and `save()`d it — which writes the whole grind profile back (`prof.data`
// replaced wholesale, utils/grindProfile.js). The confirm runs in a button
// collector after `execute` has returned and released the economy lock, so a
// `/hunt start` or `/fish cast` could be mid-run on the same profile: whichever
// saved second erased the other — the run's materials and XP, or the prestige.
//
// Here the level requirement and the current rank are the filter, and the
// reset and the trophy are the update, so a second confirmation cannot ascend
// twice and nothing else on the profile is touched.

const GrindProfile = require('../models/GrindProfile');

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.guildId
 * @param {string} opts.system    'hunt' | 'fishing' | 'mining'
 * @param {number} opts.minLevel  the level an ascension requires
 * @param {number} opts.fromRank  the prestige rank being left
 * @param {?string} [opts.trophy] a trophy to add in the same write
 * @returns {Promise<?object>} the profile after ascending, or null when the
 *   level or rank no longer qualify (a second confirmation, a level change).
 */
function ascendGrind({ userId, guildId, system, minLevel, fromRank, trophy = null }) {
    // `data.prestige` is absent on profiles that predate the field, so a first
    // ascension has to match that shape too.
    const rankMatches = fromRank === 0
        ? [{ 'data.prestige': 0 }, { 'data.prestige': { $exists: false } }, { 'data.prestige': null }]
        : [{ 'data.prestige': fromRank }];
    const update = { $set: { 'data.prestige': fromRank + 1, 'data.level': 1, 'data.xp': 0 } };
    if (trophy) update.$addToSet = { 'data.trophies': trophy };
    return GrindProfile.findOneAndUpdate(
        { userId, guildId, system, 'data.level': { $gte: minLevel }, $or: rankMatches },
        update,
        { new: true },
    );
}

module.exports = { ascendGrind };
