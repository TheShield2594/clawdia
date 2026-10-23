'use strict';

// #1190: pet passives come in two units. Rob and crime add percentage points
// to a success chance; every other passive multiplies a payout. Both used to be
// printed "+X%", so a maxed Fox read as "+20%" while it took rob from 40% to
// 60%. The balance is unchanged — these pin the chances a maxed Fox and Cat
// actually produce, and that every label says which unit it is in.

const {
    PET_DEFINITIONS, PET_MAX_LEVEL, stageForLevel, getEffectiveBonusPct,
    formatPetBonus, petBonusParts, petChanceBonus,
} = require('../src/services/petService');
const { robSuccessChance, BASE_SUCCESS_CHANCE } = require('../src/commands/economy/rob/attempt');
const { __test__: { methodOdds } } = require('../src/commands/economy/crime');
const { petCardOptions } = require('../src/services/petStatusView');

const maxed = (petId) => ({
    petId, level: PET_MAX_LEVEL, evolutionStage: stageForLevel(PET_MAX_LEVEL),
    hunger: 100, lastDecayAt: new Date(),
});

describe('success-chance passives add points', () => {
    test('a maxed Fox takes a 40% rob to 60%', () => {
        expect(BASE_SUCCESS_CHANCE).toBe(0.40);
        expect(getEffectiveBonusPct(maxed('fox'))).toBe(20);
        expect(robSuccessChance({ pets: [maxed('fox')] })).toBeCloseTo(0.60, 10);
    });

    test('a hungry Fox adds nothing, and the knife still stacks with a fed one', () => {
        expect(robSuccessChance({ pets: [{ ...maxed('fox'), hunger: 10 }] })).toBeCloseTo(0.40, 10);
        const knife = { type: 'knife', expiresAt: new Date(Date.now() + 60_000) };
        expect(robSuccessChance({ pets: [maxed('fox')], activeEffects: [knife] })).toBeCloseTo(0.75, 10);
    });

    test('a maxed Cat adds 12.5 points to a crime, capped at 95%', () => {
        expect(getEffectiveBonusPct(maxed('cat'))).toBe(12.5);
        const cat = petChanceBonus([maxed('cat')], 'crime_success');
        expect(cat).toBeCloseTo(0.125, 10);
        // /crime rolls a method at its rate plus every bonus, capped.
        expect(methodOdds({ successRate: 0.50 }, cat)).toBeCloseTo(0.625, 10);
        expect(methodOdds({ successRate: 0.90 }, cat)).toBe(0.95);
        expect(methodOdds({ successRate: 0.50 }, petChanceBonus([], 'crime_success'))).toBe(0.50);
    });

    test('only the chance passives go through petChanceBonus', () => {
        expect(petChanceBonus([maxed('wolf')], 'hunt_yield')).toBe(0);
    });
});

describe('labels say which unit a passive is in', () => {
    test('chance passives read as points, payout passives as percent', () => {
        expect(formatPetBonus('rob_success', 20)).toBe('+20 pts rob success chance');
        expect(formatPetBonus('crime_success', 12.5)).toBe('+12.5 pts crime success chance');
        expect(formatPetBonus('hunt_yield', 25)).toBe('+25% hunt yield');
    });

    test('every pet definition gets one of the two units', () => {
        for (const def of Object.values(PET_DEFINITIONS)) {
            const { unit } = petBonusParts(def.bonusType);
            expect([' pts', '%']).toContain(unit);
            expect(unit === ' pts').toBe(def.bonusType.endsWith('_success'));
        }
    });

    test('the companion card carries the unit', () => {
        const card = petCardOptions(maxed('fox'), { kicker: 'x' });
        expect(card.bonus).toEqual(expect.objectContaining({ pct: 20, unit: ' pts', label: 'rob success chance' }));
    });
});
