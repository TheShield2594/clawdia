'use strict';

// The dig transaction layer extracted from /mine dig (#613): preflight
// validation and the post-roll bonus stack, exercised against a plain user
// object with no mock interaction.

const {
    validateDigPreflight,
    applyDigBonuses,
} = require('../src/services/mineService');
const { DEPTHS, LIMITS, PICKAXE_TIERS } = require('../src/data/mineData');

const START_DEPTH = Object.values(DEPTHS).find(d => d.defaultUnlocked) ?? Object.values(DEPTHS)[0];

function makeUser(miningOverrides = {}) {
    const pick = PICKAXE_TIERS[0];
    return {
        userId: 'u1',
        guildId: 'g1',
        balance: 1000,
        mining: {
            level: 1,
            prestige: 0,
            xp: 0,
            stamina: 5,
            dailyCoins: 0,
            totalEarned: 0,
            consecutiveFails: 0,
            sinceRare: 0,
            bestPayout: 0,
            activeDepth: START_DEPTH.id,
            unlockedDepths: [START_DEPTH.id],
            equippedPickaxeIndex: 0,
            injuryUntil: null,
            lastMine: null,
            pickaxes: [{
                name: pick.name,
                tier: pick.tier,
                currentDurability: pick.baseDurability,
                maxDurability: pick.baseDurability,
                status: 'good',
            }],
            charges: {},
            ...miningOverrides,
        },
        markModified: () => {},
    };
}

describe('validateDigPreflight', () => {
    test('passes a ready user and resolves the depth, pickaxe and pickaxe data', () => {
        const res = validateDigPreflight(makeUser(), null);
        expect(res.ok).toBe(true);
        expect(res.depthId).toBe(START_DEPTH.id);
        expect(res.depth).toBe(DEPTHS[START_DEPTH.id]);
        expect(res.pickaxe).toBeDefined();
        expect(res.pickaxeData.tier).toBe(PICKAXE_TIERS[0].tier);
    });

    test.each([
        ['unknown_depth',  {}, 'nowhere'],
        ['depth_locked',   { unlockedDepths: [] }, START_DEPTH.id],
        ['injured',        { injuryUntil: new Date(Date.now() + 60_000) }, null],
        ['cooldown',       { lastMine: new Date() }, null],
        ['no_stamina',     { stamina: 0 }, null],
        ['no_pickaxe',     { equippedPickaxeIndex: -1 }, null],
    ])('rejects with %s', (reason, overrides, requested) => {
        const res = validateDigPreflight(makeUser(overrides), requested);
        expect(res.ok).toBe(false);
        expect(res.reason).toBe(reason);
    });

    test('rejects a broken pickaxe', () => {
        const user = makeUser();
        user.mining.pickaxes[0].status = 'broken';
        expect(validateDigPreflight(user, null).reason).toBe('pickaxe_broken');
    });

    test('cooldown failures carry when the next attempt is allowed', () => {
        const last = new Date();
        const res = validateDigPreflight(makeUser({ lastMine: last }), null);
        expect(res.nextAt.getTime()).toBe(last.getTime() + LIMITS.MINE_COOLDOWN_MS);
    });
});

describe('applyDigBonuses', () => {
    test('a rare find abandoned in a cave-in does not reset pity', () => {
        const user = makeUser({ sinceRare: 6 });
        applyDigBonuses(user, { success: true, tier: 'legendary', finalPayout: 0, caveInAbandoned: true }, {});
        expect(user.mining.sinceRare).toBe(7);

        const user2 = makeUser({ sinceRare: 6 });
        applyDigBonuses(user2, { success: true, tier: 'legendary', finalPayout: 100, caveInAbandoned: false }, {});
        expect(user2.mining.sinceRare).toBe(0);
    });

    test('stacks featured, pet and wilderness bonuses and tracks bestPayout', () => {
        const user = makeUser();
        const result = { success: true, tier: 'common', finalPayout: 1000 };
        applyDigBonuses(user, result, {
            isFeaturedDepth: true,
            featuredPayoutBonus: 0.25,   // +250 → 1250
            petMineYieldPct: 10,         // +125 → 1375
            wildernessActive: true,      // +138 → 1513
        });
        expect(result.featuredDepthBonus).toBe(250);
        expect(result.petYieldBonus).toBe(125);
        expect(result.wildernessBonus).toBe(138);
        expect(result.finalPayout).toBe(1513);
        expect(user.mining.bestPayout).toBe(1513);
        expect(user.balance).toBe(1000 + 513);
    });

    test('a hard-capped dig scales the forfeited figure by everything that would have applied', () => {
        const user = makeUser();
        const result = { success: true, tier: 'common', finalPayout: 0, cappedByHard: true, forfeited: 100 };
        applyDigBonuses(user, result, {
            isFeaturedDepth: true,
            featuredPayoutBonus: 0.25,
            petMineYieldPct: 10,
            wildernessActive: true,
            intensityMultiplier: 2,
        });
        expect(result.forfeited).toBe(Math.round(100 * 2 * 1.25 * 1.1 * 1.1));
    });

    test('failed digs earn no bonuses', () => {
        const user = makeUser();
        const result = { success: false, tier: null, finalPayout: 0 };
        applyDigBonuses(user, result, {
            isFeaturedDepth: true, featuredPayoutBonus: 0.25, petMineYieldPct: 50, wildernessActive: true,
        });
        expect(result.featuredDepthBonus).toBeUndefined();
        expect(result.petYieldBonus).toBeUndefined();
        expect(result.wildernessBonus).toBeUndefined();
        expect(user.balance).toBe(1000);
    });
});
