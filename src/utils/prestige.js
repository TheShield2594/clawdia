// Account-level prestige system (issue #342)

// Each tier unlocks new content + grants a global bonus stack.
const PRESTIGE_TIERS = [
    { rank: 0,  title: null,                    bonuses: {},                                                              unlocks: []                                                                                          },
    { rank: 1,  title: 'Prestige I',            bonuses: { yieldPct: 0.03 },                                              unlocks: ['black_market']                                                                            },
    { rank: 2,  title: 'Prestige II',           bonuses: { yieldPct: 0.03, staminaRegenPct: 0.05 },                       unlocks: ['black_market', 'legendary_zones']                                                         },
    { rank: 3,  title: 'Prestige III',          bonuses: { yieldPct: 0.03, staminaRegenPct: 0.05, crimeSuccessPct: 0.05 },unlocks: ['black_market', 'legendary_zones', 'syndicate_leader']                                     },
    { rank: 4,  title: 'Prestige IV',           bonuses: { yieldPct: 0.03, staminaRegenPct: 0.05, crimeSuccessPct: 0.05, xpPct: 0.05 }, unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets']    },
    { rank: 5,  title: 'Prestige V ⭐',          bonuses: { yieldPct: 0.08, staminaRegenPct: 0.05, crimeSuccessPct: 0.05, xpPct: 0.05 }, unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge'] },
    { rank: 10, title: 'The Ascended ✨',        bonuses: { yieldPct: 0.10, staminaRegenPct: 0.10, crimeSuccessPct: 0.10, xpPct: 0.10 }, unlocks: ['black_market', 'legendary_zones', 'syndicate_leader', 'exclusive_pets', 'prestige_v_badge', 'ascended'] },
];

const UNLOCK_LABELS = {
    black_market:      '🏴 Black Market shop tab',
    legendary_zones:   '🗺️ Legendary hunt / fish / mine zones',
    syndicate_leader:  '🕴️ Crime syndicate leadership',
    exclusive_pets:    '🦝 Exclusive pets',
    prestige_v_badge:  '⭐ Prestige V star + animated badge',
    ascended:          '✨ "The Ascended" title + animated profile accent',
};

const SOFT_PRESTIGE_BONUS = { yieldPct: 0.02, xpPct: 0.02 };

// Returns the tier definition for a given rank (largest rank ≤ requested).
function tierFor(rank) {
    const r = Math.max(0, Number(rank) || 0);
    let best = PRESTIGE_TIERS[0];
    for (const tier of PRESTIGE_TIERS) {
        if (tier.rank <= r) best = tier;
    }
    return best;
}

// Returns the exact display title for a rank — uses the explicit PRESTIGE_TIERS
// entry when one exists, otherwise synthesizes `Prestige <roman>` so P6–P9
// don't render as the floored "Prestige V" label.
function titleForExactRank(rank) {
    const r = Math.max(0, Number(rank) || 0);
    if (r === 0) return null;
    const explicit = PRESTIGE_TIERS.find(t => t.rank === r);
    if (explicit?.title) return explicit.title;
    return `Prestige ${roman(r)}`;
}

// Returns the explicit definition for the upcoming rank (used in /prestige confirmation).
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

function roman(n) {
    if (n <= 0) return '0';
    const map = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]];
    let out = '';
    for (const [r, v] of map) {
        while (n >= v) { out += r; n -= v; }
    }
    return out;
}

// Aggregate active bonus multipliers from prestige rank.
// Returns { yieldMult, xpMult, staminaRegenMult, crimeSuccessMult }
function getBonusMultipliers(rank) {
    const tier = tierFor(rank);
    const b = tier.bonuses || {};
    return {
        yieldMult:        1 + (b.yieldPct        ?? 0),
        xpMult:           1 + (b.xpPct           ?? 0),
        staminaRegenMult: 1 + (b.staminaRegenPct ?? 0),
        crimeSuccessMult: 1 + (b.crimeSuccessPct ?? 0),
    };
}

function hasUnlock(rank, unlockId) {
    return tierFor(rank).unlocks.includes(unlockId);
}

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
