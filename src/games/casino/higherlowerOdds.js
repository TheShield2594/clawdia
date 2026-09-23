'use strict';

// The session multiplier and card odds for `/casino higherlower`, lifted out of
// higherlower.js (#785). It measured 16.9% lines / 11.8% branches — the streak
// multiplier that decides a cash-out had never been evaluated under test.

const SUITS = ['♠', '♥', '♦', '♣'];

// What every guess returns on average: a correct guess multiplies the session
// by HOUSE_RETURN ÷ (the chance the call wins, ties aside), so each guess keeps
// 5% whatever the card.
//
// It used to add a flat +0.5× per correct guess, whatever the odds. Calling the
// likelier side wins 77% of the non-tie draws on average — every one of them
// off an ace or a king — so the first guess alone returned about 115% of the
// stake, and cashing out after it paid the player to keep playing (#873,
// pass 24).
const HOUSE_RETURN = 0.95;
// A ceiling on what one session can reach, which bounds a single hand's payout.
const MAX_SESSION_MULT = 25;

/** A card, ace low at 1 through king at 13. `rng` defaults to Math.random. */
function rollCard(rng = Math.random) {
    return {
        value: Math.floor(rng() * 13) + 1,
        suit:  SUITS[Math.floor(rng() * SUITS.length)],
    };
}

function cardLabel(value) {
    const face = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    return face[value] ?? String(value);
}

/** The three outcomes for the next card, as shares of the thirteen ranks. */
function probabilities(value) {
    const higher = 13 - value;
    const lower  = value - 1;
    const total  = 13;
    return {
        higher: higher / total,
        lower:  lower  / total,
        equal:  1      / total,
    };
}

/**
 * The chance a call wins, ties aside. A tie is a push that redraws at the same
 * multiplier, so it neither wins nor loses, and the call is decided by the
 * other twelve ranks.
 */
function winChance(value, pickedHigher) {
    const p = probabilities(value);
    return (pickedHigher ? p.higher : p.lower) / (1 - p.equal);
}

/**
 * The session multiplier after a correct call from `mult`: priced by the call's
 * odds, floored to two places, capped at MAX_SESSION_MULT. A certain call
 * (higher off an ace) is priced at HOUSE_RETURN, so it costs 5%; an impossible
 * one is 0.
 */
function nextMult(mult, value, pickedHigher) {
    const q = winChance(value, pickedHigher);
    if (q <= 0) return 0;
    // The epsilon keeps a product that is a whole cent in exact arithmetic
    // from flooring a cent short on its float error.
    return Math.min(MAX_SESSION_MULT, Math.floor(mult * (HOUSE_RETURN / q) * 100 + 1e-9) / 100);
}

module.exports = {
    SUITS, HOUSE_RETURN, MAX_SESSION_MULT,
    rollCard, cardLabel, probabilities, winChance, nextMult,
};
