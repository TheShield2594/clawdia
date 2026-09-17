'use strict';

// The read side of the ledger (#1009): one member's transactions, newest first
// and paged, and the owed payouts sitting in the dead-letter queue for them.
// Both are strictly read-only — these tests assert the queries issued and the
// shapes returned, and that nothing here writes.

const {
    fetchTransactions, fetchOwedPayouts, prettyType, signedAmount, DEFAULT_PAGE_SIZE,
} = require('../src/utils/ledger');

// A chainable Mongoose query stub that resolves to `rows`, recording the paging
// calls the way the real query would receive them.
function query(rows) {
    const q = {
        sort: jest.fn(() => q),
        skip: jest.fn(() => q),
        limit: jest.fn(() => q),
        lean: jest.fn(() => q),
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
}

describe('fetchTransactions', () => {
    test('scopes to the member, sorts newest first, and pages by number', async () => {
        const q = query([{ type: 'daily', amount: 100 }]);
        const Model = { find: jest.fn(() => q), countDocuments: jest.fn().mockResolvedValue(1) };

        const result = await fetchTransactions({ userId: 'u1', guildId: 'g1', Model });

        expect(Model.find).toHaveBeenCalledWith({ guildId: 'g1', userId: 'u1' });
        expect(Model.countDocuments).toHaveBeenCalledWith({ guildId: 'g1', userId: 'u1' });
        expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
        expect(q.skip).toHaveBeenCalledWith(0);
        expect(q.limit).toHaveBeenCalledWith(DEFAULT_PAGE_SIZE);
        expect(result).toMatchObject({ total: 1, page: 1, pages: 1, pageSize: DEFAULT_PAGE_SIZE });
        expect(result.items).toHaveLength(1);
    });

    test('skips by page, not by row', async () => {
        const q = query([]);
        const Model = { find: jest.fn(() => q), countDocuments: jest.fn().mockResolvedValue(100) };

        await fetchTransactions({ userId: 'u1', guildId: 'g1', page: 3, pageSize: 10, Model });

        expect(q.skip).toHaveBeenCalledWith(20);
        expect(q.limit).toHaveBeenCalledWith(10);
    });

    // A receipt asked for page 99 of a two-page ledger should land on the last
    // page that has rows, not an empty embed that reads as "no transactions".
    test('clamps a page past the end to the last one with rows', async () => {
        const q = query([]);
        const Model = { find: jest.fn(() => q), countDocuments: jest.fn().mockResolvedValue(25) };

        const result = await fetchTransactions({ userId: 'u1', guildId: 'g1', page: 99, pageSize: 10, Model });

        expect(result.pages).toBe(3);
        expect(result.page).toBe(3);
        expect(q.skip).toHaveBeenCalledWith(20);
    });

    test.each([
        ['zero', 0],
        ['negative', -4],
        ['not a number', NaN],
    ])('a %s page falls back to the first', async (_label, page) => {
        const q = query([]);
        const Model = { find: jest.fn(() => q), countDocuments: jest.fn().mockResolvedValue(5) };

        const result = await fetchTransactions({ userId: 'u1', guildId: 'g1', page, Model });

        expect(result.page).toBe(1);
        expect(q.skip).toHaveBeenCalledWith(0);
    });

    // An empty ledger is one page, and it does not issue the find at all — there
    // is nothing to skip into.
    test('an empty ledger is one page and reads no rows', async () => {
        const Model = { find: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) };

        const result = await fetchTransactions({ userId: 'u1', guildId: 'g1', Model });

        expect(result).toMatchObject({ items: [], total: 0, page: 1, pages: 1 });
        expect(Model.find).not.toHaveBeenCalled();
    });
});

describe('fetchOwedPayouts', () => {
    const owed = (over = {}) => ({
        _id: 'x', status: 'exhausted', service: 'economy', jobName: 'credit.owed',
        payload: { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500, payoutKey: 'k1' },
        attempts: 3, errorMessage: 'db down', createdAt: new Date('2026-01-01'),
        ...over,
    });

    test('scopes to the member and excludes settled records', async () => {
        const q = query([owed()]);
        const OwedModel = { find: jest.fn(() => q) };

        const rows = await fetchOwedPayouts({ userId: 'u1', guildId: 'g1', OwedModel });

        expect(OwedModel.find).toHaveBeenCalledWith({
            guildId: 'g1', status: { $ne: 'resolved' }, 'payload.userId': 'u1',
        });
        expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
        expect(rows).toEqual([{
            id: 'x', status: 'exhausted', service: 'economy', jobName: 'credit.owed',
            kind: 'coins', amount: 500, itemId: null, quantity: null, payoutKey: 'k1',
            attempts: 3, errorMessage: 'db down', createdAt: new Date('2026-01-01'),
        }]);
    });

    // recordOwedPayout suffixes the job name with `.owed`; a FailedJob that is
    // some other kind of failure for the same user is not a payout owed to them.
    test('keeps only records that are actually owed payouts', async () => {
        const q = query([owed(), owed({ jobName: 'someSweep', payload: { userId: 'u1' } })]);
        const OwedModel = { find: jest.fn(() => q) };

        const rows = await fetchOwedPayouts({ userId: 'u1', guildId: 'g1', OwedModel });

        expect(rows).toHaveLength(1);
        expect(rows[0].jobName).toBe('credit.owed');
    });

    test('carries the item fields for an owed item grant', async () => {
        const q = query([owed({
            jobName: 'return.owed',
            payload: { kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'lucky_charm', quantity: 2, payoutKey: 'k2' },
        })]);
        const OwedModel = { find: jest.fn(() => q) };

        const [row] = await fetchOwedPayouts({ userId: 'u1', guildId: 'g1', OwedModel });

        expect(row).toMatchObject({ kind: 'items', itemId: 'lucky_charm', quantity: 2, amount: null, payoutKey: 'k2' });
    });
});

describe('prettyType', () => {
    test('turns a machine slug into words', () => {
        expect(prettyType('gift_send')).toBe('Gift Send');
        expect(prettyType('duel_win')).toBe('Duel Win');
    });

    test('has a fallback for a missing type', () => {
        expect(prettyType(null)).toBe('Unknown');
        expect(prettyType(undefined)).toBe('Unknown');
    });
});

describe('signedAmount', () => {
    test('signs and separates', () => {
        expect(signedAmount(1234)).toBe('+1,234');
        expect(signedAmount(-1234)).toBe('-1,234');
    });

    test('zero and non-numbers are a bare 0', () => {
        expect(signedAmount(0)).toBe('0');
        expect(signedAmount(null)).toBe('0');
        expect(signedAmount('nope')).toBe('0');
    });
});
