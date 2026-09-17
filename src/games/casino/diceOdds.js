'use strict';

// The dice game's payout maths, as a pure module (#1019).
//
// `/roll`'s betting mode used to carry this logic inline and expose it only
// through a `__test__` export. Folding the game into `/casino dice` made it a
// file of its own, the way `slotsReels.js` and `kenoPaytable.js` are: no RNG, no
// Discord, just the multiplier a call pays and whether a result won it — so the
// odds are tested on their own and the game file is left with the animation and
// the payout call.

// The house edge, taken off both call types so a win pays true odds minus the
// rake rather than a flat 2×.
const HOUSE_CUT = 0.05;

/**
 * What a call pays, before the house cut.
 *
 * Exact-number bets pay at `sides:1` — one winning face out of `sides`. High/low
 * pays true odds for the split it covers (`sides / winning-face-count`) rather
 * than a flat 2×: on odd-sided dice the low half has one fewer face than the
 * high half, so a flat 2× would hand "high" bettors better-than-even odds at the
 * same payout.
 *
 * @param {{type: 'exact'|'high'|'low', number?: number}} call
 * @param {number} sides
 * @returns {number} the gross multiplier on the stake
 */
function payoutMultiplier(call, sides) {
    if (call.type === 'exact') return sides;
    const half         = Math.floor(sides / 2);
    const winningCount = call.type === 'high' ? sides - half : half;
    return sides / winningCount;
}

/** The coins a winning `bet` returns (stake included), after the house cut. */
function grossPayout(bet, call, sides) {
    return Math.floor(bet * payoutMultiplier(call, sides) * (1 - HOUSE_CUT));
}

/** How a call reads in the result copy. */
function callLabel(call, sides) {
    if (call.type === 'exact') return `exact **${call.number}**`;
    const half = Math.floor(sides / 2);
    return call.type === 'high' ? `**high** (${half + 1}–${sides})` : `**low** (1–${half})`;
}

/** Whether `result` won the call on a `sides`-sided die. */
function callWon(call, result, sides) {
    if (call.type === 'exact') return result === call.number;
    const half = Math.floor(sides / 2);
    return call.type === 'high' ? result > half : result <= half;
}

/** A 16-cell progress bar showing where a result sits on the die's range. */
function rollBar(result, sides) {
    const total  = 16;
    const filled = Math.round((result / sides) * total);
    const empty  = total - filled;
    return `\`${'█'.repeat(filled)}${'░'.repeat(empty)}\` ${result}/${sides}`;
}

module.exports = { HOUSE_CUT, payoutMultiplier, grossPayout, callLabel, callWon, rollBar };
