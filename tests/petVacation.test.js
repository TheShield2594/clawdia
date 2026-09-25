'use strict';

// Vacation mode (#1181): hunger decay, the runaway clock and bond drain all
// stand still for the window a pet is on vacation, and the pet is inactive
// meanwhile so the pause can't be farmed.

const {
    applyHungerDecay,
    effectiveHunger,
    effectiveBond,
    isPetActive,
    isOnVacation,
    checkRunaway,
    recordPetInteraction,
    getTotalBonus,
    pickDefenderPet,
    canTrain,
    activeVacation,
    joinVacation,
    startVacation,
    endVacation,
    createPet,
    VACATION_MAX_DAYS,
    HUNGER_DECAY_PER_DAY,
    RUNAWAY_DAYS,
    MS_PER_DAY,
} = require('../src/services/petService');

const DAY = MS_PER_DAY;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function pet(overrides = {}) {
    return {
        petId: 'wolf', name: 'Rex', hunger: 100, bond: 50,
        lastFed: new Date(NOW), lastDecayAt: new Date(NOW), adoptedAt: new Date(NOW),
        starving: false, starvingStartAt: null,
        ...overrides,
    };
}

const user = pets => ({ pets, markModified: jest.fn() });

describe('hunger decay pauses on vacation', () => {
    test('a pet on vacation comes back with the hunger it left with', () => {
        const u = user([pet({ hunger: 70 })]);
        startVacation(u, 14, NOW);
        const back = NOW + 14 * DAY;
        expect(effectiveHunger(u.pets[0], back)).toBeCloseTo(70, 6);
        // And decay runs again afterwards, from where it paused.
        expect(effectiveHunger(u.pets[0], back + DAY)).toBeCloseTo(70 - HUNGER_DECAY_PER_DAY, 6);
    });

    test('only the part of the window inside the vacation is paused', () => {
        // Cursor 2 days before the vacation started, read 1 day after it ended.
        const p = pet({
            hunger: 80, lastDecayAt: new Date(NOW - 2 * DAY),
            vacationFrom: new Date(NOW), vacationUntil: new Date(NOW + 5 * DAY),
        });
        expect(effectiveHunger(p, NOW + 6 * DAY)).toBeCloseTo(80 - 3 * HUNGER_DECAY_PER_DAY, 6);
    });

    test('ending early resumes decay from that moment', () => {
        const u = user([pet({ hunger: 60 })]);
        startVacation(u, 14, NOW);
        const synced = applyHungerDecay(u.pets, NOW + 2 * DAY);
        u.pets = synced;
        endVacation(u, NOW + 2 * DAY);
        expect(isOnVacation(u.pets[0], NOW + 2 * DAY)).toBe(false);
        expect(effectiveHunger(u.pets[0], NOW + 3 * DAY)).toBeCloseTo(60 - HUNGER_DECAY_PER_DAY, 6);
    });

    test('applyHungerDecay across a vacation writes back the paused hunger', () => {
        const p = pet({ hunger: 50, vacationFrom: new Date(NOW), vacationUntil: new Date(NOW + 10 * DAY) });
        const [after] = applyHungerDecay([p], NOW + 10 * DAY);
        expect(after.hunger).toBeCloseTo(50, 6);
        expect(after.starvingStartAt).toBeNull();
    });
});

describe('the runaway clock stands still on vacation', () => {
    test('a pet already empty does not run away during a vacation', () => {
        const p = pet({
            hunger: 0, starvingStartAt: new Date(NOW - 2 * DAY), lastDecayAt: new Date(NOW),
            vacationFrom: new Date(NOW), vacationUntil: new Date(NOW + 14 * DAY),
        });
        const later = NOW + 14 * DAY;
        const decayed = applyHungerDecay([p], later);
        expect(checkRunaway(decayed, later).ranAwayPets).toHaveLength(0);
        // The clock picked up where it was: two days in, one to go.
        expect(new Date(decayed[0].starvingStartAt).getTime()).toBe(later - 2 * DAY);
        const oneMore = applyHungerDecay(decayed, later + DAY);
        expect(checkRunaway(oneMore, later + DAY).ranAwayPets).toHaveLength(1);
    });

    test('a pet that runs out mid-window is back-dated to when it ran out, skipping the pause', () => {
        // 10 hunger = one day of decay; the pause starts half a day in.
        const p = pet({
            hunger: 10, lastDecayAt: new Date(NOW),
            vacationFrom: new Date(NOW + DAY / 2), vacationUntil: new Date(NOW + DAY / 2 + 5 * DAY),
        });
        const read = NOW + 7 * DAY;
        const [after] = applyHungerDecay([p], read);
        expect(after.hunger).toBe(0);
        // Ran out a day of active time in: half a day, the 5-day pause, half a day.
        expect(new Date(after.starvingStartAt).getTime()).toBe(NOW + 6 * DAY);
        expect(checkRunaway([after], NOW + 6 * DAY + RUNAWAY_DAYS * DAY - 1).ranAwayPets).toHaveLength(0);
    });
});

describe('bond does not drain on vacation', () => {
    test('a hungry pet on vacation keeps its bond', () => {
        const p = pet({ hunger: 10, bond: 40, vacationFrom: new Date(NOW), vacationUntil: new Date(NOW + 10 * DAY) });
        expect(effectiveBond(p, NOW + 10 * DAY)).toBeCloseTo(40, 6);
    });
});

describe('a pet on vacation cannot be used to farm', () => {
    const away = () => pet({ vacationFrom: new Date(NOW), vacationUntil: new Date(NOW + DAY) });

    test('its passive is off', () => {
        expect(isPetActive(away(), NOW + 1000)).toBe(false);
        expect(getTotalBonus([away()], 'hunt_yield', NOW + 1000)).toBe(0);
    });

    test('it is never picked to defend and cannot train', () => {
        expect(pickDefenderPet([away()], 1, NOW + 1000)).toBeNull();
        expect(canTrain(away(), 'power', NOW + 1000)).toEqual({ ok: false, reason: 'hungry' });
    });

    test('it earns no Pet of the Week credit', () => {
        const p = away();
        expect(recordPetInteraction(p, NOW + 1000)).toBe(false);
        expect(p.weeklyInteractions ?? 0).toBe(0);
    });

    test('everything comes back once it ends', () => {
        expect(isPetActive(away(), NOW + DAY)).toBe(true);
    });
});

describe('starting, ending and joining', () => {
    test('start covers every pet and caps at the maximum', () => {
        const u = user([pet(), pet({ petId: 'cat' })]);
        const until = startVacation(u, 99, NOW);
        expect(until.getTime()).toBe(NOW + VACATION_MAX_DAYS * DAY);
        expect(u.pets.every(p => isOnVacation(p, NOW))).toBe(true);
        expect(activeVacation(u, NOW).until.getTime()).toBe(until.getTime());
        expect(u.markModified).toHaveBeenCalledWith('pets');
    });

    test('a pet added mid-vacation joins it', () => {
        const u = user([pet()]);
        const until = startVacation(u, 5, NOW);
        const fresh = joinVacation(u, createPet('dog', { now: new Date(NOW + DAY) }), NOW + DAY);
        expect(isOnVacation(fresh, NOW + DAY)).toBe(true);
        expect(new Date(fresh.vacationUntil).getTime()).toBe(until.getTime());
    });

    test('a pet added with no vacation on is left alone', () => {
        const fresh = joinVacation(user([pet()]), createPet('dog'), NOW);
        expect(fresh.vacationFrom).toBeUndefined();
    });

    test('ending reports how many pets were away', () => {
        const u = user([pet(), pet()]);
        expect(endVacation(u, NOW)).toBe(0);
        startVacation(u, 3, NOW);
        expect(endVacation(u, NOW + DAY)).toBe(2);
        expect(activeVacation(u, NOW + DAY)).toBeNull();
    });
});
