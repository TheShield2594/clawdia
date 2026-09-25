'use strict';

// #1186: bond is earned by care, capped per day, drained by hunger and cut by
// running away — not a count of days since adoption.

const {
    BOND_MAX, BOND_DAILY_CAP, BOND_CARE, BOND_HUNGRY_DECAY_PER_DAY, BOND_RUNAWAY_PENALTY, BOND_TIERS,
    STARVING_THRESHOLD, HUNGER_DECAY_PER_DAY, MS_PER_DAY,
    createPet, recordBondCare, effectiveBond, bondTierFor, getBondTier, bondAfterRunaway,
    applyHungerDecay, getEffectiveBonusPct, heartBar,
} = require('../src/services/petService');

const NOW = Date.UTC(2026, 8, 25, 12);

describe('care raises bond', () => {
    test('a new pet starts at zero, whatever its age', () => {
        const pet = createPet('dog', { now: new Date(NOW - 400 * MS_PER_DAY) });
        expect(pet.bond).toBe(0);
        expect(effectiveBond({ ...pet, lastDecayAt: new Date(NOW) }, NOW)).toBe(0);
    });

    test('each kind of care adds its points, up to the daily cap', () => {
        const pet = { bond: 10 };
        expect(recordBondCare(pet, 'feed', NOW)).toBe(BOND_CARE.feed);
        expect(recordBondCare(pet, 'play', NOW)).toBe(BOND_CARE.play);
        expect(pet.bond).toBe(10 + BOND_CARE.feed + BOND_CARE.play);
        // The cap is spent — a battle the same day adds nothing.
        expect(BOND_CARE.feed + BOND_CARE.play).toBe(BOND_DAILY_CAP);
        expect(recordBondCare(pet, 'battle', NOW)).toBe(0);
        expect(pet.bond).toBe(10 + BOND_DAILY_CAP);
    });

    test('the cap resets on the next UTC day', () => {
        const pet = { bond: 0 };
        for (let i = 0; i < 5; i++) recordBondCare(pet, 'feed', NOW);
        expect(pet.bond).toBe(BOND_DAILY_CAP);
        expect(recordBondCare(pet, 'feed', NOW + MS_PER_DAY)).toBe(BOND_CARE.feed);
    });

    test('a partial point of room is used, and bond never passes the maximum', () => {
        const pet = { bond: BOND_MAX - 1 };
        expect(recordBondCare(pet, 'feed', NOW)).toBe(1);
        expect(pet.bond).toBe(BOND_MAX);
        expect(recordBondCare(pet, 'feed', NOW)).toBe(0);
    });

    test('an unknown kind of care adds nothing', () => {
        const pet = { bond: 5 };
        expect(recordBondCare(pet, 'showcase', NOW)).toBe(0);
        expect(pet.bond).toBe(5);
    });
});

describe('neglect lowers bond', () => {
    test('a fed pet keeps its bond', () => {
        const pet = { petId: 'dog', bond: 40, hunger: 100, lastDecayAt: new Date(NOW - MS_PER_DAY) };
        expect(effectiveBond(pet, NOW)).toBe(40);
    });

    test('a pet already below the threshold drains for the whole window', () => {
        const pet = { petId: 'dog', bond: 40, hunger: 20, lastDecayAt: new Date(NOW - 2 * MS_PER_DAY) };
        expect(effectiveBond(pet, NOW)).toBeCloseTo(40 - 2 * BOND_HUNGRY_DECAY_PER_DAY, 6);
    });

    test('drain starts only when hunger crosses the threshold', () => {
        // 40% hunger falls to 30% after one day, then spends two more below it.
        const pet = { petId: 'dog', bond: 40, hunger: STARVING_THRESHOLD + HUNGER_DECAY_PER_DAY, lastDecayAt: new Date(NOW - 3 * MS_PER_DAY) };
        expect(effectiveBond(pet, NOW)).toBeCloseTo(40 - 2 * BOND_HUNGRY_DECAY_PER_DAY, 6);
    });

    test('applyHungerDecay writes the drain back with the hunger', () => {
        const pet = { petId: 'dog', bond: 10, hunger: 10, lastDecayAt: new Date(NOW - MS_PER_DAY) };
        const [settled] = applyHungerDecay([pet], NOW);
        expect(settled.bond).toBeCloseTo(10 - BOND_HUNGRY_DECAY_PER_DAY, 6);
        // Settled, so reading it again charges nothing twice.
        expect(effectiveBond(settled, NOW)).toBeCloseTo(settled.bond, 6);
    });

    test('bond never drains below zero', () => {
        const pet = { petId: 'dog', bond: 1, hunger: 0, lastDecayAt: new Date(NOW - 30 * MS_PER_DAY) };
        expect(effectiveBond(pet, NOW)).toBe(0);
    });

    test('running away costs a fixed penalty, floored at zero', () => {
        expect(bondAfterRunaway({ bond: 70 })).toBe(70 - BOND_RUNAWAY_PENALTY);
        expect(bondAfterRunaway({ bond: 10 })).toBe(0);
    });
});

describe('tiers', () => {
    test('are ordered and start at zero', () => {
        expect(BOND_TIERS[0].min).toBe(0);
        for (let i = 1; i < BOND_TIERS.length; i++) expect(BOND_TIERS[i].min).toBeGreaterThan(BOND_TIERS[i - 1].min);
    });

    test('each boundary lands in its tier', () => {
        for (const t of BOND_TIERS) {
            expect(bondTierFor(t.min).title).toBe(t.title);
            if (t.min > 0) expect(bondTierFor(t.min - 0.01).tier).toBe(t.tier - 1);
        }
    });

    test('a higher tier boosts the passive a few percent', () => {
        const base = { petId: 'wolf', level: 30, evolutionStage: 3, hunger: 100, lastDecayAt: new Date(NOW) };
        const top  = BOND_TIERS.at(-1);
        expect(getEffectiveBonusPct({ ...base, bond: 0 }, NOW)).toBe(25);
        expect(getEffectiveBonusPct({ ...base, bond: top.min }, NOW)).toBe(Math.round(25 * (1 + top.boost) * 10) / 10);
        expect(top.boost).toBeLessThanOrEqual(0.1);
    });

    test('the tier read is decay-aware', () => {
        const pet = { petId: 'dog', bond: 36, hunger: 0, lastDecayAt: new Date(NOW - MS_PER_DAY) };
        expect(bondTierFor(36).title).toBe('Trusted');
        expect(getBondTier(pet, NOW).title).toBe('Friendly');
    });

    test('the heart bar fills with bond, not days', () => {
        expect(heartBar(0)).toBe('🖤'.repeat(8));
        expect(heartBar(50)).toBe('❤️'.repeat(4) + '🖤'.repeat(4));
        expect(heartBar(BOND_MAX)).toBe('❤️'.repeat(8));
    });
});
