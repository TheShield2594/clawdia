'use strict';

// The dashboard's analytics panels are built from queries that read every user in
// a guild — a sort on a computed field that no index can serve, and two `$group`s
// with nothing to narrow them. Running each of those once is affordable; what was
// not affordable is that nothing stopped them running again on the next request.
//
// So what these tests pin is not "the value came back" but the three properties
// that make the memo worth having: a second caller inside the window does not
// reach the database, concurrent cold callers share one query rather than each
// starting their own, and a failure is not what the next thirty seconds of
// callers are handed.

const { cachedAggregate, invalidate, invalidatePrefix, __reset } = require('../src/dashboard/lib/aggregateCache');

beforeEach(() => __reset());

// A query that counts how many times it was actually run, and can be held open
// so two callers are provably in flight at the same time.
function countingQuery(value = 'result') {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fn = jest.fn(async () => {
        await gate;
        return value;
    });
    return { fn, release: () => release() };
}

describe('cachedAggregate', () => {
    test('runs the query once and serves the second caller from the memo', async () => {
        const fn = jest.fn().mockResolvedValue(42);

        expect(await cachedAggregate('g1:economy:total', fn)).toBe(42);
        expect(await cachedAggregate('g1:economy:total', fn)).toBe(42);

        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('two callers on a cold key share one query rather than starting two', async () => {
        const { fn, release } = countingQuery('shared');

        const first  = cachedAggregate('g1:economy:top', fn);
        const second = cachedAggregate('g1:economy:top', fn);
        release();

        expect(await first).toBe('shared');
        expect(await second).toBe('shared');
        // The point of the single-flight: N simultaneous requests on a cold key are
        // otherwise N simultaneous full scans, which is the read-flood shape exactly.
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('re-runs the query once the TTL has passed', async () => {
        const fn = jest.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

        expect(await cachedAggregate('g1:stats:users', fn, 5)).toBe('first');
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(await cachedAggregate('g1:stats:users', fn, 5)).toBe('second');

        expect(fn).toHaveBeenCalledTimes(2);
    });

    test('does not cache a rejection — the next caller retries', async () => {
        const fn = jest.fn()
            .mockRejectedValueOnce(new Error('mongo is having a moment'))
            .mockResolvedValueOnce('recovered');

        await expect(cachedAggregate('g1:stats:messages', fn)).rejects.toThrow('mongo is having a moment');
        // A cached failure would hand every caller the error for the rest of the TTL,
        // turning one blip into thirty seconds of a broken panel.
        expect(await cachedAggregate('g1:stats:messages', fn)).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test('a rejection does not evict a value another key already holds', async () => {
        const good = jest.fn().mockResolvedValue('kept');
        await cachedAggregate('g1:economy:total', good);

        await expect(cachedAggregate('g1:economy:top', jest.fn().mockRejectedValue(new Error('nope'))))
            .rejects.toThrow('nope');

        expect(await cachedAggregate('g1:economy:total', good)).toBe('kept');
        expect(good).toHaveBeenCalledTimes(1);
    });
});

describe('invalidation', () => {
    test('invalidate drops one key', async () => {
        const fn = jest.fn().mockResolvedValueOnce('before').mockResolvedValueOnce('after');

        await cachedAggregate('g1:economy:total', fn);
        invalidate('g1:economy:total');

        expect(await cachedAggregate('g1:economy:total', fn)).toBe('after');
    });

    test('invalidatePrefix drops one guild without touching another', async () => {
        const mine   = jest.fn().mockResolvedValueOnce('mine-before').mockResolvedValueOnce('mine-after');
        const theirs = jest.fn().mockResolvedValue('theirs');

        await cachedAggregate('111:economy:total', mine);
        await cachedAggregate('222:economy:total', theirs);

        // Keys are `<guildId>:<name>` so that this is possible at all: an admin
        // adjusting coins in one guild must not flush every other guild's panels.
        invalidatePrefix('111:');

        expect(await cachedAggregate('111:economy:total', mine)).toBe('mine-after');
        expect(await cachedAggregate('222:economy:total', theirs)).toBe('theirs');
        expect(theirs).toHaveBeenCalledTimes(1);
    });

    test('a query already in flight when its key is invalidated is not stored', async () => {
        const { fn, release } = countingQuery('stale');
        const fresh = jest.fn().mockResolvedValue('fresh');

        const inFlight = cachedAggregate('g1:economy:total', fn);
        invalidate('g1:economy:total');
        release();
        await inFlight;

        // The in-flight result predates whatever made the caller invalidate, so it
        // must not become the cached answer.
        expect(await cachedAggregate('g1:economy:total', fresh)).toBe('fresh');
    });
});
