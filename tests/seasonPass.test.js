'use strict';

const { TIER_COUNT, XP_PER_TIER, TIER_TABLE, loreForTier } = require('../src/data/seasonPass');
const { awardSeasonXp } = require('../src/services/questService');

describe('season pass tier table', () => {
    test('has 50 sequential tiers with both tracks labeled', () => {
        expect(TIER_TABLE.length).toBe(TIER_COUNT);
        expect(TIER_COUNT).toBe(50);
        TIER_TABLE.forEach((t, i) => {
            expect(t.tier).toBe(i + 1);
            expect(t.free.label).toBeTruthy();
            expect(t.premium.label).toBeTruthy();
        });
    });

    test('premium coin total stays close to the default unlock cost (net sink)', () => {
        const premiumCoins = TIER_TABLE.reduce((s, t) => s + t.premium.coins, 0);
        // Full completion should roughly break even on coins (items/badges are the
        // value-add); anything wildly above the 100k default cost would make the
        // "sink" a faucet.
        expect(premiumCoins).toBeLessThan(120_000);
        expect(premiumCoins).toBeGreaterThan(60_000);
    });

    test('free coin faucet is bounded', () => {
        const freeCoins = TIER_TABLE.reduce((s, t) => s + t.free.coins, 0);
        expect(freeCoins).toBeLessThan(80_000);
    });

    test('milestone tiers carry items', () => {
        expect(TIER_TABLE[9].free.itemId).toBe('lifesaver');    // tier 10
        expect(TIER_TABLE[49].free.itemId).toBe('lifesaver');   // tier 50
        expect(TIER_TABLE[0].premium.itemId).toBe('lucky_charm'); // tier 1 premium hook
    });

    test('lore exists for every tier', () => {
        for (let t = 1; t <= TIER_COUNT; t++) expect(loreForTier(t)).toBeTruthy();
    });
});

describe('awardSeasonXp weekly cap', () => {
    const guildSettings = (overrides = {}) => ({
        season: { enabled: true, seasonId: 's1', xpPerTier: 100, maxTiers: 50, weeklyXpCap: 1500, ...overrides },
    });

    const freshUser = () => ({ season: { seasonId: 's1', xp: 0, tier: 0, claimedTiers: [], weekXp: 0, weekStart: new Date() } });

    test('grants XP under the cap', async () => {
        const user = freshUser();
        await awardSeasonXp(user, 100, guildSettings());
        expect(user.season.xp).toBe(100);
        expect(user.season.weekXp).toBe(100);
    });

    test('clamps a grant that crosses the cap', async () => {
        const user = freshUser();
        user.season.weekXp = 1450;
        await awardSeasonXp(user, 100, guildSettings());
        expect(user.season.xp).toBe(50);       // only the remaining 50 granted
        expect(user.season.weekXp).toBe(1500);
    });

    test('grants nothing once the cap is reached', async () => {
        const user = freshUser();
        user.season.weekXp = 1500;
        await awardSeasonXp(user, 100, guildSettings());
        expect(user.season.xp).toBe(0);
    });

    test('rolls the window over after 7 days', async () => {
        const user = freshUser();
        user.season.weekXp = 1500;
        user.season.weekStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        await awardSeasonXp(user, 100, guildSettings());
        expect(user.season.xp).toBe(100);
        expect(user.season.weekXp).toBe(100);
    });

    test('no cap when weeklyXpCap is 0', async () => {
        const user = freshUser();
        await awardSeasonXp(user, 5000, guildSettings({ weeklyXpCap: 0 }));
        expect(user.season.xp).toBe(5000);
    });

    test('season rollover resets progress and premium', async () => {
        const user = { season: { seasonId: 'old', xp: 900, tier: 9, claimedTiers: [1], premium: true, claimedPremiumTiers: [1] } };
        await awardSeasonXp(user, 50, guildSettings());
        expect(user.season.seasonId).toBe('s1');
        expect(user.season.xp).toBe(50);
        expect(user.season.premium).toBe(false);
        expect(user.season.claimedPremiumTiers).toEqual([]);
    });

    test('tier derives from xp and respects maxTiers', async () => {
        const user = freshUser();
        await awardSeasonXp(user, 1500, guildSettings({ weeklyXpCap: 0 }));
        expect(user.season.tier).toBe(15);
    });
});
