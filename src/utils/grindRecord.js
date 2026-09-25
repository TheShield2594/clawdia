'use strict';

/**
 * The server record a result card marks on its gauge: the biggest value of one
 * grind stat anyone but `excludeUserId` holds in this guild. The caller adds
 * the player's own best from before the run being drawn, so a record the run
 * just set is not measured against itself.
 *
 * One indexed read — every field asked for here has a
 * (guildId, system, data.<field>) index on GrindProfile — bounded so a slow
 * database costs the card its marker rather than the player their result.
 * Null when unknown, which draws no marker.
 *
 * @module utils/grindRecord
 */

/**
 * @param {string} guildId
 * @param {'hunt'|'fishing'|'mining'|'exploration'} system
 * @param {string} field          the `data` key, e.g. 'bestPayout'
 * @param {string} excludeUserId
 * @returns {Promise<?number>}
 */
async function serverBest(guildId, system, field, excludeUserId) {
    try {
        const GrindProfile = require('../models/GrindProfile');
        const path = `data.${field}`;
        const top = await GrindProfile.findOne(
            { guildId, system, userId: { $ne: excludeUserId }, [path]: { $gt: 0 } },
            { [path]: 1 },
        ).sort({ [path]: -1 }).maxTimeMS(2000).lean();
        return top?.data?.[field] ?? 0;
    } catch {
        return null;
    }
}

/**
 * Where a payout stands: the player's best before this run, and the server
 * record before it — the larger of everyone else's best and the player's own.
 * Null parts are unknown (a read that failed), and draw nothing.
 */
function standing(payout, { priorBest = 0, othersBest = null } = {}) {
    const record = othersBest == null ? null : Math.max(othersBest, priorBest);
    return {
        best: priorBest,
        record,
        personalBest: priorBest > 0 && payout > priorBest,
        serverRecord: record != null && payout > 0 && payout > record,
    };
}

module.exports = { serverBest, standing };
