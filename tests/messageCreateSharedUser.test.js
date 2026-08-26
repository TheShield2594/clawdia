'use strict';

// `handleLeveling` fetched the author's user document, mutated it, saved it, and
// returned it into a variable nobody read. `handleStreakAndQuests` then issued
// the identical `findOne` and saved the same user a second time — two reads and
// two writes of one document on every message the bot sees, plus a window
// between them in which each save could undo the other's fields.
//
// The parameter to thread it through already existed; the call site just did not
// use it. These tests pin that it now does, and that nothing that used to be
// persisted stopped being persisted on the way.

jest.mock('../src/models/User',     () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/Guild',    () => ({ create: jest.fn() }));
jest.mock('../src/models/Case',     () => ({ findOne: jest.fn().mockResolvedValue(null), countDocuments: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/models/Reminder', () => ({ create: jest.fn() }));

jest.mock('../src/services/aiService',      () => ({ handleAIChat: jest.fn() }));
jest.mock('../src/services/moderationLogService',            () => ({ logModeration: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/rivalryService', () => ({ checkRivalry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/chatEventService', () => ({ maybeTriggerChatEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/wealthMilestone',   () => ({ checkAndBroadcastWealthMilestone: jest.fn().mockResolvedValue(undefined) }));
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
// Stands in for the real helper, which folds `balance` out of the save and
// re-applies it as an `$inc`. What matters here is that it is the thing that
// saves, and that it saves once.
jest.mock('../src/utils/balanceDelta', () => ({
    saveWithBalanceDelta: jest.fn(async (Model, user) => {
        await user.save();
        return { credited: true, balance: user.balance ?? 0 };
    }),
}));

const User  = require('../src/models/User');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { saveWithBalanceDelta } = require('../src/utils/balanceDelta');
const { ensureQuests } = require('../src/services/questService');
const { checkRivalry } = require('../src/services/rivalryService');
const messageCreate = require('../src/events/messageCreate');
// #783 lifted these out so the auto-moderation tests drive the same fake message.
const { makeMessage, makeSettings } = require('./helpers/messageCreateMessage');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Tracks modification the way a Mongoose document does, because the flush that
// backstops the bail-out paths is gated on `isModified()`.
function makeUserDoc(overrides = {}) {
    const doc = {
        _id: 'doc1',
        userId: 'author1',
        guildId: 'guild1',
        xp: 0,
        level: 0,
        messages: 0,
        balance: 0,
        dailyMessages: 0,
        lastXpGain: null,
        streak: { current: 3, longest: 3, lastActive: new Date('2020-01-01'), claimedMilestones: [] },
        pets: [],
        _dirty: false,
        isModified() { return this._dirty; },
        ...overrides,
    };
    doc.save = jest.fn(async () => { doc._dirty = false; doc.savedXp = doc.xp; });
    // Every field the handlers assign goes through here in a real document.
    return new Proxy(doc, {
        set(target, prop, value) {
            if (prop !== '_dirty' && prop !== 'savedXp') target._dirty = true;
            target[prop] = value;
            return true;
        },
    });
}

const run = (message) => messageCreate.execute(message, { user: { id: 'bot1' } });

beforeEach(() => {
    jest.clearAllMocks();
    getGuildSettings.mockResolvedValue(makeSettings());
});

// ---------------------------------------------------------------------------

describe('a message that earns XP', () => {
    test('reads the author once, not once per handler', async () => {
        User.findOne.mockResolvedValue(makeUserDoc());

        await run(makeMessage());

        expect(User.findOne).toHaveBeenCalledTimes(1);
    });

    test('saves the author once', async () => {
        const doc = makeUserDoc();
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    test('the streak handler works on the very document the leveling handler loaded', async () => {
        const doc = makeUserDoc();
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(saveWithBalanceDelta).toHaveBeenCalledTimes(1);
        expect(saveWithBalanceDelta.mock.calls[0][1]).toBe(doc);
    });

    test('the one save carries the XP the leveling handler applied', async () => {
        const doc = makeUserDoc();
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        // The regression this guards: dropping handleLeveling's save without
        // threading its document through would silently stop XP being persisted.
        expect(doc.savedXp).toBeGreaterThan(0);
        expect(doc.messages).toBe(1);
    });

    test('rivalry standings are still checked', async () => {
        User.findOne.mockResolvedValue(makeUserDoc());

        await run(makeMessage());

        expect(checkRivalry).toHaveBeenCalledTimes(1);
    });

    test('a user on XP cooldown is still handed to the streak handler', async () => {
        const doc = makeUserDoc({ lastXpGain: new Date() });
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        expect(User.findOne).toHaveBeenCalledTimes(1);
        expect(saveWithBalanceDelta.mock.calls[0][1]).toBe(doc);
    });
});

describe('when the single write does not happen', () => {
    test('XP still lands if the streak handler throws before saving', async () => {
        const doc = makeUserDoc();
        User.findOne.mockResolvedValue(doc);
        ensureQuests.mockRejectedValueOnce(new Error('quest service is down'));
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});

        await run(makeMessage());

        expect(saveWithBalanceDelta).not.toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalledTimes(1);
        expect(doc.savedXp).toBeGreaterThan(0);
        err.mockRestore();
    });

    test('XP still lands when auto-moderation blocks the message', async () => {
        // The block path schedules a 5s cleanup of its own warning message; faked so
        // it does not outlive the test.
        jest.useFakeTimers();
        const doc = makeUserDoc();
        // applyAutoModAction loads its own document for the behaviour score; the
        // levelling document is the first one handed out.
        const modDoc = makeUserDoc({ _id: 'doc2', behaviorScore: 0, lastScoreDecay: null });
        User.findOne.mockResolvedValueOnce(doc).mockResolvedValue(modDoc);
        getGuildSettings.mockResolvedValue(makeSettings({
            moderation: { enabled: true, autoModEnabled: true, linkFilter: true },
        }));

        await run(makeMessage('look at https://example.com'));

        expect(saveWithBalanceDelta).not.toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalledTimes(1);
        expect(doc.savedXp).toBeGreaterThan(0);
        jest.useRealTimers();
    });

    test('the flush is a no-op once the streak write has landed', async () => {
        const doc = makeUserDoc();
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage());

        // A second save here would race the fire-and-forget writes that follow the
        // first one — wealth milestones and achievements both save the same document.
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    test('no document, no write', async () => {
        User.findOne.mockResolvedValue(null);
        User.create.mockResolvedValue(makeUserDoc());
        getGuildSettings.mockResolvedValue(makeSettings({
            leveling: { enabled: true, rewardsEnabled: false },
        }));

        await run(makeMessage());

        expect(saveWithBalanceDelta).not.toHaveBeenCalled();
    });
});
