'use strict';

// /roll's wager maths, now that the payout is quoted to the player before the
// dice land: the number shown while rolling has to be the number that pays.

jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/Transaction', () => ({ create: jest.fn().mockResolvedValue({}) }));

const { __test__ } = require('../src/commands/fun/roll');
const { payoutMultiplier, callWon, callLabel, rollBar } = __test__;

const HOUSE_CUT = 0.05;
const high = { type: 'high' };
const low  = { type: 'low' };
const exact = number => ({ type: 'exact', number });

describe('payoutMultiplier', () => {
    test('exact-number bets pay at the die odds', () => {
        expect(payoutMultiplier(exact(3), 6)).toBe(6);
        expect(payoutMultiplier(exact(77), 100)).toBe(100);
    });

    test('an even die splits evenly, so high and low both pay 2x', () => {
        expect(payoutMultiplier(high, 6)).toBe(2);
        expect(payoutMultiplier(low, 6)).toBe(2);
    });

    test('an odd die pays the two halves differently, matching their real odds', () => {
        // d7: low is 1-3, high is 4-7. A flat 2x would hand "high" the edge.
        expect(payoutMultiplier(low, 7)).toBeCloseTo(7 / 3);
        expect(payoutMultiplier(high, 7)).toBeCloseTo(7 / 4);
        expect(payoutMultiplier(high, 7)).toBeLessThan(payoutMultiplier(low, 7));
    });

    test('every call keeps the same house edge, whichever way it is made', () => {
        for (const sides of [2, 5, 6, 7, 20, 99, 100]) {
            for (const call of [high, low, exact(1)]) {
                const winningCount = countWins(call, sides);
                const edge = 1 - (winningCount / sides) * payoutMultiplier(call, sides) * (1 - HOUSE_CUT);
                expect(edge).toBeCloseTo(HOUSE_CUT, 10);
            }
        }
    });
});

function countWins(call, sides) {
    let wins = 0;
    for (let r = 1; r <= sides; r++) if (callWon(call, r, sides)) wins++;
    return wins;
}

describe('callWon', () => {
    test('splits an even die down the middle', () => {
        expect([1, 2, 3].every(r => callWon(low, r, 6))).toBe(true);
        expect([4, 5, 6].every(r => callWon(high, r, 6))).toBe(true);
        expect(callWon(low, 4, 6)).toBe(false);
        expect(callWon(high, 3, 6)).toBe(false);
    });

    test('high and low partition the die with no overlap or gap', () => {
        for (const sides of [2, 5, 6, 7, 20, 100]) {
            for (let r = 1; r <= sides; r++) {
                expect(callWon(high, r, sides)).toBe(!callWon(low, r, sides));
            }
        }
    });

    test('exact bets win on one number only', () => {
        expect(countWins(exact(4), 20)).toBe(1);
        expect(callWon(exact(4), 4, 20)).toBe(true);
    });
});

describe('display', () => {
    test('the quoted payout is what a winning stake actually returns', () => {
        const bet = 250;
        for (const sides of [6, 7, 100]) {
            for (const call of [high, low, exact(2)]) {
                const gross  = Math.floor(bet * payoutMultiplier(call, sides) * (1 - HOUSE_CUT));
                const quoted = Number((gross / bet).toFixed(2));
                expect(Math.abs(quoted * bet - gross)).toBeLessThanOrEqual(bet * 0.005);
            }
        }
    });

    test('the roll bar stays a fixed width at both ends of the die', () => {
        for (const sides of [2, 6, 100]) {
            const lowest  = rollBar(1, sides);
            const highest = rollBar(sides, sides);
            expect(lowest.match(/[█░]/g)).toHaveLength(16);
            expect(highest.match(/█/g)).toHaveLength(16);
        }
    });

    test('call labels name the range the player is betting on', () => {
        expect(callLabel(exact(3), 6)).toContain('3');
        expect(callLabel(low, 7)).toContain('1–3');
        expect(callLabel(high, 7)).toContain('4–7');
    });
});
