'use strict';

/**
 * #1010 — the `/trade` command's testable seams: resolving an item to commit
 * (the same soulbound / single-stack / equipped-effect refusals `/gift` makes),
 * and the finalize path that runs a confirmed trade end to end. The interactive
 * collector itself is thin glue over these; the money is here and in
 * tradeEscrow.test.js.
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
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({})) }));
const mockResolveEffectType = jest.fn(() => null);
jest.mock('../src/services/effectsService', () => ({ resolveEffectType: (...a) => mockResolveEffectType(...a) }));

const { __test__ } = require('../src/commands/economy/trade');
const { resolveItemForTrade, finalizeTrade, sideEmpty } = __test__;

const GUILD = 'g1';
const A = { id: 'user-a', username: 'Ana' };
const B = { id: 'user-b', username: 'Bo' };
const LIMITS = { coinSend: 10_000, coinReceive: 25_000, itemValueSend: 250_000, itemValueReceive: 500_000, confirmThreshold: 5_000 };

const seed = doc => mockUsers.seed({ guildId: GUILD, ...doc });
const get = id => mockUsers.get(id);
const qtyOf = (id, itemId) => (get(id)?.inventory ?? []).filter(i => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0);

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockResolveEffectType.mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

describe('resolveItemForTrade', () => {
    const doc = extra => ({ inventory: [{ itemId: 'gem', quantity: 5 }], activeEffects: [], ...extra });

    test('resolves a held item to a committable stack', () => {
        const res = resolveItemForTrade(doc(), 'GEM', 2, {});
        expect(res.item).toMatchObject({ itemId: 'gem', quantity: 2 });
    });

    test('refuses an item not held', () => {
        expect(resolveItemForTrade(doc(), 'sword', 1, {}).error).toMatch(/don't have/);
    });

    test('refuses a soulbound item', () => {
        const res = resolveItemForTrade({ inventory: [{ itemId: 'lifesaver', quantity: 1 }], activeEffects: [] }, 'lifesaver', 1, {});
        expect(res.error).toMatch(/soulbound/);
    });

    test('refuses when no single stack covers the quantity', () => {
        const res = resolveItemForTrade({ inventory: [{ itemId: 'gem', quantity: 1 }], activeEffects: [] }, 'gem', 3, {});
        expect(res.error).toMatch(/not enough/);
    });

    test('refuses an item currently equipped as an effect', () => {
        mockResolveEffectType.mockReturnValue('boost');
        const res = resolveItemForTrade({ inventory: [{ itemId: 'booster', quantity: 1 }], activeEffects: [{ type: 'boost' }] }, 'booster', 1, {});
        expect(res.error).toMatch(/active as an effect/);
    });
});

describe('finalizeTrade', () => {
    const run = (aSide, bSide) => finalizeTrade({
        tradeId: 't1', guildId: GUILD, a: A, b: B, aSide, bSide, limits: LIMITS, currency: '💰',
    });

    test('refuses a trade where nobody offered anything', async () => {
        seed({ userId: A.id }); seed({ userId: B.id });
        const out = await run({ coins: 0, item: null }, { coins: 0, item: null });
        expect(out.ok).toBe(false);
        expect(out.message).toMatch(/Nobody has offered/);
    });

    test('refuses when the net coin flow is over a daily cap', async () => {
        seed({ userId: A.id, balance: 50_000 }); seed({ userId: B.id });
        const out = await run({ coins: 20_000, item: null }, { coins: 0, item: null });
        expect(out.ok).toBe(false);
        expect(out.message).toMatch(/daily cap/);
    });

    test('runs a confirmed coins-for-item trade to completion', async () => {
        seed({ userId: A.id, balance: 500 });
        seed({ userId: B.id, inventory: [{ itemId: 'gem', quantity: 1 }] });

        const out = await run(
            { coins: 200, item: null },
            { coins: 0, item: { itemId: 'gem', quantity: 1, value: 10 } },
        );

        expect(out).toMatchObject({ ok: true, delivered: true });
        expect(get(A.id).balance).toBe(300);
        expect(get(B.id).balance).toBe(200);
        expect(qtyOf(A.id, 'gem')).toBe(1);
    });

    test('a side that can no longer cover its offer calls the whole trade off', async () => {
        seed({ userId: A.id, balance: 50 });   // no longer has the 200 promised
        seed({ userId: B.id, inventory: [{ itemId: 'gem', quantity: 1 }] });

        const out = await run(
            { coins: 200, item: null },
            { coins: 0, item: { itemId: 'gem', quantity: 1, value: 10 } },
        );

        expect(out.ok).toBe(false);
        expect(out.message).toMatch(/no longer has/);
        // Nothing moved.
        expect(get(A.id).balance).toBe(50);
        expect(qtyOf(B.id, 'gem')).toBe(1);
    });
});

describe('sideEmpty', () => {
    test('is true only with no coins and no item', () => {
        expect(sideEmpty({ coins: 0, item: null })).toBe(true);
        expect(sideEmpty({ coins: 1, item: null })).toBe(false);
        expect(sideEmpty({ coins: 0, item: { itemId: 'x' } })).toBe(false);
    });
});
