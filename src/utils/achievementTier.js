'use strict';

/**
 * The one rarity scale for achievements, keyed on xpReward.
 *
 * The unlock card's tier label and stripe, the reveal/broadcast embed colour
 * and the badge art's rim (assets/icons/build-manifest.mjs) all read this, so
 * they cannot drift apart again: the card used to label by its own
 * Bronze/Silver/Gold/Platinum scale while the embed and the badge rim used
 * Common→Legendary on different breakpoints. The hexes are the item rarity
 * palette (RARITY_CONFIG in src/commands/economy/forge.js), the same colours
 * the badge rims were generated in.
 */

const ACHIEVEMENT_TIERS = [
    { max: 50,       label: 'Common',    color: '#AAAAAA' },
    { max: 200,      label: 'Uncommon',  color: '#2ECC71' },
    { max: 500,      label: 'Rare',      color: '#3498DB' },
    { max: 999,      label: 'Epic',      color: '#9B59B6' },
    { max: Infinity, label: 'Legendary', color: '#FFD700' },
];

/**
 * The rarity tier for an achievement's xpReward (missing or zero is Common).
 * @param {number} xpReward
 * @returns {{ label: string, color: string }}
 */
function achievementTier(xpReward) {
    const xp = Number(xpReward) || 0;
    const { label, color } = ACHIEVEMENT_TIERS.find(t => xp <= t.max);
    return { label, color };
}

module.exports = { ACHIEVEMENT_TIERS, achievementTier };
