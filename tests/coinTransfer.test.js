'use strict';

/**
 * #868 and #897, the two halves of one problem: `/gift type:coins` and
 * `/bank transfer` moved coins between the same two players through two
 * different implementations, and only one of them was any good.
 *
 * `/gift` enforced the anti-alt daily caps atomically and rolled the sender back
 * when the credit missed. `/bank transfer` had no cap, no account-age gate and
 * no accounting — so the caps were decorative, anyone who hit the gift cap
 * simply transferred instead — and it debited the sender before crediting the
 * receiver with nothing watching the second write. A credit that threw left the
 * sender poorer, the receiver no richer, and no record for an operator to
 * replay: the coins were gone.
 *
 * These drive utils/coinTransfer.js, which both commands now go through, against
 * a store that evaluates the cap `$expr` for real — a mock that waved the guards
 * through would report every cap as working.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { GIFT_LIMIT_DEFAULTS } = require('../src/utils/giftCaps');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, inventory: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));

const { accountAgeRefusal, coinBudgets, commitCoinTransfer, MIN_ACCOUNT_AGE_MS } =
    require('../src/utils/coinTransfer');
const { recordOwedPayout } = require('../src/utils/owedPayout');

const GUILD = 'guild-1';
const SENDER = 'sender-1';
const RECEIVER = 'receiver-1';

const LIMITS = { ...GIFT_LIMIT_DEFAULTS };

const seed = (userId, fields = {}) => mockUsers.seed({ userId, guildId: GUILD, ...fields });

/** The transfer, with the pre-flight read the callers do folded in. */
async function transfer(amount, { limits = LIMITS, refundKey = 'interaction-1' } = {}) {
    const [senderDoc, receiverDoc] = await Promise.all([
        mockUsers.model.findOne({ userId: SENDER, guildId: GUILD }),
        mockUsers.model.findOne({ userId: RECEIVER, guildId: GUILD }),
    ]);
    return commitCoinTransfer({
        senderId: SENDER, receiverId: RECEIVER, guildId: GUILD, amount, limits,
        budgets: coinBudgets(senderDoc, receiverDoc, limits),
        refundKey, service: 'test', jobName: 'testTransfer',
    });
}

beforeEach(() => {
    mockUsers.reset();
    jest.clearAllMocks();
});

// Some tests below replace a method on the model outright — the only way to make
// a specific write reject. `jest.clearAllMocks()` clears call history but leaves
// the replacement in place, so a patch that outlives its test (a failed assertion
// skipping an in-body restore, or a stub that never had one) is inherited by
// everything after it. That is an order-dependent failure which reproduces only
// in a full run, so the whole method table is snapshotted and put back.
const pristineUserModel = { ...mockUsers.model };
afterEach(() => { Object.assign(mockUsers.model, pristineUserModel); });

describe('a transfer that works', () => {
    it('moves the coins and opens both daily windows', async () => {
        seed(SENDER, { balance: 5_000 });
        seed(RECEIVER, { balance: 0 });

        const result = await transfer(1_000);

        expect(result.status).toBe('ok');
        expect(mockUsers.get(SENDER).balance).toBe(4_000);
        expect(mockUsers.get(RECEIVER).balance).toBe(1_000);
        // The accounting the transfer path used to have none of.
        expect(mockUsers.get(SENDER).dailyGiftSent).toBe(1_000);
        expect(mockUsers.get(RECEIVER).dailyGiftReceived).toBe(1_000);
        expect(mockUsers.get(SENDER).dailyGiftReset).toBeInstanceOf(Date);
    });

    it('creates the receiver a document when they have none', async () => {
        seed(SENDER, { balance: 5_000 });

        const result = await transfer(500);

        expect(result.status).toBe('ok');
        expect(mockUsers.get(RECEIVER).balance).toBe(500);
    });

    it('accumulates against the same window rather than reopening it', async () => {
        seed(SENDER, { balance: 20_000 });
        seed(RECEIVER, { balance: 0 });

        await transfer(1_000);
        const openedAt = mockUsers.get(SENDER).dailyGiftReset;
        await transfer(2_000);

        expect(mockUsers.get(SENDER).dailyGiftSent).toBe(3_000);
        expect(mockUsers.get(SENDER).dailyGiftReset).toEqual(openedAt);
    });
});

describe('the daily caps', () => {
    it('refuses a send past the cap in the write itself, not just in the check', async () => {
        // The pre-flight message is the friendly refusal; the `$expr` in the
        // filter is what actually stops two concurrent transfers each passing a
        // check the other invalidated. Driven with a stale budget reading so
        // only the filter can refuse it.
        seed(SENDER, { balance: 100_000, dailyGiftSent: 9_500, dailyGiftReset: new Date() });
        seed(RECEIVER, { balance: 0 });

        const result = await commitCoinTransfer({
            senderId: SENDER, receiverId: RECEIVER, guildId: GUILD, amount: 1_000,
            limits: LIMITS,
            budgets: { send: { expired: false }, receive: { expired: true } },
            refundKey: 'interaction-1', service: 'test', jobName: 'testTransfer',
        });

        expect(result.status).toBe('debit_failed');
        expect(mockUsers.get(SENDER).balance).toBe(100_000);
        expect(mockUsers.get(RECEIVER).balance).toBe(0);
    });

    it("refunds the sender when the receiver's cap is reached in the race", async () => {
        seed(SENDER, { balance: 100_000 });
        seed(RECEIVER, { balance: 0, dailyGiftReceived: 24_500, dailyGiftReceivedReset: new Date() });

        const result = await commitCoinTransfer({
            senderId: SENDER, receiverId: RECEIVER, guildId: GUILD, amount: 1_000,
            limits: LIMITS,
            budgets: { send: { expired: true }, receive: { expired: false } },
            refundKey: 'interaction-1', service: 'test', jobName: 'testTransfer',
        });

        expect(result).toMatchObject({ status: 'receive_cap', refunded: true, owed: false });
        expect(mockUsers.get(SENDER).balance).toBe(100_000);
        expect(mockUsers.get(RECEIVER).balance).toBe(0);
        // The sender's allowance comes back with their coins — a transfer that
        // did not happen must not spend their day's budget.
        expect(mockUsers.get(SENDER).dailyGiftSent).toBe(0);
    });

    it('enforces nothing when an admin has switched a cap off', async () => {
        seed(SENDER, { balance: 100_000 });
        seed(RECEIVER, { balance: 0 });

        const result = await transfer(50_000, { limits: { ...LIMITS, coinSend: 0, coinReceive: 0 } });

        expect(result.status).toBe('ok');
        expect(mockUsers.get(RECEIVER).balance).toBe(50_000);
    });

    it('refuses more than the wallet holds, whatever the caps say', async () => {
        seed(SENDER, { balance: 100 });
        seed(RECEIVER, { balance: 0 });

        const result = await transfer(500);

        expect(result.status).toBe('debit_failed');
        expect(mockUsers.get(SENDER).balance).toBe(100);
    });
});

describe('a credit that will not land', () => {
    /**
     * Make the receiver's guarded credit fail, leaving every other write alone.
     * The afterEach above puts the method back, so no test has to remember to.
     */
    const breakCredit = (error, { times = Infinity } = {}) => {
        const real = mockUsers.model.findOneAndUpdate;
        let left = times;
        mockUsers.model.findOneAndUpdate = jest.fn(async (query, update, options) => {
            if (query.userId === RECEIVER && left > 0) { left -= 1; throw error; }
            return real(query, update, options);
        });
    };

    beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { console.error.mockRestore(); });

    it('rolls the sender back rather than destroying their coins', async () => {
        seed(SENDER, { balance: 5_000 });
        seed(RECEIVER, { balance: 0 });
        breakCredit(new Error('connection reset'));

        const result = await transfer(1_000);

        expect(result).toMatchObject({ status: 'credit_failed', refunded: true, owed: false });
        expect(mockUsers.get(SENDER).balance).toBe(5_000);
        expect(mockUsers.get(SENDER).dailyGiftSent).toBe(0);
        expect(mockUsers.get(RECEIVER).balance).toBe(0);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    it('retries once on the duplicate-key error an upsert race raises', async () => {
        // Losing the race to create the receiver's document means the document
        // now exists, so the second pass finds it and needs no insert.
        seed(SENDER, { balance: 5_000 });
        seed(RECEIVER, { balance: 0 });
        const e11000 = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        breakCredit(e11000, { times: 1 });

        const result = await transfer(1_000);

        expect(result.status).toBe('ok');
        expect(mockUsers.get(RECEIVER).balance).toBe(1_000);
    });

    it('does not retry an error that is not a duplicate key', async () => {
        // Repeating a write whose outcome is unknown is how a credit lands twice.
        seed(SENDER, { balance: 5_000 });
        seed(RECEIVER, { balance: 0 });
        breakCredit(new Error('connection reset'), { times: 1 });

        const result = await transfer(1_000);

        expect(result.status).toBe('credit_failed');
        expect(mockUsers.get(RECEIVER).balance).toBe(0);
    });

    it('records the refund as owed when the rollback fails too', async () => {
        // The case that used to destroy coins outright: the debit committed, the
        // credit did not, and the refund could not be written either.
        seed(SENDER, { balance: 5_000 });
        seed(RECEIVER, { balance: 0 });
        breakCredit(new Error('connection reset'));
        mockUsers.model.updateOne = jest.fn(async () => { throw new Error('still down'); });

        const result = await transfer(1_000, { refundKey: 'interaction-77' });

        expect(result).toMatchObject({ status: 'credit_failed', refunded: false, owed: true });
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'test',
            jobName: 'testTransfer',
            guildId: GUILD,
            payload: {
                kind: 'coins', userId: SENDER, guildId: GUILD, amount: 1_000,
                // Keyed by the interaction, so a replay of this refund cannot
                // pay it a second time.
                payoutKey: 'transfer:interaction-77:refund',
            },
        }));
    });

    it('records the refund as owed when the rollback matches no document', async () => {
        // `updateOne` resolves without rejecting when its filter matches nothing,
        // so an unchecked refund is indistinguishable from one that landed. If
        // the sender's document went away between the debit and the rollback,
        // reporting `refunded: true` would tell them their coins came back and
        // leave the replay job with nothing to settle — the silent loss this
        // module exists to prevent, one layer further in.
        seed(SENDER, { balance: 5_000 });
        seed(RECEIVER, { balance: 0 });
        breakCredit(new Error('connection reset'));
        const real = mockUsers.model.updateOne;
        mockUsers.model.updateOne = jest.fn(async (query, update, options) => {
            if (query.userId === SENDER) return { matchedCount: 0, modifiedCount: 0 };
            return real(query, update, options);
        });

        const result = await transfer(1_000, { refundKey: 'interaction-88' });

        expect(result).toMatchObject({ status: 'credit_failed', refunded: false, owed: true });
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                amount: 1_000, payoutKey: 'transfer:interaction-88:refund',
            }),
        }));
    });

    it('reports the payout unrecorded when even the queue write fails', async () => {
        // Not a distinction anyone enjoys, but the caller has to be able to tell
        // "recoverable" from "gone", and only one of the two is worth promising.
        seed(SENDER, { balance: 5_000 });
        seed(RECEIVER, { balance: 0 });
        breakCredit(new Error('connection reset'));
        mockUsers.model.updateOne = jest.fn(async () => { throw new Error('still down'); });
        recordOwedPayout.mockResolvedValueOnce(false);

        const result = await transfer(1_000);

        expect(result).toMatchObject({ refunded: false, owed: false });
    });
});

describe('the account-age gate', () => {
    const old = { username: 'old', createdTimestamp: Date.now() - 365 * 24 * 3_600_000 };
    const fresh = { username: 'fresh', createdTimestamp: Date.now() - 3_600_000 };

    it('turns a brand-new sender away', () => {
        expect(accountAgeRefusal(fresh, old)).toMatch(/too new to send coins/);
    });

    it('turns a brand-new receiver away, and names them', () => {
        expect(accountAgeRefusal(old, fresh)).toMatch(/fresh's Discord account is too new to receive coins/);
    });

    it('lets a command keep its own word for what is moving', () => {
        expect(accountAgeRefusal(fresh, old, { noun: 'gifts' })).toMatch(/too new to send gifts/);
    });

    it('passes a pair of established accounts', () => {
        expect(accountAgeRefusal(old, old)).toBeNull();
    });

    it('sits exactly on seven days', () => {
        const now = Date.now();
        const justOld = { username: 'x', createdTimestamp: now - MIN_ACCOUNT_AGE_MS };
        const justNew = { username: 'x', createdTimestamp: now - MIN_ACCOUNT_AGE_MS + 1 };
        expect(accountAgeRefusal(justOld, justOld, { now })).toBeNull();
        expect(accountAgeRefusal(justNew, justOld, { now })).toMatch(/too new/);
    });
});
