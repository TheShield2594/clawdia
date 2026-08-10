'use strict';

const { getPityBonus, buildPityStreakField, PITY_COPY } = require('../src/utils/pityBonus');
const { calculateSuccessChance } = require('../src/services/huntService');
const { ZONES } = require('../src/data/huntData');

const LIMITS_HUNT = require('../src/data/huntData').LIMITS;
const LIMITS_FISH = require('../src/data/fishData').LIMITS;
const LIMITS_MINE = require('../src/data/mineData').LIMITS;

const limits = { PITY_CONSECUTIVE_FAILS: 4, PITY_BONUS_PER_STACK: 0.15 };

describe('getPityBonus', () => {
    test('grants nothing before the streak reaches the threshold', () => {
        for (let fails = 0; fails < limits.PITY_CONSECUTIVE_FAILS; fails++) {
            expect(getPityBonus(fails, limits)).toBe(0);
        }
    });

    test('starts on the Nth straight failure and stacks one per further failure', () => {
        expect(getPityBonus(4, limits)).toBeCloseTo(0.15);
        expect(getPityBonus(5, limits)).toBeCloseTo(0.30);
        expect(getPityBonus(6, limits)).toBeCloseTo(0.45);
    });

    test('caps at PITY_CONSECUTIVE_FAILS stacks', () => {
        expect(getPityBonus(7, limits)).toBeCloseTo(0.60);
        expect(getPityBonus(50, limits)).toBeCloseTo(0.60);
    });

    test('treats a missing streak as no bonus', () => {
        expect(getPityBonus(undefined, limits)).toBe(0);
    });

    test('feeds through calculateSuccessChance', () => {
        const weapon = { tier: 1, currentDurability: 80, maxDurability: 80, baseDurability: 80, upgrade: null };
        const base   = { hunt: { level: 1, prestige: 0, activeCharm: null, activeFocus: false, consecutiveFails: 0 } };
        const pitied = { hunt: { ...base.hunt, consecutiveFails: 4 } };

        const without = calculateSuccessChance(base, weapon, ZONES.beginner_forest);
        const with4   = calculateSuccessChance(pitied, weapon, ZONES.beginner_forest);

        expect(with4 - without).toBeCloseTo(0.15);
    });
});

describe('buildPityStreakField', () => {
    test('counts down to the threshold before pity is active', () => {
        const field = buildPityStreakField(2, limits, PITY_COPY.hunt);
        expect(field.name).toContain('2/4');
        expect(field.value).toContain('2 more misses');
        expect(field.value).not.toContain('on your next');
    });

    test('uses the singular noun on the last miss before the threshold', () => {
        expect(buildPityStreakField(3, limits, PITY_COPY.hunt).value).toContain('1 more miss and');
        expect(buildPityStreakField(3, limits, PITY_COPY.fishing).value).toContain('1 more cast and');
        expect(buildPityStreakField(3, limits, PITY_COPY.mining).value).toContain('1 more swing and');
    });

    test('reports the live bonus once pity is active', () => {
        expect(buildPityStreakField(4, limits, PITY_COPY.hunt).value).toContain('+15% success');
        expect(buildPityStreakField(5, limits, PITY_COPY.hunt).value).toContain('+30% success');
        expect(buildPityStreakField(6, limits, PITY_COPY.hunt).value).toContain('+45% success');
    });

    test('marks the cap and stops climbing', () => {
        const at7  = buildPityStreakField(7, limits, PITY_COPY.hunt);
        const at99 = buildPityStreakField(99, limits, PITY_COPY.hunt);
        expect(at7.value).toContain('+60% success');
        expect(at7.value).toContain('(max)');
        expect(at99.value).toContain('+60% success');
    });

    test('the displayed bonus matches what the success formula actually applies', () => {
        for (const fails of [4, 5, 6, 7, 20]) {
            const shown  = buildPityStreakField(fails, limits, PITY_COPY.hunt).value.match(/\+(\d+)% success/)[1];
            const actual = Math.round(getPityBonus(fails, limits) * 100);
            expect(Number(shown)).toBe(actual);
        }
    });

    test('each activity uses its own vocabulary', () => {
        expect(buildPityStreakField(5, limits, PITY_COPY.hunt).name).toContain('straight misses');
        expect(buildPityStreakField(5, limits, PITY_COPY.fishing).name).toContain('casts without a bite');
        expect(buildPityStreakField(5, limits, PITY_COPY.mining).name).toContain('dry swings');
    });

    test('the progress bar never overflows or underflows', () => {
        for (const fails of [0, 1, 4, 7, 500]) {
            const bar = buildPityStreakField(fails, limits, PITY_COPY.hunt).value.match(/`([█░]+)`/)[1];
            expect(bar).toHaveLength(16);
        }
    });

    test('renders for every activity at the real configured limits', () => {
        const cases = [
            [LIMITS_HUNT, PITY_COPY.hunt],
            [LIMITS_FISH, PITY_COPY.fishing],
            [LIMITS_MINE, PITY_COPY.mining],
        ];
        for (const [lim, copy] of cases) {
            for (const fails of [1, lim.PITY_CONSECUTIVE_FAILS, lim.PITY_CONSECUTIVE_FAILS * 3]) {
                const field = buildPityStreakField(fails, lim, copy);
                expect(field.name.length).toBeGreaterThan(0);
                expect(field.name.length).toBeLessThanOrEqual(256);   // Discord field-name limit
                expect(field.value.length).toBeLessThanOrEqual(1024); // Discord field-value limit
            }
        }
    });
});
