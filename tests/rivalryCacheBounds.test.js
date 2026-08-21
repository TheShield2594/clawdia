'use strict';

// rankCache used to hold every user of every guild the bot ever saw, and the
// write-through bumped updatedAt on every XP-earning message — so on any
// active guild the 5-minute TTL never fired and nothing was ever evicted or
// refreshed. These tests pin the bounds that replaced that: a per-guild entry
// cap, a FIFO cap on cached guilds, and a TTL that actually expires.

// getLeaderboard queries the User model; replace it with a stand-in whose
// result the tests control.
let mockFindResult = [];
jest.mock('../src/models/User', () => ({
    find: jest.fn(() => ({
        sort: () => ({
            limit: limit => ({
                select: () => ({
                    lean: async () => mockFindResult.slice(0, limit),
                }),
            }),
        }),
    })),
}));

const User = require('../src/models/User');
const { __test__ } = require('../src/services/rivalryService');
const {
    applyStanding, buildIndex, compare, rankCache, getLeaderboard,
    CACHE_TTL, MAX_GUILDS, MAX_ENTRIES_PER_GUILD,
} = __test__;

function population(size) {
    return Array.from({ length: size }, (_, i) => ({
        userId: `u${i}`,
        level:  size - i, // already in leaderboard order
        xp:     0,
    }));
}

function makeBoard(entries, { truncated = false } = {}) {
    const sorted = entries.slice().sort(compare);
    return { entries: sorted, index: buildIndex(sorted), updatedAt: Date.now(), truncated };
}

beforeEach(() => {
    rankCache.clear();
    mockFindResult = [];
    User.find.mockClear();
});

describe('getLeaderboard bounds what it caches', () => {
    test('caps a guild at MAX_ENTRIES_PER_GUILD and marks the board truncated', async () => {
        mockFindResult = population(MAX_ENTRIES_PER_GUILD + 500);
        const board = await getLeaderboard('g1');

        expect(board.entries).toHaveLength(MAX_ENTRIES_PER_GUILD);
        expect(board.truncated).toBe(true);
    });

    test('a guild smaller than the cap is complete and not truncated', async () => {
        mockFindResult = population(30);
        const board = await getLeaderboard('g1');

        expect(board.entries).toHaveLength(30);
        expect(board.truncated).toBe(false);
    });

    test('evicts the oldest guild FIFO once MAX_GUILDS are cached', async () => {
        mockFindResult = population(1);
        for (let i = 0; i < MAX_GUILDS; i++) await getLeaderboard(`g${i}`);
        expect(rankCache.size).toBe(MAX_GUILDS);

        await getLeaderboard('one-more');
        expect(rankCache.size).toBe(MAX_GUILDS);
        expect(rankCache.has('g0')).toBe(false);
        expect(rankCache.has('one-more')).toBe(true);
    });

    test('a refresh of an already-cached guild does not evict anyone', async () => {
        mockFindResult = population(1);
        for (let i = 0; i < MAX_GUILDS; i++) await getLeaderboard(`g${i}`);

        rankCache.get('g0').updatedAt = 0; // expire it
        await getLeaderboard('g0');

        expect(rankCache.size).toBe(MAX_GUILDS);
        expect(rankCache.has('g0')).toBe(true);
    });

    test('an expired entry is re-read from the database', async () => {
        mockFindResult = population(5);
        const first = await getLeaderboard('g1');
        expect(User.find).toHaveBeenCalledTimes(1);

        // Fresh: served from cache.
        expect(await getLeaderboard('g1')).toBe(first);
        expect(User.find).toHaveBeenCalledTimes(1);

        first.updatedAt = Date.now() - CACHE_TTL - 1;
        const second = await getLeaderboard('g1');
        expect(second).not.toBe(first);
        expect(User.find).toHaveBeenCalledTimes(2);
    });
});

describe('applyStanding leaves the TTL alone', () => {
    test('a write-through no longer refreshes updatedAt', () => {
        const board = makeBoard(population(10));
        board.updatedAt = 12345;

        applyStanding(board, { userId: 'u9', level: 100, xp: 0 });

        expect(board.updatedAt).toBe(12345);
    });
});

describe('applyStanding on a truncated board', () => {
    test('a user below the window is reported as out of scope, not inserted', () => {
        const board = makeBoard(population(MAX_ENTRIES_PER_GUILD), { truncated: true });

        const result = applyStanding(board, { userId: 'outsider', level: 0, xp: 0 });

        expect(result).toBeNull();
        expect(board.entries).toHaveLength(MAX_ENTRIES_PER_GUILD);
        expect(board.index.has('outsider')).toBe(false);
    });

    test('a user climbing into the window is inserted and the last entry falls out', () => {
        const board = makeBoard(population(MAX_ENTRIES_PER_GUILD), { truncated: true });
        const lastBefore = board.entries[board.entries.length - 1];

        const result = applyStanding(board, { userId: 'climber', level: 50, xp: 1 });

        expect(result.oldRank).toBeNull();
        expect(board.entries).toHaveLength(MAX_ENTRIES_PER_GUILD);
        expect(board.index.has('climber')).toBe(true);
        expect(board.index.has(lastBefore.userId)).toBe(false);
        // The index still maps every entry to its position.
        for (let i = 0; i < board.entries.length; i++) {
            expect(board.index.get(board.entries[i].userId)).toBe(i);
        }
    });

    test('an update to a user already inside the window behaves as before', () => {
        const board = makeBoard(population(MAX_ENTRIES_PER_GUILD), { truncated: true });

        const result = applyStanding(board, { userId: 'u150', level: 90, xp: 0 });

        expect(result.oldRank).toBe(151);
        // Passes everyone below level 90; the incumbent at exactly 90 keeps
        // the tie, as elsewhere.
        expect(result.newRank).toBe(112);
        expect(board.entries).toHaveLength(MAX_ENTRIES_PER_GUILD);
    });
});
