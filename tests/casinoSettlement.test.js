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
 * pays 2:1, a straight number pays 35:1.
 */

const s = require('../src/games/casino/settlement');

describe('blackjack — a natural pays 3:2', () => {
    it('pays half again on the bet', () => {
        expect(s.naturalBlackjackProfit(10)).toBe(15);
        expect(s.naturalBlackjackCredit(10)).toBe(25);
    });

    it('rounds the half coin down to the house on an odd bet', () => {
        // 25 × 1.5 = 37.5, and the half coin is the house's.
        expect(s.naturalBlackjackProfit(25)).toBe(37);
    });
});

describe('blackjack — an ordinary win pays even money', () => {
    it('returns the bet and the same again', () => {
        expect(s.blackjackWinProfit(100)).toBe(100);
        expect(s.blackjackWinCredit(100)).toBe(200);
    });
});

// #873, pass 26. Blackjack boosted the whole profit and poker the profit over
// the stake, and a 2× coin booster made them pay back 146% and 138%. No casino
// game takes a multiplier now, and these helpers take no argument for one.
describe('no booster reaches a payout', () => {
    it.each([
        ['naturalBlackjackProfit', 1],
        ['naturalBlackjackCredit', 1],
        ['blackjackWinProfit', 1],
        ['blackjackWinCredit', 1],
        ['blackjackHandCredit', 2],
        ['rouletteSettlement', 3],
    ])('%s takes no multiplier', (name, arity) => {
        expect(s[name]).toHaveLength(arity);
    });

    it('the profit-boost helper is gone', () => {
        expect(s.boostedPayout).toBeUndefined();
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
        expect(s.blackjackHandCredit('win', 100)).toBe(200);
    });

    it('returns exactly the bet on a push', () => {
        expect(s.blackjackHandCredit('push', 100)).toBe(100);
    });

    it('credits nothing on a loss or a bust', () => {
        // No luck save in blackjack any more (#873, pass 26): at 99.9% before
        // any save, the charm and streak's loss-to-push paid 111%.
        expect(s.blackjackHandCredit('lose', 100)).toBe(0);
        expect(s.blackjackHandCredit('bust', 100)).toBe(0);
    });

    it('settles a split as two hands against one dealer, each on its own bet', () => {
        // The case the split/double-down `totalCredit` covers: hand 1 doubled
        // to 200 and won, hand 2 left at 100 and pushed.
        const credit = s.blackjackHandCredit('win', 200) + s.blackjackHandCredit('push', 100);
        expect(credit).toBe(500);
        // Staked 300 across the two, so the player is up 200.
        expect(credit - 300).toBe(200);
    });

    it('is never worse than losing', () => {
        for (const outcome of ['win', 'push', 'lose', 'bust']) {
            expect(s.blackjackHandCredit(outcome, 100)).toBeGreaterThanOrEqual(0);
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

    it.each(['blackjack', 'roulette'])('%s requires it', game => {
        expect(read(game)).toContain("require('./settlement')");
    });

    it('blackjack no longer computes a 3:2 payout or an insurance credit inline', () => {
        const source = read('blackjack');
        expect(source).not.toMatch(/Math\.round\(Math\.floor\(bet \* 1\.5\)/);
        expect(source).not.toMatch(/insuranceBet \* 3/);
        expect(source).not.toMatch(/Math\.round\((activeBet|hBet) \* totalCoinMult\)/);
    });

    it('poker pays the Hold\'em paytable and nothing on top', () => {
        expect(read('poker')).not.toMatch(/playerStake \+ Math\.round\(\(/);
        expect(read('poker')).toContain('const payout = gross;');
    });

    it('roulette no longer computes its credit inline', () => {
        expect(read('roulette')).not.toMatch(/won \? bet \+ profit : 0/);
    });
});
