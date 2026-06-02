/**
 * District benefit checker — lets other commands query active district bonuses.
 *
 * Usage (synchronous — pass an already-loaded guild document):
 *   const guildDoc = await Guild.findOne({ guildId });
 *   const { isDistrictActive } = require('../services/districtService');
 *   if (isDistrictActive(guildDoc, 'wilderness')) { ... }
 */

/**
 * Returns true if the given district is currently active (fully funded and not expired).
 * @param {object} guildDoc - Loaded Mongoose guild document (not a guildId string).
 * @param {string} districtId - e.g. 'wilderness', 'arena', 'underground'.
 */
function isDistrictActive(guildDoc, districtId) {
    if (!guildDoc?.districts) return false;
    const entry = guildDoc.districts.find(d => d.districtId === districtId);
    if (!entry?.activeUntil) return false;
    return entry.activeUntil.getTime() > Date.now();
}

/**
 * Returns a map of districtId → boolean for all 5 districts.
 */
function getActiveDistricts(guildDoc) {
    const ids = ['marketplace', 'bank', 'underground', 'wilderness', 'arena'];
    const out = {};
    for (const id of ids) out[id] = isDistrictActive(guildDoc, id);
    return out;
}

module.exports = { isDistrictActive, getActiveDistricts };
