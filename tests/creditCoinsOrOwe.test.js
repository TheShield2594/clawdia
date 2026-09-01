'use strict';

/**
 * #873. Three group payouts — the duel escrow, the heist share, the syndicate
 * share — each wrote their own "credit this player, and cope if it fails", and
 * each coped differently and wrongly. The two failures they had between them:
 *
 *   - An update whose filter matched no document resolves without rejecting, so
 *     `credited = true` on "it did not throw" counted a payout that moved
 *     nothing. That is #804 again, one subsystem over.
 *   - Retrying an unguarded `$inc` whose outcome is unknown pays twice.
 *
 * These drive the shared helper against a store that evaluates the payout-key
 * guard for real, because a mock that waved it through would report the retry
 * as safe when it is the exact thing the key makes safe.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const { creditCoinsOrOwe } = require('../src/utils/creditOrOwe');
const { recordOwedPayout } = require('../src/utils/owedPayout');

// The store's own implementations, captured before any test replaces one.
// `mockUsers.reset()` clears call records but leaves a `mockImplementation`
// standing, so a test that makes a write fail would make it fail for every test
// after it.
const storeImpl = new Map(Object.entries(mockUsers.model)
    .filter(([, fn]) => typeof fn?.getMockImplementation === 'function')
    .map(([name, fn]) => [name, fn.getMockImplementation()]));
const restoreStore = () => {
    for (const [name, impl] of storeImpl) mockUsers.model[name].mockImplementation(impl);
};

const GUILD = 'guild-1';
const USER  = 'user-1';
const WHO   = { userId: USER, guildId: GUILD };
const OPTS  = { payoutKey: 'crew:job-1:user-1', service: 'heistService', jobName: 'heistPayout' };

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    restoreStore();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('a credit that lands', () => {
    test('moves the coins and owes nothing', async () => {
        mockUsers.seed({ ...WHO, balance: 100 });

        const result = await creditCoinsOrOwe(WHO, 250, OPTS);

        expect(result).toMatchObject({ credited: true, owed: false });
        expect(mockUsers.get(USER).balance).toBe(350);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('records the key, so the same payout cannot be applied twice', async () => {
        mockUsers.seed({ ...WHO, balance: 100 });

        await creditCoinsOrOwe(WHO, 250, OPTS);
        const second = await creditCoinsOrOwe(WHO, 250, OPTS);

        // The second call is reported as a success — the payout has landed —
        // without moving a coin. Reporting it as owed instead would loop the
        // replay on a debt that was already settled.
        expect(second).toMatchObject({ credited: true, owed: false });
        expect(mockUsers.get(USER).balance).toBe(350);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('a credit that matched no document', () => {
    test('is not counted as a payout', async () => {
        // No seed: the crew member has no document in this guild.
        const result = await creditCoinsOrOwe(WHO, 250, OPTS);

        expect(result.credited).toBe(false);
    });

    test('is written down where the replay can find it', async () => {
        await creditCoinsOrOwe(WHO, 250, OPTS);

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'heistService',
            jobName: 'heistPayout',
            guildId: GUILD,
            // The payload shape `replayOwedPayout` knows how to pay, key
            // included — the syndicate's own record carried neither, so
            // `npm run payouts:replay` could not see it or settle it.
            payload: {
                kind: 'coins', userId: USER, guildId: GUILD,
                amount: 250, payoutKey: 'crew:job-1:user-1',
            },
        }));
    });

    test('is not retried — the document will still be missing', async () => {
        await creditCoinsOrOwe(WHO, 250, OPTS);

        expect(mockUsers.model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
});

describe('a credit that rejects', () => {
    test('is retried, and a retry after a write that had actually landed pays once', async () => {
        mockUsers.seed({ ...WHO, balance: 100 });
        const real = mockUsers.model.findOneAndUpdate.bind(mockUsers.model);
        jest.spyOn(mockUsers.model, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
            // The write commits and the response is lost, which is the case the
            // key exists for: the second attempt must not credit again.
            await real(...args);
            throw new Error('connection reset');
        });

        const result = await creditCoinsOrOwe(WHO, 250, OPTS);

        expect(result).toMatchObject({ credited: true, owed: false });
        expect(mockUsers.get(USER).balance).toBe(350);
    });

    test('is written down once every attempt has failed', async () => {
        mockUsers.seed({ ...WHO, balance: 100 });
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        const result = await creditCoinsOrOwe(WHO, 250, OPTS);

        expect(result).toMatchObject({ credited: false, owed: true });
        expect(recordOwedPayout).toHaveBeenCalledTimes(1);
    });

    test('reports the debt as unrecorded when the record itself will not write', async () => {
        recordOwedPayout.mockResolvedValue(false);
        mockUsers.seed({ ...WHO, balance: 100 });
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        // `owed: false` is the sentence a caller must word differently: the
        // coins are neither paid nor recoverable without a human.
        await expect(creditCoinsOrOwe(WHO, 250, OPTS)).resolves.toMatchObject({
            credited: false, owed: false,
        });
    });
});

describe('bookkeeping that travels with the credit', () => {
    test('moves the counters in the same write as the coins', async () => {
        mockUsers.seed({ ...WHO, balance: 100, lifetimeGambled: 250 });

        await creditCoinsOrOwe(WHO, 250, { ...OPTS, counters: { lifetimeGambled: -250 } });

        expect(mockUsers.get(USER)).toMatchObject({ balance: 350, lifetimeGambled: 0 });
    });

    test('does not move them when the credit does not land', async () => {
        mockUsers.seed({ ...WHO, balance: 100, lifetimeGambled: 250 });
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        await creditCoinsOrOwe(WHO, 250, { ...OPTS, counters: { lifetimeGambled: -250 } });

        expect(mockUsers.get(USER)).toMatchObject({ balance: 100, lifetimeGambled: 250 });
    });

    test('writes them into the owed record, so a replay reproduces the whole write', async () => {
        // Without this the replay pays the coins and leaves the counter where
        // the failed write left it — a stake put back a week later that still
        // counts as gambled.
        mockUsers.seed({ ...WHO, balance: 100 });
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        await creditCoinsOrOwe(WHO, 250, { ...OPTS, counters: { lifetimeGambled: -250 } });

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ counters: { lifetimeGambled: -250 } }),
        }));
    });

    test('leaves the field off the record when there are none', async () => {
        await creditCoinsOrOwe(WHO, 250, OPTS);

        const [{ payload }] = recordOwedPayout.mock.calls[0];
        expect(payload).not.toHaveProperty('counters');
    });
});

describe('never rejecting', () => {
    // Two sequential crew-payout loops and one `Promise.all` over refunds all
    // depend on this: one share that could not be written down must not abandon
    // the shares after it.
    test('survives a counters value it cannot build a write from', async () => {
        // Computed inside the retry guard, so a bad one is an owed record
        // rather than a rejection that abandons the rest of a crew payout.
        mockUsers.seed({ ...WHO, balance: 100 });

        await expect(creditCoinsOrOwe(WHO, 250, { ...OPTS, counters: null }))
            .resolves.toMatchObject({ credited: true });
    });

    test('survives a recording failure that throws rather than returning false', async () => {
        recordOwedPayout.mockRejectedValue(new Error('the queue is down too'));
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        await expect(creditCoinsOrOwe(WHO, 250, OPTS)).resolves.toMatchObject({
            credited: false, owed: false,
        });
    });
});

describe('an amount that is not a payout', () => {
    test.each([0, -50, NaN])('%p moves nothing and owes nothing', async amount => {
        mockUsers.seed({ ...WHO, balance: 100 });

        await expect(creditCoinsOrOwe(WHO, amount, OPTS)).resolves.toMatchObject({
            credited: true, owed: false,
        });
        expect(mockUsers.get(USER).balance).toBe(100);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});
