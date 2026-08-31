'use strict';

// The reel table and the payout evaluation for `/casino slots`, lifted out of
// slots.js (#885). `evaluate` was module-private behind a three-stage reveal
// animation, so nothing tested it directly — and it is what decides the payout
// on every spin: wild substitution, the multiplier stack, the two-of-a-kind
// half rate, and the jackpot hand-off contract all live in it.
//
// The module is pure on purpose: no discord.js, no models, no services. It is
// required by slots.js for the real game and by tests/casinoSlotsReels.test.js
// as a table.

const SYMBOLS = [
    { emoji: '🍒', name: 'Cherry',   type: 'regular',    weight: 28, payout: 2  },
    { emoji: '🍋', name: 'Lemon',    type: 'regular',    weight: 22, payout: 3  },
    { emoji: '🍇', name: 'Grape',    type: 'regular',    weight: 18, payout: 5  },
    { emoji: '🔔', name: 'Bell',     type: 'regular',    weight: 12, payout: 8  },
    { emoji: '💎', name: 'Diamond',  type: 'regular',    weight: 8,  payout: 15 },
    { emoji: '🌟', name: 'Star',     type: 'regular',    weight: 5,  payout: 25 },
    { emoji: '🃏', name: 'Wild',     type: 'wild',       weight: 4              },
    { emoji: '⚡', name: '2x Boost', type: 'multiplier', weight: 3, multiplier: 2 },
    { emoji: '🌸', name: 'Scatter',  type: 'scatter',    weight: 2              },
];

const BY_NAME = new Map(SYMBOLS.map(s => [s.name, s]));

const HIGH_VALUE_SYMBOLS = ['Bell', 'Diamond', 'Star'];

const TOTAL_WEIGHT = SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
const SPIN_POOL    = SYMBOLS.filter(s => s.type === 'regular' || s.type === 'wild');

// What a Triple Wild pays when it cannot claim the progressive pool: on a free
// spin (which staked nothing) or when the pool credit failed and was rolled
// back. A Triple Wild is never a dead spin.
const FREE_SPIN_JACKPOT_MULT = 25;

// The half rate a two-of-a-kind pays, relative to that symbol's three-of-a-kind
// row. Floored, so a partial win never rounds up into a coin that was not bet.
const TWO_OF_A_KIND_RATE = 0.5;

/** One weighted reel. `rng` returns a float in [0, 1) — Math.random by default. */
function spinReel(rng = Math.random) {
    let r = rng() * TOTAL_WEIGHT;
    for (const s of SYMBOLS) {
        r -= s.weight;
        if (r <= 0) return s;
    }
    return SYMBOLS[0];
}

/** A filler emoji for a reel that has not locked yet — never a scatter or boost. */
function randomEmoji(rng = Math.random) {
    return SPIN_POOL[Math.floor(rng() * SPIN_POOL.length)].emoji;
}

/**
 * Which regular symbol a hand is playing for.
 *
 * Most hands have only one candidate. The one that does not is a wild beside
 * two *different* regulars (🃏 🍒 🌟), where both are one-of-a-kind and the wild
 * could complete either into a two-of-a-kind. This used to fall out of the
 * insertion order of a frequency object — that is, whichever of the two landed
 * on the lower reel — which is not a rule anyone chose and would have changed
 * silently under a reordering of the symbol table.
 *
 * The rule, pinned here and in tests: the largest group wins, and a tie between
 * groups of equal size goes to the higher-paying symbol. 🃏 🍒 🌟 pays Star.
 * Ties on payout cannot happen — every row in SYMBOLS is a distinct multiple.
 *
 * @param {object[]} regulars the `type: 'regular'` reels, in reel order.
 * @returns {{symbol: object, count: number}|null} null when there are none.
 */
function bestRegular(regulars) {
    if (!regulars.length) return null;

    const counts = new Map();
    for (const s of regulars) counts.set(s.name, (counts.get(s.name) || 0) + 1);

    let best = null;
    for (const [name, count] of counts) {
        const symbol = BY_NAME.get(name);
        if (!best || count > best.count || (count === best.count && symbol.payout > best.symbol.payout)) {
            best = { symbol, count };
        }
    }
    return best;
}

/**
 * Score a set of three reels.
 *
 * Precedence, highest first — a hand is only ever one of these:
 *   1. three wilds  → `jackpot`, and the payout is **the caller's to fill in**.
 *      The progressive pool is claimed through casinoJackpotService on a paid
 *      spin, or paid at FREE_SPIN_JACKPOT_MULT when it cannot be; neither
 *      figure is knowable here, so this returns `payout: 0` rather than a
 *      number the caller would have to remember to overwrite.
 *   2. three multipliers → `mult3`, a flat 4× the bet.
 *   3. two or more scatters → `scatter`, and the free spins are resolved by the
 *      caller from `scatterCount` (2 → 3 spins, 3 → 5 spins at 1.5×). Payout is
 *      0: a scatter hand wins spins, not coins.
 *   4. three of a kind, counting wilds as the played symbol → `three`.
 *   5. two of a kind, likewise → `two`, at half the three-of-a-kind rate.
 *   6. anything else → `lose`.
 *
 * Multipliers stack multiplicatively across the reels they appear on and apply
 * to `three` and `two` payouts. They cannot apply to `mult3` (nothing is left
 * to multiply) and are deliberately not applied to a jackpot: the pool is coins
 * other players paid in, not a multiple of this bet.
 *
 * @param {object[]} reels three entries from SYMBOLS.
 * @param {number} bet the stake, already debited by the caller.
 * @returns {{payout: number, outcome: string, symbol: object|null,
 *   wildCount: number, multFactor: number, scatterCount: number}}
 *   `scatterCount` is reported only on a `scatter` hand; a single scatter beside
 *   two other symbols is not a scatter hand and reports 0.
 */
function evaluate(reels, bet) {
    const regulars   = reels.filter(s => s.type === 'regular');
    const wilds      = reels.filter(s => s.type === 'wild');
    const mults      = reels.filter(s => s.type === 'multiplier');
    const scatters   = reels.filter(s => s.type === 'scatter');
    const wildCount  = wilds.length;
    const multFactor = mults.reduce((acc, m) => acc * m.multiplier, 1);

    const hand = (payout, outcome, symbol = null, scatterCount = 0) =>
        ({ payout, outcome, symbol, wildCount, multFactor, scatterCount });

    if (wildCount === 3)      return hand(0, 'jackpot');            // payout filled in by caller
    if (mults.length === 3)   return hand(bet * 4, 'mult3');
    if (scatters.length >= 2) return hand(0, 'scatter', null, scatters.length);

    const best = bestRegular(regulars);
    if (best) {
        const { symbol, count } = best;
        const effective = count + wildCount;

        if (effective >= 3) return hand(bet * symbol.payout * multFactor, 'three', symbol);
        if (effective === 2) return hand(Math.floor(bet * symbol.payout * TWO_OF_A_KIND_RATE * multFactor), 'two', symbol);
    }

    return hand(0, 'lose');
}

module.exports = {
    SYMBOLS,
    HIGH_VALUE_SYMBOLS,
    SPIN_POOL,
    TOTAL_WEIGHT,
    FREE_SPIN_JACKPOT_MULT,
    TWO_OF_A_KIND_RATE,
    spinReel,
    randomEmoji,
    bestRegular,
    evaluate,
};
