'use strict';

/**
 * The arithmetic that decides how many coins a settled casino hand credits.
 *
 * Hand ranking was extracted here long ago (`blackjackHands`, `pokerHands`) and
 * is tested to 100%. The step *after* it — turning an outcome and a stake into
 * the number that goes into `$inc: { balance }` — stayed inline in the game
 * files, buried behind button collectors that no unit test can drive, at 10-27%
 * statement coverage (#883). It is the largest block of untested code in the
 * repo that decides how many coins a player receives, in a subsystem whose
 * history (#785, #807, the balanceDelta/payoutKey work) says money bugs are the
 * recurring failure mode. Rounding order and multiplier stacking are exactly
 * where those hide, and neither is visible from the outside.
 *
 * So the numbers live here, as functions of their inputs and nothing else. The
 * games keep the coin writes, the embeds and the collectors; this keeps the
 * arithmetic.
 *
 * Every function here reproduces what the games already did, rounding order
 * included.
 *
 * No coin multiplier reaches any of it. Blackjack and poker used to boost their
 * profit — blackjack the whole of it, poker the profit over the stake — and a
 * 2× booster made them pay back 146% and 138% of the stake. Every casino game
 * pays its table odds and nothing on top now (#873, pass 26).
 */

// ── Blackjack ────────────────────────────────────────────────────────────────

/**
 * Profit on a natural 21, which pays 3:2.
 *
 * An odd bet loses its half coin to the house: a 25-coin natural pays 37.
 */
function naturalBlackjackProfit(bet) {
    return Math.floor(bet * 1.5);
}

/** Total credit on a natural: the bet back, plus the 3:2 profit. */
function naturalBlackjackCredit(bet) {
    return bet + naturalBlackjackProfit(bet);
}

/** Profit on an ordinary blackjack win, which pays even money. */
function blackjackWinProfit(bet) {
    return bet;
}

/** Total credit on an ordinary win: the bet back, plus even-money profit. */
function blackjackWinCredit(bet) {
    return bet + blackjackWinProfit(bet);
}

/**
 * Total credit when a player holding a natural takes even money against a
 * dealer's ace: paid 1:1 at once, whatever the hole card. It is the same coins
 * as an ordinary win.
 */
function evenMoneyCredit(bet) {
    return blackjackWinCredit(bet);
}

/**
 * What insurance credits when the dealer turns over a natural.
 *
 * Insurance costs half the bet and pays 2:1, so the credit is the insurance
 * stake back plus twice it — three times the stake, and `insuranceProfit` is
 * the two-thirds of that the player is up on the side bet.
 *
 * A side bet against the dealer's hole card at fixed odds.
 */
function insuranceCredit(insuranceStake) {
    return insuranceStake * 3;
}

/** The winnings on insurance, which is what the embed reports. */
function insuranceProfit(insuranceStake) {
    return insuranceStake * 2;
}

/** Half the bet, rounded down — what insurance costs, and 0 for a bet of 1. */
function insuranceCost(bet) {
    return Math.floor(bet / 2);
}

/**
 * What one settled blackjack hand credits, for `settleHand`'s four outcomes.
 *
 * A split plays two of these against one dealer hand and sums them, which is
 * why it is per-hand: the two halves can carry different bets once one has been
 * doubled.
 *
 * @param {'win'|'push'|'lose'|'bust'} outcome  from blackjackHands.settleHand
 * @param {number} bet  this hand's stake, after any double down
 * @returns {number} coins to credit for this hand
 */
function blackjackHandCredit(outcome, bet) {
    if (outcome === 'win')  return blackjackWinCredit(bet);
    if (outcome === 'push') return bet;
    return 0;
}

// ── Roulette ─────────────────────────────────────────────────────────────────

/**
 * Profit and credit on a roulette spin, at the table odds for the bet placed.
 *
 * `profit` is signed (it is what the embed shows) and `credit` is what goes
 * into the balance: 0 on a loss, because the stake was debited when the bet was
 * placed and is not being returned.
 *
 * @param {number} bet
 * @param {number} payoutOdds  the `payout` of the BETS entry: 1, 2 or 35
 * @param {boolean} won
 */
function rouletteSettlement(bet, payoutOdds, won) {
    const profit = won ? bet * payoutOdds : -bet;
    return { profit, credit: won ? bet + profit : 0 };
}

// Poker settles through holdemRules.js, which is Casino Hold'em's paytable. The
// old heads-up game's fold, pot and showdown helpers went with it (#873, pass 24).

module.exports = {
    naturalBlackjackProfit,
    naturalBlackjackCredit,
    blackjackWinProfit,
    blackjackWinCredit,
    blackjackHandCredit,
    evenMoneyCredit,
    insuranceCredit,
    insuranceProfit,
    insuranceCost,
    rouletteSettlement,
};
