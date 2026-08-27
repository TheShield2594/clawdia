'use strict';

/**
 * `retryJob` is what replays a dead-letter entry, and until #804 gave it the
 * owed-payout script nothing called it — so nothing had ever executed it.
 *
 * The handler is what moves the money. Two operators running
 * `npm run payouts:replay -- --pay` at once must not both reach it for the same
 * record: that is a second `$inc`, or a second inventory grant, which is the
 * exact failure the owed queue exists to avoid.
 *
 * The first attempt at this used a compare-and-set on `attempts`, which is not
 * enough: it stops two runs that read the same pre-claim state, but a run that
 * reads *after* the other's claim sees the incremented value and matches on it.
 * Hence the lease, and hence the sequential test below — the one the CAS passed
 * and should not have.
 */

jest.mock('../src/models/FailedJob', () => ({ findById: jest.fn(), findOneAndUpdate: jest.fn() }));

const FailedJob = require('../src/models/FailedJob');
const { retryJob, claimableFilter, RETRY_LEASE_MS } = require('../src/utils/jobRunner');

/**
 * One FailedJob document, with `findOneAndUpdate` evaluating the claim filter
 * the way the server does — including the `$or` over the lease, which is the
 * whole point of the exercise.
 */
function stubRecord(over = {}) {
    const doc = {
        _id: 'f1', payload: { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 },
        attempts: 0, maxAttempts: 3, status: 'pending',
        errorMessage: 'mongo down', errorStack: null,
        claimedAt: null, claimedBy: null,
        resolvedAt: null, resolvedBy: null, lastAttemptAt: new Date(0),
        save: jest.fn(async () => doc),
        ...over,
    };

    // A snapshot, the way the driver hands one back — not a live reference to
    // the document a claim mutates.
    FailedJob.findById.mockImplementation(async () => ({ ...doc }));

    FailedJob.findOneAndUpdate.mockImplementation(async (filter, update) => {
        if (filter._id !== doc._id) return null;
        if (!filter.status.$in.includes(doc.status)) return null;

        const [free, expired] = filter.$or;
        const leaseIsFree = doc.claimedAt === null || doc.claimedAt === undefined;
        const leaseIsStale = doc.claimedAt != null && doc.claimedAt <= expired.claimedAt.$lte;
        if (!(free.claimedAt === null && leaseIsFree) && !leaseIsStale) return null;

        doc.attempts += update.$inc.attempts;
        Object.assign(doc, update.$set);
        return doc;
    });
    return doc;
}

/** Resolves once `release()` is called. */
function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}

beforeEach(() => jest.clearAllMocks());

describe('claimableFilter', () => {
    test('matches a free lease and one older than the window, not a live one', () => {
        const now = new Date('2026-08-27T00:10:00Z');
        const filter = claimableFilter(now);

        expect(filter.status).toEqual({ $in: ['pending', 'retrying'] });
        // `{ claimedAt: null }` also matches a document that has no claimedAt at
        // all, which is every record written before the field existed.
        expect(filter.$or[0]).toEqual({ claimedAt: null });
        expect(filter.$or[1].claimedAt.$lte).toEqual(new Date(now.getTime() - RETRY_LEASE_MS));
    });
});

describe('retryJob', () => {
    test('runs the handler with the stored payload and resolves the record', async () => {
        const doc = stubRecord();
        const handler = jest.fn().mockResolvedValue(undefined);

        const after = await retryJob('f1', handler, 'an-operator');

        expect(handler).toHaveBeenCalledWith(doc.payload);
        expect(after.status).toBe('resolved');
        expect(after.resolvedBy).toBe('an-operator');
        expect(after.attempts).toBe(1);
    });

    test('claims the record before the handler runs, not after', async () => {
        stubRecord();
        const order = [];
        FailedJob.findOneAndUpdate.mockImplementation(async () => {
            order.push('claim');
            return { attempts: 1, maxAttempts: 3, payload: {}, save: jest.fn() };
        });

        await retryJob('f1', async () => { order.push('handler'); });

        expect(order).toEqual(['claim', 'handler']);
    });

    test('releases the lease whichever way the handler ends', async () => {
        stubRecord();

        const resolved = await retryJob('f1', async () => {});
        expect(resolved.claimedAt).toBeNull();
        expect(resolved.claimedBy).toBeNull();

        stubRecord();
        const failed = await retryJob('f1', async () => { throw new Error('still down'); });
        // Back to pending with no lease, so the next run can take it straight
        // away rather than waiting out a window nobody is holding.
        expect(failed.status).toBe('pending');
        expect(failed.claimedAt).toBeNull();
    });

    // Two runs that read the same pre-claim state.
    test('two runs starting together: only one reaches the handler', async () => {
        stubRecord();
        const handler = jest.fn().mockResolvedValue(undefined);

        const results = await Promise.allSettled([retryJob('f1', handler), retryJob('f1', handler)]);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(results.find(r => r.status === 'rejected').reason.message)
            .toMatch(/already being retried/);
    });

    // The one a compare-and-set on `attempts` alone gets wrong: the second run
    // reads *after* the first has claimed, so it sees the incremented value and
    // matches on it. Only the lease refuses it.
    test('a run arriving while another holds the record never reaches the handler', async () => {
        stubRecord();
        const held = gate();
        const handler = jest.fn()
            .mockImplementationOnce(() => held.promise)
            .mockImplementation(async () => {});

        const first = retryJob('f1', handler);
        // Let the first run claim and enter its handler before the second reads.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        await expect(retryJob('f1', handler)).rejects.toThrow(/already being retried/);

        held.release();
        await first;
        expect(handler).toHaveBeenCalledTimes(1);
    });

    // A run that died holding the record. Refusing these outright would close
    // the race by stranding them forever instead.
    test('a lease older than the window is reclaimable', async () => {
        stubRecord({
            status: 'retrying',
            attempts: 1,
            claimedAt: new Date(Date.now() - RETRY_LEASE_MS - 1000),
            claimedBy: 'a-run-that-died',
        });
        const handler = jest.fn().mockResolvedValue(undefined);

        const after = await retryJob('f1', handler, 'the-next-operator');

        expect(handler).toHaveBeenCalled();
        expect(after.status).toBe('resolved');
        expect(after.attempts).toBe(2);
    });

    test('a record written before the lease field existed is claimable', async () => {
        const doc = stubRecord();
        delete doc.claimedAt;
        const handler = jest.fn().mockResolvedValue(undefined);

        await retryJob('f1', handler);

        expect(handler).toHaveBeenCalled();
    });

    test('a handler that throws leaves the record pending for another attempt', async () => {
        stubRecord();

        const after = await retryJob('f1', async () => { throw new Error('still down'); });

        expect(after.status).toBe('pending');
        expect(after.errorMessage).toBe('still down');
        expect(after.attempts).toBe(1);
    });

    test('the last permitted attempt exhausts the record rather than looping', async () => {
        stubRecord({ attempts: 2, maxAttempts: 3 });

        const after = await retryJob('f1', async () => { throw new Error('still down'); });

        expect(after.attempts).toBe(3);
        expect(after.status).toBe('exhausted');
    });

    test.each([
        ['resolved',  'Job already resolved'],
        ['exhausted', 'Job exhausted'],
    ])('refuses a %s record without touching the handler', async (status, message) => {
        stubRecord({ status });
        const handler = jest.fn();

        await expect(retryJob('f1', handler)).rejects.toThrow(message);
        expect(handler).not.toHaveBeenCalled();
    });

    test('refuses an id no record has', async () => {
        FailedJob.findOneAndUpdate.mockResolvedValue(null);
        FailedJob.findById.mockResolvedValue(null);

        await expect(retryJob('nope', jest.fn())).rejects.toThrow('FailedJob not found');
    });
});
