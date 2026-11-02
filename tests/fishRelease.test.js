'use strict';

// Keep / release in the service (fishService): what a cast leaves on offer,
// what spending it does, and the river karma a release earns.

// The rarity test below measures a probability shift. It used to sample it —
// 4,000 real crypto rolls per arm against a fixed 3-point margin — and sampling
// noise sometimes put the two arms exactly on the margin, failing CI on PRs
// that never touched fishing. fishService draws from `crypto.randomInt`
// directly (not the secureRandom test seam), so the seam here is crypto: while
// `mockGridDraw` is set, `randomInt(max)` answers from it, and otherwise every
// call goes to the real thing. Named `mock…` because jest.mock's factory may
// only close over variables with that prefix.
let mockGridDraw = null;
jest.mock('crypto', () => {
    const actual = jest.requireActual('crypto');
    return {
        ...actual,
        randomInt: (...args) => (mockGridDraw && args.length === 1 ? mockGridDraw(args[0]) : actual.randomInt(...args)),
    };
});

const {
    recordPendingRelease, releasePlan, applyRelease, declineRelease, rollTier, executeCast, ensureFishingData,
    RELEASE_KARMA_MAX,
} = require('../src/services/fishService');
const { FISH, LOCATIONS, ROD_TIERS } = require('../src/data/fishData');

const makeUser = () => ({
    userId: 'u1', guildId: 'g1', balance: 0,
    fishing: { level: 1, xp: 0, prestige: 0, totalEarned: 1000, dailyCoins: 500, releaseKarma: 0, fishReleased: 0 },
    markModified() {},
});

const caught = { success: true, catchType: 'fish', fish: FISH.bass, finalPayout: 300, xpEarned: 40 };

test('a landed, paying fish is left on offer, keyed by its cast', () => {
    const user = makeUser();
    expect(recordPendingRelease(user, 'c1', caught)).toMatchObject({ castId: 'c1', fishId: 'bass', payout: 300, xp: 40 });
    expect(releasePlan(user, 'c1')).not.toBeNull();
    expect(releasePlan(user, 'c2')).toBeNull();
});

test('junk, a miss or a capped (zero) payout leaves nothing — and clears an older offer', () => {
    const user = makeUser();
    recordPendingRelease(user, 'c1', caught);
    for (const r of [{ success: true, catchType: 'junk', finalPayout: 5 }, { success: false }, { ...caught, finalPayout: 0 }]) {
        expect(recordPendingRelease(user, 'c2', r)).toBeNull();
    }
    expect(releasePlan(user, 'c1')).toBeNull();
});

test('releasing unwinds the earnings, pays the XP again, and banks karma up to the cap', () => {
    const user = makeUser();
    recordPendingRelease(user, 'c1', caught);
    const out = applyRelease(user, releasePlan(user, 'c1'));
    expect(out).toMatchObject({ xp: 40, karma: 1 });
    expect(user.fishing).toMatchObject({ totalEarned: 700, dailyCoins: 200, fishReleased: 1, xp: 40, pendingRelease: null });

    user.fishing.releaseKarma = RELEASE_KARMA_MAX;
    recordPendingRelease(user, 'c2', caught);
    applyRelease(user, releasePlan(user, 'c2'));
    expect(user.fishing.releaseKarma).toBe(RELEASE_KARMA_MAX);
});

test('keeping closes the offer, once', () => {
    const user = makeUser();
    recordPendingRelease(user, 'c1', caught);
    expect(declineRelease(user, 'c1')).toBe(true);
    expect(declineRelease(user, 'c1')).toBe(false);
    expect(releasePlan(user, 'c1')).toBeNull();
});

describe('river karma', () => {
    const rod = { tier: ROD_TIERS[0].tier, currentDurability: 50, maxDurability: 50, status: 'good' };
    // The share of rolls landing rare or better, measured over n evenly spaced
    // draws across [0, 1) instead of n random ones. That walks the tier weights
    // exactly, so the rate is the true probability to within 1/n, and both arms
    // see the same draws: the difference between them is karma and nothing else.
    const rareRate = (karma, n = 4000) => {
        const user = { fishing: { prestige: 0, releaseKarma: karma, activeBait: null } };
        let rarePlus = 0;
        try {
            for (let i = 0; i < n; i++) {
                mockGridDraw = max => Math.floor(((i + 0.5) / n) * max);
                if (!['common', 'uncommon'].includes(rollTier(user, LOCATIONS.pond, rod))) rarePlus += 1;
            }
        } finally {
            mockGridDraw = null;
        }
        return rarePlus / n;
    };

    test('a charge shifts the next fish up the rarity ladder', () => {
        expect(rareRate(1)).toBeGreaterThan(rareRate(0) + 0.03);
    });

    test('a fish catch spends one charge; a miss spends none', () => {
        const base = () => {
            const u = {
                userId: 'u1', guildId: 'g1', balance: 0, streak: { current: 0 },
                fishing: {
                    level: 1, xp: 0, prestige: 0, stamina: 10, dailyCoins: 0, dailyCasts: 0, releaseKarma: 2,
                    rods: [{ ...rod, name: 'Rod', baseDurability: 50 }], equippedRodIndex: 0,
                    unlockedLocations: ['pond'], activeLocation: 'pond', bait: {}, materials: {}, catalog: {},
                },
                hunt: { materials: {} },
                markModified() {},
            };
            ensureFishingData(u);
            return u;
        };
        let spentOnFish = false, keptOnMiss = false;
        for (let i = 0; i < 400 && !(spentOnFish && keptOnMiss); i++) {
            const u = base();
            const r = executeCast(u, 'pond');
            if (r.success && r.catchType === 'fish') {
                expect(u.fishing.releaseKarma).toBe(1);
                expect(r.karmaUsed).toBe(true);
                spentOnFish = true;
            } else if (!r.success && !r.traitEscape) {
                expect(u.fishing.releaseKarma).toBe(2);
                keptOnMiss = true;
            }
        }
        expect(spentOnFish && keptOnMiss).toBe(true);
    });
});
