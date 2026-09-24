'use strict';

// The reels, the paytable and the payout evaluation for `/casino slots`.
//
// The module is pure on purpose: no discord.js, no models, no services. It is
// required by slots.js for the real game and by tests/casinoSlotsReels.test.js,
// which walks every one of the 64³ stop combinations to pin the return.
//
// ── Reel strips, not weighted draws ──────────────────────────────────────────
//
// Each reel is a fixed strip of 64 symbols, and a spin picks one stop per reel.
// The player sees a 3×3 window: the stop itself on the payline, and the symbol
// either side of it on the strip above and below. Those neighbours are real —
// they are what is actually next to the stop — so a near miss on the rows above
// or below is one the machine really produced, not one drawn in for effect.
// The counts per strip are the weights the old weighted draw used, just laid out
// where the player can see them.
//
// ── The return ───────────────────────────────────────────────────────────────
//
// 94% of every coin staked comes back, made of three parts:
//
//   reels and features   ≈ 92.5%  line wins, free spins and the Heat meter's hot
//                                 spins, exact over every stop combination
//   Triple Wild pot       ≤ 1.0%  the share of the progressive pool a Triple Wild
//                                 claims on top of its line pay — capped at
//                                 JACKPOT_CAP_MULT × the bet, which is what holds
//                                 it to 1% of the stake whatever the pool holds
//   random pool drop      ≤ 0.5%  casinoJackpotService's per-bet trigger, capped
//                                 the same way for every casino game
//
// The caps are the fix for the jackpot being farmable. Uncapped, a 10-coin spin
// won the same pool as a 100,000-coin one, so slots at the minimum stake paid
// back more than it took whenever the pool held more than ~12,700 coins, which
// was nearly always.
//
// ── What changed from the weighted-draw machine (pass 25) ────────────────────
//
//   - A pair never pays less than the stake. The old two-of-a-kind paid 25% of
//     the three-of-a-kind row, so a Cherry or Lemon pair returned half or
//     three-quarters of the bet and was shown as a win: a loss dressed as one
//     on about a quarter of all spins. Pairs now pay only for Bell, Diamond and
//     Star, and every one of them is a real profit.
//   - Wilds substitute for everything but a Scatter. 🃏🃏⚡ used to lose outright
//     because there was no regular symbol for the wilds to copy.
//   - Scatters count anywhere in the window and award free spins on top of
//     whatever the payline paid, instead of replacing it.
//   - Triple Wild pays a fixed TRIPLE_WILD_MULT from the machine, and the pool
//     share on top of it; it is never a dead spin and never worth less than a
//     three-of-a-kind.

const SYMBOLS = [
    { emoji: '🍒', name: 'Cherry',   plural: 'Cherries', type: 'regular',    three: 4,  pair: 0 },
    { emoji: '🍋', name: 'Lemon',    plural: 'Lemons',   type: 'regular',    three: 6,  pair: 0 },
    { emoji: '🍇', name: 'Grape',    plural: 'Grapes',   type: 'regular',    three: 10, pair: 0 },
    { emoji: '🔔', name: 'Bell',     plural: 'Bells',    type: 'regular',    three: 20, pair: 2 },
    { emoji: '💎', name: 'Diamond',  plural: 'Diamonds', type: 'regular',    three: 40, pair: 4 },
    { emoji: '🌟', name: 'Star',     plural: 'Stars',    type: 'regular',    three: 88, pair: 8 },
    { emoji: '🃏', name: 'Wild',     plural: 'Wilds',    type: 'wild'                            },
    { emoji: '⚡', name: 'Boost',    plural: 'Boosts',   type: 'multiplier', multiplier: 2       },
    { emoji: '🌸', name: 'Scatter',  plural: 'Scatters', type: 'scatter'                         },
];

const BY_NAME  = new Map(SYMBOLS.map(s => [s.name, s]));
const REGULARS = SYMBOLS.filter(s => s.type === 'regular');

// How many of each symbol one strip carries. Every reel carries the same set,
// laid out in a different order.
const STRIP_COUNTS = {
    Cherry: 18, Lemon: 15, Grape: 11, Bell: 8, Diamond: 5, Star: 3,
    Wild: 2, Boost: 1, Scatter: 1,
};
const STRIP_LENGTH = Object.values(STRIP_COUNTS).reduce((a, b) => a + b, 0);

// The fixed pays that are not a regular symbol's row.
const TRIPLE_WILD_MULT  = 100;  // plus the progressive share on a paid spin
const TRIPLE_BOOST_MULT = 100;

// Free spins by how many Scatters are in the window. They play on the same
// reels, cannot retrigger, and Triple Wild in one pays TRIPLE_WILD_MULT only —
// the progressive is for staked spins.
const FREE_SPINS = {
    2: { spins: 8,  mult: 1 },
    3: { spins: 15, mult: 2 },
};

// The Heat meter: every paid spin adds one, and a full meter makes the next paid
// spin a Hot Spin — reel 1 stops on a high-value symbol. It fills from play, not
// from losses. The Hot Reel it replaces fired after three losses in a row, which
// paid best to whoever kept chasing.
const HEAT_MAX = 10;
const HIGH_VALUE_SYMBOLS = ['Bell', 'Diamond', 'Star'];

// What the luck items do on slots. They are small on purpose: at the old 20%
// re-spin and 25% refund, a player holding both got back 113% of every stake
// and farmed the machine. At these, both together stay under 100% with the
// progressive included (tests/casinoSlotsReels.test.js holds that line).
const LUCKY_CHARM_RESPIN  = 0.03;  // a losing spin re-spins
const LUCKY_STREAK_REFUND = 0.03;  // a losing spin that stays lost is refunded

// The share of each staked coin a Triple Wild's pool claim is worth, at most.
const PROGRESSIVE_RETURN = 0.01;

/**
 * Lays `STRIP_COUNTS` out along one strip, each symbol spread evenly so that
 * copies of one symbol are as far apart as the counts allow. `phase` shifts
 * where each symbol's run starts, which is what makes the three reels differ.
 * Deterministic: the strips are part of the paytable and the tests read them.
 */
function buildStrip(phase) {
    const items = [];
    SYMBOLS.forEach((symbol, index) => {
        const count = STRIP_COUNTS[symbol.name];
        const offset = (phase * (index + 1)) % 1;
        for (let k = 0; k < count; k++) {
            items.push({ symbol, key: ((k + offset) / count) % 1 + index * 1e-9 });
        }
    });
    return items.sort((a, b) => a.key - b.key).map(item => item.symbol);
}

const REELS = [buildStrip(0.37), buildStrip(0.71), buildStrip(0.13)];

// Reel 1's stops that land a high-value symbol on the payline — where a Hot
// Spin's first reel stops. Weighted by how often each appears, like any stop.
const HOT_STOPS = REELS[0]
    .map((symbol, stop) => (HIGH_VALUE_SYMBOLS.includes(symbol.name) ? stop : -1))
    .filter(stop => stop >= 0);

const at = (reel, stop) => REELS[reel][((stop % STRIP_LENGTH) + STRIP_LENGTH) % STRIP_LENGTH];

/**
 * The 3×3 window for a set of stops, as rows: `[top, payline, bottom]`, each
 * row left to right.
 */
function windowAt(stops) {
    return [-1, 0, 1].map(offset => stops.map((stop, reel) => at(reel, stop + offset)));
}

const countScatters = window => window.flat().filter(s => s.type === 'scatter').length;

/**
 * Spins the reels. `rng` returns a float in [0, 1) — Math.random by default.
 * `hot` stops reel 1 on a high-value symbol (the Heat meter's Hot Spin); `lock`
 * holds reel 1 at a stop already chosen, for a Lucky Charm re-spin of a Hot
 * Spin that must not lose the lock it was given.
 *
 * @returns {{stops: number[], window: object[][], line: object[], scatterCount: number}}
 */
function spin({ rng = Math.random, hot = false, lock = null } = {}) {
    const pick = () => Math.floor(rng() * STRIP_LENGTH);
    const first = lock ?? (hot ? HOT_STOPS[Math.floor(rng() * HOT_STOPS.length)] : pick());
    const stops = [first, pick(), pick()];
    const window = windowAt(stops);
    return { stops, window, line: window[1], scatterCount: countScatters(window) };
}

// What a still-spinning cell may flash: anything off the strip but a Scatter,
// which would read as a Scatter the stopped reel then does not show.
const FILLER = REELS[0].filter(s => s.type !== 'scatter');

/** A filler emoji for a cell whose reel is still spinning. */
function fillerEmoji(rng = Math.random) {
    return FILLER[Math.floor(rng() * FILLER.length)].emoji;
}

/**
 * Score one spin.
 *
 * The payline is scored as the best of the ways it can be read, since a Wild
 * can stand in for any symbol but a Scatter:
 *
 *   - three Wilds → `jackpot`, paying TRIPLE_WILD_MULT. On a paid spin the
 *     caller claims the progressive share on top; this figure is the machine's.
 *   - every non-Wild symbol a Boost → `mult3`, TRIPLE_BOOST_MULT (🃏⚡⚡, ⚡⚡⚡).
 *   - for each regular symbol: three of it (counting Wilds) → `three` at its
 *     row, two → `pair` at its pair pay. Boosts on the line multiply these, at
 *     ×2 each. With no regular on the line at all, the Wilds are free to be any
 *     of them, so 🃏🃏⚡ reads as the best pair there is.
 *
 * Scatters are not on the payline's side of the ledger: two or more anywhere in
 * the window award free spins (`freeSpins`) on top of whatever the line paid.
 * `freeSpin: true` scores a free spin, where Scatters do nothing.
 *
 * @param {object[]} line   the three payline symbols, left to right
 * @param {number}   bet    the stake
 * @param {object}   [opts]
 * @param {number}   [opts.scatterCount]  Scatters in the window; defaults to
 *                                        those on the line
 * @param {boolean}  [opts.freeSpin]
 * @returns {{payout: number, outcome: string, symbol: object|null, lineMult: number,
 *   wildCount: number, multFactor: number, scatterCount: number,
 *   freeSpins: {spins: number, mult: number}|null}}
 */
function evaluate(line, bet, { scatterCount = countScatters([line]), freeSpin = false } = {}) {
    const wildCount  = line.filter(s => s.type === 'wild').length;
    const boosts     = line.filter(s => s.type === 'multiplier');
    const regulars   = line.filter(s => s.type === 'regular');
    const scatterOnLine = line.some(s => s.type === 'scatter');
    const multFactor = boosts.reduce((acc, b) => acc * b.multiplier, 1);
    const freeSpins  = !freeSpin && scatterCount >= 2 ? FREE_SPINS[Math.min(scatterCount, 3)] : null;

    const hand = (lineMult, outcome, symbol = null, factor = multFactor) => ({
        payout: Math.floor(bet * lineMult),
        outcome,
        symbol,
        lineMult,
        wildCount,
        multFactor: factor,
        scatterCount: freeSpin ? 0 : scatterCount,
        freeSpins,
    });

    if (wildCount === 3) return hand(TRIPLE_WILD_MULT, 'jackpot', null, 1);

    let best = hand(0, 'lose');
    const consider = candidate => { if (candidate.lineMult > best.lineMult) best = candidate; };

    if (boosts.length && !regulars.length && !scatterOnLine) {
        consider(hand(TRIPLE_BOOST_MULT, 'mult3', null, 1));
    }

    const candidates = regulars.length ? [...new Set(regulars)] : REGULARS;
    for (const symbol of candidates) {
        const count = regulars.filter(s => s === symbol).length + wildCount;
        if (count === 3) consider(hand(symbol.three * multFactor, 'three', symbol));
        else if (count === 2 && symbol.pair > 0) consider(hand(symbol.pair * multFactor, 'pair', symbol));
    }
    return best;
}

/** Whether a scored spin cost the player money: nothing back and no free spins. */
function isNetLoss(result, bet) {
    return result.payout < bet && !result.freeSpins;
}

/**
 * The exact figures behind the paytable, over every stop combination: each
 * line's odds, the hit rate, the free-spin rate, and the return. Computed once
 * and kept — 64³ evaluations is a quarter of a million, fine once and wasteful
 * per button press.
 */
let oddsCache = null;
function odds() {
    if (oddsCache) return oddsCache;

    const lines = new Map();
    const tally = (key, p) => lines.set(key, (lines.get(key) ?? 0) + p);

    // One pass per first-reel set: every stop (a normal spin) and the Hot Spin's.
    function walk(firstStops, freeSpin) {
        let ret = 0, hit = 0, lose = 0, freeRate = 0, freeValue = 0, tripleWild = 0;
        const p = 1 / (firstStops.length * STRIP_LENGTH * STRIP_LENGTH);
        for (const a of firstStops) for (let b = 0; b < STRIP_LENGTH; b++) for (let c = 0; c < STRIP_LENGTH; c++) {
            const window = windowAt([a, b, c]);
            const r = evaluate(window[1], 1, { scatterCount: countScatters(window), freeSpin });
            ret += p * r.lineMult;
            if (r.lineMult > 0) hit += p;
            if (r.outcome === 'jackpot') tripleWild += p;
            if (r.freeSpins) { freeRate += p; freeValue += p * r.freeSpins.spins * r.freeSpins.mult; }
            if (isNetLoss(r, 1)) lose += p;
            if (!freeSpin && firstStops.length === STRIP_LENGTH) {
                const key = r.outcome === 'three' || r.outcome === 'pair' ? `${r.outcome}:${r.symbol.name}` : r.outcome;
                if (r.lineMult > 0) tally(key, p);
            }
        }
        return { ret, hit, lose, freeRate, freeValue, tripleWild };
    }

    const every  = [...Array(STRIP_LENGTH).keys()];
    const free   = walk(every, true);
    const normal = walk(every, false);
    const hot    = walk(HOT_STOPS, false);
    // A free spin's worth, in stakes: its line return. freeValue counts spins
    // times their multiplier, so a spin's award is freeValue × that.
    const spinReturn = s => s.ret + s.freeValue * free.ret;
    const loop = (HEAT_MAX * spinReturn(normal) + spinReturn(hot)) / (HEAT_MAX + 1);

    oddsCache = {
        lines,
        hitRate:       normal.hit,
        freeSpinRate:  normal.freeRate,
        tripleWild:    normal.tripleWild,
        normalReturn:  spinReturn(normal),
        hotReturn:     spinReturn(hot),
        freeSpinReturn: free.ret,
        lossRate:      { normal: normal.lose, hot: hot.lose },
        // Reels and features, over a full Heat cycle.
        reelReturn:    loop,
    };
    return oddsCache;
}

// A Triple Wild's pool claim is capped at this many stakes, which holds its
// share of the return to PROGRESSIVE_RETURN at any stake: the chance of the hand
// times the cap is exactly that. Computed from the strips, so a strip change
// moves the cap with it.
const TRIPLE_WILD_CHANCE = [0, 1, 2]
    .map(reel => REELS[reel].filter(s => s.type === 'wild').length / STRIP_LENGTH)
    .reduce((a, b) => a * b, 1);
const JACKPOT_CAP_MULT = Math.floor(PROGRESSIVE_RETURN / TRIPLE_WILD_CHANCE);

module.exports = {
    SYMBOLS,
    BY_NAME,
    REELS,
    STRIP_COUNTS,
    STRIP_LENGTH,
    HOT_STOPS,
    HEAT_MAX,
    HIGH_VALUE_SYMBOLS,
    TRIPLE_WILD_MULT,
    TRIPLE_BOOST_MULT,
    FREE_SPINS,
    LUCKY_CHARM_RESPIN,
    LUCKY_STREAK_REFUND,
    PROGRESSIVE_RETURN,
    TRIPLE_WILD_CHANCE,
    JACKPOT_CAP_MULT,
    windowAt,
    spin,
    fillerEmoji,
    evaluate,
    isNetLoss,
    odds,
};
