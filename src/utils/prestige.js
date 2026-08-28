// Account-level prestige system (issue #342)

// Each tier unlocks new content + grants a global bonus stack.
const PRESTIGE_TIERS = [
    { rank: 0,  title: null,                    bonuses: {},                                                              unlocks: []                                                                                          },
    { rank: 1,  title: 'Prestige I',            bonuses: { yieldPct: 0.03 },                                              unlocks: ['black_market']                                                                            },
    { rank: 2,  title: 'Prestige II',           bonuses: { yieldPct: 0.03, staminaRegenPct: 0.05 },                       unlocks: ['black_market', 'legendary_zones']                                                         },
    { rank: 3,  title: 'Prestige III',          bonuses: { yieldPct: 0.03, staminaRegenPct: 0.05, crimeSuccessPct: 0.05 },unlocks: ['black_market', 'legendary_zones', 'syndicate_leader']                                     },
    { rank: 4,  title: 'Prestige IV',           bonuses: { yieldPct: 0.03, staminaRegenPct: 0.05, crimeSuccessPct: 0.05, xpPct: 0.05 }, unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets']    },
    { rank: 5,  title: 'Prestige V ⭐',          bonuses: { yieldPct: 0.08, staminaRegenPct: 0.05, crimeSuccessPct: 0.05, xpPct: 0.05 },                                        unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge'] },
    { rank: 6,  title: 'Prestige VI',            bonuses: { yieldPct: 0.08, staminaRegenPct: 0.08, crimeSuccessPct: 0.05, xpPct: 0.05 },                                        unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge', 'daily_challenge'] },
    { rank: 7,  title: 'Prestige VII',           bonuses: { yieldPct: 0.09, staminaRegenPct: 0.08, crimeSuccessPct: 0.08, xpPct: 0.05 },                                        unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge', 'daily_challenge', 'syndicate_extra_slot'] },
    { rank: 8,  title: 'Prestige VIII 💠',       bonuses: { yieldPct: 0.09, staminaRegenPct: 0.09, crimeSuccessPct: 0.08, xpPct: 0.08, rareTierShiftPct: 0.005 },              unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge', 'daily_challenge', 'syndicate_extra_slot', 'p8_black_market'] },
    { rank: 9,  title: 'Prestige IX 💠',         bonuses: { yieldPct: 0.10, staminaRegenPct: 0.09, crimeSuccessPct: 0.09, xpPct: 0.09, rareTierShiftPct: 0.01 },               unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge', 'daily_challenge', 'syndicate_extra_slot', 'p8_black_market'] },
    { rank: 10, title: 'The Ascended ✨',         bonuses: { yieldPct: 0.10, staminaRegenPct: 0.10, crimeSuccessPct: 0.10, xpPct: 0.10, rareTierShiftPct: 0.015 },              unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge', 'daily_challenge', 'syndicate_extra_slot', 'p8_black_market', 'ascended'] },
];

const UNLOCK_LABELS = {
    black_market:        '🏴 Black Market shop tab',
    legendary_zones:     '🗺️ Legendary hunt / fish / mine zones',
    syndicate_leader:    '🕴️ Crime syndicate leadership',
    exclusive_pets:      '🦝 Exclusive pets',
    prestige_v_badge:    '⭐ Prestige V star + animated badge',
    daily_challenge:     '📋 Daily Challenge board (bonus coin objectives)',
    syndicate_extra_slot:'👥 +2 syndicate member slots (12 total) for leaders',
    p8_black_market:     '💠 P8+ exclusive Black Market items (Voidsteel Cache, Ghost Ledger, Obsidian Crown)',
    ascended:            '✨ "The Ascended" title + animated profile accent',
};

const SOFT_PRESTIGE_BONUS = { yieldPct: 0.02, xpPct: 0.02 };

/**
 * The tier definition governing a rank: the highest entry in `PRESTIGE_TIERS`
 * whose `rank` is at or below the one asked for.
 *
 * The table is not dense above rank 5, so this floors rather than looks up —
 * which is right for bonuses and unlocks (a rank between two entries keeps the
 * lower one's) and wrong for the display title, since flooring rank 7 would
 * render it "Prestige V". Use `titleForExactRank` for anything a user reads.
 *
 * @param {number} rank a prestige rank; anything non-numeric or negative is 0
 * @returns {{rank: number, title: ?string, bonuses: object, unlocks: string[]}}
 */
function tierFor(rank) {
    const r = Math.max(0, Number(rank) || 0);
    let best = PRESTIGE_TIERS[0];
    for (const tier of PRESTIGE_TIERS) {
        if (tier.rank <= r) best = tier;
    }
    return best;
}

/**
 * The display title for exactly this rank — the explicit `PRESTIGE_TIERS` entry
 * when there is one, otherwise a synthesized `Prestige <roman>`, so a rank the
 * table does not name does not render as the floored tier below it.
 *
 * @param {number} rank
 * @returns {?string} null at rank 0, which has no title
 */
function titleForExactRank(rank) {
    const r = Math.max(0, Number(rank) || 0);
    if (r === 0) return null;
    const explicit = PRESTIGE_TIERS.find(t => t.rank === r);
    if (explicit?.title) return explicit.title;
    return `Prestige ${roman(r)}`;
}

/**
 * What the next prestige buys — the tier at `rank + 1`, for the confirmation
 * `/prestige` shows before it resets an account.
 *
 * Above the last explicit entry there is nothing to look up, so this carries the
 * current tier's bonuses and unlocks forward under the new rank and title. The
 * result is shaped like a `PRESTIGE_TIERS` entry either way.
 *
 * @param {number} rank the rank held now
 * @returns {{rank: number, title: ?string, bonuses: object, unlocks: string[]}}
 */
function nextTierAfter(rank) {
    const r = Math.max(0, Number(rank) || 0);
    const target = r + 1;
    // If we have an explicit entry for this rank, return it; otherwise interpolate from PRESTIGE_TIERS[5] for ranks 6-9, etc.
    const explicit = PRESTIGE_TIERS.find(t => t.rank === target);
    if (explicit) return explicit;
    // Fallback: use prior tier definition with target rank
    const prior = tierFor(target);
    return { ...prior, rank: target, title: `Prestige ${roman(target)}` };
}

/**
 * Roman numerals, for the synthesized tier titles.
 *
 * @param {number} n
 * @returns {string} `'0'` for anything at or below zero
 */
function roman(n) {
    if (n <= 0) return '0';
    const map = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]];
    let out = '';
    for (const [r, v] of map) {
        while (n >= v) { out += r; n -= v; }
    }
    return out;
}

/**
 * The prestige bonuses as multipliers a caller can apply directly — 1.0 at rank
 * 0, so an un-prestiged account needs no special case at the call site.
 *
 * `rareTierShift` is the odd one out: it is an additive probability shift, not a
 * multiplier, and is 0 rather than 1 when the rank grants none.
 *
 * @param {number} rank
 * @returns {{yieldMult: number, xpMult: number, staminaRegenMult: number,
 *   crimeSuccessMult: number, rareTierShift: number}}
 */
function getBonusMultipliers(rank) {
    const tier = tierFor(rank);
    const b = tier.bonuses || {};
    return {
        yieldMult:        1 + (b.yieldPct        ?? 0),
        xpMult:           1 + (b.xpPct           ?? 0),
        staminaRegenMult: 1 + (b.staminaRegenPct ?? 0),
        crimeSuccessMult: 1 + (b.crimeSuccessPct ?? 0),
        rareTierShift:    b.rareTierShiftPct ?? 0,
    };
}

/**
 * Whether a rank has unlocked a piece of content.
 *
 * @param {number} rank
 * @param {string} unlockId a key of `UNLOCK_LABELS` — `'black_market'`,
 *   `'daily_challenge'`, and so on
 * @returns {boolean}
 */
function hasUnlock(rank, unlockId) {
    return tierFor(rank).unlocks.includes(unlockId);
}

/**
 * The badge shown beside a name: `✨` at 10, `⭐` from 5, `⟦P3⟧` below that.
 *
 * @param {number} rank
 * @returns {string} empty at rank 0, so it can be concatenated unconditionally
 */
function badgeFor(rank) {
    if (!rank) return '';
    if (rank >= 10) return '✨';
    if (rank >= 5)  return '⭐';
    if (rank >= 1)  return `⟦P${rank}⟧`;
    return '';
}

module.exports = {
    PRESTIGE_TIERS,
    UNLOCK_LABELS,
    SOFT_PRESTIGE_BONUS,
    tierFor,
    titleForExactRank,
    nextTierAfter,
    getBonusMultipliers,
    hasUnlock,
    badgeFor,
    roman,
};
