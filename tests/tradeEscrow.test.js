'use strict';

/**
 * #1010 — the money core of `/trade`, driven directly because that is where all
 * the coins and items are. A trade is a two-way duel escrow: both sides commit,
 * both accept, and the stakes are swapped rather than won. The invariants are
 * the ones #873/#969 established for the duel and the gift:
 *
 *   - a refused take moves nothing: everything already taken is handed back;
 *   - a successful take always reaches a completed deliver — every delivery is
 *     owed-on-failure, so an asset is delivered or filed, never lost or doubled;
 *   - the coin debits are keyed, so a lost response is a question the document
 *     answers rather than a guess between minting and destroying.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', {
    balance: 0, paidPayouts: [], spentDebits: [], inventory: [],
    dailyGiftSent: 0, dailyGiftReceived: 0, dailyGiftItemValueSent: 0, dailyGiftItemValueReceived: 0,
});

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const { recordOwedPayout } = require('../src/utils/owedPayout');
const { logTransaction } = require('../src/utils/logTransaction');
const {
    settleTrade, checkTradeBudgets, tradeBudgetFlows,
    takeCoins, rollbackCoins, tradeCoinEscrowKey,
} = require('../src/utils/tradeEscrow');

const GUILD = 'guild-1';
const A = 'user-a';
const B = 'user-b';
const TID = 'trade-1';

const storeImpl = new Map(Object.entries(mockUsers.model)
    .filter(([, fn]) => typeof fn?.getMockImplementation === 'function')
    .map(([name, fn]) => [name, fn.getMockImplementation()]));
const restoreStore = () => { for (const [name, impl] of storeImpl) mockUsers.model[name].mockImplementation(impl); };

const seed = doc => mockUsers.seed({ userId: doc.userId, guildId: GUILD, ...doc });
const get = id => mockUsers.get(id);
const qtyOf = (id, itemId) => (get(id)?.inventory ?? []).filter(i => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0);

const offer = ({ a = {}, b = {} }) => ({
    tradeId: TID, guildId: GUILD,
    a: { userId: A, coins: 0, item: null, ...a },
    b: { userId: B, coins: 0, item: null, ...b },
});

const LIMITS = { coinSend: 10_000, coinReceive: 25_000, itemValueSend: 250_000, itemValueReceive: 500_000, confirmThreshold: 5_000 };

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    restoreStore();
    recordOwedPayout.mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('a complete swap', () => {
    test('coins for an item: each side ends with the other’s stake', async () => {
        seed({ userId: A, balance: 500 });
        seed({ userId: B, balance: 0, inventory: [{ itemId: 'lucky_charm', quantity: 3 }] });

        const result = await settleTrade(offer({
            a: { coins: 200 },
            b: { item: { itemId: 'lucky_charm', quantity: 2, value: 100 } },
        }));

        expect(result).toMatchObject({ success: true, delivered: true });
        expect(get(A).balance).toBe(300);          // A spent 200
        expect(get(B).balance).toBe(200);          // B received 200
        expect(qtyOf(A, 'lucky_charm')).toBe(2);    // A received 2
        expect(qtyOf(B, 'lucky_charm')).toBe(1);    // B kept 1
    });

    test('coins and items both ways', async () => {
        seed({ userId: A, balance: 1000, inventory: [{ itemId: 'gem', quantity: 5 }] });
        seed({ userId: B, balance: 1000, inventory: [{ itemId: 'relic', quantity: 1 }] });

        const result = await settleTrade(offer({
            a: { coins: 100, item: { itemId: 'gem', quantity: 2, value: 50 } },
            b: { coins: 300, item: { itemId: 'relic', quantity: 1, value: 400 } },
        }));

        expect(result).toMatchObject({ success: true, delivered: true });
        expect([get(A).balance, get(B).balance]).toEqual([1200, 800]); // A: -100 +300, B: -300 +100
        expect(qtyOf(A, 'relic')).toBe(1);
        expect(qtyOf(B, 'relic')).toBe(0);
        expect(qtyOf(A, 'gem')).toBe(3);
        expect(qtyOf(B, 'gem')).toBe(2);
    });

    test('writes a ledger row per asset that moved', async () => {
        seed({ userId: A, balance: 500 });
        seed({ userId: B, balance: 0, inventory: [{ itemId: 'gem', quantity: 1 }] });

        await settleTrade(offer({ a: { coins: 100 }, b: { item: { itemId: 'gem', quantity: 1, value: 10 } } }));

        const types = logTransaction.mock.calls.map(c => c[0].type);
        expect(types).toEqual(expect.arrayContaining(['trade_coins_receive', 'trade_coins_send', 'trade_item_receive', 'trade_item_send']));
    });
});

describe('a take that cannot be completed moves nothing', () => {
    test('a side short on coins: the trade is refused and no asset moves', async () => {
        seed({ userId: A, balance: 50 });
        seed({ userId: B, balance: 0, inventory: [{ itemId: 'gem', quantity: 1 }] });

        const result = await settleTrade(offer({ a: { coins: 200 }, b: { item: { itemId: 'gem', quantity: 1, value: 10 } } }));

        expect(result.success).toBe(false);
        expect(result.reason).toBe(`short:${A}`);
        expect(get(A).balance).toBe(50);
        expect(qtyOf(B, 'gem')).toBe(1);   // B's item was never taken
    });

    test('the second side lacks the item: the first side’s taken coins are returned', async () => {
        seed({ userId: A, balance: 500 });
        seed({ userId: B, balance: 0, inventory: [] }); // B has no gem to give

        const result = await settleTrade(offer({
            a: { coins: 200 },
            b: { item: { itemId: 'gem', quantity: 1, value: 10 } },
        }));

        expect(result.success).toBe(false);
        expect(result.reason).toBe(`item:${B}`);
        // A's coins were taken then handed straight back — balance whole again.
        expect(get(A).balance).toBe(500);
        // And the keyed escrow debit is marked reversed, so a retry cannot read
        // it as still held.
        expect((get(A).spentDebits ?? []).map(e => e.reversed)).toEqual([true]);
    });

    test('an item taken from side A is returned when side B’s item is missing', async () => {
        seed({ userId: A, balance: 0, inventory: [{ itemId: 'gem', quantity: 2 }] });
        seed({ userId: B, balance: 0, inventory: [] });

        const result = await settleTrade(offer({
            a: { item: { itemId: 'gem', quantity: 2, value: 10 } },
            b: { item: { itemId: 'relic', quantity: 1, value: 10 } },
        }));

        expect(result.success).toBe(false);
        expect(result.reason).toBe(`item:${B}`);
        expect(qtyOf(A, 'gem')).toBe(2); // A's gems came back
    });
});

describe('delivery is owed-on-failure, never lost', () => {
    test('a credit that cannot land files an owed record and reports it', async () => {
        seed({ userId: A, balance: 500 });
        seed({ userId: B, balance: 0, inventory: [{ itemId: 'gem', quantity: 1 }] });

        // Break only the delivery credit to B (a paidPayouts pipeline write on B).
        const store = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate.mockImplementation(async (f, u, o) => {
            const isCredit = Array.isArray(u) && JSON.stringify(u).includes('paidPayouts');
            if (isCredit && f.userId === B) throw new Error('mongo is down');
            return store(f, u, o);
        });

        const result = await settleTrade(offer({ a: { coins: 100 }, b: { item: { itemId: 'gem', quantity: 1, value: 10 } } }));

        expect(result).toMatchObject({ success: true, delivered: false, owed: true });
        expect(recordOwedPayout).toHaveBeenCalled();
        // A still received B's item — the take succeeded, only one delivery failed.
        expect(qtyOf(A, 'gem')).toBe(1);
    });
});

describe('a reversal that cannot be confirmed is written down for replay', () => {
    // #1023 review. If the keyed give-back of an escrowed stake cannot be
    // confirmed, the coins are stuck on the taker. The escrow key is the durable
    // record, but recovering from it by hand needs knowing it is there — so a
    // stuck reversal files an owed *reversal*, keyed to the escrow debit, that
    // `payouts:replay` re-runs through `reverseKeyedDebit` (never a blind credit,
    // which could pay twice against a reversal that later lands).
    test('records an owed reversal when the give-back cannot be confirmed', async () => {
        seed({ userId: A, balance: 500 });

        // The escrow debit lands: A's 200 coins are now held.
        const took = await takeCoins(A, GUILD, 200, TID);
        expect(took.debited).toBe(true);
        expect(get(A).balance).toBe(300);

        // Every reversal write throws, so reverseKeyedDebit exhausts its retries
        // unresolved; the resolve read still shows the debit landed un-reversed —
        // the coins are genuinely stuck.
        const store = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate.mockImplementation(async (f, u, o) => {
            const isReversal = u?.$set && Object.keys(u.$set).some(k => k.includes('reversed'));
            if (isReversal) throw new Error('mongo is down');
            return store(f, u, o);
        });

        const result = await rollbackCoins(A, GUILD, 200, TID);

        expect(result.credited).toBe(false);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'trade', jobName: 'tradeCoinReversal', guildId: GUILD,
            payload: {
                kind: 'reversal', userId: A, guildId: GUILD, amount: 200,
                payoutKey: tradeCoinEscrowKey(TID, A),
            },
        }));
        // The debit still stands — the coins really are stuck, which is why the
        // record exists.
        expect(get(A).balance).toBe(300);
    });

    test('a reversal that lands needs no record', async () => {
        seed({ userId: A, balance: 500 });
        await takeCoins(A, GUILD, 200, TID);

        const result = await rollbackCoins(A, GUILD, 200, TID);

        expect(result.credited).toBe(true);
        expect(recordOwedPayout).not.toHaveBeenCalled();
        expect(get(A).balance).toBe(500); // handed straight back
    });
});

describe('the anti-funnel budgets', () => {
    test('net flow is the imbalance, not the gross', () => {
        const flows = tradeBudgetFlows(offer({
            a: { coins: 500, item: { value: 100 } },
            b: { coins: 300, item: { value: 100 } },
        }));
        // Coins: A gives 500, B gives 300 → net 200 from A. Item value cancels.
        expect(flows).toEqual({ coinNet: 200, itemNet: 0 });
    });

    test('refuses a trade whose net coin flow is over the sender’s daily cap', () => {
        const refusal = checkTradeBudgets(offer({ a: { coins: 20_000 }, b: { coins: 0 } }), {
            aDoc: { userId: A }, bDoc: { userId: B }, limits: LIMITS, currency: '💰',
        });
        expect(refusal).toMatch(/over the daily cap/);
    });

    test('a fair swap consumes no budget and is allowed', () => {
        const refusal = checkTradeBudgets(offer({ a: { coins: 20_000 }, b: { coins: 20_000 } }), {
            aDoc: { userId: A }, bDoc: { userId: B }, limits: LIMITS, currency: '💰',
        });
        expect(refusal).toBeNull();
    });

    test('reserves the net value against the daily counters when the swap completes', async () => {
        seed({ userId: A, balance: 500 });
        seed({ userId: B, balance: 200 });

        const result = await settleTrade(
            offer({ a: { coins: 500 }, b: { coins: 200 } }),
            { limits: LIMITS, aDoc: get(A), bDoc: get(B) },
        );

        expect(result.success).toBe(true);
        // Net 300 from A to B — spent on A's send counter and B's receive counter.
        expect(get(A).dailyGiftSent).toBe(300);
        expect(get(B).dailyGiftReceived).toBe(300);
    });

    test('refuses atomically when a cap would be exceeded, moving nothing', async () => {
        // A is 500 short of the daily send cap and offering 1000 net.
        seed({ userId: A, balance: 20_000, dailyGiftSent: 9_500, dailyGiftReset: new Date() });
        seed({ userId: B, balance: 0 });

        const result = await settleTrade(
            offer({ a: { coins: 1_000 }, b: { coins: 0 } }),
            { limits: LIMITS, aDoc: get(A), bDoc: get(B) },
        );

        expect(result).toMatchObject({ success: false, reason: 'budget:coins' });
        // The guarded reservation rejected before any coin moved.
        expect(get(A).balance).toBe(20_000);
        expect(get(A).dailyGiftSent).toBe(9_500);
    });

    test('refunds a reserved budget when a later take fails', async () => {
        // B is the net sender (gives 500, receives 100) but cannot cover its 500.
        seed({ userId: A, balance: 500 });
        seed({ userId: B, balance: 0 });

        const result = await settleTrade(
            offer({ a: { coins: 100 }, b: { coins: 500 } }),
            { limits: LIMITS, aDoc: get(A), bDoc: get(B) },
        );

        expect(result).toMatchObject({ success: false, reason: `short:${B}` });
        // The reservations taken before B's coin take failed are handed back.
        expect(get(B).dailyGiftSent).toBe(0);
        expect(get(A).dailyGiftReceived).toBe(0);
        // And A's committed coins were returned.
        expect(get(A).balance).toBe(500);
    });
});
