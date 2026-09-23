'use strict';

/**
 * Bundled badge art for the built-in achievements.
 *
 * The badges ship with the item-icon catalogue as `achievement:<id>` keys
 * (`src/assets/item-icons/achievement__<id>.png`, see assets/icons/STYLE.md).
 * They are bundle-only: there is no per-guild upload, so this reads the baked
 * default set directly rather than going through getItemImageAttachment and its
 * database fallback.
 *
 * Only built-in definitions get art. Custom achievements are named by guild
 * admins and their ids are free text, so one could reuse a built-in id; the
 * lookup is keyed on the definition object itself, not the id string, so a
 * custom achievement never borrows a built-in badge. Anything without art
 * (custom achievements, badges not generated yet) returns null and the caller
 * keeps its existing fallback — the pixel trophy or the emoji.
 *
 * Secret achievements have art too. Callers must only show it once the
 * achievement is earned, never in a locked list.
 */

const { ACHIEVEMENTS } = require('../data/achievements');
const { getDefaultItemImage } = require('./defaultItemImages');

const BUILT_IN = new Set(ACHIEVEMENTS);

/** The catalogue key for a built-in achievement's badge. */
const achievementArtId = (id) => `achievement:${id}`;

/**
 * The badge PNG for a built-in achievement definition, or null.
 * @param {object} def an achievement definition
 * @returns {Buffer | null}
 */
function getAchievementArt(def) {
    if (!def || !BUILT_IN.has(def)) return null;
    return getDefaultItemImage(achievementArtId(def.id))?.data ?? null;
}

module.exports = { achievementArtId, getAchievementArt };
