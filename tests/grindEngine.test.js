'use strict';

// #892. /hunt, /fish, /mine and /explore were four parallel implementations of
// one design — 5,600 lines of service code with the same shapes in it four
// times over. The mechanics that are not about animals or fish or ore now live
// in one engine, parameterised per subsystem.
//
// Two things are pinned here. The first is the engine itself: the stamina bank,
// the rolling window, the ladder and the format, each once. The second is that
// all four services actually go through it — an engine two of them use is the
// same duplication with an extra file.

const fs = require('fs');
const path = require('path');

const grind = require('../src/services/grindEngine');
const huntService = require('../src/services/huntService');
const fishService = require('../src/services/fishService');
const mineService = require('../src/services/mineService');
const exploreService = require('../src/services/exploreService');

const GRINDS = ['hunt', 'fish', 'mine', 'explore'];
const SERVICES = { hunt: huntService, fish: fishService, mine: mineService, explore: exploreService };

// A stand-in for the Mongoose document: the engine only ever reads a
// subdocument off it and calls markModified.
function doc(overrides = {}) {
    const user = { markModified: key => user.marked.push(key), marked: [], ...overrides };
    return user;
}

function seeded(id, fields = {}) {
    const user = doc();
    grind.ensureSharedFields(user, id);
    Object.assign(user[grind.specFor(id).key], fields);
    user.marked.length = 0;
    return user;
}

describe('the spec table', () => {
    test('every grind names the subdocument it lives under', () => {
        expect(Object.keys(grind.GRINDS)).toEqual(GRINDS);
        expect(GRINDS.map(id => grind.specFor(id).key)).toEqual(['hunt', 'fishing', 'mining', 'exploration']);
    });

    test('an unknown grind is an error rather than a silent no-op', () => {
        // The alternative is a stamina bar that never fills and a daily window
        // that never rolls, on a subsystem nobody has finished wiring up.
        expect(() => grind.specFor('forage')).toThrow(/unknown grind "forage"/);
        expect(() => grind.getMaxStamina(doc(), 'forage')).toThrow(/unknown grind/);
    });

    test('each spec carries a ladder and a daily window', () => {
        for (const id of GRINDS) {
            const spec = grind.specFor(id);
            expect([id, spec.levels.length > 0]).toEqual([id, true]);
            expect([id, spec.limits.DAILY_WINDOW_MS > 0]).toEqual([id, true]);
            expect([id, spec.limits.STAMINA_REGEN_MS > 0]).toEqual([id, true]);
            expect([id, spec.dailyCounters]).toEqual([id, expect.arrayContaining(['dailyCoins'])]);
        }
    });
});

describe('the fields the engine owns', () => {
    test.each(GRINDS)('%s: seeds a profile that has never been touched', id => {
        const user = doc();

        expect(grind.ensureSharedFields(user, id)).toBe(true);

        const d = user[grind.specFor(id).key];
        expect(d.stamina).toBe(grind.specFor(id).maxStaminaBase);
        expect([d.xp, d.level, d.prestige]).toEqual([0, 1, 0]);
        expect(d.staminaLastRegen).toBeNull();
        expect(d.dailyWindowStart).toBeNull();
        expect(d.materials).toEqual({});
        expect(user.marked).toEqual([grind.specFor(id).key]);
    });

    test.each(GRINDS)('%s: a second call writes nothing and marks nothing', id => {
        const user = doc();
        grind.ensureSharedFields(user, id);
        user.marked.length = 0;

        expect(grind.ensureSharedFields(user, id)).toBe(false);
        expect(user.marked).toEqual([]);
    });

    test.each(GRINDS)('%s: never overwrites a value that is already there', id => {
        const user = seeded(id, { stamina: 2, xp: 900, level: 7, materials: { pelt: 3 } });
        grind.ensureSharedFields(user, id);

        const d = user[grind.specFor(id).key];
        expect([d.stamina, d.xp, d.level, d.materials]).toEqual([2, 900, 7, { pelt: 3 }]);
    });
});

describe('the stamina bank', () => {
    test.each(GRINDS)('%s: credits one point per interval and carries the remainder', id => {
        const { limits } = grind.specFor(id);
        const key = grind.specFor(id).key;
        const anchor = new Date(Date.now() - (2 * limits.STAMINA_REGEN_MS + 1000));
        const user = seeded(id, { stamina: 1, staminaLastRegen: anchor });

        expect(grind.applyStaminaRegen(user, id)).toBe(true);
        expect(user[key].stamina).toBe(3);
        // Advanced by exactly two intervals, not to now: the leftover second is
        // still owed to the player.
        expect(user[key].staminaLastRegen.getTime())
            .toBe(anchor.getTime() + 2 * limits.STAMINA_REGEN_MS);
    });

    test.each(GRINDS)('%s: credits nothing before the first interval is up', id => {
        const { limits } = grind.specFor(id);
        const user = seeded(id, { stamina: 1, staminaLastRegen: new Date(Date.now() - (limits.STAMINA_REGEN_MS - 5_000)) });

        expect(grind.applyStaminaRegen(user, id)).toBe(false);
        expect(user[grind.specFor(id).key].stamina).toBe(1);
        expect(user.marked).toEqual([]);
    });

    // The drift this replaces: hunt, fish and mine rewrote the anchor and marked
    // the subdocument on every call while the bar was full, so reading a profile
    // was a database write. Explore had been fixed and the other three had not.
    test.each(GRINDS)('%s: a full bar is not a write', id => {
        const max = grind.getMaxStamina(seeded(id), id);
        const user = seeded(id, { stamina: max, staminaLastRegen: new Date() });

        expect(grind.applyStaminaRegen(user, id)).toBe(false);
        expect(user.marked).toEqual([]);
    });

    test.each(GRINDS)('%s: a full bar with a stale anchor refreshes it once', id => {
        const { limits } = grind.specFor(id);
        const max = grind.getMaxStamina(seeded(id), id);
        const user = seeded(id, { stamina: max, staminaLastRegen: new Date(Date.now() - 2 * limits.STAMINA_REGEN_MS) });

        expect(grind.applyStaminaRegen(user, id)).toBe(true);
        expect(grind.applyStaminaRegen(user, id)).toBe(false);
    });

    test.each(GRINDS)('%s: never fills past the ceiling', id => {
        const { limits, key } = grind.specFor(id);
        const max = grind.getMaxStamina(seeded(id), id);
        const user = seeded(id, { stamina: max - 1, staminaLastRegen: new Date(Date.now() - 50 * limits.STAMINA_REGEN_MS) });

        grind.applyStaminaRegen(user, id);
        expect(user[key].stamina).toBe(max);
    });

    test.each(GRINDS)('%s: the countdown is zero at full and a whole interval from cold', id => {
        const { limits } = grind.specFor(id);
        const max = grind.getMaxStamina(seeded(id), id);

        expect(grind.msUntilNextStamina(seeded(id, { stamina: max }), id)).toBe(0);
        expect(grind.msUntilNextStamina(seeded(id, { stamina: 0, staminaLastRegen: null }), id))
            .toBe(limits.STAMINA_REGEN_MS);
    });

    test('a restore can target a bar belonging to another grind', () => {
        // This is what an energy drink does — it refills the fishing and hunting
        // bars together — and it is why fishService no longer requires
        // huntService to reach the second one.
        const user = doc();
        const result = grind.restoreStamina(user, 'hunt', 3);

        expect(user.hunt.stamina).toBe(grind.specFor('hunt').maxStaminaBase);
        expect(result.wasFull).toBe(true);
        expect(grind.restoreStamina(seeded('hunt', { stamina: 1 }), 'hunt', 3).after).toBe(4);
    });

    test('a restore clamps at the ceiling and reports whether it was already full', () => {
        const max = grind.getMaxStamina(seeded('mine'), 'mine');

        expect(grind.restoreStamina(seeded('mine', { stamina: max - 1 }), 'mine', 5).after).toBe(max);
        expect(grind.restoreStamina(seeded('mine', { stamina: max }), 'mine', 5))
            .toMatchObject({ before: max, after: max, wasFull: true });
    });
});

describe('the rolling daily window', () => {
    test.each(GRINDS)('%s: rolls when the window has run out, zeroing every counter', id => {
        const { limits, key, dailyCounters, dailyStaminaItem } = grind.specFor(id);
        const fields = { dailyWindowStart: new Date(Date.now() - limits.DAILY_WINDOW_MS - 1) };
        for (const c of dailyCounters) fields[c] = 500;
        if (dailyStaminaItem) fields[dailyStaminaItem.used] = 3;
        const user = seeded(id, fields);

        expect(grind.applyDailyReset(user, id)).toBe(true);
        for (const c of dailyCounters) expect([id, c, user[key][c]]).toEqual([id, c, 0]);
        if (dailyStaminaItem) expect(user[key][dailyStaminaItem.used]).toBe(0);
        expect(user.marked).toEqual([key]);
    });

    test.each(GRINDS)('%s: leaves a window that is still open alone', id => {
        const user = seeded(id, { dailyWindowStart: new Date(), dailyCoins: 500 });

        expect(grind.applyDailyReset(user, id)).toBe(false);
        expect(user[grind.specFor(id).key].dailyCoins).toBe(500);
    });

    test.each(GRINDS)('%s: opens a window for a player who has never played', id => {
        const user = seeded(id);
        expect(grind.applyDailyReset(user, id)).toBe(true);
        expect(user[grind.specFor(id).key].dailyWindowStart).toBeInstanceOf(Date);
    });

    // The second drift this replaces: hunt answered 0 for "no window" and mine
    // answered null, and they are opposite facts. A window that has run out is 0
    // and resets on the next action; a player who has never acted has no window.
    test.each(GRINDS)('%s: tells a window that never started apart from one that expired', id => {
        const { limits } = grind.specFor(id);

        expect(grind.msUntilDailyReset(seeded(id), id)).toBeNull();
        expect(grind.msUntilDailyReset(doc(), id)).toBeNull();
        expect(grind.msUntilDailyReset(undefined, id)).toBeNull();

        const expired = seeded(id, { dailyWindowStart: new Date(Date.now() - limits.DAILY_WINDOW_MS - 1000) });
        expect(grind.msUntilDailyReset(expired, id)).toBe(0);

        const halfway = seeded(id, { dailyWindowStart: new Date(Date.now() - limits.DAILY_WINDOW_MS / 2) });
        expect(grind.msUntilDailyReset(halfway, id)).toBeGreaterThan(limits.DAILY_WINDOW_MS / 2 - 5_000);
    });
});

describe('the level ladder', () => {
    test.each(GRINDS)('%s: reads the level off the whole table, not one rung at a time', id => {
        const { levels } = grind.specFor(id);

        expect(grind.levelFromXp(0, id)).toBe(1);
        expect(grind.levelFromXp(levels[2].xpRequired, id)).toBe(levels[2].level);
        expect(grind.levelFromXp(Number.MAX_SAFE_INTEGER, id)).toBe(levels.at(-1).level);
    });

    test.each(GRINDS)('%s: one large award can carry a player up several rungs', id => {
        const { levels, key } = grind.specFor(id);
        const user = seeded(id);
        const target = levels[3];

        const result = grind.applyXp(user, target.xpRequired, id);
        expect(result).toMatchObject({ oldLevel: 1, newLevel: target.level, leveledUp: true });
        expect(user[key].level).toBe(target.level);
    });

    test.each(GRINDS)('%s: an award that changes no rung reports no level-up', id => {
        const user = seeded(id);
        expect(grind.applyXp(user, 1, id)).toMatchObject({ leveledUp: false, newLevel: 1 });
        expect(user.marked).toEqual([]);
    });

    test.each(GRINDS)('%s: the ladder row is clamped at both ends', id => {
        const { levels } = grind.specFor(id);

        // Level 0 is not a level anyone has; it used to index -1 and return
        // undefined, which the callers then read a title off.
        expect(grind.getLevelData(0, id)).toBe(levels[0]);
        expect(grind.getLevelData(1, id)).toBe(levels[0]);
        expect(grind.getLevelData(levels.length + 50, id)).toBe(levels.at(-1));
    });

    // The third drift: hunt, fish and mine returned a negative number when a
    // player's xp had run past their recorded level, which renders as
    // "-40 XP to go". Explore clamped it.
    test.each(GRINDS)('%s: never owes a negative amount, and owes nothing at the top', id => {
        const { levels } = grind.specFor(id);

        expect(grind.xpToNextLevel(1, 0, id)).toBe(levels[1].xpRequired);
        expect(grind.xpToNextLevel(1, levels[1].xpRequired + 40, id)).toBe(0);
        expect(grind.xpToNextLevel(levels.length, levels.at(-1).xpRequired, id)).toBeNull();
    });
});

describe('the daily payout throttle', () => {
    const GEAR = ['hunt', 'fish', 'mine'];

    test.each(GEAR)('%s: pays in full below the soft cap', id => {
        const user = seeded(id, { dailyCoins: 0 });
        const throttle = grind.dailyThrottle(user, id);

        expect([throttle.cappedByHard, throttle.softCapped]).toEqual([false, false]);
        expect(throttle.settle(5_000)).toBe(5_000);
    });

    test.each(GEAR)('%s: halves past the soft cap', id => {
        const { DAILY_SOFT_CAP } = grind.specFor(id).limits;
        const throttle = grind.dailyThrottle(seeded(id, { dailyCoins: DAILY_SOFT_CAP }), id);

        expect(throttle.softCapped).toBe(true);
        expect(throttle.settle(5_000)).toBe(2_500);
    });

    test.each(GEAR)('%s: clamps to the headroom under the hard cap', id => {
        const { DAILY_HARD_CAP } = grind.specFor(id).limits;
        const throttle = grind.dailyThrottle(seeded(id, { dailyCoins: DAILY_HARD_CAP - 40 }), id);

        expect(throttle.remaining).toBe(40);
        expect(throttle.settle(1_000_000)).toBe(40);
    });

    test.each(GEAR)('%s: reports the hard cap and never settles below zero', id => {
        const { DAILY_HARD_CAP } = grind.specFor(id).limits;
        const throttle = grind.dailyThrottle(seeded(id, { dailyCoins: DAILY_HARD_CAP + 5_000 }), id);

        expect(throttle.cappedByHard).toBe(true);
        expect(throttle.remaining).toBe(0);
        expect(throttle.settle(5_000)).toBe(0);
        expect(throttle.settle(-100)).toBe(0);
    });

    test('the soft cap is one rate rather than a 0.50 in each service', () => {
        expect(grind.SOFT_CAP_RATE).toBe(0.50);
    });
});

describe('the gathering-yield claim', () => {
    // The engine reaches effectsService for the real charge; here the point is
    // the *policy*, so the effect lookup is stubbed through the user document
    // shape effectsService reads.
    const withCharge = (effect, charges = 2) => ({
        markModified: () => {},
        activeEffects: [{ type: effect, charges, expiresAt: new Date(Date.now() + 3_600_000) }],
    });

    test('spends nothing when there is no charge to spend', () => {
        expect(grind.claimGatheringYield({ markModified: () => {} }, 100, 200)).toBeNull();
    });

    // The rule fishing did not have: within a hair of the daily hard cap the
    // headroom clamp swallows the whole bonus, so the charge buys nothing.
    test('spends nothing when doubling would not pay more', () => {
        const user = withCharge('silvered_talisman');
        expect(grind.claimGatheringYield(user, 40, 40)).toBeNull();
        expect(user.activeEffects[0].charges).toBe(2);
    });

    test('spends exactly one charge when doubling pays, and says what is left', () => {
        const user = withCharge('silvered_talisman');
        const claim = grind.claimGatheringYield(user, 100, 200);

        expect(claim).toMatchObject({ effect: 'silvered_talisman', chargesLeft: 1 });
        expect(typeof claim.label).toBe('string');
        expect(claim.emoji.length).toBeGreaterThan(0);
        expect(user.activeEffects[0].charges).toBe(1);
    });
});

describe('the countdown format', () => {
    test('rounds up, so a countdown does not reach zero before the thing happens', () => {
        expect(grind.formatMs(1)).toBe('1s');
        expect(grind.formatMs(999)).toBe('1s');
        expect(grind.formatMs(0)).toBe('0s');
        expect(grind.formatMs(-5_000)).toBe('0s');
    });

    test('drops to the coarsest useful pair of units', () => {
        expect(grind.formatMs(45_000)).toBe('45s');
        expect(grind.formatMs(90_000)).toBe('1m 30s');
        expect(grind.formatMs(3_600_000)).toBe('1h 0m');
        expect(grind.formatMs(2 * 3_600_000 + 30 * 60_000)).toBe('2h 30m');
    });
});

describe('all four services go through the engine', () => {
    const source = id => fs.readFileSync(
        path.join(__dirname, '..', 'src', 'services', `${id === 'fish' ? 'fish' : id}Service.js`), 'utf8');

    test.each(GRINDS)('%s requires it', id => {
        expect(source(id)).toMatch(/require\('\.\/grindEngine'\)/);
    });

    // The point of the engine is that these are not written out per subsystem
    // any more. A service that grows its own copy back has undone it.
    //
    // Asserted as "the definition delegates" rather than "no `function name(`
    // appears": every one of these is now a one-line `const name = … grind.…`,
    // so a check for the `function` keyword alone would pass a reimplementation
    // written in the same arrow style the delegations use — which is the form a
    // regrown copy would actually take.
    const SHARED = ['getMaxStamina', 'applyStaminaRegen', 'msUntilNextStamina',
        'applyDailyReset', 'msUntilDailyReset', 'getLevelData', 'xpToNextLevel', 'formatMs'];

    test.each(GRINDS)('%s delegates every shared mechanic it defines', id => {
        const text = source(id);

        for (const name of SHARED) {
            // Not every grind defines every one — explore has no daily-reset
            // countdown, for instance. What it defines, it must delegate.
            const defined = new RegExp(`^(?:const|let|var|async function|function)\\s+${name}\\b.*$`, 'm').exec(text);
            if (!defined) continue;

            expect([id, name, /\bgrind\./.test(defined[0])]).toEqual([id, name, true]);
        }
    });

    // …and the assertion above is only worth anything if it is looking at the
    // real definitions, so this fails if the names stop being found at all.
    test.each(GRINDS)('%s defines enough of them for that check to mean something', id => {
        const text = source(id);
        const found = SHARED.filter(name =>
            new RegExp(`^(?:const|let|var|async function|function)\\s+${name}\\b`, 'm').test(text));

        expect(found.length).toBeGreaterThanOrEqual(6);
    });

    test.each(GRINDS)('%s still exports them, so its callers did not have to move', id => {
        for (const name of ['getMaxStamina', 'applyStaminaRegen', 'msUntilNextStamina', 'formatMs']) {
            expect([id, name, typeof SERVICES[id][name]]).toEqual([id, name, 'function']);
        }
    });

    // The other half of #892: fishService required huntService outright, to
    // reach the hunting stamina bar and material bag. A lower-level mechanic
    // reached for through whichever sibling happens to own it is how the four
    // subsystems became one knot.
    test('no grind service requires another', () => {
        for (const id of GRINDS) {
            for (const other of GRINDS) {
                expect([id, other, new RegExp(`require\\('\\./${other}Service'\\)`).test(source(id))])
                    .toEqual([id, other, false]);
            }
        }
    });
});
