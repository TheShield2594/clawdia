'use strict';

// Casino Hold'em: the rules and the settlement for `/casino poker`, as a pure
// module — no RNG, no Discord, no models — so the odds are tested on their own.
//
// It replaced a heads-up game against a dealer "AI" (#873, pass 24). That game
// paid back about 121% of every stake to a player who simply checked to the
// river, and about 150% to one who knew its gaps: the dealer folded half its
// hands before the flop without looking at the player, could never fold or
// bet after it, called every raise, printed an "equity" that was the showdown
// result, and refunded the whole stake on a timeout at any street.
//
// Casino Hold'em has no dealer decisions to exploit. The player antes and sees
// their two cards and the flop, then folds (losing the ante) or calls twice the
// ante. The dealer qualifies with a pair of fours or better:
//
//   - dealer does not qualify → the ante pays by ANTE_PAYTABLE, the call pushes;
//   - dealer qualifies, player's best five wins → ante by the paytable, call 1:1;
//   - the same five either way → both push;
//   - dealer's best five wins → both lost.
//
// The published edge under correct play is about 2.2% of the ante. A player who
// calls every hand gives up about 8% of the ante a hand, 97.4% of everything
// staked; tests/casinoHoldem.test.js measures that on a seeded deck.

// What the ante pays, by the player's best five of seven. Everything below a
// flush pays even money.
const ANTE_PAYTABLE = [
    { name: 'Royal Flush',     pays: 100 },
    { name: 'Straight Flush',  pays: 20 },
    { name: 'Four of a Kind',  pays: 10 },
    { name: 'Full House',      pays: 3 },
    { name: 'Flush',           pays: 2 },
];

/** The call is twice the ante. */
const CALL_MULTIPLE = 2;

/** The lowest pair the dealer qualifies with: fours. */
const QUALIFYING_PAIR = 4;

/**
 * A ranked hand's name for the paytable. `rankHand` calls every straight flush
 * a Straight Flush; an ace-high one is the royal.
 */
function paytableName(hand) {
    if (hand.score === 8 && hand.tiebreak[0] === 14) return 'Royal Flush';
    return hand.name;
}

/** What a winning ante pays, to one, for the player's best five. */
function anteOdds(hand) {
    return ANTE_PAYTABLE.find(row => row.name === paytableName(hand))?.pays ?? 1;
}

/** Whether the dealer's best five qualifies: a pair of fours or better. */
function dealerQualifies(hand) {
    if (hand.score >= 2) return true;
    return hand.score === 1 && hand.tiebreak[0] >= QUALIFYING_PAIR;
}

/**
 * Settle a called hand.
 *
 * @param {number} ante
 * @param {object} player the player's best five, from `bestHand`
 * @param {object} dealer the dealer's best five, from `bestHand`
 * @param {number} cmp    `compareTuple(player, dealer)`: > 0 when the player wins
 * @returns {{outcome: 'win'|'no-qualify'|'push'|'lose', gross: number}} `gross`
 *   is everything credited back, stakes included: ante plus call are staked.
 */
function settleCalled(ante, player, dealer, cmp) {
    const call = ante * CALL_MULTIPLE;
    const anteWin = ante + ante * anteOdds(player);

    if (!dealerQualifies(dealer)) return { outcome: 'no-qualify', gross: anteWin + call };
    if (cmp > 0)  return { outcome: 'win',  gross: anteWin + call * 2 };
    if (cmp === 0) return { outcome: 'push', gross: ante + call };
    return { outcome: 'lose', gross: 0 };
}

module.exports = {
    ANTE_PAYTABLE, CALL_MULTIPLE, QUALIFYING_PAIR,
    paytableName, anteOdds, dealerQualifies, settleCalled,
};
