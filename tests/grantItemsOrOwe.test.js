'use strict';

/**
 * #873. `creditCoinsOrOwe` for the half of the economy that moves items.
 *
 * Three unwind paths — `/market list`'s stock return, `/market cancel`'s, and
 * `/gift`'s item rollback — each wrote their own version, and between them they
 * had the same two failures the coin side had:
 *
 *   - `grantInventoryItem` answers `null` rather than throwing when no document
 *     matched, so reading the absence of a throw as success reported a return
 *     that moved nothing. Two of the three did exactly that.
 *   - A retried, unguarded credit whose outcome is unknown grants twice.
 *
 * Driven against a store that evaluates the payout-key guard for real, because a
 * mock that waved it through would report the retry as safe when the key is the
 * only reason it is.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, inventory: [], paidPayouts: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const { grantItemsOrOwe } = require('../src/utils/creditOrOwe');
const { recordOwedPayout } = require('../src/utils/owedPayout');

// The store's own implementations, captured before any test replaces one:
// `reset()` clears call records but leaves a `mockImplementation` standing, so a
// test that makes a write fail would make it fail for every test after it.
const storeImpl = new Map(Object.entries(mockUsers.model)
    .filter(([, fn]) => typeof fn?.getMockImplementation === 'function')
    .map(([name, fn]) => [name, fn.getMockImplementation()]));
const restoreStore = () => {
    for (const [name, impl] of storeImpl) mockUsers.model[name].mockImplementation(impl);
};

const GUILD = 'guild-1';
const USER  = 'user-1';
const WHO   = { userId: USER, guildId: GUILD };
const OPTS  = { payoutKey: 'listing:listing-1:cancel', service: 'market', jobName: 'cancelListing' };

/** The daily item-gift allowance descriptor `/gift`'s rollback hands over. */
const REFUND = window => ({
    usedField:  'dailyGiftItemValueSent',
    resetField: 'dailyGiftItemValueReset',
    cap:        250_000,
    amount:     200,
    window,
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    restoreStore();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('a grant that lands', () => {
    test('adds the items and owes nothing', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'lucky_charm', quantity: 1 }] });

        const result = await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS);

        expect(result).toMatchObject({ granted: true, owed: false });
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 3 }]);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('appends a slot when the player holds none of it', async () => {
        mockUsers.seed({ ...WHO, inventory: [] });

        await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS);

        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
    });

    test('writes the key down, so a second grant under it moves nothing', async () => {
        mockUsers.seed({ ...WHO, inventory: [] });

        await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS);
        const second = await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS);

        // 'duplicate' is a success — the items are there — and must not be
        // recorded as owed, or the replay queue would grant them again.
        expect(second).toMatchObject({ granted: true, owed: false });
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('refunds the budget in the same write as the grant', async () => {
        const window = new Date('2026-09-05T10:00:00Z');
        mockUsers.seed({
            ...WHO, inventory: [],
            dailyGiftItemValueSent: 500, dailyGiftItemValueReset: window,
        });

        await grantItemsOrOwe(WHO, 'lucky_charm', 2, { ...OPTS, budgetRefund: REFUND(window) });

        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(mockUsers.get(USER).dailyGiftItemValueSent).toBe(300);
    });

    test('leaves a later window\'s allowance alone', async () => {
        // The gate that makes the owed record safe to replay: the counter resets
        // every 24 hours, and a refund applied to a window the gift was never
        // charged against hands the sender allowance they did not spend.
        mockUsers.seed({
            ...WHO, inventory: [],
            dailyGiftItemValueSent: 500,
            dailyGiftItemValueReset: new Date('2026-09-06T10:00:00Z'),
        });

        await grantItemsOrOwe(WHO, 'lucky_charm', 2, {
            ...OPTS, budgetRefund: REFUND(new Date('2026-09-05T10:00:00Z')),
        });

        // The item still comes back; only the allowance is held.
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(mockUsers.get(USER).dailyGiftItemValueSent).toBe(500);
    });

    test('is a no-op for a quantity there is nothing to grant', async () => {
        mockUsers.seed({ ...WHO, inventory: [] });

        expect(await grantItemsOrOwe(WHO, 'lucky_charm', 0, OPTS)).toMatchObject({ granted: true, owed: false });
        expect(mockUsers.get(USER).inventory).toEqual([]);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('a grant that does not land', () => {
    test('survives a rejection that the retry gets past', async () => {
        mockUsers.seed({ ...WHO, inventory: [] });
        const real = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate
            .mockRejectedValueOnce(new Error('transient'))
            .mockImplementation(real);

        const result = await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS);

        expect(result).toMatchObject({ granted: true, owed: false });
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
    });

    test('does not report a return that matched no document as made', async () => {
        // The failure both market unwinds ignored: no document, no throw, and
        // `granted` would have been true on the absence of one.
        const result = await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS);

        expect(result.granted).toBe(false);
        expect(result.owed).toBe(true);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            jobName: 'cancelListing',
            guildId: GUILD,
            payload: {
                kind: 'items', userId: USER, guildId: GUILD,
                itemId: 'lucky_charm', quantity: 2,
                payoutKey: 'listing:listing-1:cancel',
            },
        }));
    });

    test('creates the document instead when upsert is asked for', async () => {
        const result = await grantItemsOrOwe(WHO, 'lucky_charm', 2, { ...OPTS, upsert: true });

        expect(result).toMatchObject({ granted: true, owed: false });
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('records the grant as owed when every attempt rejects', async () => {
        mockUsers.seed({ ...WHO, inventory: [] });
        mockUsers.model.findOneAndUpdate.mockRejectedValue(new Error('write failed'));

        const result = await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS);

        expect(result).toMatchObject({ granted: false, owed: true });
        expect(result.error.message).toBe('write failed');
        expect(mockUsers.model.findOneAndUpdate).toHaveBeenCalledTimes(3);
    });

    test('carries the budget refund onto the owed payload', async () => {
        // Without it the replay returns the item and leaves the allowance where
        // the failed write left it — a sender charged a day's cap for a gift
        // that never arrived. The window travels with it so the replay can tell
        // whether the allowance it would refund is still the one that was spent.
        const window = new Date('2026-09-05T10:00:00Z');

        await grantItemsOrOwe(WHO, 'lucky_charm', 2, { ...OPTS, budgetRefund: REFUND(window) });

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ budgetRefund: REFUND(window) }),
        }));
    });

    test('carries the caller\'s extra fields onto the owed payload', async () => {
        const result = await grantItemsOrOwe(WHO, 'lucky_charm', 2, {
            ...OPTS, extra: { listingId: 'listing-1' },
        });

        expect(result.owed).toBe(true);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ listingId: 'listing-1' }),
        }));
    });

    test('says the grant is unrecorded when the queue write fails too', async () => {
        recordOwedPayout.mockResolvedValue(false);

        expect(await grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS))
            .toMatchObject({ granted: false, owed: false });
    });

    // Two market unwinds and one gift rollback have other work left to do after
    // this returns, and a throw here would abandon it — the buyer's refund, or
    // the reply that says what happened.
    test('never rejects, even when recording the payout throws', async () => {
        recordOwedPayout.mockRejectedValue(new Error('queue is down'));

        await expect(grantItemsOrOwe(WHO, 'lucky_charm', 2, OPTS))
            .resolves.toMatchObject({ granted: false, owed: false });
    });
});
