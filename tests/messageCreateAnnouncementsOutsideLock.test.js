'use strict';

// #894. The level-up embed and the quest/streak notifications were awaited
// *inside* `withUserLock`, so the lock's hold time included Discord API latency
// and rate-limit queueing rather than just the database work it exists to
// serialise. A holder stuck behind a 429 can reach the mutex's 15-second
// timeout override — and that override exists to break deadlocks, so reaching
// it lets the next flow run alongside this one and reintroduces the lost update
// the lock was built to prevent.
//
// They are collected under the lock now and sent after it. These pin that:
// nothing announces while the lock is held, everything still announces, the
// order is unchanged, and one failing send does not swallow the rest.

jest.mock('../src/models/User',     () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/Guild',    () => ({ create: jest.fn() }));
jest.mock('../src/models/Case',     () => ({ findOne: jest.fn().mockResolvedValue(null), countDocuments: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/models/Reminder', () => ({ create: jest.fn() }));

jest.mock('../src/services/aiService',      () => ({ handleAIChat: jest.fn() }));
jest.mock('../src/services/moderationLogService', () => ({ logModeration: jest.fn().mockResolvedValue(undefined) }));
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
        return { leveled: true, newLevel: (user.level || 0) + 1, gained: amount };
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
const { announceLevelUp } = require('../src/services/levelingService');
const { notifyQuestComplete, notifyQuestNearComplete, notifyDailyQuestReset, ensureQuests } = require('../src/services/questService');
const { checkNewMilestones } = require('../src/utils/streakMultiplier');
const { hasEffect } = require('../src/services/effectsService');
const { pendingLocks } = require('../src/utils/userMutex');
const messageCreate = require('../src/events/messageCreate');
const { useFixedClock } = require('./helpers/fixedClock');

function makeUserDoc(overrides = {}) {
    const doc = {
        _id: 'doc1',
        userId: 'author1',
        guildId: 'guild1',
        xp: 0,
        level: 4,
        messages: 0,
        balance: 0,
        dailyMessages: 0,
        lastXpGain: null,
        streak: { current: 3, longest: 3, lastActive: new Date('2020-01-01'), claimedMilestones: [] },
        pets: [],
        isModified() { return false; },
        ...overrides,
    };
    doc.save = jest.fn().mockResolvedValue(undefined);
    return doc;
}

function makeSettings(overrides = {}) {
    return {
        ai: { enabled: false },
        leveling: { enabled: true, rewardsEnabled: true, xpRate: 1, noXpChannelIds: [], noXpRoleIds: [] },
        moderation: { enabled: false },
        suggestions: { enabled: false },
        bibleVerse: { autoRespond: false },
        ...overrides,
    };
}

function makeMessage(content = 'hello there') {
    return {
        id: 'msg1',
        url: 'https://discord.com/channels/guild1/chan1/msg1',
        content,
        author: { id: 'author1', bot: false, toString: () => '<@author1>' },
        attachments: new Map(),
        mentions: { has: () => false },
        member: {
            id: 'author1',
            permissions: { has: () => false },
            roles: { cache: { some: () => false } },
            bannable: false, kickable: false, moderatable: false,
        },
        guild: { id: 'guild1', name: 'Guild One' },
        channel: { id: 'chan1', send: jest.fn().mockResolvedValue({ delete: jest.fn().mockResolvedValue(undefined) }) },
        client: { user: { id: 'bot1' } },
        delete: jest.fn().mockResolvedValue(undefined),
    };
}

const run = message => messageCreate.execute(message, { user: { id: 'bot1' } });

// The mutex has no "is this key held" accessor, and it should not grow one for
// a test — but it does report how many keys have work in flight, and this suite
// runs one message at a time. Zero means the lock has been released.
const lockHeld = () => pendingLocks() > 0;

beforeEach(() => {
    jest.clearAllMocks();
    getGuildSettings.mockResolvedValue(makeSettings());
    User.findOne.mockResolvedValue(makeUserDoc());
});

describe('Discord sends and the user lock', () => {
    useFixedClock();

    test('the level-up embed is sent after the lock is released, not inside it', async () => {
        let heldWhenAnnouncing = null;
        announceLevelUp.mockImplementation(async () => { heldWhenAnnouncing = lockHeld(); });

        await run(makeMessage());

        expect(announceLevelUp).toHaveBeenCalledTimes(1);
        expect(heldWhenAnnouncing).toBe(false);
    });

    test('the quest notifications are too', async () => {
        const held = [];
        notifyQuestComplete.mockImplementation(async () => { held.push(lockHeld()); });
        notifyQuestNearComplete.mockImplementation(async () => { held.push(lockHeld()); });
        ensureQuests.mockResolvedValue({ assignedNewDaily: true });
        notifyDailyQuestReset.mockImplementation(async () => { held.push(lockHeld()); });

        await run(makeMessage());

        expect(held).toEqual([false, false, false]);
    });

    test('so are the streak-shield and milestone messages', async () => {
        // A shield consumed after a missed day, and a milestone crossed on the
        // same message — the two paths that call channel.send directly.
        hasEffect.mockReturnValue(true);
        checkNewMilestones.mockReturnValue([{ days: 30, coins: 5000, badge: '🔥' }]);
        User.findOne.mockResolvedValue(makeUserDoc({
            streak: {
                current: 29,
                longest: 29,
                // 60 hours ago: past the 48h break, inside the shield's 72h window.
                lastActive: new Date(Date.now() - 60 * 60 * 60 * 1000),
                claimedMilestones: [],
            },
        }));

        const message = makeMessage();
        const held = [];
        message.channel.send.mockImplementation(async () => {
            held.push(lockHeld());
            return { delete: jest.fn().mockResolvedValue(undefined) };
        });

        await run(message);

        const texts = message.channel.send.mock.calls.map(([arg]) => arg);
        expect(texts.some(t => typeof t === 'string' && t.includes('Streak Shield'))).toBe(true);
        expect(texts.some(t => typeof t === 'string' && t.includes('30-day streak milestone'))).toBe(true);
        expect(held).toEqual(held.map(() => false));
        expect(held.length).toBeGreaterThan(0);
    });

    test('a level-up still announces even when automod then blocks the message', async () => {
        // It did before the sends moved out of the lock — the announcement is
        // queued before the automod gate is reached — and blocking the message
        // is not a reason to swallow the promotion.
        //
        // Fake timers because the warning the automod path posts schedules its
        // own deletion five seconds out, which would otherwise outlive the run.
        jest.useFakeTimers();
        try {
            getGuildSettings.mockResolvedValue(makeSettings({
                moderation: { enabled: true, autoModEnabled: true, linkFilter: true },
            }));
            User.findOne
                .mockResolvedValueOnce(makeUserDoc())
                .mockResolvedValue(makeUserDoc({ _id: 'doc2', behaviorScore: 0, lastScoreDecay: null }));

            await run(makeMessage('look at https://example.com'));

            expect(announceLevelUp).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    test('the level-up is announced before the quest notification it rides with', async () => {
        const order = [];
        announceLevelUp.mockImplementation(async () => { order.push('level'); });
        notifyQuestComplete.mockImplementation(async () => { order.push('quest'); });

        await run(makeMessage());

        expect(order).toEqual(['level', 'quest']);
    });

    test('one failing send does not skip the ones queued behind it', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        announceLevelUp.mockRejectedValue(new Error('429 from Discord'));

        await run(makeMessage());

        expect(notifyQuestComplete).toHaveBeenCalledTimes(1);
        expect(notifyQuestNearComplete).toHaveBeenCalledTimes(1);
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });

    test('a rate-limited send does not delay the same user\'s next message', async () => {
        // The shape of the bug: with the send inside the lock, the second
        // message's document read queues behind Discord's response.
        //
        // Every resolver is kept, not just the last one. Only one send is
        // queued as this stands — both flows are handed the same document
        // object, so the `lastXpGain` the first stamps puts the second inside
        // handleLeveling's 60-second XP cooldown, which returns before a
        // level-up can be queued. A fixture that ever gave each flow its own
        // document would queue two, and holding a single `releaseSend` would
        // then leave one promise pending and hang the test rather than fail it.
        const releaseSends = [];
        announceLevelUp.mockImplementation(() => new Promise(resolve => { releaseSends.push(resolve); }));

        const first = run(makeMessage('one'));
        // Let the first flow reach its (now post-lock) announcement.
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        User.findOne.mockClear();
        const second = run(makeMessage('two'));
        await new Promise(resolve => setImmediate(resolve));

        // Held inside the lock, this would still be 0: the second flow would be
        // waiting on a Discord call that has not answered.
        expect(User.findOne).toHaveBeenCalled();

        expect(releaseSends).not.toEqual([]);
        for (const releaseSend of releaseSends) releaseSend();
        await Promise.all([first, second]);
    });
});
