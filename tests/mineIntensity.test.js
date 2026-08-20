'use strict';

const { promoteIntensity, executeMine, ensureMineData } = require('../src/services/mineService');
const {
    INTENSITY_LEVELS, CHOOSABLE_INTENSITY, DEFAULT_INTENSITY_LEVEL,
} = require('../src/data/mineData');

const byLevel = n => INTENSITY_LEVELS.find(l => l.level === n);

describe('the intensity ladder', () => {
    test('rises in payout and in risk together', () => {
        for (let i = 1; i < INTENSITY_LEVELS.length; i++) {
            expect(INTENSITY_LEVELS[i].multiplier).toBeGreaterThan(INTENSITY_LEVELS[i - 1].multiplier);
            expect(INTENSITY_LEVELS[i].caveInRisk).toBeGreaterThanOrEqual(INTENSITY_LEVELS[i - 1].caveInRisk);
            expect(INTENSITY_LEVELS[i].durLoss).toBeGreaterThanOrEqual(INTENSITY_LEVELS[i - 1].durLoss);
        }
    });

    test('the Abyss cannot be selected — it is what a good read pays at Deep', () => {
        expect(CHOOSABLE_INTENSITY.map(l => l.level)).toEqual([1, 2, 3, 4]);
        expect(promoteIntensity(byLevel(4)).multiplier).toBe(byLevel(5).multiplier);
    });

    test('the safe rung really is free of cave-ins', () => {
        expect(byLevel(1).caveInRisk).toBe(0);
    });

    test('the default rung is one a miner can actually pick', () => {
        expect(CHOOSABLE_INTENSITY.some(l => l.level === DEFAULT_INTENSITY_LEVEL)).toBe(true);
    });
});

describe('a correct vein read pays more without adding danger', () => {
    test.each(CHOOSABLE_INTENSITY.map(l => [l.name, l.level]))(
        'from %s the promotion raises payout and leaves risk alone', (_name, level) => {
            const chosen   = byLevel(level);
            const promoted = promoteIntensity(chosen);

            expect(promoted.multiplier).toBe(byLevel(level + 1).multiplier);
            expect(promoted.multiplier).toBeGreaterThan(chosen.multiplier);
            // The whole point: the miner chose this risk, and reading the seam does
            // not silently raise it on them.
            expect(promoted.caveInRisk).toBe(chosen.caveInRisk);
            expect(promoted.durLoss).toBe(chosen.durLoss);
            expect(promoted.name).toBe(chosen.name);
        });

    test('the top rung has nothing above it to promote into', () => {
        const top = INTENSITY_LEVELS[INTENSITY_LEVELS.length - 1];
        expect(promoteIntensity(top)).toEqual(top);
    });

    test('promotion does not mutate the shared ladder', () => {
        const before = JSON.parse(JSON.stringify(INTENSITY_LEVELS));
        CHOOSABLE_INTENSITY.forEach(promoteIntensity);
        expect(INTENSITY_LEVELS).toEqual(before);
    });
});

describe('the chosen intensity is what the dig actually uses', () => {
    function miner() {
        const user = { balance: 0, mining: {}, quests: [], markModified() {} };
        ensureMineData(user);
        Object.assign(user.mining, {
            level: 20,
            pickaxes: [{
                name: 'Steel Pickaxe', tier: 3, slug: 'steel_pickaxe',
                currentDurability: 160, maxDurability: 160, baseDurability: 160,
                repairCount: 0, upgrade: null, status: 'good',
            }],
            equippedPickaxeIndex: 0,
        });
        return user;
    }

    afterEach(() => { if (jest.isMockFunction(Math.random)) Math.random.mockRestore(); });

    test('a safe dig can never cave in, however unlucky the roll', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);   // worst case for every roll
        const result = executeMine(miner(), 'surface_quarry', { intensity: byLevel(1) });
        expect(result.caveIn).toBeUndefined();
    });

    test('a promoted dig pays the higher multiplier at the risk that was chosen', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const deep     = byLevel(4);
        const promoted = promoteIntensity(deep);

        const plain = executeMine(miner(), 'surface_quarry', { intensity: { ...deep, caveInRisk: 0 } });
        const read  = executeMine(miner(), 'surface_quarry', { intensity: { ...promoted, caveInRisk: 0 } });

        expect(read.finalPayout).toBeGreaterThan(plain.finalPayout);
        expect(read.intensityLevel.caveInRisk).toBe(plain.intensityLevel.caveInRisk);
    });

    test('a new miner starts on a sane default rung', () => {
        expect(miner().mining.preferredIntensity).toBe(DEFAULT_INTENSITY_LEVEL);
    });
});
