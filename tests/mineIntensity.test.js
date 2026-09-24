'use strict';

const {
    promoteIntensity, executeMine, ensureMineData, surveyRock, rockReadAccuracy, digIntensity, riskAt,
} = require('../src/services/mineService');
// Mine rolls draw from src/utils/secureRandom.js, not Math.random (CodeQL
// js/insecure-randomness); mockRandom drives that seam and Math.random together.
const { mockRandom, restoreRandom } = require('./helpers/secureRandom');
const {
    INTENSITY_LEVELS, CHOOSABLE_INTENSITY, DEFAULT_INTENSITY_LEVEL,
    SEAM_GRADES, ROCK_STABILITY, ROCK_READ,
} = require('../src/data/mineData');
const { describeSurvey, intensityButtonLabel, digSummaryLines } = require('../src/commands/economy/mine/dig');

const byLevel = n => INTENSITY_LEVELS.find(l => l.level === n);

describe('the intensity ladder', () => {
    test('rises in payout and in risk together', () => {
        for (let i = 1; i < INTENSITY_LEVELS.length; i++) {
            expect(INTENSITY_LEVELS[i].multiplier).toBeGreaterThan(INTENSITY_LEVELS[i - 1].multiplier);
            expect(INTENSITY_LEVELS[i].caveInRisk).toBeGreaterThanOrEqual(INTENSITY_LEVELS[i - 1].caveInRisk);
            expect(INTENSITY_LEVELS[i].durLoss).toBeGreaterThanOrEqual(INTENSITY_LEVELS[i - 1].durLoss);
        }
    });

    test('Frenzied cannot be selected — it is what a good seam pays at Reckless', () => {
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

test('the ladder is named for how you swing, not for a depth', () => {
    expect(INTENSITY_LEVELS.map(l => l.name)).toEqual(['Careful', 'Steady', 'Hard', 'Reckless', 'Frenzied']);
});

test('blasting clear costs more the harder you pushed', () => {
    for (let i = 2; i < INTENSITY_LEVELS.length; i++) {
        expect(INTENSITY_LEVELS[i].blastCost).toBeGreaterThan(INTENSITY_LEVELS[i - 1].blastCost);
    }
});

describe('a seam promotion pays more without adding danger', () => {
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

    test('a rich seam lifts two rungs, capped at the top', () => {
        expect(promoteIntensity(byLevel(2), 2).multiplier).toBe(byLevel(4).multiplier);
        expect(promoteIntensity(byLevel(4), 2).multiplier).toBe(byLevel(5).multiplier);
        expect(promoteIntensity(byLevel(4), 2).promotedBy).toBe(1);
    });

    test('a thin seam lifts nothing', () => {
        expect(promoteIntensity(byLevel(3), 0)).toBe(byLevel(3));
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

    afterEach(() => { restoreRandom(); });

    test('a safe dig can never cave in, however unlucky the roll', () => {
        mockRandom(0);   // worst case for every roll
        const result = executeMine(miner(), 'surface_quarry', { intensity: byLevel(1) });
        expect(result.caveIn).toBeUndefined();
    });

    test('a promoted dig pays the higher multiplier at the risk that was chosen', () => {
        mockRandom(0);
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

describe('the rock survey', () => {
    function miner(tier = 1, lamp = null) {
        const user = { balance: 0, mining: {}, quests: [], markModified() {} };
        ensureMineData(user);
        Object.assign(user.mining, {
            pickaxes: [{ name: 'P', tier, currentDurability: 100, maxDurability: 100, baseDurability: 100, status: 'good' }],
            equippedPickaxeIndex: 0,
            activeLamp: lamp,
        });
        return user;
    }

    afterEach(() => { restoreRandom(); });

    test('the seam grades average out to one rung up — the old vein read\'s economy', () => {
        const total = SEAM_GRADES.reduce((s, g) => s + g.weight, 0);
        const mean  = SEAM_GRADES.reduce((s, g) => s + g.promote * g.weight, 0) / total;
        expect(mean).toBeCloseTo(0.9, 5);
    });

    test('stability averages to roughly the ladder\'s own risk', () => {
        const total = ROCK_STABILITY.reduce((s, g) => s + g.weight, 0);
        const mean  = ROCK_STABILITY.reduce((s, g) => s + g.riskMult * g.weight, 0) / total;
        expect(mean).toBeGreaterThan(0.95);
        expect(mean).toBeLessThan(1.1);
    });

    test('better gear reads the rock truer, and a lamp helps', () => {
        expect(rockReadAccuracy(miner(1))).toBeCloseTo(ROCK_READ.BASE_ACCURACY, 5);
        expect(rockReadAccuracy(miner(5))).toBeGreaterThan(rockReadAccuracy(miner(2)));
        expect(rockReadAccuracy(miner(1, 'miners_lamp'))).toBeGreaterThan(rockReadAccuracy(miner(1)));
        expect(rockReadAccuracy(miner(5, 'miners_lamp'))).toBeLessThanOrEqual(ROCK_READ.MAX_ACCURACY);
    });

    test('a correct read reports the true stability', () => {
        mockRandom(0);
        const s = surveyRock(miner());
        expect(s.read).toBe(s.stability);
    });

    test('a misread is only ever one step off', () => {
        // 0.99 fails every accuracy check; the weighted rolls land on the last entry.
        mockRandom(0.99);
        const s = surveyRock(miner());
        const at = i => ROCK_STABILITY.indexOf(i);
        expect(s.read).not.toBe(s.stability);
        expect(Math.abs(at(s.read) - at(s.stability))).toBe(1);
    });

    test('the dig runs at the true risk and the seam\'s payout', () => {
        const survey = { seam: SEAM_GRADES[1], stability: ROCK_STABILITY[2], read: ROCK_STABILITY[1], accuracy: 0.6 };
        const run = digIntensity(byLevel(3), survey);
        expect(run.multiplier).toBe(byLevel(4).multiplier);
        expect(run.caveInRisk).toBeCloseTo(byLevel(3).caveInRisk * ROCK_STABILITY[2].riskMult, 5);
        expect(run.durLoss).toBe(byLevel(3).durLoss);
        expect(run.blastCost).toBe(byLevel(3).blastCost);
    });

    test('Careful never caves in, whatever the rock', () => {
        expect(riskAt(byLevel(1), ROCK_STABILITY[2])).toBe(0);
    });

    test('the prompt shows the read risk, not the true one, and the seam payout', () => {
        const survey = { seam: SEAM_GRADES[2], stability: ROCK_STABILITY[2], read: ROCK_STABILITY[0], accuracy: 0.6 };
        const label = intensityButtonLabel(byLevel(2), survey);
        expect(label).toBe(`Steady · ${byLevel(4).multiplier}× · ~3% risk`);
        expect(intensityButtonLabel(byLevel(1), survey)).toContain('no risk');
        expect(label.length).toBeLessThanOrEqual(80);

        const text = describeSurvey(survey, 'Iron Pickaxe');
        expect(text).toContain('Rich seam');
        expect(text).toContain('Solid rock');
        expect(text).toContain('Iron Pickaxe reads rock right 60%');
        expect(text).not.toContain('Fractured');
    });

    test('the result says what the rock really was when the read was wrong', () => {
        const survey = { seam: SEAM_GRADES[0], stability: ROCK_STABILITY[2], read: ROCK_STABILITY[1], accuracy: 0.6 };
        const run = digIntensity(byLevel(3), survey);
        const [line] = digSummaryLines({ success: true }, byLevel(3), run, survey);
        expect(line).toContain('Fractured rock — you read seamed rock');
        expect(line).toContain('21% risk');
    });
});

describe('Careful costs the pickaxe nothing', () => {
    afterEach(() => { restoreRandom(); });

    test('a successful Careful dig leaves durability alone', () => {
        const user = { balance: 0, mining: {}, quests: [], markModified() {} };
        ensureMineData(user);
        Object.assign(user.mining, {
            level: 20,
            pickaxes: [{ name: 'Wooden Pickaxe', tier: 1, currentDurability: 50, maxDurability: 80, baseDurability: 80, status: 'good' }],
            equippedPickaxeIndex: 0,
        });
        mockRandom(0);   // success
        const result = executeMine(user, 'surface_quarry', { intensity: byLevel(1) });
        expect(result.success).toBe(true);
        expect(result.durabilityLost).toBe(0);
        expect(user.mining.pickaxes[0].currentDurability).toBe(50);
    });
});
