'use strict';

/**
 * #893 — the write the per-message pipeline used to make unconditionally.
 *
 * With leveling and quests on, every guild message cost a full `User` read and
 * a full `User` write. The write was forced by one field: `dailyMessages`, the
 * raider-track counter, which ticks on every message including the ones where
 * XP is on cooldown and nothing else about the user changed. So a chatty server
 * paid a document save per message per active member for a `+1`.
 *
 * The counter now goes out as the `$inc` it always was, and the save is skipped
 * — but only when the counter really is all that is pending. Everything else in
 * this chain (a streak rollover, quest progress, a milestone's coins, XP) still
 * takes the full save, and these tests are mostly about that boundary: skipping
 * a write on a wrong guess is how XP goes missing.
 */

jest.mock('../src/models/User',     () => ({ findOne: jest.fn(), create: jest.fn(), updateOne: jest.fn(async () => ({ modifiedCount: 1 })) }));
jest.mock('../src/models/Guild',    () => ({ create: jest.fn() }));
jest.mock('../src/models/Case',     () => ({ findOne: jest.fn().mockResolvedValue(null), countDocuments: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/models/Reminder', () => ({ create: jest.fn() }));

jest.mock('../src/services/aiService',            () => ({ handleAIChat: jest.fn() }));
jest.mock('../src/services/moderationLogService', () => ({ logModeration: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/rivalryService',       () => ({ checkRivalry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/chatEventService',     () => ({ maybeTriggerChatEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/wealthMilestone',         () => ({ checkAndBroadcastWealthMilestone: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/achievementService', () => ({
    checkAndAward: jest.fn().mockResolvedValue([]),
    announceAchievements: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/streakMultiplier', () => ({
    getStreakMultiplier: jest.fn(() => 1),
    checkNewMilestones: jest.fn(() => []),
}));
jest.mock('../src/services/effectsService', () => ({
    hasEffect: jest.fn(() => false),
    consumeEffect: jest.fn(),
    getXpMultiplier: jest.fn(() => 1),
    getServerXpMultiplier: jest.fn(() => 1),
}));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn().mockResolvedValue({ assignedNewDaily: false }),
    onMessage: jest.fn().mockResolvedValue({ completed: [], nearComplete: [] }),
    onStreakUpdate: jest.fn().mockResolvedValue({ completed: [], nearComplete: [] }),
    notifyQuestComplete: jest.fn().mockResolvedValue(undefined),
    notifyQuestNearComplete: jest.fn().mockResolvedValue(undefined),
    notifyDailyQuestReset: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/levelingService', () => ({
    applyXpGain: jest.fn((user, amount) => {
        user.xp = (user.xp || 0) + amount;
        return { leveled: false, newLevel: user.level, gained: amount };
    }),
    announceLevelUp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/utils/balanceDelta', () => ({
    saveWithBalanceDelta: jest.fn(async (Model, user) => {
        await user.save();
        return { credited: true, balance: user.balance ?? 0 };
    }),
}));

const User = require('../src/models/User');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { saveWithBalanceDelta } = require('../src/utils/balanceDelta');
const { checkNewMilestones } = require('../src/utils/streakMultiplier');
const { checkAndAward } = require('../src/services/achievementService');
const messageCreate = require('../src/events/messageCreate');
const { makeMessage, makeSettings } = require('./helpers/messageCreateMessage');

// ---------------------------------------------------------------------------
// A document that reports its modified paths, because that is what the write
// decision now reads. The set is cleared by `save()`, and by `unmarkModified`
// for the one path the `$inc` settles on its own.
// ---------------------------------------------------------------------------
function makeUserDoc(overrides = {}) {
    const now = new Date();
    const modified = new Set();
    const target = {
        _id: 'doc1',
        userId: 'author1',
        guildId: 'guild1',
        xp: 0,
        level: 0,
        messages: 0,
        balance: 0,
        dailyMessages: 4,
        // Same UTC day on both, so neither the streak nor the daily reset has
        // anything to do — the steady state this is all about.
        lastDailyReset: now,
        lastXpGain: null,
        streak: { current: 3, longest: 3, lastActive: now, claimedMilestones: [] },
        quests: [],
        pets: [],
        modifiedPaths() { return [...modified]; },
        isModified(path) { return path ? modified.has(path) : modified.size > 0; },
        unmarkModified(path) { modified.delete(path); },
        ...overrides,
    };
    target.save = jest.fn(async () => { modified.clear(); target.savedXp = target.xp; });

    const internal = new Set(['savedXp']);
    return new Proxy(target, {
        set(t, prop, value) {
            // Mongoose only marks a path modified when the value actually
            // differs; assigning the same number back is not a write.
            if (!internal.has(prop) && t[prop] !== value) modified.add(prop);
            t[prop] = value;
            return true;
        },
    });
}

const onCooldown = () => ({ lastXpGain: new Date() });

const run = message => messageCreate.execute(message, { user: { id: 'bot1' } });

beforeEach(() => {
    jest.clearAllMocks();
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    getGuildSettings.mockResolvedValue(makeSettings());
});

// ---------------------------------------------------------------------------

describe('a message where only the daily counter moved', () => {
    test('the document is not saved', async () => {
        const doc = makeUserDoc(onCooldown());
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(doc.save).not.toHaveBeenCalled();
        expect(saveWithBalanceDelta).not.toHaveBeenCalled();
    });

    test('the counter goes out as an $inc instead', async () => {
        const doc = makeUserDoc(onCooldown());
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(User.updateOne).toHaveBeenCalledTimes(1);
        const [filter, update] = User.updateOne.mock.calls[0];
        expect(filter).toEqual({ userId: 'author1', guildId: 'guild1' });
        expect(update).toEqual({ $inc: { dailyMessages: 1 } });
    });

    test('the in-memory counter still counts this message', async () => {
        // The raider bonus reads it on the next message through the same
        // process; an `$inc` that left the loaded copy behind would under-pay.
        const doc = makeUserDoc(onCooldown());
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(doc.dailyMessages).toBe(5);
    });

    test('the path is settled, so the backstop flush writes nothing', async () => {
        // The caller flushes anything left modified. Leaving `dailyMessages`
        // flagged after the `$inc` would put the full save straight back, and
        // double-count the message into the bargain.
        const doc = makeUserDoc(onCooldown());
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(doc.isModified()).toBe(false);
        expect(doc.save).not.toHaveBeenCalled();
    });
});

describe('a message where anything else moved', () => {
    test('XP earned takes the full save, not the $inc', async () => {
        const doc = makeUserDoc();   // not on cooldown, so XP lands
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(saveWithBalanceDelta).toHaveBeenCalledTimes(1);
        expect(doc.savedXp).toBeGreaterThan(0);
        expect(User.updateOne).not.toHaveBeenCalled();
    });

    test('a streak milestone takes the full save', async () => {
        const doc = makeUserDoc(onCooldown());
        User.findOne.mockResolvedValue(doc);
        checkNewMilestones.mockReturnValueOnce([{ days: 7, coins: 12_500, badge: 'Week Warrior' }]);

        await run(makeMessage());

        // The coins are on the document; an `$inc` of the counter alone would
        // drop them.
        expect(saveWithBalanceDelta).toHaveBeenCalledTimes(1);
        expect(User.updateOne).not.toHaveBeenCalled();
    });

    test('a fresh achievement takes the full save', async () => {
        const doc = makeUserDoc(onCooldown());
        User.findOne.mockResolvedValue(doc);
        checkAndAward.mockImplementationOnce(async user => {
            user.achievementsCount = (user.achievementsCount || 0) + 1;
            return [{ id: 'chatty' }];
        });

        await run(makeMessage());

        expect(saveWithBalanceDelta).toHaveBeenCalledTimes(1);
        expect(User.updateOne).not.toHaveBeenCalled();
    });

    test("the day's first message takes the full save, because the reset is a $set", async () => {
        const doc = makeUserDoc({
            ...onCooldown(),
            dailyMessages: 40,
            lastDailyReset: new Date('2020-01-01'),
        });
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(saveWithBalanceDelta).toHaveBeenCalledTimes(1);
        expect(User.updateOne).not.toHaveBeenCalled();
        expect(doc.dailyMessages).toBe(1);
    });

    test('a document that cannot report its modified paths is saved, not guessed at', async () => {
        const doc = makeUserDoc(onCooldown());
        doc.modifiedPaths = undefined;
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(saveWithBalanceDelta).toHaveBeenCalledTimes(1);
        expect(User.updateOne).not.toHaveBeenCalled();
    });
});
