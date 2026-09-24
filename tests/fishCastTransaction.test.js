'use strict';

// The cast transaction layer extracted from the /fish command (#613):
// preflight validation, reward snapshot/rollback for the interactive reel-in,
// and the post-roll bonus stack. These run against a plain user object — no
// mock interaction, which is the point of the extraction.

const {
    validateCastPreflight,
    snapshotCastRewards,
    revertEscapedCast,
    downgradeOptionalMiss,
    applyCastBonuses,
    rollWinterHuntMaterial,
} = require('../src/services/fishService');
const { LIMITS, ROD_TIERS, FISH, FISH_WEIGHT_SCALE } = require('../src/data/fishData');

function makeUser(fishingOverrides = {}) {
    const bamboo = ROD_TIERS[0];
    return {
        userId: 'u1',
        guildId: 'g1',
        balance: 1000,
        hunt: { materials: {} },
        fishing: {
            level: 1,
            prestige: 0,
            xp: 0,
            stamina: 10,
            dailyCoins: 0,
            totalEarned: 0,
            successfulCasts: 0,
            consecutiveFails: 0,
            bestPayout: 0,
            legendaryCatches: 0,
            eventCatches: 0,
            sinceRare: 0,
            activeLocation: 'pond',
            unlockedLocations: ['pond'],
            equippedRodIndex: 0,
            injuryUntil: null,
            lastCast: null,
            rods: [{
                name: bamboo.name,
                tier: bamboo.tier,
                slug: bamboo.slug,
                currentDurability: bamboo.baseDurability,
                maxDurability: bamboo.baseDurability,
                status: 'good',
            }],
            bait: {},
            materials: {},
            personalBest: { fish: null, weight: 0, payout: 0 },
            weeklyRecord: { fish: null, weight: 0, userId: null, username: null, weekStart: null },
            ...fishingOverrides,
        },
        markModified: () => {},
    };
}

describe('validateCastPreflight', () => {
    test('passes a ready user and resolves the location, rod and rod data', () => {
        const user = makeUser();
        const res = validateCastPreflight(user, null);
        expect(res.ok).toBe(true);
        expect(res.locationId).toBe('pond');
        expect(res.location.name).toBeDefined();
        expect(res.rod).toBe(user.fishing.rods[0]);
        expect(res.rodData).toBeDefined();
    });

    test.each([
        ['unknown_location', {}, 'nowhere'],
        ['location_locked',  { unlockedLocations: [] }, 'pond'],
        ['injured',          { injuryUntil: new Date(Date.now() + 60_000) }, null],
        ['cooldown',         { lastCast: new Date() }, null],
        ['no_stamina',       { stamina: 0 }, null],
        ['no_rod',           { equippedRodIndex: -1 }, null],
    ])('rejects with %s', (reason, overrides, requested) => {
        const res = validateCastPreflight(makeUser(overrides), requested);
        expect(res.ok).toBe(false);
        expect(res.reason).toBe(reason);
    });

    test('rejects a broken rod', () => {
        const user = makeUser();
        user.fishing.rods[0].status = 'broken';
        expect(validateCastPreflight(user, null).reason).toBe('rod_broken');
    });

    test('cooldown-shaped failures carry when the next attempt is allowed', () => {
        const last = new Date();
        const res = validateCastPreflight(makeUser({ lastCast: last }), null);
        expect(res.nextAt.getTime()).toBe(last.getTime() + LIMITS.CAST_COOLDOWN_MS);
    });

    test('no_stamina reports the pity counters for the renderer', () => {
        const res = validateCastPreflight(makeUser({ stamina: 0, consecutiveFails: 7, sinceRare: 9 }), null);
        expect(res.reason).toBe('no_stamina');
        expect(res.consecutiveFails).toBe(7);
        expect(res.sinceRare).toBe(9);
        expect(res.pityBonus).toBeGreaterThan(0);
        expect(res.maxStamina).toBeGreaterThan(0);
    });
});

describe('snapshot / revert on an escaped required reel-in', () => {
    test('restores every reward field and counts the miss toward pity', () => {
        const user = makeUser();
        const snapshot = snapshotCastRewards(user);

        // Simulate what a successful executeCast would have mutated.
        user.balance += 500;
        user.fishing.totalEarned += 500;
        user.fishing.dailyCoins += 500;
        user.fishing.successfulCasts += 1;
        user.fishing.xp += 40;
        user.fishing.consecutiveFails = 0;
        user.fishing.materials.fish_scale = 2;

        const result = { success: true, finalPayout: 500, rawPayout: 500, xpEarned: 40, tier: 'legendary' };
        revertEscapedCast(user, snapshot, result);

        expect(user.balance).toBe(snapshot.balance);
        expect(user.fishing.totalEarned).toBe(snapshot.totalEarned);
        expect(user.fishing.dailyCoins).toBe(snapshot.dailyCoins);
        expect(user.fishing.successfulCasts).toBe(snapshot.successfulCasts);
        expect(user.fishing.xp).toBe(snapshot.xp);
        expect(user.fishing.materials).toEqual(snapshot.materials);
        // The escape is a miss: pity progress must not be handed back.
        expect(user.fishing.consecutiveFails).toBe(snapshot.consecutiveFails + 1);
        expect(result.success).toBe(false);
        expect(result.finalPayout).toBe(0);
        expect(result.escaped).toBe(true);
    });
});

describe('downgradeOptionalMiss', () => {
    test('takes ~65% of the payout back and re-tiers to uncommon', () => {
        const user = makeUser();
        user.balance += 1000;
        user.fishing.totalEarned += 1000;
        user.fishing.dailyCoins += 1000;
        const result = { success: true, finalPayout: 1000, rawPayout: 1000, tier: 'rare' };

        downgradeOptionalMiss(user, result);

        expect(result.finalPayout).toBe(350);
        expect(result.tier).toBe('uncommon');
        expect(user.balance).toBe(makeUser().balance + 350);
    });

    test('the best payout falls back to what was actually paid, not the full roll', () => {
        const user = makeUser({ bestPayout: 200 });
        const snapshot = snapshotCastRewards(user);
        // executeCast recorded the full roll as the new best.
        user.fishing.bestPayout = 1000;
        const result = { success: true, finalPayout: 1000, rawPayout: 1000, tier: 'rare' };

        downgradeOptionalMiss(user, result, snapshot);
        expect(user.fishing.bestPayout).toBe(350);

        // …and when the old best beats the downgraded payout, the old best stands.
        const user2 = makeUser({ bestPayout: 600 });
        const snapshot2 = snapshotCastRewards(user2);
        user2.fishing.bestPayout = 1000;
        downgradeOptionalMiss(user2, { success: true, finalPayout: 1000, rawPayout: 1000, tier: 'rare' }, snapshot2);
        expect(user2.fishing.bestPayout).toBe(600);
    });

    test('a heaviest-ever entry set by the catch records the downgraded payout', () => {
        const user = makeUser({ personalBest: { fish: 'Pike', weight: 12, payout: 1000 } });
        const result = { success: true, finalPayout: 1000, rawPayout: 1000, tier: 'rare', weightLbs: 12, fish: { name: 'Pike' } };
        downgradeOptionalMiss(user, result);
        expect(user.fishing.personalBest.payout).toBe(350);
    });

    test('the rare that got away is swapped for a real Uncommon, recorded in its place', () => {
        const user = makeUser();
        const snapshot = snapshotCastRewards(user);
        const rare = FISH.salmon;
        // What executeCast recorded for the rare catch.
        user.fishing.catalog = { [rare.id]: { count: 1, heaviest: 20, scale: FISH_WEIGHT_SCALE } };
        user.fishing.materials = { [rare.specialDrop?.itemId ?? 'x']: 1 };
        const result = {
            success: true, catchType: 'fish', fish: rare, tier: 'rare', finalPayout: 1000, rawPayout: 1000,
            sizeTierId: 'large', sizeLabel: 'Large', weightLbs: 20, specialDrop: rare.specialDrop ?? null,
        };

        downgradeOptionalMiss(user, result, snapshot, { locationId: 'pond', username: 'bob' });

        expect(result.tier).toBe('uncommon');
        expect(result.fish.tier).toBe('uncommon');
        expect(result.escapedFish).toBe(rare);
        expect(result.specialDrop).toBeNull();
        expect(user.fishing.materials).toEqual({});
        // The rare never joins the catalog; the Uncommon does.
        expect(user.fishing.catalog[rare.id]).toBeUndefined();
        expect(user.fishing.catalog[result.fish.id].count).toBe(1);
        expect(result.firstCatch).toBe(true);
        if (result.fish.sizeVariance) {
            expect(result.sizeLabel).toBe('Large');
            expect(result.weightLbs).toBeGreaterThan(0);
        }
    });

    test('a catch downgraded to Uncommon no longer starts a boss fight', () => {
        const user = makeUser();
        const result = { success: true, finalPayout: 1000, rawPayout: 1000, tier: 'rare', bossEncounter: { fish: {}, tier: 'rare' } };
        downgradeOptionalMiss(user, result, snapshotCastRewards(user));
        expect(result.bossEncounter).toBeNull();
    });
});

describe('applyCastBonuses', () => {
    test('rare+ success resets the sinceRare counter; a miss increments it', () => {
        const user = makeUser({ sinceRare: 6 });
        applyCastBonuses(user, { success: true, tier: 'epic', finalPayout: 100 }, {});
        expect(user.fishing.sinceRare).toBe(0);

        const user2 = makeUser({ sinceRare: 6 });
        applyCastBonuses(user2, { success: false, tier: null, finalPayout: 0 }, {});
        expect(user2.fishing.sinceRare).toBe(7);
    });

    test('stacks pet, featured and wilderness bonuses in order and tracks bestPayout', () => {
        const user = makeUser();
        const result = { success: true, tier: 'common', finalPayout: 1000 };
        applyCastBonuses(user, result, {
            petFishYieldPct: 10,             // +100 → 1100
            isFeaturedSpot: true,
            featuredPayoutBonus: 0.25,       // +275 → 1375
            wildernessActive: true,          // +138 → 1513
        });
        expect(result.petYieldBonus).toBe(100);
        expect(result.featuredSpotBonus).toBe(275);
        expect(result.wildernessBonus).toBe(138);
        expect(result.finalPayout).toBe(1513);
        expect(user.fishing.bestPayout).toBe(1513);
        expect(user.balance).toBe(1000 + 513);
    });

    test('wilderness bonus is clamped to the daily hard cap', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP - 5 });
        const result = { success: true, tier: 'common', finalPayout: 1000 };
        applyCastBonuses(user, result, { wildernessActive: true });
        expect(result.wildernessBonus).toBe(5);
    });

    test('pet and featured-spot bonuses are clamped to the daily hard cap too', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP - 30 });
        const result = { success: true, tier: 'common', finalPayout: 1000 };
        applyCastBonuses(user, result, {
            petFishYieldPct: 10,          // wants +100, 30 of headroom
            isFeaturedSpot: true,
            featuredPayoutBonus: 0.25,    // no headroom left
            wildernessActive: true,
        });
        expect(result.petYieldBonus).toBe(30);
        expect(result.featuredSpotBonus).toBeUndefined();
        expect(result.wildernessBonus).toBeUndefined();
        expect(user.fishing.dailyCoins).toBe(LIMITS.DAILY_HARD_CAP);
        expect(user.balance).toBe(1000 + 30);
    });

    test('a player already at the hard cap earns no bonus at all', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP });
        const result = { success: true, tier: 'common', finalPayout: 500 };
        applyCastBonuses(user, result, { petFishYieldPct: 50, isFeaturedSpot: true, featuredPayoutBonus: 0.25, wildernessActive: true });
        expect(result.finalPayout).toBe(500);
        expect(user.balance).toBe(1000);
    });

    test('failed casts earn no bonuses', () => {
        const user = makeUser();
        const result = { success: false, tier: null, finalPayout: 0 };
        applyCastBonuses(user, result, { petFishYieldPct: 50, isFeaturedSpot: true, featuredPayoutBonus: 0.25, wildernessActive: true });
        expect(result.petYieldBonus).toBeUndefined();
        expect(result.featuredSpotBonus).toBeUndefined();
        expect(result.wildernessBonus).toBeUndefined();
        expect(user.balance).toBe(1000);
    });
});

describe('rollWinterHuntMaterial', () => {
    test('grants nothing outside the winter_hunt event or away from the lake', () => {
        const user = makeUser();
        expect(rollWinterHuntMaterial(user, { success: true }, null, 'lake')).toBeNull();
        expect(rollWinterHuntMaterial(user, { success: true }, 'winter_hunt', 'pond')).toBeNull();
        expect(rollWinterHuntMaterial(user, { success: false }, 'winter_hunt', 'lake')).toBeNull();
    });

    test('a winning roll credits one arctic hunt material', () => {
        const user = makeUser();
        const spy = jest.spyOn(Math, 'random').mockReturnValue(0.1);
        try {
            const mat = rollWinterHuntMaterial(user, { success: true }, 'winter_hunt', 'lake');
            expect(mat).toBeTruthy();
            expect(user.hunt.materials[mat]).toBe(1);
        } finally {
            spy.mockRestore();
        }
    });
});
