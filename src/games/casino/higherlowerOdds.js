'use strict';

// The session multiplier and card odds for `/casino higherlower`, lifted out of
// higherlower.js (#785). It measured 16.9% lines / 11.8% branches — the streak
// multiplier that decides a cash-out had never been evaluated under test.

const SUITS = ['♠', '♥', '♦', '♣'];

// Session multiplier: starts at 1.0, gains +0.5 per correct guess, capped at 6.0.
const STREAK_BONUS = 0.5;
const MAX_SESSION_MULT = 6.0;

/** What a streak of `streak` correct guesses is worth, capped. */
function sessionMult(streak) {
    return Math.min(MAX_SESSION_MULT, 1.0 + streak * STREAK_BONUS);
}

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

module.exports = { SUITS, STREAK_BONUS, MAX_SESSION_MULT, sessionMult, rollCard, cardLabel, probabilities };
