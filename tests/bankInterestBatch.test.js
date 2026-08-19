'use strict';

// The weekly Bank-district payout used to hydrate every banking user in a guild
// as a full Mongoose document, then issue one `findOneAndUpdate` and one
// `Transaction.create` per user. Weekly cadence bounds how often that hurts, but
// a large install still serialises thousands of round trips behind one cron tick.
//
// These tests pin the shape of the replacement — projected, lean, batched — and,
// just as importantly, that it still pays exactly what the old loop paid.

jest.mock('discord.js', () => ({
    EmbedBuilder: class {
        setColor() { return this; }
        setTitle() { return this; }
        setDescription() { return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
    },
}));

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User',  () => ({ find: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/models/Transaction', () => ({ insertMany: jest.fn() }));
jest.mock('../src/services/districtService', () => ({ isDistrictActive: jest.fn(() => true) }));

const Guild       = require('../src/models/Guild');
const User        = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const { applyBankInterest } = require('../src/services/schedulerService');

const INTEREST_BEARING_CAP = 100_000;

// Records which query modifiers the job asked for, so the projection and `lean()`
// are assertable rather than merely present in the source.
function stubUserFind(docs) {
    const calls = { select: null, lean: false };
    User.find.mockImplementation(() => {
        const chain = {
            select(fields) { calls.select = fields; return chain; },
            lean() { calls.lean = true; return Promise.resolve(docs); },
            then(resolve, reject) { return Promise.resolve(docs).then(resolve, reject); },
        };
        return chain;
    });
    return calls;
}

function bankers(count, bank = 1_000) {
    return Array.from({ length: count }, (_, i) => ({
        _id: `id${i}`, userId: `u${i}`, bank, balance: 0,
    }));
}

beforeEach(() => {
    jest.clearAllMocks();
    Guild.find.mockReturnValue({ lean: () => Promise.resolve([{ guildId: 'g1', economy: {} }]) });
    // A non-null return is the job's signal that it won the weekly claim.
    Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });
    User.bulkWrite.mockResolvedValue({});
    Transaction.insertMany.mockResolvedValue([]);
});

describe('applyBankInterest', () => {
    test('reads only the three fields it needs, and does not hydrate documents', async () => {
        const calls = stubUserFind(bankers(3));

        await applyBankInterest({});

        expect(calls.select).toBe('userId bank balance');
        expect(calls.lean).toBe(true);
    });

    test('credits every user in one bulkWrite instead of one update each', async () => {
        stubUserFind(bankers(3, 2_000));

        await applyBankInterest({});

        expect(User.bulkWrite).toHaveBeenCalledTimes(1);
        const [ops] = User.bulkWrite.mock.calls[0];
        expect(ops).toHaveLength(3);
        expect(ops[0]).toEqual({ updateOne: { filter: { _id: 'id0' }, update: { $inc: { bank: 100 } } } });
    });

    test('writes the ledger in one insertMany instead of one create each', async () => {
        stubUserFind(bankers(2, 2_000));

        await applyBankInterest({});

        expect(Transaction.insertMany).toHaveBeenCalledTimes(1);
        const [entries] = Transaction.insertMany.mock.calls[0];
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({
            userId: 'u0', guildId: 'g1', type: 'bank_interest', amount: 100, balance: 0,
        });
    });

    test('credits before it writes the ledger — an entry with no credit claims coins nobody got', async () => {
        stubUserFind(bankers(1, 2_000));
        const order = [];
        User.bulkWrite.mockImplementation(async () => { order.push('credit'); return {}; });
        Transaction.insertMany.mockImplementation(async () => { order.push('ledger'); return []; });

        await applyBankInterest({});

        expect(order).toEqual(['credit', 'ledger']);
    });

    test('a failed ledger write does not take the payout down with it', async () => {
        stubUserFind(bankers(1, 2_000));
        Transaction.insertMany.mockRejectedValue(new Error('ledger unavailable'));
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(applyBankInterest({})).resolves.toBeUndefined();

        expect(User.bulkWrite).toHaveBeenCalledTimes(1);
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    test('sends in batches, so the op array does not grow with the guild', async () => {
        stubUserFind(bankers(2_500, 2_000));

        await applyBankInterest({});

        // 1000 + 1000 + 500: holding all 2500 ops before sending would trade the
        // round trips for an equally unbounded amount of memory.
        expect(User.bulkWrite.mock.calls.map(([ops]) => ops.length)).toEqual([1000, 1000, 500]);
        expect(Transaction.insertMany.mock.calls.map(([rows]) => rows.length)).toEqual([1000, 1000, 500]);
    });

    test('still caps the interest-bearing balance, and still skips users it rounds to zero', async () => {
        stubUserFind([
            { _id: 'rich', userId: 'rich', bank: 10 * INTEREST_BEARING_CAP, balance: 0 },
            { _id: 'dust', userId: 'dust', bank: 19, balance: 0 },
        ]);

        await applyBankInterest({});

        const [ops] = User.bulkWrite.mock.calls[0];
        // 5% of the cap, not 5% of the balance; and floor(19 * 0.05) === 0 buys
        // nobody an op.
        expect(ops).toEqual([
            { updateOne: { filter: { _id: 'rich' }, update: { $inc: { bank: INTEREST_BEARING_CAP * 0.05 } } } },
        ]);
    });

    test('writes nothing at all when no user earns anything', async () => {
        stubUserFind([{ _id: 'dust', userId: 'dust', bank: 5, balance: 0 }]);

        await applyBankInterest({});

        expect(User.bulkWrite).not.toHaveBeenCalled();
        expect(Transaction.insertMany).not.toHaveBeenCalled();
    });
});
