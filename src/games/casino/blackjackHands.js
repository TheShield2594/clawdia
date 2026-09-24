'use strict';

// Hand totals, the dealer loop and the settle for `/casino blackjack`, lifted
// out of blackjack.js (#785).
//
// blackjack.js measured 29.3% lines / 21.3% branches. #623 covered the opening
// debit; what it did not reach is the part after it — soft-ace demotion, the
// dealer drawing to 17, and which of win/push/lose a finished hand is. All of
// it sat behind a button collector in a 688-line command.

const SUITS  = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** The 52 cards, shuffled. `rng` returns a float in [0, 1) — Math.random by default. */
function buildDeck(rng = Math.random) {
    const deck = [];
    for (const suit of SUITS) {
        for (const value of VALUES) deck.push({ suit, value });
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

/** Aces count 11 here; handTotal demotes them if the hand would bust. */
function cardValue(card) {
    if (['J', 'Q', 'K'].includes(card.value)) return 10;
    if (card.value === 'A') return 11;
    return parseInt(card.value, 10);
}

/**
 * The best total the hand can make — each ace drops to 1 only if it must — and
 * whether an ace is still counting 11 in it.
 */
function handCount(hand) {
    let total = hand.reduce((sum, c) => sum + cardValue(c), 0);
    let aces  = hand.filter(c => c.value === 'A').length;
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total, soft: aces > 0 };
}

/** The best total the hand can make — each ace drops to 1 only if it must. */
function handTotal(hand) {
    return handCount(hand).total;
}

/** True while an ace in the hand still counts 11: A-6 is a soft 17, A-6-K a hard one. */
function isSoftHand(hand) {
    return handCount(hand).soft;
}

/**
 * What the table calls a hand: "Blackjack", "Bust (24)", "Soft 17" or "17".
 *
 * `natural: false` is for a split hand, whose two-card 21 is only 21 — it pays
 * even money, and calling it blackjack would promise 3:2.
 */
function totalLabel(hand, { natural = true } = {}) {
    const { total, soft } = handCount(hand);
    if (natural && isNaturalBlackjack(hand)) return 'Blackjack';
    if (total > 21) return `Bust (${total})`;
    if (soft && total < 21) return `Soft ${total}`;
    return `${total}`;
}

/**
 * Whether the dealer checks the hole card for blackjack before anyone acts:
 * under an ace and under any ten-value card, as at every US table. Checking
 * only under the ace let a ten-up dealer's natural take a doubled or split
 * stake whole, and let a player's drawn 21 push against it.
 */
function dealerPeeks(upCard) {
    return upCard.value === 'A' || cardValue(upCard) === 10;
}

/** Double down is offered on a two-card 9, 10 or 11 and nothing else. */
function canDoubleDown(hand) {
    const total = handTotal(hand);
    return hand.length === 2 && (total === 9 || total === 10 || total === 11);
}

/** Two cards of equal value split — so K-Q splits, both being tens. */
function canSplitHand(hand) {
    return hand.length === 2 && cardValue(hand[0]) === cardValue(hand[1]);
}

/**
 * The dealer's turn: draw until the total is 17 or more. That stands on a soft
 * 17 — A-6 already totals 17 with the ace counting 11, so the loop never asks
 * for another card.
 *
 * Mutates `hand` and `deck`, which is what the caller wants — the message shows
 * the dealer's cards as they land. Returns the final total.
 */
function playDealerHand(hand, deck) {
    while (handTotal(hand) < 17) hand.push(deck.pop());
    return handTotal(hand);
}

/**
 * Which way a finished hand went.
 *
 * A natural outranks any other 21, so the flags say which side holds one: a
 * dealer's two-card 21 beats a player's drawn 21 rather than pushing it.
 *
 * @param {number} playerTotal
 * @param {number} dealerTotal
 * @param {object} [naturals]
 * @param {boolean} [naturals.dealerNatural]  the dealer's first two cards are 21
 * @param {boolean} [naturals.playerNatural]  so are the player's — never a split hand
 * @returns {'bust'|'win'|'push'|'lose'} 'bust' is the player's own bust, which
 *   loses whatever the dealer then does — including the dealer busting too.
 */
function settleHand(playerTotal, dealerTotal, { dealerNatural = false, playerNatural = false } = {}) {
    if (playerTotal > 21) return 'bust';
    if (dealerNatural !== playerNatural) return dealerNatural ? 'lose' : 'win';
    if (dealerTotal > 21) return 'win';
    if (playerTotal > dealerTotal) return 'win';
    if (playerTotal === dealerTotal) return 'push';
    return 'lose';
}

/** A two-card 21 — the natural, which pays before anyone acts. */
function isNaturalBlackjack(hand) {
    return hand.length === 2 && handTotal(hand) === 21;
}

module.exports = {
    SUITS, VALUES,
    buildDeck, cardValue, handTotal, isSoftHand, totalLabel,
    canDoubleDown, canSplitHand, dealerPeeks,
    playDealerHand, settleHand, isNaturalBlackjack,
};
