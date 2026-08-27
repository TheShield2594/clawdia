'use strict';

/**
 * `retryJob` is what replays a dead-letter entry, and until #804 gave it the
 * owed-payout script nothing called it — so nothing had ever executed it.
 *
 * The handler is what moves the money. Two operators running
 * `npm run payouts:replay -- --pay` at once must not both reach it for the same
 * record: that is a second `$inc`, or a second inventory grant, which is the
 * exact failure the owed queue exists to avoid.
 */

jest.mock('../src/models/FailedJob', () => ({ findById: jest.fn(), findOneAndUpdate: jest.fn() }));

const FailedJob = require('../src/models/FailedJob');
const { retryJob } = require('../src/utils/jobRunner');

/**
 * A stand-in for one FailedJob document, with `findOneAndUpdate` behaving the
 * way the server does: the compare-and-set on `attempts` matches at most once.
 */
function stubRecord(over = {}) {
    const doc = {
        _id: 'f1', payload: { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 },
        attempts: 0, maxAttempts: 3, status: 'pending',
        errorMessage: 'mongo down', errorStack: null,
        resolvedAt: null, resolvedBy: null, lastAttemptAt: new Date(0),
        save: jest.fn(async () => doc),
        ...over,
    };

    // A snapshot, the way the driver hands one back — not a live reference to
    // the document the claim below mutates. Returning the live object would let
    // a racing caller read the winner's post-claim `attempts` and match on it,
    // which is a property of the stub and not of any real database.
    FailedJob.findById.mockImplementation(async () => ({ ...doc }));
    FailedJob.findOneAndUpdate.mockImplementation(async (filter, update) => {
        if (filter._id !== doc._id) return null;
        if (!filter.status.$in.includes(doc.status)) return null;
        // The CAS. A run whose read is stale no longer matches.
        if (filter.attempts !== doc.attempts) return null;
        doc.attempts += update.$inc.attempts;
        doc.status = update.$set.status;
        doc.lastAttemptAt = update.$set.lastAttemptAt;
        return doc;
    });
    return doc;
}

beforeEach(() => jest.clearAllMocks());

describe('retryJob', () => {
    test('runs the handler with the stored payload and resolves the record', async () => {
        const doc = stubRecord();
        const handler = jest.fn().mockResolvedValue(undefined);

        const after = await retryJob('f1', handler, 'an-operator');

        expect(handler).toHaveBeenCalledWith(doc.payload);
        expect(after.status).toBe('resolved');
        expect(after.resolvedBy).toBe('an-operator');
        expect(after.resolvedAt).toBeInstanceOf(Date);
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

        // The other way round is the whole bug: the window between deciding a
        // record is retriable and marking it is a window two runs fit through.
        expect(order).toEqual(['claim', 'handler']);
    });

    // The race, played out. Both runs read the record while it is pending;
    // only one may reach the handler.
    test('a second run racing the same record never reaches the handler', async () => {
        stubRecord();
        const handler = jest.fn().mockResolvedValue(undefined);

        const [first, second] = await Promise.allSettled([
            retryJob('f1', handler),
            retryJob('f1', handler),
        ]);

        expect(handler).toHaveBeenCalledTimes(1);
        const outcomes = [first.status, second.status].sort();
        expect(outcomes).toEqual(['fulfilled', 'rejected']);
        const loser = first.status === 'rejected' ? first : second;
        expect(loser.reason.message).toMatch(/already being retried/);
    });

    test('a record another run advanced between the read and the claim is refused', async () => {
        const doc = stubRecord();
        FailedJob.findById.mockImplementation(async () => {
            // Hand back the state as it was before the other run claimed it.
            const stale = { ...doc, attempts: doc.attempts };
            doc.attempts += 1;
            return stale;
        });
        const handler = jest.fn();

        await expect(retryJob('f1', handler)).rejects.toThrow(/already being retried/);
        expect(handler).not.toHaveBeenCalled();
    });

    // A run that died mid-replay leaves the record `retrying`. Refusing those
    // outright would close the race by stranding them forever instead.
    test('a record stranded in retrying by a dead run can still be claimed', async () => {
        stubRecord({ status: 'retrying', attempts: 1 });
        const handler = jest.fn().mockResolvedValue(undefined);

        const after = await retryJob('f1', handler);

        expect(handler).toHaveBeenCalled();
        expect(after.status).toBe('resolved');
        expect(after.attempts).toBe(2);
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
        expect(FailedJob.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('refuses an id no record has', async () => {
        FailedJob.findById.mockResolvedValue(null);

        await expect(retryJob('nope', jest.fn())).rejects.toThrow('FailedJob not found');
    });
});
