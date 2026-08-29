'use strict';

// Hand evaluation for `/casino poker`, lifted out of poker.js (#785).
//
// #623 covered the opening debit for all eight games and closed. What it never
// reached was the half that decides what the player is *paid*: this file was
// module-private inside a 825-line command, so the only way to run
// `rankHand` was to drive a whole interaction through a collector, and nothing
// did. It measured 9.4% lines / 4.3% branches — a straight flush and a wheel
// had never been ranked in a test.
//
// Nothing here reaches for discord.js, a model or the clock. The one source of
// randomness, the shuffle, takes an injectable rng, so a test can hand it a
// seeded one and deal a known board.

const SUITS  = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK   = Object.fromEntries(VALUES.map((v, i) => [v, i + 2]));

/** The 52 cards, shuffled. `rng` returns a float in [0, 1) — Math.random by default. */
function buildDeck(rng = Math.random) {
    const deck = [];
    for (const suit of SUITS) for (const value of VALUES) deck.push({ suit, value });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const cardStr = c => `${c.value}${c.suit}`;
const handStr = hand => hand.map(cardStr).join('  ');

/**
 * Rank exactly five cards.
 *
 * @returns {{score: number, name: string, tiebreak: number[]}} `score` is the
 *   category, 0 (high card) to 8 (straight flush); `tiebreak` breaks ties
 *   within a category, most significant first.
 */
function rankHand(hand) {
    const ranks = hand.map(c => RANK[c.value]).sort((a, b) => a - b);
    const suits = hand.map(c => c.suit);
    const freq  = {};
    for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
    const entries  = Object.entries(freq).map(([r, c]) => [Number(r), c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const counts   = entries.map(e => e[1]);
    const tiebreak = entries.map(e => e[0]);
    const flush    = suits.every(s => s === suits[0]);
    const straight = ranks[4] - ranks[0] === 4 && new Set(ranks).size === 5;
    // A-2-3-4-5, where the ace plays low. Ranked as a five-high straight, which
    // is why its tiebreak is written out rather than taken from `ranks`.
    const wheel    = JSON.stringify(ranks) === JSON.stringify([2, 3, 4, 5, 14]);

    if ((straight || wheel) && flush) return { score: 8, name: 'Straight Flush', tiebreak: wheel ? [5,4,3,2,1] : [...ranks].reverse() };
    if (counts[0] === 4)              return { score: 7, name: 'Four of a Kind',  tiebreak };
    if (counts[0] === 3 && counts[1] === 2) return { score: 6, name: 'Full House', tiebreak };
    if (flush)                        return { score: 5, name: 'Flush',            tiebreak: [...ranks].reverse() };
    if (straight || wheel)            return { score: 4, name: 'Straight',         tiebreak: wheel ? [5,4,3,2,1] : [...ranks].reverse() };
    if (counts[0] === 3)              return { score: 3, name: 'Three of a Kind',  tiebreak };
    if (counts[0] === 2 && counts[1] === 2) return { score: 2, name: 'Two Pair',  tiebreak };
    if (counts[0] === 2)              return { score: 1, name: 'One Pair',         tiebreak };
    return { score: 0, name: 'High Card', tiebreak: [...ranks].reverse() };
}

/** Negative if `a` loses, positive if it wins, 0 for an exact tie. */
function compareTuple(a, b) {
    if (a.score !== b.score) return a.score - b.score;
    for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
        const av = a.tiebreak[i] ?? 0;
        const bv = b.tiebreak[i] ?? 0;
        if (av !== bv) return av - bv;
    }
    return 0;
}

/** The best five of seven, with the five it chose. */
function bestHand(cards) {
    let best = null;
    for (let i = 0; i < cards.length - 1; i++) {
        for (let j = i + 1; j < cards.length; j++) {
            const five = cards.filter((_, idx) => idx !== i && idx !== j);
            const h    = rankHand(five);
            if (!best || compareTuple(h, best) > 0) best = { ...h, cards: five };
        }
    }
    return best;
}

/** The showdown: 'win', 'lose' or 'push', from the player's side. */
function compareHands(playerAll, dealerAll) {
    const p   = bestHand(playerAll);
    const d   = bestHand(dealerAll);
    const cmp = compareTuple(p, d);
    if (cmp > 0) return { result: 'win',  playerHand: p, dealerHand: d };
    if (cmp < 0) return { result: 'lose', playerHand: p, dealerHand: d };
    return { result: 'push', playerHand: p, dealerHand: d };
}

module.exports = {
    SUITS, VALUES, RANK,
    buildDeck, cardStr, handStr,
    rankHand, compareTuple, bestHand, compareHands,
};
