'use strict';

// The action lock gates money — two /casino games or two /fish casts for one
// user racing each other's debits. It used to live in a process-local `Map`, so
// a restart dropped every lease and a second instance shared none of them, and
// since there is no sharding scaffolding anywhere in src/ a second instance
// would have double-paid users rather than scaled them. It is a Mongo document
// now, acquired with a conditional upsert.
//
// The fake below implements exactly the three model calls the lock makes, with
// the semantics Mongo gives them — in particular the unique index on `key`
// rejecting an upsert insert, which is what "already held" actually is. Without
// that the tests would prove nothing about the mechanism under test.

const mockLocks = new Map(); // key -> { key, token, expiresAt }

jest.mock('../src/models/ActiveLock', () => ({
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
        const existing = mockLocks.get(filter.key);
        const doc = { ...update.$set };

        // The filter is { key, expiresAt: { $lte: now } }: it matches an expired
        // lock, and misses both a live one and a key with no document at all.
        if (existing && existing.expiresAt <= filter.expiresAt.$lte) {
            mockLocks.set(filter.key, doc);
            return options.new ? doc : existing;
        }
        if (existing) {
            // Live lock: the upsert falls through to an insert, which the unique
            // index rejects.
            const err = new Error('E11000 duplicate key error collection: activelocks index: key_1');
            err.code = 11000;
            throw err;
        }
        mockLocks.set(filter.key, doc);
        return options.new ? doc : null;
    }),
    deleteOne: jest.fn(async (filter) => {
        const existing = mockLocks.get(filter.key);
        if (!existing || existing.token !== filter.token) return { deletedCount: 0 };
        mockLocks.delete(filter.key);
        return { deletedCount: 1 };
    }),
}));

const ActiveLock = require('../src/models/ActiveLock');
const { tryAcquire, release } = require('../src/utils/activeGameLock');
const { luckySaveEligible, LUCKY_SAVE_MAX_BET } = require('../src/services/effectsService');

beforeEach(() => {
    mockLocks.clear();
    jest.clearAllMocks();
});

describe('activeGameLock', () => {
    test('acquires a free lock and returns a token', async () => {
        const token = await tryAcquire('test:1');
        expect(token).toBeTruthy();
        await expect(release('test:1', token)).resolves.toBe(true);
    });

    test('rejects a second acquire while held', async () => {
        const token = await tryAcquire('test:2');
        expect(token).toBeTruthy();
        await expect(tryAcquire('test:2')).resolves.toBeNull();
        await release('test:2', token);
    });

    test('can re-acquire after release', async () => {
        const token = await tryAcquire('test:3');
        await expect(release('test:3', token)).resolves.toBe(true);
        const token2 = await tryAcquire('test:3');
        expect(token2).toBeTruthy();
        await release('test:3', token2);
    });

    test('expired locks can be re-acquired (TTL backstop)', async () => {
        expect(await tryAcquire('test:4', -1)).toBeTruthy(); // already expired
        const token = await tryAcquire('test:4');
        expect(token).toBeTruthy();
        await release('test:4', token);
    });

    test('release is token-validated — a stale holder cannot free a new lease', async () => {
        const tokenA = await tryAcquire('test:5', -1); // expires immediately
        const tokenB = await tryAcquire('test:5');     // new flow takes over after expiry
        expect(tokenB).toBeTruthy();
        expect(tokenB).not.toBe(tokenA);

        // The stale holder's release must be a no-op…
        await expect(release('test:5', tokenA)).resolves.toBe(false);
        // …leaving the lock still held by the new lease
        await expect(tryAcquire('test:5')).resolves.toBeNull();

        // The rightful owner can release it
        await expect(release('test:5', tokenB)).resolves.toBe(true);
        const token = await tryAcquire('test:5');
        expect(token).toBeTruthy();
        await release('test:5', token);
    });

    test('release without a matching token is a no-op', async () => {
        const token = await tryAcquire('test:6');
        await expect(release('test:6', 'bogus-token')).resolves.toBe(false);
        await expect(tryAcquire('test:6')).resolves.toBeNull(); // still held
        await expect(release('test:6', token)).resolves.toBe(true);
    });

    test('release of a missing token is a no-op rather than a throw', async () => {
        await expect(release('test:6b', null)).resolves.toBe(false);
        await expect(release('test:6b', undefined)).resolves.toBe(false);
    });

    test('locks are independent per key', async () => {
        const a = await tryAcquire('test:7a');
        const b = await tryAcquire('test:7b');
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
        await release('test:7a', a);
        await release('test:7b', b);
    });

    // ── The properties that only matter now that the lock is shared state ────

    test('the lease is persisted, not held in this process', async () => {
        await tryAcquire('test:8');
        expect(ActiveLock.findOneAndUpdate).toHaveBeenCalledTimes(1);
        const [filter, update] = ActiveLock.findOneAndUpdate.mock.calls[0];
        expect(filter.key).toBe('test:8');
        expect(filter.expiresAt.$lte).toBeInstanceOf(Date);
        expect(update.$set.expiresAt).toBeInstanceOf(Date);
    });

    test('a lock taken by another process is visible to this one', async () => {
        // What the Map could not do: the lease exists without this process ever
        // having acquired it.
        mockLocks.set('test:9', {
            key: 'test:9',
            token: 'held-by-another-process',
            expiresAt: new Date(Date.now() + 60_000),
        });
        await expect(tryAcquire('test:9')).resolves.toBeNull();
    });

    test('a lease left behind by a crashed process is taken over once expired', async () => {
        mockLocks.set('test:10', {
            key: 'test:10',
            token: 'orphaned',
            expiresAt: new Date(Date.now() - 1),
        });
        const token = await tryAcquire('test:10');
        expect(token).toBeTruthy();
        expect(token).not.toBe('orphaned');
    });

    test('concurrent acquires of one key produce exactly one winner', async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, () => tryAcquire('test:11')),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('tokens are unique across attempts so one lease cannot free another', async () => {
        const tokens = new Set();
        for (let i = 0; i < 50; i++) {
            const key = `test:12:${i}`;
            const token = await tryAcquire(key);
            tokens.add(token);
            await release(key, token);
        }
        expect(tokens.size).toBe(50);
    });

    test('refuses the action when the database errors rather than letting it through', async () => {
        // Failing closed is the right answer for something that gates money.
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        ActiveLock.findOneAndUpdate.mockRejectedValueOnce(new Error('connection lost'));
        await expect(tryAcquire('test:13')).resolves.toBeNull();
        errorSpy.mockRestore();
    });

    test('a failed release leaves the lease to expire instead of throwing', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const token = await tryAcquire('test:14');
        ActiveLock.deleteOne.mockRejectedValueOnce(new Error('connection lost'));
        await expect(release('test:14', token)).resolves.toBe(false);
        errorSpy.mockRestore();
    });
});

describe('luckySaveEligible', () => {
    test('allows low-stakes bets', () => {
        expect(luckySaveEligible(10)).toBe(true);
        expect(luckySaveEligible(LUCKY_SAVE_MAX_BET)).toBe(true);
    });

    test('blocks bets above the cap', () => {
        expect(luckySaveEligible(LUCKY_SAVE_MAX_BET + 1)).toBe(false);
        expect(luckySaveEligible(1_000_000_000)).toBe(false);
    });
});
