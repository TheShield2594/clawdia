'use strict';
const { secureRandom } = require('../../utils/secureRandom');

// The crash point and the multiplier curve for `/casino crash`, lifted out of
// crash.js (#785). It measured 26.3% lines / 16.1% branches: the curve decides
// every payout in the game and ran only inside a ticking lobby.

const GROWTH = 1.12;

const MAX_CRASH = 100.00;

/**
 * Where the round busts: 0.99 / (1 − r), floored to two places, never below
 * 1.00× and never above MAX_CRASH.
 *
 * That makes P(crash ≥ m) = 0.99 / m for every two-place target m, so a cash-out
 * at any multiplier returns 99% of the stake on average — the one-percent edge
 * the game advertises, at 1.5× and at 50× alike. About 2% of rounds land on
 * 1.00× and bust before the first tick: the 1% below 1.00× the formula floors
 * up, and the 1% that would have busted between 1.00× and 1.01×.
 *
 * It used to be 0.99 / r with the bottom 1% of rolls busting instantly. Those
 * rolls are the ones 0.99 / r maps to *above* 99×, so the instant bust came out
 * of the top of the curve rather than off every target evenly: P(crash ≥ m)
 * was 0.99 / m − 0.01, and a player cashing at 10× got back 89%, at 50× 49%
 * (#873, pass 24). It also rounded to the nearest cent rather than down, so a
 * round that busted at 1.995× paid a 2.00× target.
 *
 * `rng` returns a float in [0, 1) — secureRandom (crypto) by default.
 */
function generateCrashPoint(rng = secureRandom) {
    const raw = 0.99 / (1 - rng());
    // The epsilon keeps a quotient that is a whole cent in exact arithmetic
    // (0.99 / 0.495 = 2) from flooring a cent short on its float error.
    return Math.min(MAX_CRASH, Math.max(1.00, Math.floor(raw * 100 + 1e-9) / 100));
}

/** The multiplier after `tick` ticks — 1.12^tick, to two places. */
function multiplierAt(tick) {
    return parseFloat(Math.pow(GROWTH, tick).toFixed(2));
}

/** How many ticks a round survives before it reaches `crashPoint`. */
function ticksUntilCrash(crashPoint) {
    return Math.ceil(Math.log(crashPoint) / Math.log(GROWTH));
}

/** Two decimals below 10×, one above, because the row gets long. */
function multLabel(m) {
    return m >= 10 ? m.toFixed(1) + 'x' : m.toFixed(2) + 'x';
}

module.exports = { GROWTH, MAX_CRASH, generateCrashPoint, multiplierAt, ticksUntilCrash, multLabel };
