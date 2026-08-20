'use strict';

const {
    ensureMineData,
    getMaxStamina,
    calculateCritChance,
    applyPayoutModifiers,
    rollTier,
    levelFromXp,
} = require('../src/services/mineService');
const {
    MINER_LEVELS, PRESTIGE_BONUSES, DEPTHS, LIMITS,
} = require('../src/data/mineData');

const MAX_MINER_LEVEL   = MINER_LEVELS.length;
const MAX_MINE_PRESTIGE = PRESTIGE_BONUSES.length - 1;

function miner({ level = 1, prestige = 0, xp = 0 } = {}) {
    const user = { mining: {}, markModified() {} };
    ensureMineData(user);
    Object.assign(user.mining, { level, prestige, xp });
    return user;
}

/** What /mine prestige does to the profile when a miner ascends. */
function ascend(user) {
    user.mining.prestige += 1;
    user.mining.level = 1;
    user.mining.xp = 0;
    return user;
}

describe('the prestige ladder is reachable', () => {
    test('Miner Level tops out where the level table ends', () => {
        expect(levelFromXp(MINER_LEVELS[MAX_MINER_LEVEL - 1].xpRequired)).toBe(MAX_MINER_LEVEL);
        expect(levelFromXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_MINER_LEVEL);
    });

    test('every rank in the bonus table can be climbed to', () => {
        const user = miner({ level: MAX_MINER_LEVEL });
        for (let rank = 1; rank <= MAX_MINE_PRESTIGE; rank++) {
            user.mining.level = MAX_MINER_LEVEL;
            ascend(user);
            expect(user.mining.prestige).toBe(rank);
            expect(user.mining.level).toBe(1);
            expect(user.mining.xp).toBe(0);
        }
        expect(user.mining.prestige).toBe(MAX_MINE_PRESTIGE);
    });
});

describe('prestige bonuses actually apply', () => {
    test('max stamina grows at the rank the table says it does', () => {
        for (let rank = 0; rank <= MAX_MINE_PRESTIGE; rank++) {
            const expected = LIMITS.MAX_STAMINA_BASE + PRESTIGE_BONUSES[rank].staminaBonus;
            expect(getMaxStamina(miner({ prestige: rank }))).toBe(expected);
        }
    });

    test('crit chance rises with rank', () => {
        const p0 = calculateCritChance(miner({ prestige: 0 }));
        const p1 = calculateCritChance(miner({ prestige: 1 }));
        expect(p1).toBeGreaterThan(p0);
        expect(p1 - p0).toBeCloseTo(PRESTIGE_BONUSES[1].critBonus, 5);
    });

    test('payouts rise at the rank that grants a payout bonus', () => {
        const depth = DEPTHS.surface_quarry;
        const plain  = applyPayoutModifiers(miner({ prestige: 2 }), 1000, depth).adjustedPayout;
        const bonused = applyPayoutModifiers(miner({ prestige: 3 }), 1000, depth).adjustedPayout;
        expect(bonused).toBe(Math.round(1000 * (1 + PRESTIGE_BONUSES[3].payoutBonus)));
        expect(bonused).toBeGreaterThan(plain);
    });

    test('the rarity bonus shifts weight off common', () => {
        // P4 adds a 2% rarity bonus, which moves 2% of the depth's *common* weight
        // into rare. On the Abyss that is a third of a percentage point — far too
        // small to separate by sampling — so probe the boundary instead. rollTier
        // consumes exactly one Math.random(), and weightedRoll walks the tiers in
        // ascending rarity, so the largest random value that still returns 'common'
        // is that tier's share of the roll.
        const commonShare = prestige => {
            const user = miner({ prestige });
            const spy = jest.spyOn(Math, 'random');
            let lo = 0;
            let hi = 1;
            for (let i = 0; i < 50; i++) {
                const mid = (lo + hi) / 2;
                spy.mockReturnValue(mid);
                if (rollTier(user, DEPTHS.surface_quarry) === 'common') lo = mid;
                else hi = mid;
            }
            spy.mockRestore();
            return lo;
        };

        expect(commonShare(4)).toBeLessThan(commonShare(3));
        expect(commonShare(3)).toEqual(commonShare(0));   // no rarity bonus below P4
    });

    test('rank is clamped so a rank past the table cannot crash the lookups', () => {
        const beyond = miner({ prestige: MAX_MINE_PRESTIGE + 10 });
        expect(getMaxStamina(beyond)).toBe(LIMITS.MAX_STAMINA_BASE + PRESTIGE_BONUSES[MAX_MINE_PRESTIGE].staminaBonus);
        expect(() => calculateCritChance(beyond)).not.toThrow();
        expect(() => rollTier(beyond, DEPTHS.the_abyss)).not.toThrow();
    });
});

describe('a prestiged miner keeps what they bought', () => {
    test('unlocked depths survive the level reset', () => {
        const user = miner({ level: MAX_MINER_LEVEL });
        user.mining.unlockedDepths = ['surface_quarry', 'coal_tunnels', 'iron_mines', 'crystal_caves', 'the_abyss'];
        user.mining.pickaxes = [{ tier: 5, name: 'Void Pickaxe' }];
        user.mining.materials = { mythril_dust: 7 };

        ascend(user);

        expect(user.mining.unlockedDepths).toContain('the_abyss');
        expect(user.mining.pickaxes).toHaveLength(1);
        expect(user.mining.materials.mythril_dust).toBe(7);
    });

    test('access is decided by the unlock list, not the reset level', () => {
        // The dig handler gates on unlockedDepths alone; the level requirement is
        // enforced once at purchase. Otherwise a P1 miner at Level 1 would be locked
        // out of an Abyss they had already paid 75,000 coins for.
        const user = ascend(miner({ level: MAX_MINER_LEVEL }));
        user.mining.unlockedDepths = ['surface_quarry', 'the_abyss'];

        expect(user.mining.level).toBeLessThan(DEPTHS.the_abyss.unlockLevel);
        expect(user.mining.unlockedDepths.includes('the_abyss')).toBe(true);
    });
});
