'use strict';

/**
 * #873, pass 8. `creditEventCurrencyOrOwe` is `creditCoinsOrOwe` for the seasonal
 * event currency — candy, hearts, snowflakes — which lives in the `eventCurrency`
 * array rather than in `balance`. It has the same two failures to guard against:
 *
 *   - a credit whose filter matched no document resolves without rejecting, so
 *     "it did not throw" must not count as a payout (the #804 shape);
 *   - retrying a write whose outcome is unknown must not credit twice.
 *
 * These drive the helper against a store that evaluates the payout-key guard and
 * the bump-or-append credit pipeline for real, the same way `creditCoinsOrOwe`'s
 * suite does — a mock that waved either through would report the retry as safe
 * when the key is the only reason it is. `tests/eventCurrencyPayoutRecovery.test.js`
 * covers the happy paths and the call sites; this covers the failure branches.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [], eventCurrency: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const { creditEventCurrencyOrOwe } = require('../src/utils/creditOrOwe');
const { recordOwedPayout } = require('../src/utils/owedPayout');

// The store's own implementations, captured before any test replaces one, so a
// test that makes a write fail does not make it fail for every test after it.
const storeImpl = new Map(Object.entries(mockUsers.model)
    .filter(([, fn]) => typeof fn?.getMockImplementation === 'function')
    .map(([name, fn]) => [name, fn.getMockImplementation()]));
const restoreStore = () => {
    for (const [name, impl] of storeImpl) mockUsers.model[name].mockImplementation(impl);
};

const GUILD = 'guild-1';
const USER  = 'user-1';
const WHO   = { userId: USER, guildId: GUILD };
const OPTS  = { payoutKey: 'event:trickortreat:i1:currency', service: 'trickortreat', jobName: 'candyReward' };
const candyOf = () => mockUsers.get(USER).eventCurrency.find(e => e.currencyId === 'candy')?.amount ?? 0;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    restoreStore();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('a credit that lands', () => {
    test('moves the currency and owes nothing', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'candy', amount: 10 }] });

        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);

        expect(result).toMatchObject({ credited: true, owed: false });
        expect(candyOf()).toBe(15);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('records the key, so the same payout cannot be applied twice', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [] });

        await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);
        const second = await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);

        expect(second).toMatchObject({ credited: true, owed: false });
        expect(candyOf()).toBe(5);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('a credit that matched no document', () => {
    test('is not counted as a payout, and is written down for the replay', async () => {
        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);

        expect(result.credited).toBe(false);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'trickortreat',
            jobName: 'candyReward',
            guildId: GUILD,
            payload: {
                kind: 'eventCurrency', userId: USER, guildId: GUILD,
                currencyId: 'candy', amount: 5, payoutKey: 'event:trickortreat:i1:currency',
            },
        }));
    });

    test('is not retried — the document will still be missing', async () => {
        await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);
        expect(mockUsers.model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
});

describe('a credit that misses while the key is absent', () => {
    test('is treated as unknown and retried, not written down as missing', async () => {
        // Present document, key absent, but the guarded update returns null:
        // a concurrent write. `classifyUnmatchedPayout` reads 'unknown', which
        // must retry rather than be recorded as a missing-document owe. The
        // retry then lands against the real store.
        mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'candy', amount: 0 }] });
        mockUsers.model.findOneAndUpdate.mockResolvedValueOnce(null);

        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);

        expect(result).toMatchObject({ credited: true, owed: false });
        expect(candyOf()).toBe(5);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('a credit that rejects', () => {
    test('is retried, and a retry after a write that had actually landed credits once', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [] });
        const real = mockUsers.model.findOneAndUpdate.bind(mockUsers.model);
        jest.spyOn(mockUsers.model, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
            // Commits, then loses its response — the case the key exists for.
            await real(...args);
            throw new Error('connection reset');
        });

        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);

        expect(result).toMatchObject({ credited: true, owed: false });
        expect(candyOf()).toBe(5);
    });

    test('is written down once every attempt has failed', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [] });
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS);

        expect(result).toMatchObject({ credited: false, owed: true });
        expect(recordOwedPayout).toHaveBeenCalledTimes(1);
    });

    test('reports the debt as unrecorded when the record itself will not write', async () => {
        recordOwedPayout.mockResolvedValue(false);
        mockUsers.seed({ ...WHO, eventCurrency: [] });
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        await expect(creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS)).resolves.toMatchObject({
            credited: false, owed: false,
        });
    });
});

describe('never rejecting', () => {
    test('survives a recording failure that throws rather than returning false', async () => {
        recordOwedPayout.mockRejectedValue(new Error('the queue is down too'));
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        await expect(creditEventCurrencyOrOwe(WHO, 'candy', 5, OPTS)).resolves.toMatchObject({
            credited: false, owed: false,
        });
    });
});

describe('an amount or currency that is not a payout', () => {
    test.each([0, -50, NaN])('amount %p moves nothing and owes nothing', async amount => {
        mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'candy', amount: 10 }] });

        await expect(creditEventCurrencyOrOwe(WHO, 'candy', amount, OPTS)).resolves.toMatchObject({
            credited: true, owed: false,
        });
        expect(candyOf()).toBe(10);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a null currency id moves nothing and owes nothing', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [] });

        await expect(creditEventCurrencyOrOwe(WHO, null, 5, OPTS)).resolves.toMatchObject({
            credited: true, owed: false,
        });
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});
