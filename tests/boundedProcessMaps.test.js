'use strict';

// Three process-local Maps missed the repo's bounded-cache convention (#928).
// `BoundedRateLimiter`, `customBadWordRegexes` and `guildSettingsCache` all cap
// and sweep; `voiceJoinTimes`, `chatEventService`'s `guildState` and the RSS
// dead-feed bookkeeping grew with no ceiling. None leaks fast enough to matter
// over days, which is exactly why nothing would ever catch it — so the ceiling
// is asserted here rather than left to be noticed after months of uptime.

const { useFixedClock, advanceClock, HOUR, MINUTE } = require('./helpers/fixedClock');

jest.mock('../src/models/Guild', () => ({
    find: jest.fn(() => ({ lean: async () => [] })),
    findOne: jest.fn(),
    updateOne: jest.fn(async () => ({})),
}));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => null) }));
jest.mock('../src/services/rivalryService', () => ({ checkRivalry: jest.fn() }));
jest.mock('../src/services/tempVoiceService', () => ({ handleVoiceStateUpdate: jest.fn() }));
jest.mock('../src/utils/safeFeedFetch', () => ({ safeFetchFeed: jest.fn() }));

const voiceStateUpdate = require('../src/events/voiceStateUpdate');
const chatEventService = require('../src/services/chatEventService');
const { checkRssFeeds, __test__: rss } = require('../src/services/rssService');

// ---------------------------------------------------------------------------
// voiceJoinTimes — src/events/voiceStateUpdate.js
// ---------------------------------------------------------------------------

describe('voiceJoinTimes is bounded', () => {
    useFixedClock();

    const {
        voiceJoinTimes,
        MAX_TRACKED_VOICE_SESSIONS,
        VOICE_SWEEP_INTERVAL_MS,
        MAX_VOICE_SESSION_MS,
        resetVoiceJoinTimes,
    } = voiceStateUpdate.__test__;

    beforeEach(() => resetVoiceJoinTimes());

    /** A join transition for `userId` in `guildId`. */
    function join(guildId, userId) {
        const member = { id: userId, user: { bot: false }, roles: { cache: { some: () => false } } };
        return voiceStateUpdate.execute(
            { channelId: null, guild: { id: guildId }, member },
            { channelId: 'voice-1', guild: { id: guildId }, member },
            {},
        );
    }

    /** A leave transition, which is what normally clears the entry. */
    function leave(guildId, userId) {
        const member = { id: userId, user: { bot: false }, roles: { cache: { some: () => false } } };
        return voiceStateUpdate.execute(
            { channelId: 'voice-1', guild: { id: guildId }, member },
            { channelId: null, guild: { id: guildId }, member },
            {},
        );
    }

    test('a join followed by its leave leaves nothing behind', async () => {
        await join('g1', 'u1');
        expect(voiceJoinTimes.size).toBe(1);
        await leave('g1', 'u1');
        expect(voiceJoinTimes.size).toBe(0);
    });

    test('joins whose leave never arrives are swept once they are older than a session', async () => {
        await join('g1', 'stranded');
        // The leave for this one is never delivered — the bot was removed from
        // the guild, or the gateway dropped the transition.
        expect(voiceJoinTimes.size).toBe(1);

        // Still inside a plausible session: a sweep must not take it.
        advanceClock(VOICE_SWEEP_INTERVAL_MS + MINUTE);
        await join('g1', 'other');
        expect(voiceJoinTimes.has('g1:stranded')).toBe(true);

        advanceClock(MAX_VOICE_SESSION_MS + MINUTE);
        await join('g1', 'later');
        expect(voiceJoinTimes.has('g1:stranded')).toBe(false);
        expect(voiceJoinTimes.has('g1:later')).toBe(true);
    });

    test('the sweep runs at most once per interval', async () => {
        await join('g1', 'stranded');
        advanceClock(MAX_VOICE_SESSION_MS + MINUTE);

        // First join past the cutoff sweeps; the entry goes.
        await join('g1', 'a');
        expect(voiceJoinTimes.has('g1:stranded')).toBe(false);

        // A second stranded join inside the same interval is not swept again,
        // which is the point of the interval — the sweep is O(n) per hour.
        await join('g1', 'b');
        advanceClock(MAX_VOICE_SESSION_MS + MINUTE);
        await join('g1', 'c');
        expect(voiceJoinTimes.has('g1:b')).toBe(false);
    });

    test('the map never exceeds its cap, however many joins arrive', async () => {
        for (let i = 0; i < MAX_TRACKED_VOICE_SESSIONS + 250; i++) {
            await join('g1', `u${i}`);
        }
        expect(voiceJoinTimes.size).toBe(MAX_TRACKED_VOICE_SESSIONS);
        // FIFO: the oldest joins are the ones dropped.
        expect(voiceJoinTimes.has('g1:u0')).toBe(false);
        expect(voiceJoinTimes.has(`g1:u${MAX_TRACKED_VOICE_SESSIONS + 249}`)).toBe(true);
    });

    test('a leave past the cutoff awards nothing rather than depending on sweep timing', async () => {
        const { getGuildSettings } = require('../src/utils/guildSettingsCache');
        getGuildSettings.mockResolvedValue({
            leveling: { enabled: true, voiceXpEnabled: true, rewardsEnabled: true, voiceXpRate: 1 },
        });

        await join('g1', 'u1');
        advanceClock(MAX_VOICE_SESSION_MS + HOUR);
        await leave('g1', 'u1');

        const User = require('../src/models/User');
        expect(User.findOne).not.toHaveBeenCalled();
        expect(voiceJoinTimes.has('g1:u1')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// guildState — src/services/chatEventService.js
// ---------------------------------------------------------------------------

describe('chatEventService guildState is bounded', () => {
    const { guildState, MAX_TRACKED_GUILDS, MIN_MESSAGES_BETWEEN } = chatEventService.__test__;

    beforeEach(() => guildState.clear());

    const messageIn = guildId => ({
        guild: { id: guildId },
        channel: { isTextBased: () => true },
    });

    test('one entry per guild, capped FIFO', async () => {
        for (let i = 0; i < MAX_TRACKED_GUILDS + 100; i++) {
            await chatEventService.maybeTriggerChatEvent(messageIn(`g${i}`), {});
        }
        expect(guildState.size).toBe(MAX_TRACKED_GUILDS);
        expect(guildState.has('g0')).toBe(false);
        expect(guildState.has(`g${MAX_TRACKED_GUILDS + 99}`)).toBe(true);
    });

    test('eviction costs progress toward the next event, never an early one', async () => {
        // Fill to the cap with the victim inserted first, having almost earned
        // an event, then push it out.
        const victim = messageIn('victim');
        for (let i = 0; i < MIN_MESSAGES_BETWEEN - 1; i++) {
            await chatEventService.maybeTriggerChatEvent(victim, {});
        }
        expect(guildState.get('victim').messagesSince).toBe(MIN_MESSAGES_BETWEEN - 1);

        for (let i = 0; i < MAX_TRACKED_GUILDS; i++) {
            await chatEventService.maybeTriggerChatEvent(messageIn(`filler${i}`), {});
        }
        expect(guildState.has('victim')).toBe(false);

        await chatEventService.maybeTriggerChatEvent(victim, {});
        expect(guildState.get('victim').messagesSince).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Dead-feed bookkeeping — src/services/rssService.js
// ---------------------------------------------------------------------------

describe('RSS dead-feed state is pruned', () => {
    useFixedClock();

    const { feedFailCounts, feedLastFailTime, pruneFeedFailureState, DEAD_FEED_STATE_TTL_MS } = rss;

    beforeEach(() => {
        feedFailCounts.clear();
        feedLastFailTime.clear();
    });

    test('an entry inside the TTL survives — a feed still being polled keeps its count', () => {
        feedFailCounts.set('https://live.example/feed', 3);
        feedLastFailTime.set('https://live.example/feed', Date.now());

        advanceClock(DEAD_FEED_STATE_TTL_MS - MINUTE);
        pruneFeedFailureState();

        expect(feedFailCounts.get('https://live.example/feed')).toBe(3);
    });

    test('an entry nothing has retried since the TTL is dropped', () => {
        feedFailCounts.set('https://unsubscribed.example/feed', 5);
        feedLastFailTime.set('https://unsubscribed.example/feed', Date.now());

        advanceClock(DEAD_FEED_STATE_TTL_MS + MINUTE);
        pruneFeedFailureState();

        expect(feedFailCounts.has('https://unsubscribed.example/feed')).toBe(false);
        expect(feedLastFailTime.has('https://unsubscribed.example/feed')).toBe(false);
    });

    test('the TTL outlasts the retry cooldown, so a parked feed is still parked', () => {
        expect(DEAD_FEED_STATE_TTL_MS).toBeGreaterThan(rss.DEAD_FEED_COOLDOWN_MS);
    });

    test('a half-written pair is reclaimed from either side', () => {
        feedFailCounts.set('https://a.example/feed', 2);      // no timestamp
        feedLastFailTime.set('https://b.example/feed', Date.now()); // no count

        pruneFeedFailureState();

        expect(feedFailCounts.size).toBe(0);
        expect(feedLastFailTime.size).toBe(0);
    });

    test('a sweep prunes even when it throws before finishing', async () => {
        feedFailCounts.set('https://stale.example/feed', 4);
        feedLastFailTime.set('https://stale.example/feed', Date.now() - DEAD_FEED_STATE_TTL_MS - HOUR);

        const Guild = require('../src/models/Guild');
        Guild.find.mockImplementationOnce(() => ({ lean: async () => { throw new Error('mongo down'); } }));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await checkRssFeeds({});

        expect(feedFailCounts.has('https://stale.example/feed')).toBe(false);
        console.error.mockRestore();
    });

    test('the prune leaves daily-news-only feeds alone while they are current', async () => {
        // The sweep only queries guilds with rssFeeds, so a URL configured
        // solely by a daily-news profile is absent from its subscription list.
        // Pruning against that list would clear it every five minutes.
        feedFailCounts.set('https://digest-only.example/feed', 3);
        feedLastFailTime.set('https://digest-only.example/feed', Date.now());

        await checkRssFeeds({});

        expect(feedFailCounts.get('https://digest-only.example/feed')).toBe(3);
    });
});
