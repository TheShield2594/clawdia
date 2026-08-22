'use strict';

// discord.js and the Guild model both load fine without a gateway or DB
// connection, so this suite exercises the real command module.

const { parseDuration, pickWinners } = require('../src/commands/utility/giveaway');

describe('parseDuration', () => {
    it('parses each supported unit', () => {
        expect(parseDuration('30s')).toBe(30_000);
        expect(parseDuration('30m')).toBe(1_800_000);
        expect(parseDuration('2h')).toBe(7_200_000);
        expect(parseDuration('1d')).toBe(86_400_000);
    });

    it('rejects malformed input rather than producing NaN', () => {
        for (const bad of ['', '30', 'h', '-5m', '1.5h', '10w', 'abc']) {
            expect(parseDuration(bad)).toBeNull();
        }
    });
});

describe('winner selection fairness', () => {
    it('picks the requested number of distinct winners', () => {
        const entrants = Array.from({ length: 50 }, (_, i) => `user${i}`);
        const winners = pickWinners(entrants, 5);
        expect(winners).toHaveLength(5);
        expect(new Set(winners).size).toBe(5);
        winners.forEach(w => expect(entrants).toContain(w));
    });

    it('never returns more winners than entrants', () => {
        expect(pickWinners(['a', 'b'], 10)).toHaveLength(2);
        expect(pickWinners([], 3)).toHaveLength(0);
    });

    it('does not mutate the entrant list', () => {
        const entrants = ['a', 'b', 'c', 'd'];
        pickWinners(entrants, 2);
        expect(entrants).toEqual(['a', 'b', 'c', 'd']);
    });

    it('gives every entrant a roughly equal chance of winning', () => {
        const entrants = Array.from({ length: 10 }, (_, i) => i);
        const wins = new Array(10).fill(0);
        const TRIALS = 20_000;
        for (let i = 0; i < TRIALS; i++) wins[pickWinners(entrants, 1)[0]]++;

        // Uniform expectation is TRIALS/10 = 2000 each. Allow generous slack
        // for sampling noise; a biased comparator shuffle skews far past this.
        const expected = TRIALS / entrants.length;
        for (const count of wins) {
            expect(count).toBeGreaterThan(expected * 0.8);
            expect(count).toBeLessThan(expected * 1.2);
        }
    });
});
