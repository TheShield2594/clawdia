'use strict';

// Two fixes to /mine dig's transaction layer:
//
// - The dig lock. The cooldown (30s) is shorter than the dig's own prompts
//   (over 50s with a cave-in), so the claim now also holds a lock that only the
//   commit or the release clears — a second dig cannot start on the same
//   snapshot while the first is still waiting on a button.
// - A haul abandoned in a cave-in. Fleeing used to take the coins back and
//   nothing else: the material drop, the success tally, the fail streak and
//   every find-rewarding quest still booked the ore as kept.

jest.mock('../src/models/GrindProfile', () => ({
    findOneAndUpdate: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
}));
jest.mock('../src/utils/grindProfile', () => ({
    persistGrindIfNew: jest.fn(async () => {}),
    attachGrind: jest.fn(async () => {}),
}));
jest.mock('../src/utils/balanceDelta', () => ({
    detachBalanceDelta: jest.fn(() => 0),
    commitBalanceDelta: jest.fn(async () => ({ credited: true })),
}));

const GrindProfile = require('../src/models/GrindProfile');
const {
    validateDigPreflight,
    claimDigCooldown,
    commitDig,
    abandonCaveIn,
    blastClearCaveIn,
    keptFind,
    applyDigBonuses,
    updateMineQuestProgress,
} = require('../src/services/mineService');
const { buildMineEmbed } = require('../src/commands/economy/mine/embeds');
const { DEPTHS, LIMITS, PICKAXE_TIERS, MINE_QUEST_TEMPLATES, ORES } = require('../src/data/mineData');

function makeUser(miningOverrides = {}) {
    const pick = PICKAXE_TIERS[0];
    return {
        userId: 'u1',
        guildId: 'g1',
        balance: 1000,
        quests: [],
        mining: {
            level: 1,
            prestige: 0,
            xp: 0,
            stamina: 5,
            dailyCoins: 0,
            dailyMines: 0,
            totalEarned: 0,
            successfulMines: 0,
            consecutiveFails: 0,
            legendaryFinds: 0,
            eventFinds: 0,
            sinceRare: 0,
            bestPayout: 0,
            activeDepth: 'surface_quarry',
            unlockedDepths: ['surface_quarry'],
            equippedPickaxeIndex: 0,
            injuryUntil: null,
            lastMine: null,
            digLockUntil: null,
            materials: {},
            pickaxes: [{
                name: pick.name, tier: pick.tier, status: 'good',
                currentDurability: pick.baseDurability, maxDurability: pick.baseDurability,
            }],
            charges: {},
            ...miningOverrides,
        },
        markModified: () => {},
        save: jest.fn(async () => {}),
    };
}

beforeEach(() => jest.clearAllMocks());

// ─── Dig lock ────────────────────────────────────────────────────────────────

describe('dig lock', () => {
    test('preflight turns away a dig while another one holds the lock', () => {
        const user = makeUser({ digLockUntil: new Date(Date.now() + 60_000) });
        expect(validateDigPreflight(user, null).reason).toBe('dig_in_progress');
    });

    test('an expired lock (a dig whose process died) does not block', () => {
        const user = makeUser({ digLockUntil: new Date(Date.now() - 1) });
        expect(validateDigPreflight(user, null).ok).toBe(true);
    });

    test('the claim requires the lock to be free and takes it for DIG_LOCK_MS', async () => {
        GrindProfile.findOneAndUpdate.mockResolvedValue({ data: {} });
        const user = makeUser();
        const claim = await claimDigCooldown(user);

        expect(claim.claimed).toBe(true);
        const [filter, update] = GrindProfile.findOneAndUpdate.mock.calls[0];
        expect(JSON.stringify(filter)).toContain('data.digLockUntil');
        const lockUntil = update.$set['data.digLockUntil'];
        expect(lockUntil.getTime() - update.$set['data.lastMine'].getTime()).toBe(LIMITS.DIG_LOCK_MS);
        // The in-memory profile carries the lock so a save mid-flow keeps it.
        expect(user.mining.digLockUntil).toBe(lockUntil);
    });

    test('the lock outlasts the cooldown, or it would not cover the prompts', () => {
        expect(LIMITS.DIG_LOCK_MS).toBeGreaterThan(LIMITS.MINE_COOLDOWN_MS);
    });

    test('a claim lost to a held lock reports the dig in progress, not a cooldown', async () => {
        GrindProfile.findOneAndUpdate.mockResolvedValue(null);
        GrindProfile.findOne.mockResolvedValue({
            data: { lastMine: new Date(Date.now() - 40_000), digLockUntil: new Date(Date.now() + 60_000) },
        });
        const claim = await claimDigCooldown(makeUser());
        expect(claim).toEqual({ claimed: false, inProgress: true });
    });

    test('a claim lost to the cooldown alone still reports when to come back', async () => {
        const last = new Date(Date.now() - 5_000);
        GrindProfile.findOneAndUpdate.mockResolvedValue(null);
        GrindProfile.findOne.mockResolvedValue({ data: { lastMine: last, digLockUntil: null } });
        const claim = await claimDigCooldown(makeUser());
        expect(claim.claimed).toBe(false);
        expect(claim.nextAt.getTime()).toBe(last.getTime() + LIMITS.MINE_COOLDOWN_MS);
    });

    test('releasing the claim frees the lock too', async () => {
        GrindProfile.findOneAndUpdate.mockResolvedValue({ data: {} });
        GrindProfile.updateOne.mockResolvedValue({});
        const claim = await claimDigCooldown(makeUser());
        await claim.release();
        const [, update] = GrindProfile.updateOne.mock.calls[0];
        expect(update.$set['data.digLockUntil']).toBeNull();
    });

    test('committing the dig clears the lock in the profile it saves', async () => {
        const user = makeUser({ digLockUntil: new Date(Date.now() + 60_000) });
        await commitDig(user, 1000, { payoutKey: 'k' });
        expect(user.mining.digLockUntil).toBeNull();
        expect(user.save).toHaveBeenCalled();
    });
});

// ─── Cave-in resolution ──────────────────────────────────────────────────────

/** What executeMine leaves behind for a legendary strike that caved in. */
function caveInResult(over = {}) {
    return {
        success: true,
        caveIn: true,
        ore: ORES.stone,
        tier: 'legendary',
        isCrit: true,
        finalPayout: 500,
        caveInPayout: 500,
        caveInEscrow: 500,
        specialDrop: { itemId: 'ore_chunk', name: 'Ore Chunk' },
        priorConsecutiveFails: 3,
        ...over,
    };
}

/** A user as executeMine left them after crediting that strike. */
function afterStrike() {
    return makeUser({
        dailyCoins: 500, totalEarned: 500, successfulMines: 8, consecutiveFails: 0,
        legendaryFinds: 1, materials: { ore_chunk: 2 },
    });
}

describe('abandonCaveIn', () => {
    test('undoes everything executeMine booked for the buried haul', () => {
        const user = afterStrike();
        user.balance = 1500;
        const result = caveInResult();
        abandonCaveIn(user, result);

        expect(user.balance).toBe(1000);
        expect(user.mining.dailyCoins).toBe(0);
        expect(user.mining.totalEarned).toBe(0);
        expect(user.mining.legendaryFinds).toBe(0);
        expect(user.mining.materials.ore_chunk).toBe(1);
        expect(user.mining.successfulMines).toBe(7);
        // Fleeing is neither a success nor a failed swing: the streak goes back.
        expect(user.mining.consecutiveFails).toBe(3);

        expect(result.finalPayout).toBe(0);
        expect(result.specialDrop).toBeNull();
        expect(result.caveInAbandoned).toBe(true);
        expect(result.caveInLostPayout).toBe(1000);
        expect(keptFind(result)).toBe(false);
    });

    test('hands back a spent gathering-yield charge', () => {
        const refundEffectCharge = jest.fn();
        const result = caveInResult({ gatheringYield: { effect: 'double_yield' } });
        abandonCaveIn(afterStrike(), result, { refundEffectCharge });
        expect(refundEffectCharge).toHaveBeenCalledWith(expect.anything(), 'double_yield');
        expect(result.gatheringYield).toBeNull();
    });
});

describe('blastClearCaveIn', () => {
    test('spends a charge and releases the escrow', () => {
        const user = afterStrike();
        user.mining.charges.iron_blast = 4;
        const result = caveInResult();
        blastClearCaveIn(user, result, 'iron_blast');

        expect(user.mining.charges.iron_blast).toBe(3);
        expect(result.finalPayout).toBe(1000);
        expect(result.caveInBonusPaid).toBe(500);
        expect(result.caveInEscaped).toBe(true);
        expect(keptFind(result)).toBe(true);
    });

    test('clamps the escrow to the daily hard cap', () => {
        const user = afterStrike();
        user.mining.dailyCoins = LIMITS.DAILY_HARD_CAP - 100;
        const result = caveInResult();
        blastClearCaveIn(user, result, null);
        expect(result.caveInBonusPaid).toBe(100);
        expect(user.mining.dailyCoins).toBe(LIMITS.DAILY_HARD_CAP);
    });
});

describe('an abandoned haul counts toward no find quest', () => {
    const typed = type => MINE_QUEST_TEMPLATES.find(t => t.type === type);

    test.each([
        'legendary_plus_finds', 'rare_plus_finds', 'crits', 'material_drops',
    ].filter(typed))('%s', type => {
        const user = makeUser();
        user.quests = [{ questId: typed(type).id, progress: 0, completedAt: null, expiresAt: new Date(Date.now() + 60_000) }];
        const result = caveInResult({ caveInAbandoned: true, specialDrop: { itemId: 'x' } });
        updateMineQuestProgress(user, result, 'surface_quarry');
        expect(user.quests[0].progress).toBe(0);

        updateMineQuestProgress(user, { ...result, caveInAbandoned: false }, 'surface_quarry');
        expect(user.quests[0].progress).toBe(1);
    });

    test('and breaks a success streak', () => {
        const t = typed('success_streak');
        if (!t) return;
        const user = makeUser();
        user.quests = [{ questId: t.id, progress: 2, completedAt: null, expiresAt: new Date(Date.now() + 60_000) }];
        updateMineQuestProgress(user, caveInResult({ caveInAbandoned: true }), 'surface_quarry');
        expect(user.quests[0].progress).toBe(0);
    });
});

// ─── Hard cap on the yield bonuses ───────────────────────────────────────────

describe('applyDigBonuses respects the daily hard cap', () => {
    test('featured and pet bonuses stop at the cap like the Wilderness one does', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP - 100 });
        const result = { success: true, tier: 'common', finalPayout: 1000 };
        applyDigBonuses(user, result, {
            isFeaturedDepth: true, featuredPayoutBonus: 0.25, petMineYieldPct: 50, wildernessActive: true,
        });
        expect(result.featuredDepthBonus).toBe(100);
        expect(result.petYieldBonus).toBeUndefined();
        expect(result.wildernessBonus).toBeUndefined();
        expect(user.mining.dailyCoins).toBe(LIMITS.DAILY_HARD_CAP);
    });
});

// ─── Result embed ────────────────────────────────────────────────────────────

describe('the result embed for an abandoned haul', () => {
    const user = () => ({ balance: 1000, mining: { level: 1, xp: 0, stamina: 4, dailyCoins: 0, dailyMines: 0, consecutiveFails: 0 } });
    const pickaxe = { name: 'Wooden Pickaxe', status: 'good', currentDurability: 60, maxDurability: 80 };

    test('renders the loss, never a strike', () => {
        const result = caveInResult({
            caveInAbandoned: true, caveInLostPayout: 1000, finalPayout: 0, specialDrop: null,
            xpEarned: 10, critMultiplier: 2, levelUp: null,
        });
        const embed = buildMineEmbed(result, user(), DEPTHS.surface_quarry, pickaxe, '🪙', null);
        expect(embed.data.title).toContain('Fled the Cave-in');
        expect(embed.data.title).not.toContain('LEGENDARY STRIKE');
        expect(embed.data.description).toContain('buried');
        const reward = embed.data.fields.find(f => f.name === 'Reward').value;
        expect(reward).toContain('~~🪙1,000~~');
        expect(embed.data.fields.some(f => f.name === '🪨 Material Drop!')).toBe(false);
    });
});
