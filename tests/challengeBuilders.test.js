'use strict';

/**
 * #786. Building the /work and /daily mini-games was the one thing that made
 * those two commands untestable: both picked their wrong answers in an
 * unbounded `while` that kept rolling until it had two distinct ones. Under a
 * pinned rng — which is how a test makes a payout a number rather than a range
 * — every roll produces the same candidate and the loop never exits. The first
 * run of tests/economyWorkCommand.test.js took the process to an 8 GB heap.
 *
 * Both are bounded now, with a deterministic fill after the bound, which is the
 * shape buildMathProblem in the same file already used. These pin that: the
 * builders terminate under the worst rng there is, and still produce a real
 * question with distinct options.
 */

const { generateWorkChallenge } = require('../src/utils/workChallenge');
const { generateDailyChallenge } = require('../src/utils/dailyChallenge');

/** The labels on a challenge's buttons, in the order they were rendered. */
const labels = challenge => challenge.row.components.map(b => b.data.label);
const customIds = challenge => challenge.row.components.map(b => b.data.custom_id);

const FIXED_ROLLS = [0, 0.25, 0.5, 0.75, 0.999];

afterEach(() => {
    if (Math.random.mockRestore) Math.random.mockRestore();
});

describe('the work challenge', () => {
    // Every job maps to a type, and a name that maps to none takes a generic
    // one — so this reaches every builder in the file.
    const JOBS = ['Cashier', 'Dishwasher', 'Developer', 'Teacher', 'Chef', 'Designer',
        'Surgeon', 'Director', 'Musician', 'Tester'];

    it.each(FIXED_ROLLS)('terminates for every job with Math.random pinned at %s', roll => {
        jest.spyOn(Math, 'random').mockReturnValue(roll);
        for (const job of JOBS) {
            const challenge = generateWorkChallenge(job);
            expect([job, typeof challenge.description]).toEqual([job, 'string']);
            expect([job, challenge.row.components.length]).toEqual([job, 3]);
        }
    });

    it('offers three distinct answers, exactly one of them correct', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
        for (const job of JOBS) {
            const challenge = generateWorkChallenge(job);
            const ids = customIds(challenge);
            expect([job, ids.filter(id => id === challenge.correctId)]).toEqual([job, [challenge.correctId]]);
            expect([job, new Set(labels(challenge)).size]).toEqual([job, 3]);
        }
    });

    it('gives the quick-count game two wrong answers that are not the count', () => {
        // 0.5 is the pathological roll for this one: the offset it produces is
        // zero, so every candidate equals the target and the unbounded loop
        // never found a second answer.
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
        const challenge = generateWorkChallenge('Chef');
        expect(challenge.type).toBe('quick_count');

        const correct = challenge.row.components
            .find(b => b.data.custom_id === challenge.correctId).data.label;
        const wrong = labels(challenge).filter(l => l !== correct);
        expect(wrong).toHaveLength(2);
        expect(new Set(wrong).size).toBe(2);
        expect(wrong.map(Number).every(Number.isFinite)).toBe(true);
    });
});

describe('the daily challenge', () => {
    it.each(FIXED_ROLLS)('terminates with Math.random pinned at %s', roll => {
        jest.spyOn(Math, 'random').mockReturnValue(roll);
        const challenge = generateDailyChallenge();
        expect(typeof challenge.description).toBe('string');
        expect(challenge.timeLimit).toBeGreaterThan(0);
        expect(challenge.row.components.length).toBeGreaterThan(0);
    });

    it('marks exactly one option correct', () => {
        for (const roll of FIXED_ROLLS) {
            jest.spyOn(Math, 'random').mockReturnValue(roll);
            const challenge = generateDailyChallenge();
            const ids = customIds(challenge);
            expect([roll, ids.filter(id => id === challenge.correctId)])
                .toEqual([roll, [challenge.correctId]]);
            Math.random.mockRestore();
        }
    });

    it('still produces distinct options under a real rng', () => {
        for (let i = 0; i < 50; i++) {
            const challenge = generateDailyChallenge();
            expect(new Set(labels(challenge)).size).toBe(challenge.row.components.length);
        }
    });
});
