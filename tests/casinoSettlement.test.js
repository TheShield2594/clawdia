'use strict';

/**
 * #883. The arithmetic that decides how many coins a settled hand credits.
 *
 * The pure hand-ranking modules were already at 100% while the settlement math
 * sitting right after them — the numbers that actually go into
 * `$inc: { balance }` — was at 10-27%, unreachable behind button collectors.
 * That is the largest block of untested code in the repo that decides what a
 * player is paid, and rounding order and multiplier stacking are where money
 * bugs in this codebase have historically lived (#785, #807).
 *
 * These cases are written as the payouts a dealer would state, not as
 * re-derivations of the implementation: a 3:2 natural on 10 pays 15, insurance
 * pays 2:1, a straight number pays 35:1. Where the code does something a dealer
 * would not — floor before the booster, no booster on roulette at all — the
 * case says so explicitly, because that is the behaviour a refactor would
 * otherwise "fix" and change what players receive.
 */

const s = require('../src/games/casino/settlement');

// A 2x personal booster on a guild running a 1.5x server boost. The stack is
// multiplicative, so this is 3x, and it is the case where an implementation
// that rounds in the wrong place is visibly wrong rather than off by one.
const STACKED = 2 * 1.5;

describe('boostedPayout — the stake is not part of the winnings', () => {
    it('pays the gross unchanged when there is no booster', () => {
        expect(s.boostedPayout(100, 150, 1)).toBe(150);
    });

    it('boosts the profit only, never the stake', () => {
        // 100 staked, 150 gross, so 50 of profit. At 2x that is 100 of profit,
        // not a 300 payout.
        expect(s.boostedPayout(100, 150, 2)).toBe(200);
    });

    it('stacks the personal and server multipliers into one', () => {
        expect(s.boostedPayout(100, 150, STACKED)).toBe(250);
    });

    it('rounds the boosted profit, leaving the stake exact', () => {
        // 33 of profit at 1.5x is 49.5. Rounded once, at the end: 100 + 50.
        expect(s.boostedPayout(100, 133, 1.5)).toBe(150);
    });

    it('never reduces a payout when a guild sets a multiplier below 1', () => {
        // serverBoost.multiplier is admin-set and nothing clamps it, so a 0.5
        // must not turn a 150 win into a 125 one. The `> 1` guard is what
        // stops that, and it is behaviour rather than an optimisation.
        expect(s.boostedPayout(100, 150, 0.5)).toBe(150);
    });

    it('leaves a push alone at any multiplier', () => {
        // Nothing above the stake, so nothing to boost: a returned bet is
        // returned, not multiplied.
        expect(s.boostedPayout(100, 100, STACKED)).toBe(100);
    });

    it('leaves a loss at zero rather than crediting a boosted negative', () => {
        expect(s.boostedPayout(100, 0, STACKED)).toBe(0);
    });
});

describe('blackjack — a natural pays 3:2', () => {
    it('pays half again on the bet', () => {
        expect(s.naturalBlackjackProfit(10, 1)).toBe(15);
        expect(s.naturalBlackjackCredit(10, 1)).toBe(25);
    });

    it('rounds the half coin down to the house on an odd bet', () => {
        // 25 at 3:2 is 37.5. The player gets 37.
        expect(s.naturalBlackjackProfit(25, 1)).toBe(37);
    });

    it('floors the 3:2 before the booster, not after', () => {
        // The ordering that a refactor would most plausibly change, and it is
        // worth a coin per hand: floor(37.5) * 2 = 74, where 37.5 * 2 = 75.
        expect(s.naturalBlackjackProfit(25, 2)).toBe(74);
    });

    it('boosts the whole 3:2 profit, unlike poker', () => {
        // Blackjack multiplies the entire profit with no `> 1` guard — 15 of
        // profit at 3x is 45 — where poker would boost only what is above the
        // stake. The two games genuinely differ; this pins which is which.
        expect(s.naturalBlackjackProfit(10, STACKED)).toBe(45);
        expect(s.naturalBlackjackCredit(10, STACKED)).toBe(55);
    });
});

describe('blackjack — an ordinary win pays even money', () => {
    it('returns the bet and the same again', () => {
        expect(s.blackjackWinProfit(100, 1)).toBe(100);
        expect(s.blackjackWinCredit(100, 1)).toBe(200);
    });

    it('boosts the profit, so the credit is the bet plus the boosted profit', () => {
        expect(s.blackjackWinProfit(100, STACKED)).toBe(300);
        expect(s.blackjackWinCredit(100, STACKED)).toBe(400);
    });

    it('rounds a fractional boosted profit rather than truncating it', () => {
        expect(s.blackjackWinProfit(33, 1.5)).toBe(50); // 49.5
    });
});

describe('blackjack — insurance is a fixed 2:1 side bet', () => {
    it('costs half the bet, rounded down', () => {
        expect(s.insuranceCost(100)).toBe(50);
        expect(s.insuranceCost(25)).toBe(12);
    });

    it('costs nothing on a bet of 1, which is why the button is hidden there', () => {
        expect(s.insuranceCost(1)).toBe(0);
    });

    it('credits the stake back plus twice it when the dealer has a natural', () => {
        expect(s.insuranceCredit(50)).toBe(150);
        expect(s.insuranceProfit(50)).toBe(100);
    });

    it('takes no coin multiplier at all', () => {
        // Deliberate: no booster has ever applied to insurance, and the
        // functions take no multiplier argument rather than ignoring one.
        expect(s.insuranceCredit).toHaveLength(1);
        expect(s.insuranceProfit).toHaveLength(1);
    });

    it('is a whole side bet — the credit is always three times the profit-and-a-half', () => {
        for (const stake of [1, 7, 50, 12_345]) {
            expect(s.insuranceCredit(stake)).toBe(stake + s.insuranceProfit(stake));
        }
    });
});

describe('blackjack — credit per settled hand', () => {
    it('pays a win at even money', () => {
        expect(s.blackjackHandCredit('win', 100, 1)).toBe(200);
        expect(s.blackjackHandCredit('win', 100, STACKED)).toBe(400);
    });

    it('returns exactly the bet on a push, at any multiplier', () => {
        expect(s.blackjackHandCredit('push', 100, 1)).toBe(100);
        expect(s.blackjackHandCredit('push', 100, STACKED)).toBe(100);
    });

    it('credits nothing on a loss', () => {
        expect(s.blackjackHandCredit('lose', 100, STACKED)).toBe(0);
    });

    it('returns the bet when the lucky charm saves a loss, and does not boost it', () => {
        expect(s.blackjackHandCredit('lose', 100, STACKED, true)).toBe(100);
    });

    it('credits nothing on a bust, saved or not', () => {
        // A bust is the player's own doing and the charm does not cover it —
        // the games only offer the save on an ordinary loss to the dealer.
        expect(s.blackjackHandCredit('bust', 100, 1)).toBe(0);
        expect(s.blackjackHandCredit('bust', 100, 1, true)).toBe(0);
    });

    it('settles a split as two hands against one dealer, each on its own bet', () => {
        // The case the split/double-down `totalCredit` covers: hand 1 doubled
        // to 200 and won, hand 2 left at 100 and pushed.
        const credit = s.blackjackHandCredit('win', 200, 1) + s.blackjackHandCredit('push', 100, 1);
        expect(credit).toBe(500);
        // Staked 300 across the two, so the player is up 200.
        expect(credit - 300).toBe(200);
    });

    it('is never worse than losing', () => {
        for (const outcome of ['win', 'push', 'lose', 'bust']) {
            expect(s.blackjackHandCredit(outcome, 100, 1)).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('roulette — the wheel pays table odds and nothing else', () => {
    it('pays even money on the outside bets', () => {
        expect(s.rouletteSettlement(100, 1, true)).toEqual({ profit: 100, credit: 200 });
    });

    it('pays 2:1 on a dozen or a column', () => {
        expect(s.rouletteSettlement(100, 2, true)).toEqual({ profit: 200, credit: 300 });
    });

    it('pays 35:1 on a straight number', () => {
        expect(s.rouletteSettlement(100, 35, true)).toEqual({ profit: 3_500, credit: 3_600 });
    });

    it('credits nothing on a loss and reports the stake as the loss', () => {
        // The stake left the balance when the bet was placed, so a loss credits
        // zero rather than debiting again. `profit` is signed because it is
        // what the embed prints.
        expect(s.rouletteSettlement(100, 35, false)).toEqual({ profit: -100, credit: 0 });
    });

    it('takes no coin multiplier, unlike every other game in the casino', () => {
        // Preserved rather than corrected: the odds are the wheel's. Pinned
        // because the absence is invisible at the call site and reads like an
        // oversight — a booster here would be a deliberate change, not a fix.
        expect(s.rouletteSettlement).toHaveLength(3);
    });
});

describe('poker — the dealer folding pays a flat 3:2', () => {
    it('pays half again on the opening bet', () => {
        expect(s.pokerFoldWinPayout(100, 1)).toBe(150);
    });

    it('boosts only the half-bet of profit, not the whole 1.5x', () => {
        // 50 of profit at 3x is 150, so 250 — where boosting the gross would
        // pay 450.
        expect(s.pokerFoldWinPayout(100, STACKED)).toBe(250);
    });

    it('floors the 3:2 on an odd bet before anything else', () => {
        expect(s.pokerFoldWinPayout(25, 1)).toBe(37);
    });
});

describe('poker — the dealer folding later pays the pot', () => {
    it('pays the pot when there is no booster', () => {
        // Pot opens at twice the bet; the player has staked the bet.
        expect(s.pokerPotPayout(100, 200, 1)).toBe(200);
    });

    it('boosts the pot above the stake only', () => {
        expect(s.pokerPotPayout(100, 200, 2)).toBe(300);
    });

    it('handles a raised hand, where the stake and the pot both grew', () => {
        // Player raised 100 into a pot that took 200 from the raise round.
        expect(s.pokerPotPayout(200, 400, 1)).toBe(400);
        expect(s.pokerPotPayout(200, 400, 2)).toBe(600);
    });
});

describe('poker — showdown', () => {
    it('doubles the stake on a win', () => {
        expect(s.pokerShowdownGross('win', 100)).toBe(200);
        expect(s.pokerShowdownPayout('win', 100, 1)).toBe(200);
    });

    it('returns the stake on a split pot', () => {
        expect(s.pokerShowdownGross('push', 100)).toBe(100);
        expect(s.pokerShowdownPayout('push', 100, STACKED)).toBe(100);
    });

    it('credits nothing on a loss', () => {
        expect(s.pokerShowdownGross('lose', 100)).toBe(0);
        expect(s.pokerShowdownPayout('lose', 100, STACKED)).toBe(0);
    });

    it('boosts a win over the stake', () => {
        expect(s.pokerShowdownPayout('win', 100, STACKED)).toBe(400);
    });

    it('treats a lucky-streak save as the push it is resolved to', () => {
        // The games resolve the random roll first and pass the settled outcome
        // in, so the save returns the stake and is not boosted.
        expect(s.pokerShowdownPayout('push', 250, STACKED)).toBe(250);
    });
});

describe('across the games, a stake is never multiplied', () => {
    // The single invariant behind every case above, stated once: whatever the
    // booster, a returned bet is the bet. A rounding or ordering slip that
    // multiplied the stake would mint coins on every push in the casino.
    it.each([
        ['blackjack push', mult => s.blackjackHandCredit('push', 500, mult)],
        ['blackjack lucky save', mult => s.blackjackHandCredit('lose', 500, mult, true)],
        ['poker split pot', mult => s.pokerShowdownPayout('push', 500, mult)],
        ['boostedPayout at break-even', mult => s.boostedPayout(500, 500, mult)],
    ])('%s returns exactly the stake', (_label, credit) => {
        for (const mult of [1, 1.5, 2, STACKED, 10]) {
            expect(credit(mult)).toBe(500);
        }
    });
});

/**
 * The extraction is only worth anything if the games route through it. These
 * are source checks in the spirit of tests/migrationIndexes.test.js: the
 * arithmetic above is tested, and nothing that credits coins is allowed to keep
 * a second copy of it that no test can reach.
 */
describe('the games settle through this module', () => {
    const fs = require('fs');
    const path = require('path');
    const read = game => fs.readFileSync(path.join(__dirname, '..', 'src', 'games', 'casino', `${game}.js`), 'utf8');

    it.each(['blackjack', 'poker', 'roulette'])('%s requires it', game => {
        expect(read(game)).toContain("require('./settlement')");
    });

    it('blackjack no longer computes a 3:2 payout or an insurance credit inline', () => {
        const source = read('blackjack');
        expect(source).not.toMatch(/Math\.round\(Math\.floor\(bet \* 1\.5\)/);
        expect(source).not.toMatch(/insuranceBet \* 3/);
        expect(source).not.toMatch(/Math\.round\((activeBet|hBet) \* totalCoinMult\)/);
    });

    it('poker no longer computes the profit-only boost inline, at any of its five payout sites', () => {
        // Five copies of the same expression, one per site, was how a rounding
        // change could reach four of them and miss the fifth.
        expect(read('poker')).not.toMatch(/playerStake \+ Math\.round\(\(/);
    });

    it('roulette no longer computes its credit inline', () => {
        expect(read('roulette')).not.toMatch(/won \? bet \+ profit : 0/);
    });
});
