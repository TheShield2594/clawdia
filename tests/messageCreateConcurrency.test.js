'use strict';

// #617: the message pipeline loads the author's User document once and hands
// the same object through levelling, quests, streaks and achievements before a
// single `save()`. `save()` writes every modified path as an absolute `$set`,
// so two of the same user's messages overlapping in that window is one
// message's worth of XP, quest progress and streak state written back to what
// it was before. These pin that the two flows no longer overlap.

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
const messageCreate = require('../src/events/messageCreate');
const { useFixedClock } = require('./helpers/fixedClock');

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
    const channel = {
        id: 'chan1',
        send: jest.fn().mockResolvedValue({ delete: jest.fn().mockResolvedValue(undefined) }),
    };
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
        channel,
        client: { user: { id: 'bot1' } },
        delete: jest.fn().mockResolvedValue(undefined),
    };
}

const run = (message) => messageCreate.execute(message, { user: { id: 'bot1' } });

const { maybeTriggerChatEvent } = require('../src/services/chatEventService');

const { gates } = require('./helpers/deferred');

/**
 * One turn of the event loop — what a query costs the flow that issued it.
 *
 * `setImmediate` rather than a 5ms sleep (#949): the property these tests need
 * from a round trip is that the flow yields, so a concurrent one can reach its
 * own read. A duration on top of that is a number the assertions never look at,
 * and one more thing for a loaded runner to reorder.
 */
const roundTrip = () => new Promise(setImmediate);

beforeEach(() => {
    jest.clearAllMocks();
    getGuildSettings.mockResolvedValue(makeSettings());
});

describe('two messages from the same user', () => {
    // The daily counter resets when the stored `lastDailyReset` is not today's
    // UTC date (messageCreate.js:291-296), and the fixture below stamps it with
    // its own `new Date()`. Unpinned, a run that crosses midnight UTC between
    // the fixture and the handler's read triggers the reset, and the counter
    // this suite asserts on comes back 1 instead of 2 — a lost-update failure
    // reported for a clock, once a year, at midnight (#632).
    useFixedClock();

    test('the second flow does not read the document until the first has written it', async () => {
        const order = [];

        User.findOne.mockImplementation(async () => {
            // Logged here, not after the await: a real query reads the document
            // when it reaches the server, and the round trip is the wait that
            // follows. Logging after it would show 'read' happening after a
            // concurrent flow's save and hide the interleaving entirely.
            order.push('read');
            await roundTrip();
            const doc = makeUserDoc();
            const save = doc.save;
            doc.save = jest.fn(async () => { order.push('save'); return save(); });
            return doc;
        });

        await Promise.all([run(makeMessage('one')), run(makeMessage('two'))]);

        // Interleaved would be read, read, save, save — one message's XP lost.
        expect(order).toEqual(['read', 'save', 'read', 'save']);
    });

    // Handing both flows the same in-memory object would not model the bug: JS
    // has no preemption, so `x = x + 1` still lands twice on one object. The
    // lost update is a property of the round trip — each read is a snapshot of
    // what was stored, and each save writes that snapshot's descendant back. So
    // the mock is a tiny store, and reading from it costs a tick.
    function backedByStore(stored = { dailyMessages: 0, xp: 0, messages: 0, lastXpGain: null, lastDailyReset: new Date() }) {
        // lastDailyReset is in here because the counter resets when the stored
        // date is not today — a store that forgets it hands every read a fresh
        // day, and the counter can never reach 2 however well it is serialised.
        const PERSISTED = ['dailyMessages', 'xp', 'messages', 'lastXpGain', 'lastDailyReset', 'level'];
        User.findOne.mockImplementation(async () => {
            // The snapshot is taken when the query is issued, before the round
            // trip — which is the whole of the lost update. Snapshotting after
            // the await would let a concurrent flow's write land first and be
            // picked up, and no amount of racing would ever lose anything.
            const snapshot = { ...stored };
            await roundTrip();
            const doc = makeUserDoc(snapshot);
            const save = doc.save;
            doc.save = jest.fn(async () => {
                for (const field of PERSISTED) stored[field] = doc[field];
                return save();
            });
            return doc;
        });
        return stored;
    }

    test('the second message counts on top of the first, not instead of it', async () => {
        const stored = backedByStore();

        await Promise.all([run(makeMessage('one')), run(makeMessage('two'))]);

        // Both flows read before either writes — which is what happens without
        // the lock — and each stores 1. The counter is the plainest reading of
        // the lost update: two messages, one counted.
        expect(stored.dailyMessages).toBe(2);
    });

    test('the first message\'s XP is still there after the second writes', async () => {
        const stored = backedByStore();

        await run(makeMessage('one'));
        const afterFirst = stored.xp;
        expect(afterFirst).toBeGreaterThan(0);

        await run(makeMessage('two'));

        // The second message is inside the 60s XP cooldown the first started,
        // so it adds none — but it must not write back the pre-first-message
        // value either.
        expect(stored.xp).toBe(afterFirst);
    });

    test('messages from different users are not queued behind each other', async () => {
        const order = [];
        // Each write is held open until the *other* one has started, so the
        // overlap is established rather than inferred from a 10ms write
        // outlasting whatever the other flow was doing (#949). A lock keyed any
        // coarser than per-user never gets both writes in flight, and this
        // waits for something that will not happen rather than reporting a
        // plausible-looking order.
        const writes = gates(['author1', 'author2']);
        User.findOne.mockImplementation(async filter => {
            const doc = makeUserDoc({ userId: filter.userId });
            const save = doc.save;
            doc.save = jest.fn(async () => {
                order.push(`enter:${filter.userId}`);
                writes.started[filter.userId].resolve();
                await writes.finish[filter.userId].promise;
                order.push(`leave:${filter.userId}`);
                return save();
            });
            return doc;
        });

        const second = makeMessage('two');
        second.author = { ...second.author, id: 'author2' };
        second.member = { ...second.member, id: 'author2' };

        const both = Promise.all([run(makeMessage('one')), run(second)]);
        await writes.allStarted();
        writes.finish.author1.resolve();
        writes.finish.author2.resolve();
        await both;

        // Both writes were in flight before either finished. Keying the lock
        // per guild, or globally, would serialise every message the bot sees.
        expect(order).toEqual([
            'enter:author1', 'enter:author2', 'leave:author1', 'leave:author2',
        ]);
    });
});

describe('the automod gate still stops the message', () => {
    test('a blocked message reaches neither the streak write nor the ambient events', async () => {
        jest.useFakeTimers();
        try {
            const doc = makeUserDoc();
            const modDoc = makeUserDoc({ _id: 'doc2', behaviorScore: 0, lastScoreDecay: null });
            User.findOne.mockResolvedValueOnce(doc).mockResolvedValue(modDoc);
            getGuildSettings.mockResolvedValue(makeSettings({
                moderation: { enabled: true, autoModEnabled: true, linkFilter: true },
            }));

            await run(makeMessage('look at https://example.com'));

            expect(saveWithBalanceDelta).not.toHaveBeenCalled();
            // Wrapping the user chain in a lock must not turn the gate into a
            // gate on that chain alone — a blocked message still gets no
            // airdrop, no crate and no trivia.
            expect(maybeTriggerChatEvent).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    test('a message that passes does reach them', async () => {
        User.findOne.mockResolvedValue(makeUserDoc());

        await run(makeMessage());

        expect(maybeTriggerChatEvent).toHaveBeenCalledTimes(1);
    });
});
