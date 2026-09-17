'use strict';

// The coinflip game's payout maths (#1019). Trivial — a coin is 50/50 — but the
// rake has to be exactly the 5% edge the fun-command solo flip charged, and the
// win has to return the stake plus that profit, since `placeWager` has already
// taken the stake.

const { HEADS, TAILS, RAKE, other, winProfit, winPayout } = require('../src/games/casino/coinflipOdds');

describe('coinflip odds', () => {
    test('the two sides are distinct and `other` swaps them', () => {
        expect(other(HEADS)).toBe(TAILS);
        expect(other(TAILS)).toBe(HEADS);
    });

    test('a win pays the stake back plus the profit, net of the 5% rake', () => {
        for (const bet of [10, 100, 250, 9_999, 1_000_000]) {
            expect(winProfit(bet)).toBe(Math.floor(bet * (1 - RAKE)));
            expect(winPayout(bet)).toBe(bet + winProfit(bet));
        }
    });

    test('the effective multiplier is 1.95x, the same edge as before the fold', () => {
        const bet = 1000;
        expect(winPayout(bet) / bet).toBeCloseTo(2 - RAKE, 5);
    });
});
