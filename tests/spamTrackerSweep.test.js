'use strict';

/**
 * #600. The spam window used to be a `Map<guildId, Map<userId, timestamps>>`
 * with nothing that ever removed an entry. A user's array was pruned only when
 * *that same user* posted again, so somebody who said one word in one guild and
 * never came back stayed resident for the life of the process — and the outer
 * map grew a guild entry per guild and never shed one either.
 *
 * A leak is invisible from behaviour: a tracker that never forgets punishes
 * exactly the same messages as one that does. So these tests read the store
 * directly. What they hold is that entries are created where messages happen,
 * that the periodic sweep reclaims them once their timestamps age out, and
 * that flattening the two maps into one `guildId:userId` key did not merge two
 * guilds' counts into one.
 */

// Installed before the handler is required, so the module-level sweep interval
// registered at require time is a fake one this file can advance.
jest.useFakeTimers();

jest.mock('../src/models/User',     () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/Guild',    () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/models/Case',     () => ({ findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/Reminder', () => ({ create: jest.fn() }));
jest.mock('../src/services/moderationLogService', () => ({ logModeration: jest.fn() }));
jest.mock('../src/services/aiService', () => ({ handleAIChat: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));

const User = require('../src/models/User');
const Case = require('../src/models/Case');
const { logModeration } = require('../src/services/moderationLogService');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { makeMessage, makeModerationSettings } = require('./helpers/messageCreateMessage');
const messageCreate = require('../src/events/messageCreate');

const spamLimiter = messageCreate._spamLimiter;
const run = message => messageCreate.execute(message, { user: { id: 'bot1' } });

/** Spam protection armed with a threshold high enough that nothing under test trips it. */
const spamSettings = (over = {}) => makeModerationSettings({
    spamProtection: true, spamThreshold: 50, spamWindow: 5, ...over,
});

let quiet;

beforeEach(() => {
    jest.clearAllMocks();
    quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    User.findOne.mockResolvedValue({
        userId: 'author1', guildId: 'guild1', behaviorScore: 0, lastScoreDecay: null,
        save: jest.fn(async () => {}),
    });
    Case.countDocuments.mockResolvedValue(0);
    Case.findOne.mockResolvedValue(null);
    logModeration.mockResolvedValue({ caseId: 7 });
    getGuildSettings.mockResolvedValue(spamSettings());

    // Each test starts from an empty store: the tracker is module state, and
    // the clock is frozen, so nothing ages out between tests on its own.
    spamLimiter.reset('guild1:sweeper');
    for (let i = 0; i < 25; i++) spamLimiter.reset(`guild1:visitor${i}`);
    spamLimiter.reset('guild1:shared');
    spamLimiter.reset('guild2:shared');
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    quiet.mockRestore();
});

afterAll(() => {
    jest.useRealTimers();
});

describe('the spam window is reclaimed', () => {
    test('a user who posts once leaves an entry behind', async () => {
        await run(makeMessage({ content: 'hi', userId: 'sweeper' }));

        expect(spamLimiter.size).toBeGreaterThan(0);
    });

    test('the periodic sweep drops entries once their timestamps have aged out', async () => {
        for (let i = 0; i < 25; i++) {
            await run(makeMessage({ content: 'hi', userId: `visitor${i}` }));
        }
        expect(spamLimiter.size).toBe(25);

        // One sweep tick is 60s — the widest window any guild can configure —
        // so the first tick still sees timestamps inside it. The one after it
        // is where a visitor who never came back is finally forgotten.
        jest.advanceTimersByTime(60_000);
        jest.advanceTimersByTime(60_000);

        expect(spamLimiter.size).toBe(0);
    });

    test('the sweep keeps a user who is still inside their window', async () => {
        await run(makeMessage({ content: 'hi', userId: 'sweeper' }));

        // Far enough for the tick to fire, not far enough for a 5s window to
        // have closed on a message sent a second ago.
        jest.advanceTimersByTime(59_000);
        await run(makeMessage({ content: 'hi', userId: 'sweeper' }));
        jest.advanceTimersByTime(1_500);

        expect(spamLimiter.size).toBe(1);
    });
});

describe('one flat key per (guild, user)', () => {
    test('the same user in two guilds is two counts, not one', async () => {
        getGuildSettings.mockResolvedValue(spamSettings({ spamThreshold: 3 }));

        await run(makeMessage({ content: 'hi', userId: 'shared', guildId: 'guild1' }));
        await run(makeMessage({ content: 'hi', userId: 'shared', guildId: 'guild1' }));
        const elsewhere = makeMessage({ content: 'hi', userId: 'shared', guildId: 'guild2' });

        await run(elsewhere);

        // Three messages from one account, but only two in either guild. A
        // shared counter would punish someone for being active in two servers.
        expect(elsewhere.delete).not.toHaveBeenCalled();
        expect(spamLimiter.size).toBe(2);
    });
});
