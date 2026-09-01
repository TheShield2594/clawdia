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
 * included. Where two games disagree — and they do — the disagreement is
 * preserved and documented rather than tidied into one rule, because tidying it
 * would change what players are paid.
 *
 * The three shapes, and where each is used:
 *
 *   profit-boosted  the stake returns unmultiplied and only the winnings are
 *                   boosted, guarded on the multiplier exceeding 1. Poker, at
 *                   every one of its five payout sites.
 *   fully boosted   the whole profit is multiplied with no guard. Blackjack.
 *   unboosted       no coin multiplier reaches the payout at all. Roulette,
 *                   whose odds are fixed by the wheel.
 */

/**
 * A payout where the stake comes back untouched and only the profit is boosted.
 *
 * `Math.round` sits outside the multiplication and inside the addition, so the
 * stake is never rounded — a 2x booster on a 150-coin win over a 100-coin stake
 * pays 100 + round(50 * 2) = 200, not round(150 * 2) = 300.
 *
 * The `> 1` guard is load-bearing rather than an optimisation: a guild's
 * `serverBoost.multiplier` is admin-set and nothing clamps it to 1 or more, so
 * without the guard a booster configured below 1 would quietly *cut* payouts.
 *
 * @param {number} stake        what the player has already put in
 * @param {number} grossPayout  what the hand pays before any booster
 * @param {number} coinMultiplier  combined personal x server multiplier
 * @returns {number} coins to credit
 */
function boostedPayout(stake, grossPayout, coinMultiplier) {
    if (!(grossPayout > stake) || !(coinMultiplier > 1)) return grossPayout;
    return stake + Math.round((grossPayout - stake) * coinMultiplier);
}

// ── Blackjack ────────────────────────────────────────────────────────────────

/**
 * Profit on a natural 21, which pays 3:2.
 *
 * The floor runs first and the multiplier second: an odd bet loses its half
 * coin to the 3:2 rate before any booster sees it, so a 25-coin natural at 2x
 * pays round(floor(37.5) * 2) = 74 and not round(37.5 * 2) = 75. That ordering
 * is the house's, and it is what the game has always done.
 *
 * Unlike poker, the whole profit is boosted with no `> 1` guard — the natural's
 * profit *is* the boosted quantity, and the bet is credited separately by the
 * caller.
 */
function naturalBlackjackProfit(bet, coinMultiplier) {
    return Math.round(Math.floor(bet * 1.5) * coinMultiplier);
}

/** Total credit on a natural: the bet back, plus the 3:2 profit. */
function naturalBlackjackCredit(bet, coinMultiplier) {
    return bet + naturalBlackjackProfit(bet, coinMultiplier);
}

/**
 * Profit on an ordinary blackjack win, which pays even money.
 *
 * Boosted whole and unguarded, matching the natural above rather than poker.
 */
function blackjackWinProfit(bet, coinMultiplier) {
    return Math.round(bet * coinMultiplier);
}

/** Total credit on an ordinary win: the bet back, plus even-money profit. */
function blackjackWinCredit(bet, coinMultiplier) {
    return bet + blackjackWinProfit(bet, coinMultiplier);
}

/**
 * What insurance credits when the dealer turns over a natural.
 *
 * Insurance costs half the bet and pays 2:1, so the credit is the insurance
 * stake back plus twice it — three times the stake, and `insuranceProfit` is
 * the two-thirds of that the player is up on the side bet.
 *
 * No coin multiplier: insurance is a side bet against the dealer's hole card at
 * fixed odds, and no booster has ever touched it. Deliberate, and the reason it
 * takes no multiplier argument at all rather than one that is ignored.
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
 * What one settled blackjack hand credits, for `settleHand`'s four outcomes
 * plus the lucky-charm save.
 *
 * A split plays two of these against one dealer hand and sums them, which is
 * why it is per-hand: the two halves can carry different bets once one has been
 * doubled.
 *
 * @param {'win'|'push'|'lose'|'bust'} outcome  from blackjackHands.settleHand
 * @param {number} bet  this hand's stake, after any double down
 * @param {number} coinMultiplier
 * @param {boolean} luckySaved  a loss the lucky charm or streak turned into a push
 * @returns {number} coins to credit for this hand
 */
function blackjackHandCredit(outcome, bet, coinMultiplier, luckySaved = false) {
    if (outcome === 'win')  return blackjackWinCredit(bet, coinMultiplier);
    if (outcome === 'push') return bet;
    // A bust is a loss the player caused and the charm does not save; only an
    // ordinary loss to the dealer is eligible, which is what the games check.
    if (outcome === 'bust') return 0;
    return luckySaved ? bet : 0;
}

// ── Roulette ─────────────────────────────────────────────────────────────────

/**
 * Profit and credit on a roulette spin, at the table odds for the bet placed.
 *
 * No coin multiplier reaches this, unlike every other game in the casino. That
 * is preserved rather than corrected: roulette's odds are the wheel's — 35:1 on
 * a straight number against a 1-in-37 chance — and a 2x booster on top of that
 * is a different game, not a bug in this one. Recorded here because the absence
 * is invisible at the call site and reads like an oversight.
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

// ── Poker ────────────────────────────────────────────────────────────────────

/**
 * What the player is credited when the dealer folds before the flop.
 *
 * The gross is a flat 3:2 on the opening bet — a small consolation for a hand
 * that ended before it started — and the boost applies to the half-bet of
 * profit only, not to the whole 1.5x.
 */
function pokerFoldWinPayout(bet, coinMultiplier) {
    return boostedPayout(bet, Math.floor(bet * 1.5), coinMultiplier);
}

/**
 * What the player is credited when the dealer folds on the flop, turn or river:
 * the pot, with only the part of it above their own stake boosted.
 *
 * The pot opens at twice the bet and every raise the player makes adds at least
 * as much to the pot as to their stake, so the pot always exceeds the stake and
 * this is always a win.
 */
function pokerPotPayout(playerStake, pot, coinMultiplier) {
    return boostedPayout(playerStake, pot, coinMultiplier);
}

/**
 * The showdown payout before any booster, for a compared hand.
 *
 * A win returns double the stake, a push returns it, a loss returns nothing —
 * unless the lucky streak saved it, which the caller decides (it is a random
 * roll) and passes in as an already-resolved outcome of 'push'.
 */
function pokerShowdownGross(outcome, playerStake) {
    if (outcome === 'win')  return playerStake * 2;
    if (outcome === 'push') return playerStake;
    return 0;
}

/** The showdown payout with the booster applied to the winnings. */
function pokerShowdownPayout(outcome, playerStake, coinMultiplier) {
    return boostedPayout(playerStake, pokerShowdownGross(outcome, playerStake), coinMultiplier);
}

module.exports = {
    boostedPayout,
    naturalBlackjackProfit,
    naturalBlackjackCredit,
    blackjackWinProfit,
    blackjackWinCredit,
    blackjackHandCredit,
    insuranceCredit,
    insuranceProfit,
    insuranceCost,
    rouletteSettlement,
    pokerFoldWinPayout,
    pokerPotPayout,
    pokerShowdownGross,
    pokerShowdownPayout,
};
