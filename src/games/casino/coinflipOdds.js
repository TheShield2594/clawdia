'use strict';

// The coinflip game's payout maths, as a pure module (#1019).
//
// Trivial next to `diceOdds.js` — a coin is 50/50 — but it lives beside it for
// the same reason: no RNG and no Discord, so the rake and what a win pays are
// tested on their own. The flip itself (the one random draw, from secureRandom) stays in the game
// file; everything here is a function of the stake.

const HEADS = 'Heads';
const TAILS = 'Tails';

// The house keeps 5% of a win, so a called flip pays 1.95× rather than 2× — the
// same edge `/coinflip`'s solo mode charged before the fold.
const RAKE = 0.05;

/** The other side of the coin. */
function other(side) {
    return side === HEADS ? TAILS : HEADS;
}

/** Net profit on a winning `bet`, after the rake (the stake is returned on top). */
function winProfit(bet) {
    return Math.floor(bet * (1 - RAKE));
}

/**
 * The coins a winning `bet` returns: the stake back plus the profit. `placeWager`
 * has already taken the stake, so this is what the payout credits.
 */
function winPayout(bet) {
    return bet + winProfit(bet);
}

module.exports = { HEADS, TAILS, RAKE, other, winProfit, winPayout };
