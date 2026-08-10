'use strict';

const {
    applyHungerDecay,
    effectiveHunger,
    isPetActive,
    checkRunaway,
    feedPet,
    getTotalBonus,
    getPetBonus,
    HUNGER_DECAY_PER_DAY,
    REST_DURATION_MS,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    MS_PER_DAY,
} = require('../src/services/petService');

const HOUR = 3_600_000;
const NOW  = Date.UTC(2026, 0, 15, 12, 0, 0); // fixed clock; every call passes `now`

/** A plain pet object with its decay cursor `agoMs` in the past. */
function petAged(agoMs, overrides = {}) {
    return {
        petId: 'wolf',
        name: 'Rex',
        hunger: 100,
        lastFed: new Date(NOW - agoMs),
        lastDecayAt: new Date(NOW - agoMs),
        adoptedAt: new Date(NOW - agoMs),
        starving: false,
        starvingStartAt: null,
        ...overrides,
    };
}

describe('hunger decay is continuous', () => {
    test('accrues on partial days instead of flooring to whole days', () => {
        const pet = petAged(23 * HOUR);
        expect(effectiveHunger(pet, NOW)).toBeCloseTo(100 - (23 / 24) * HUNGER_DECAY_PER_DAY, 6);
    });

    test('a feeding cadence just under 24h no longer defeats decay entirely', () => {
        // Regression: decay used to floor (now - lastFed) to whole days, and feeding
        // reset that cursor — so feeding every 23h charged zero decay, forever.
        const perCycleDecay = (23 / 24) * HUNGER_DECAY_PER_DAY;
        let pet   = petAged(0);
        let clock = NOW;

        for (let cycle = 0; cycle < 5; cycle++) {
            clock += 23 * HOUR;
            pet = applyHungerDecay([pet], clock)[0];
            // The decay landed. Under the old cursor this stayed pinned at 100.
            expect(pet.hunger).toBeCloseTo(100 - perCycleDecay, 6);

            const fed = feedPet(pet, 'not_the_favorite', clock); // +10 hunger
            pet = { ...pet, hunger: fed.hunger, lastFed: new Date(clock), lastDecayAt: new Date(clock) };
        }
    });

    test('feeding cheaper than the decay rate still loses ground', () => {
        // +10 per feed only holds the line at a ~24h cadence; feed every 3 days
        // and the pet slides toward starving regardless of being fed.
        let pet   = petAged(0);
        let clock = NOW;

        for (let cycle = 0; cycle < 4; cycle++) {
            clock += 3 * MS_PER_DAY;
            pet = applyHungerDecay([pet], clock)[0];
            const fed = feedPet(pet, 'not_the_favorite', clock);
            pet = { ...pet, hunger: fed.hunger, lastDecayAt: new Date(clock) };
        }

        expect(pet.hunger).toBeCloseTo(100 - 4 * (3 * HUNGER_DECAY_PER_DAY - 10), 6);
        expect(isPetActive(pet, clock)).toBe(false);
    });

    test('is idempotent — re-applying without elapsed time changes nothing', () => {
        const once  = applyHungerDecay([petAged(3 * MS_PER_DAY)], NOW)[0];
        const twice = applyHungerDecay([once], NOW)[0];
        expect(twice.hunger).toBe(once.hunger);
        expect(new Date(twice.lastDecayAt).getTime()).toBe(new Date(once.lastDecayAt).getTime());
    });

    test('advances lastDecayAt but leaves lastFed alone', () => {
        const fedAt = NOW - 5 * MS_PER_DAY;
        const pet   = applyHungerDecay([petAged(5 * MS_PER_DAY)], NOW)[0];
        expect(new Date(pet.lastFed).getTime()).toBe(fedAt);
        expect(new Date(pet.lastDecayAt).getTime()).toBe(NOW);
    });

    test('never drops below zero', () => {
        const pet = applyHungerDecay([petAged(365 * MS_PER_DAY)], NOW)[0];
        expect(pet.hunger).toBe(0);
    });

    test('falls back to lastFed for pets predating the lastDecayAt cursor', () => {
        const legacy = petAged(2 * MS_PER_DAY);
        delete legacy.lastDecayAt;
        expect(effectiveHunger(legacy, NOW)).toBeCloseTo(100 - 2 * HUNGER_DECAY_PER_DAY, 6);
    });
});

describe('resting', () => {
    test('halves decay for the portion of the window spent resting', () => {
        const resting = petAged(4 * HOUR, { restUntil: new Date(NOW) });
        const awake   = petAged(4 * HOUR);

        // 2h rested at half rate + 2h awake at full rate.
        const expected = 100 - (2 * HOUR * 5 + 2 * HOUR * 10) / MS_PER_DAY;
        expect(effectiveHunger(resting, NOW)).toBeCloseTo(expected, 6);
        expect(effectiveHunger(resting, NOW)).toBeGreaterThan(effectiveHunger(awake, NOW));
    });

    test('rest credit is capped at the rest duration', () => {
        const pet = petAged(10 * MS_PER_DAY, { restUntil: new Date(NOW) });
        const fullRate = 100 - 10 * HUNGER_DECAY_PER_DAY;
        const credit   = (REST_DURATION_MS * (HUNGER_DECAY_PER_DAY - 5)) / MS_PER_DAY;
        expect(effectiveHunger(pet, NOW)).toBeCloseTo(Math.max(0, fullRate + credit), 6);
    });
});

describe('read-time staleness', () => {
    test('a pet whose owner never runs /pet still goes inactive', () => {
        // The stored hunger is stale at 100; only the cursor reveals the truth.
        const neglected = petAged(30 * MS_PER_DAY);
        expect(neglected.hunger).toBe(100);
        expect(isPetActive(neglected, NOW)).toBe(false);
        expect(getPetBonus(neglected, NOW)).toBeNull();
    });

    test('getTotalBonus ignores pets that have gone hungry since the last write', () => {
        const fresh = petAged(HOUR);
        const stale = petAged(30 * MS_PER_DAY);
        expect(getTotalBonus([fresh], 'hunt_yield', NOW)).toBe(10);
        expect(getTotalBonus([stale], 'hunt_yield', NOW)).toBe(0);
    });

    test('effectiveHunger does not mutate the pet', () => {
        const pet = petAged(5 * MS_PER_DAY);
        effectiveHunger(pet, NOW);
        expect(pet.hunger).toBe(100);
        expect(new Date(pet.lastDecayAt).getTime()).toBe(NOW - 5 * MS_PER_DAY);
    });

    test('the bonus lapses exactly at the starving threshold', () => {
        const daysToThreshold = (100 - STARVING_THRESHOLD) / HUNGER_DECAY_PER_DAY;
        const justAbove = petAged(daysToThreshold * MS_PER_DAY - HOUR);
        const justBelow = petAged(daysToThreshold * MS_PER_DAY + HOUR);
        expect(isPetActive(justAbove, NOW)).toBe(true);
        expect(isPetActive(justBelow, NOW)).toBe(false);
    });
});

describe('starvation clock', () => {
    test('starvingStartAt is back-dated to when hunger actually hit zero', () => {
        // 10 hunger left, 10 days elapsed at 10/day → it ran out after ~1 day.
        const pet = applyHungerDecay([petAged(10 * MS_PER_DAY, { hunger: 10 })], NOW)[0];
        expect(pet.hunger).toBe(0);
        const startedAt = new Date(pet.starvingStartAt).getTime();
        expect(startedAt).toBeCloseTo(NOW - 9 * MS_PER_DAY, -4);
    });

    test('a long-neglected pet is not handed a fresh grace period', () => {
        const pet = applyHungerDecay([petAged(30 * MS_PER_DAY)], NOW)[0];
        const { keepPets, ranAwayPets } = checkRunaway([pet], NOW);
        expect(ranAwayPets).toHaveLength(1);
        expect(keepPets).toHaveLength(0);
    });

    test('a pet that just ran out is still within the grace period', () => {
        // Exactly enough elapsed time to reach zero right now.
        const pet = applyHungerDecay([petAged(10 * MS_PER_DAY)], NOW)[0];
        expect(pet.hunger).toBe(0);
        const { keepPets, ranAwayPets } = checkRunaway([pet], NOW);
        expect(ranAwayPets).toHaveLength(0);
        expect(keepPets).toHaveLength(1);
    });

    test('the clock is cleared while hunger remains above zero', () => {
        const pet = applyHungerDecay([petAged(MS_PER_DAY, { starvingStartAt: new Date(NOW - 5 * MS_PER_DAY) })], NOW)[0];
        expect(pet.hunger).toBeGreaterThan(0);
        expect(pet.starvingStartAt).toBeNull();
    });

    test('runaway needs a full RUNAWAY_DAYS at zero hunger', () => {
        const dying    = { ...petAged(0), hunger: 0, starvingStartAt: new Date(NOW - (RUNAWAY_DAYS + 1) * MS_PER_DAY) };
        const clinging = { ...petAged(0), hunger: 0, starvingStartAt: new Date(NOW - (RUNAWAY_DAYS - 1) * MS_PER_DAY) };
        expect(checkRunaway([dying], NOW).ranAwayPets).toHaveLength(1);
        expect(checkRunaway([clinging], NOW).ranAwayPets).toHaveLength(0);
    });
});
