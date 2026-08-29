'use strict';

// The crash point and the multiplier curve for `/casino crash`, lifted out of
// crash.js (#785). It measured 26.3% lines / 16.1% branches: the curve decides
// every payout in the game and ran only inside a ticking lobby.

const GROWTH = 1.12;

/**
 * Where the round busts. 1% of rounds bust instantly at 1.00×; the rest follow
 * 0.99/r, which is the 1% house edge.
 *
 * The 100× cap never binds — 0.99/r only reaches 100 at r <= 0.0099, and
 * everything below 0.01 has already returned 1.00 — so the largest round the
 * game deals is 99.00×. It is left in as the guard it is; raise the instant-bust
 * floor and it starts doing work. tests/casinoPayoutTables.test.js pins both.
 *
 * `rng` returns a float in [0, 1) — Math.random by default.
 */
function generateCrashPoint(rng = Math.random) {
    const r = rng();
    if (r < 0.01) return 1.00;
    return Math.min(100.00, parseFloat((0.99 / r).toFixed(2)));
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

module.exports = { GROWTH, generateCrashPoint, multiplierAt, ticksUntilCrash, multLabel };
