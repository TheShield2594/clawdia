'use strict';

// #617: one User document read, mutated by four services, saved once. Correct
// per message, and a lost update the moment two of the same user's messages
// overlap — `save()` writes every modified path as an absolute `$set`, so the
// second write puts XP, quest progress and streak state back to what they were
// before the first message.

const { withUserLock, pendingLocks, DEFAULT_TIMEOUT_MS } = require('../src/utils/userMutex');

const tick = ms => new Promise(r => setTimeout(r, ms));

describe('withUserLock', () => {
    test('two flows on the same key do not interleave their read-modify-write', async () => {
        let stored = 0;

        // The exact shape the message pipeline has: read, await, write back.
        const readModifyWrite = () => withUserLock('guild1:author1', async () => {
            const loaded = stored;
            await tick(10);
            stored = loaded + 1;
        });

        await Promise.all([readModifyWrite(), readModifyWrite(), readModifyWrite()]);

        expect(stored).toBe(3);
    });

    test('without the lock the same flows lose an update — the bug this exists for', async () => {
        let stored = 0;
        const unlocked = async () => {
            const loaded = stored;
            await tick(10);
            stored = loaded + 1;
        };

        await Promise.all([unlocked(), unlocked(), unlocked()]);

        expect(stored).toBe(1);
    });

    test('different keys run concurrently', async () => {
        const order = [];
        await Promise.all([
            withUserLock('a', async () => { await tick(20); order.push('a'); }),
            withUserLock('b', async () => { await tick(1);  order.push('b'); }),
        ]);

        expect(order).toEqual(['b', 'a']);
    });

    test('the runner keeps its return value and its rejection', async () => {
        await expect(withUserLock('k', async () => 'value')).resolves.toBe('value');
        await expect(withUserLock('k', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    });

    test('a flow that throws does not wedge the next one on the same key', async () => {
        const failed = withUserLock('k', async () => { throw new Error('boom'); });
        const after  = withUserLock('k', async () => 'ran');

        await expect(failed).rejects.toThrow('boom');
        await expect(after).resolves.toBe('ran');
    });

    test('the queue drains — no entry is kept for a key with no work in flight', async () => {
        await Promise.all([
            withUserLock('x', async () => tick(5)),
            withUserLock('x', async () => tick(5)),
            withUserLock('y', async () => tick(5)),
        ]);

        expect(pendingLocks()).toBe(0);
    });

    test('a holder that never settles blocks its key only until the timeout', async () => {
        jest.useFakeTimers();
        try {
            let ran = false;
            const stuck = withUserLock('hung', () => new Promise(() => {}));
            const next  = withUserLock('hung', async () => { ran = true; });

            await Promise.resolve();
            expect(ran).toBe(false);

            jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
            await next;

            expect(ran).toBe(true);
            expect(stuck).toBeInstanceOf(Promise);
        } finally {
            jest.useRealTimers();
        }
    });
});
