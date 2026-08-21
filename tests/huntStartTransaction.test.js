'use strict';

// The hunt transaction layer extracted from /hunt start (#613): preflight
// validation and the post-roll bonus stack, exercised against a plain user
// object with no mock interaction.

const {
    validateHuntPreflight,
    applyHuntBonuses,
    getRarePityThreshold,
} = require('../src/services/huntService');
const { ZONES, LIMITS, WEAPON_TIERS } = require('../src/data/huntData');

function makeUser(huntOverrides = {}) {
    const rifle = WEAPON_TIERS[0];
    return {
        userId: 'u1',
        guildId: 'g1',
        balance: 1000,
        hunt: {
            level: 1,
            prestige: 0,
            xp: 0,
            stamina: 5,
            dailyCoins: 0,
            totalEarned: 0,
            consecutiveFails: 0,
            sinceRare: 0,
            activeZone: 'beginner_forest',
            unlockedZones: ['beginner_forest'],
            equippedWeaponIndex: 0,
            injuryUntil: null,
            lastHunt: null,
            weapons: [{
                name: rifle.name,
                tier: rifle.tier,
                currentDurability: rifle.baseDurability,
                maxDurability: rifle.baseDurability,
                status: 'good',
            }],
            ammo: {},
            bestPayout: 0,
            ...huntOverrides,
        },
        markModified: () => {},
    };
}

describe('validateHuntPreflight', () => {
    test('passes a ready user and resolves the zone, weapon and weapon data', () => {
        const res = validateHuntPreflight(makeUser(), null);
        expect(res.ok).toBe(true);
        expect(res.zoneId).toBe('beginner_forest');
        expect(res.zone).toBe(ZONES.beginner_forest);
        expect(res.weapon).toBeDefined();
        expect(res.weaponData.tier).toBe(1);
    });

    test.each([
        ['unknown_zone',  {}, 'nowhere'],
        ['zone_locked',   { unlockedZones: [] }, 'beginner_forest'],
        ['injured',       { injuryUntil: new Date(Date.now() + 60_000) }, null],
        ['cooldown',      { lastHunt: new Date() }, null],
        ['no_stamina',    { stamina: 0 }, null],
        ['no_weapon',     { equippedWeaponIndex: -1 }, null],
    ])('rejects with %s', (reason, overrides, requested) => {
        const res = validateHuntPreflight(makeUser(overrides), requested);
        expect(res.ok).toBe(false);
        expect(res.reason).toBe(reason);
    });

    test('rejects a broken weapon and reports whether it is condemned', () => {
        const user = makeUser();
        user.hunt.weapons[0].status = 'broken';
        const res = validateHuntPreflight(user, null);
        expect(res.reason).toBe('weapon_broken');
        expect(typeof res.condemned).toBe('boolean');
    });

    test('cooldown failures carry when the next attempt is allowed', () => {
        const last = new Date();
        const res = validateHuntPreflight(makeUser({ lastHunt: last }), null);
        expect(res.nextAt.getTime()).toBe(last.getTime() + LIMITS.HUNT_COOLDOWN_MS);
    });

    test('no_stamina reports the pity cap for the renderer', () => {
        const res = validateHuntPreflight(makeUser({ stamina: 0, sinceRare: 8 }), null);
        expect(res.reason).toBe('no_stamina');
        expect(res.sinceRare).toBe(8);
        expect(res.pityCap).toBe(getRarePityThreshold(ZONES.beginner_forest));
        expect(res.maxStamina).toBeGreaterThan(0);
    });
});

describe('applyHuntBonuses', () => {
    test('rare+ success resets sinceRare; a miss increments it', () => {
        const user = makeUser({ sinceRare: 4 });
        applyHuntBonuses(user, { success: true, tier: 'legendary', finalPayout: 100, xpEarned: 0 }, 'beginner_forest', {});
        expect(user.hunt.sinceRare).toBe(0);

        const user2 = makeUser({ sinceRare: 4 });
        applyHuntBonuses(user2, { success: false, tier: null, finalPayout: 0, xpEarned: 0 }, 'beginner_forest', {});
        expect(user2.hunt.sinceRare).toBe(5);
    });

    test('stacks pet, featured and wilderness coin bonuses and records best payout', () => {
        const user = makeUser();
        const result = { success: true, tier: 'common', finalPayout: 1000, xpEarned: 0, animal: { name: 'Rabbit' } };
        applyHuntBonuses(user, result, 'beginner_forest', {
            petYieldPct: 10,               // +100 → 1100
            isFeaturedZone: true,
            featuredPayoutBonus: 0.25,     // +275 → 1375
            wildernessActive: true,        // +138 → 1513
        });
        expect(result.petYieldBonus).toBe(100);
        expect(result.featuredZoneBonus).toBe(275);
        expect(result.wildernessBonus).toBe(138);
        expect(result.finalPayout).toBe(1513);
        expect(user.balance).toBe(1000 + 513);
        expect(user.hunt.bestPayout).toBe(1513);
    });

    test('every coin bonus is clamped to the daily hard cap', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP - 5 });
        const result = { success: true, tier: 'common', finalPayout: 1000, xpEarned: 0 };
        applyHuntBonuses(user, result, 'beginner_forest', {
            petYieldPct: 50, isFeaturedZone: true, featuredPayoutBonus: 0.25, wildernessActive: true,
        });
        const totalBonus = (result.petYieldBonus ?? 0) + (result.featuredZoneBonus ?? 0) + (result.wildernessBonus ?? 0);
        expect(totalBonus).toBeLessThanOrEqual(5);
    });

    test('pet XP bonus folds its level-up into the result', () => {
        const user = makeUser();
        // Enough base XP that a 50% bonus crosses a level boundary.
        const result = { success: true, tier: 'common', finalPayout: 0, xpEarned: 200, levelUp: null };
        applyHuntBonuses(user, result, 'beginner_forest', { petXpPct: 50 });
        expect(result.petXpBonus).toBe(100);
        expect(result.xpEarned).toBe(300);
    });

    test('failed hunts earn no bonuses', () => {
        const user = makeUser();
        const result = { success: false, tier: null, finalPayout: 0, xpEarned: 0 };
        applyHuntBonuses(user, result, 'beginner_forest', {
            petYieldPct: 50, petXpPct: 50, isFeaturedZone: true, featuredPayoutBonus: 0.25, wildernessActive: true,
        });
        expect(result.petYieldBonus).toBeUndefined();
        expect(result.featuredZoneBonus).toBeUndefined();
        expect(result.wildernessBonus).toBeUndefined();
        expect(user.balance).toBe(1000);
    });
});
