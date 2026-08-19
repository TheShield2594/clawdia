'use strict';

// checkRivalry runs on every XP-earning message. It used to answer "did this
// player pass anyone?" by rebuilding the guild's entire leaderboard array and
// re-sorting it — 0.26 ms at 1k members, 2.0 ms at 10k, 14 ms at 50k, each time,
// synchronously, on the event loop. It then threw the answer away for anyone
// outside the top 100.
//
// The standings are already sorted, and one player's XP gain moves exactly one
// entry, so the update is now a shift across the span they actually crossed.
// These tests pin two things: that the cheap update lands in the same order a
// full sort would have produced, and that it stays cheap.

const { __test__ } = require('../src/services/rivalryService');
const { applyStanding, compare, buildIndex } = __test__;

/** The reference answer: what the previous rebuild-and-sort produced. */
function referenceOrder(entries, savedUser) {
    const updated = entries.map(e =>
        e.userId === savedUser.userId ? { ...savedUser } : { ...e });
    if (!updated.some(e => e.userId === savedUser.userId)) updated.push({ ...savedUser });
    updated.sort(compare);
    return updated.map(e => e.userId);
}

function makeBoard(entries) {
    const sorted = entries.slice().sort(compare);
    return { entries: sorted, index: buildIndex(sorted), updatedAt: Date.now() };
}

/** A deterministic pseudo-random source, so a failure is reproducible. */
function seeded(seed) {
    let s = seed;
    return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
}

function population(size, rand) {
    return Array.from({ length: size }, (_, i) => ({
        userId: `u${i}`,
        level:  Math.floor(rand() * 30),
        xp:     Math.floor(rand() * 5_000),
    }));
}

describe('applyStanding orders exactly as the full re-sort did', () => {
    test('an XP gain lands the climber where a sort would have put them', () => {
        const board = makeBoard(population(200, seeded(7)));
        const target = board.entries[120];
        const saved = { userId: target.userId, level: target.level, xp: target.xp + 4_000 };

        const expected = referenceOrder(board.entries, saved);
        applyStanding(board, saved);

        expect(board.entries.map(e => e.userId)).toEqual(expected);
    });

    test('a level-up jumps the player over everyone below the new level', () => {
        const board = makeBoard(population(200, seeded(11)));
        const target = board.entries[199];
        const saved = { userId: target.userId, level: 99, xp: 0 };

        const expected = referenceOrder(board.entries, saved);
        const { newRank } = applyStanding(board, saved);

        expect(newRank).toBe(1);
        expect(board.entries.map(e => e.userId)).toEqual(expected);
    });

    test('a player who lost XP slides back down to the right place', () => {
        // Prestige and admin corrections both move XP the other way; the shift
        // has to run downward too, or the cache orders wrongly from then on.
        const board = makeBoard(population(200, seeded(13)));
        const target = board.entries[10];
        const saved = { userId: target.userId, level: 0, xp: 0 };

        const expected = referenceOrder(board.entries, saved);
        applyStanding(board, saved);

        expect(board.entries.map(e => e.userId)).toEqual(expected);
    });

    test('a member not yet in the cache is inserted in order', () => {
        const board = makeBoard(population(50, seeded(17)));
        const saved = { userId: 'newcomer', level: 12, xp: 900 };

        const expected = referenceOrder(board.entries, saved);
        const { oldRank, newRank } = applyStanding(board, saved);

        expect(oldRank).toBeNull();
        expect(board.entries.map(e => e.userId)).toEqual(expected);
        expect(board.entries[newRank - 1].userId).toBe('newcomer');
    });

    test('a thousand updates in a row keep the cache sorted and indexed', () => {
        const rand = seeded(23);
        const board = makeBoard(population(300, rand));

        for (let i = 0; i < 1_000; i++) {
            const at = Math.floor(rand() * board.entries.length);
            const entry = board.entries[at];
            const saved = {
                userId: entry.userId,
                level:  entry.level + (rand() < 0.05 ? 1 : 0),
                xp:     entry.xp + Math.floor(rand() * 30),
            };
            const expected = referenceOrder(board.entries, saved);
            applyStanding(board, saved);
            expect(board.entries.map(e => e.userId)).toEqual(expected);
        }

        // The index is the only reason a lookup is O(1); a drifted one would
        // silently start reporting the wrong old rank.
        for (let i = 0; i < board.entries.length; i++) {
            expect(board.index.get(board.entries[i].userId)).toBe(i);
        }
    });
});

describe('applyStanding reports the climb the DMs are built from', () => {
    const board = () => makeBoard([
        { userId: 'a', level: 5, xp: 900 },
        { userId: 'b', level: 5, xp: 800 },
        { userId: 'c', level: 5, xp: 700 },
        { userId: 'd', level: 5, xp: 600 },
        { userId: 'e', level: 5, xp: 500 },
    ]);

    test('names everyone passed, with the rank each one now holds', () => {
        const result = applyStanding(board(), { userId: 'e', level: 5, xp: 850 });

        expect(result).toEqual({
            oldRank: 5,
            newRank: 2,
            overtaken: [
                { userId: 'b', rank: 3 },
                { userId: 'c', rank: 4 },
                { userId: 'd', rank: 5 },
            ],
        });
    });

    test('a gain that passes nobody reports an empty climb', () => {
        const result = applyStanding(board(), { userId: 'c', level: 5, xp: 750 });
        expect(result).toMatchObject({ oldRank: 3, newRank: 3, overtaken: [] });
    });

    test('a tie leaves the incumbent ahead, as the sort did', () => {
        // compare() returns 0 for equal level and XP, and a stable sort kept the
        // entry that was already there first. The shift stops at the tie for the
        // same reason — nobody gets a "you were passed" DM for a draw.
        const result = applyStanding(board(), { userId: 'd', level: 5, xp: 700 });
        expect(result).toMatchObject({ newRank: 4, overtaken: [] });
    });
});

describe('the update stays cheap as the guild grows', () => {
    /** Counts how many entries the update actually reads. */
    function countingBoard(entries) {
        const built = makeBoard(entries);
        const reads = { count: 0 };
        const proxy = new Proxy(built.entries, {
            get(target, prop, receiver) {
                if (typeof prop === 'string' && /^\d+$/.test(prop)) reads.count++;
                return Reflect.get(target, prop, receiver);
            },
        });
        return { board: { ...built, entries: proxy }, reads };
    }

    test('a routine XP gain touches a handful of entries, not the guild', () => {
        const { board, reads } = countingBoard(population(50_000, seeded(29)));

        // Someone mid-table gains enough to pass a few neighbours.
        const target = board.entries[25_000];
        reads.count = 0;
        applyStanding(board, { userId: target.userId, level: target.level, xp: target.xp + 1 });

        expect(reads.count).toBeLessThan(50);
    });

    test('the cached array is updated in place, never rebuilt', () => {
        // The allocation was half the cost: a fresh N-element array per message.
        const board = makeBoard(population(1_000, seeded(31)));
        const before = board.entries;
        applyStanding(board, { userId: 'u500', level: 99, xp: 99 });
        expect(board.entries).toBe(before);
    });
});
