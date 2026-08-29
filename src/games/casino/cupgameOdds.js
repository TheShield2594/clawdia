'use strict';

// The double-or-nothing escalation for `/casino cupgame`, lifted out of
// cupgame.js (#785).
//
// cupgame.js measured 20.7% lines / 10.0% branches. The escalation is the
// whole game — each round doubles the payout and adds two shuffles — and it
// was reachable only by pressing a button on a live message, so no test had
// ever asked what round 4 pays.

// Base win multiplier (1/3 chance × 2.8 ≈ 93% RTP)
const BASE_WIN_MULT = 2.8;
// Shuffle counts per round (gets harder each double-or-nothing)
const ROUND_SHUFFLES = [3, 5, 7, 9];
// Maximum double-or-nothing rounds before forced cash-out
const MAX_ROUNDS = 4;

/** Shuffles for a 1-based round; rounds past the table hold at the last entry. */
function shufflesForRound(round) {
    return ROUND_SHUFFLES[Math.min(round - 1, ROUND_SHUFFLES.length - 1)];
}

/** Round 1 pays BASE_WIN_MULT, and each round after that doubles it. */
function payoutForRound(bet, round) {
    return Math.floor(bet * BASE_WIN_MULT * Math.pow(2, round - 1));
}

module.exports = { BASE_WIN_MULT, ROUND_SHUFFLES, MAX_ROUNDS, shufflesForRound, payoutForRound };
