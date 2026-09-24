'use strict';

/**
 * The items only a `/work` shift can turn up (its Lucky Find).
 *
 * They are not in the shop, so the shop catalogue can't name them; this is
 * their catalogue. `describeItem` reads it for the name, emoji, rarity and
 * lore, `/use` for what each one does, and `/work` for what it drops.
 *
 *   shift_booster  an effect: 1.25x /work pay for 3 hours, on top of a
 *                  Salary Raise (EFFECT_CONFIGS, getShiftMultiplier)
 *   master_key     opens the supply closet: one of the ordinary /work finds
 *   career_badge   counts as CAREER_BADGE_SHIFTS shifts toward the next job
 *                  tier, until the top one
 */
const WORK_FINDS = [
    {
        itemId: 'shift_booster', name: 'Shift Booster', emoji: '📋', rarity: 'Uncommon',
        description: '📋 1.25x pay on /work shifts for 3 hours. Stacks with a Salary Raise.',
        lore: 'A clipboard that makes you look busy enough to be paid like it.',
    },
    {
        itemId: 'master_key', name: 'Master Key', emoji: '🔑', rarity: 'Rare',
        description: '🔑 Opens the supply closet at work: one Lucky Charm, Streak Shield, Lifesaver or 2x booster.',
        lore: 'Facilities has been looking for this since the last reorg.',
    },
    {
        itemId: 'career_badge', name: 'Career Badge', emoji: '📛', rarity: 'Rare',
        description: '📛 Counts as 5 shifts toward your next job tier.',
        lore: 'Name, title, and a photo nobody approved.',
    },
];

const WORK_FINDS_BY_ID = new Map(WORK_FINDS.map(f => [f.itemId, f]));

/** The work-find row for an id (case-insensitive), or null. */
function getWorkFind(itemId) {
    return WORK_FINDS_BY_ID.get(String(itemId ?? '').toLowerCase()) ?? null;
}

// What the Master Key's supply closet holds: the ordinary /work finds, weighted
// toward the cheap ones.
const SUPPLY_CLOSET = [
    { itemId: 'lucky_charm',     weight: 30, emoji: '🍀',   name: 'Lucky Charm' },
    { itemId: 'streak_shield',   weight: 20, emoji: '🔥🛡️', name: 'Streak Shield' },
    { itemId: 'lifesaver',       weight: 20, emoji: '🛟',   name: 'Lifesaver' },
    { itemId: 'coin_booster_2x', weight: 15, emoji: '💰🚀', name: '2x Coin Booster' },
    { itemId: 'xp_booster_2x',   weight: 15, emoji: '⭐🚀', name: '2x XP Booster' },
];

function rollSupplyCloset(randomFn = Math.random) {
    const total = SUPPLY_CLOSET.reduce((sum, e) => sum + e.weight, 0);
    let r = randomFn() * total;
    for (const entry of SUPPLY_CLOSET) {
        r -= entry.weight;
        if (r < 0) return entry;
    }
    return SUPPLY_CLOSET[SUPPLY_CLOSET.length - 1];
}

// How many shifts a Career Badge is worth.
const CAREER_BADGE_SHIFTS = 5;

module.exports = { WORK_FINDS, getWorkFind, SUPPLY_CLOSET, rollSupplyCloset, CAREER_BADGE_SHIFTS };
