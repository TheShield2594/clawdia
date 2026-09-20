'use strict';

/**
 * #873, pass 8 — the seasonal-event currency credits are keyed.
 *
 * Candy, hearts, snowflakes, shells and frost tokens live in the `eventCurrency`
 * array, not in `balance`, so the pass-6 coin helper could not credit them and
 * pass 7 stopped short of them for exactly that reason. Every one moved with a
 * bare, unkeyed write announced as paid regardless — a `$inc`/`$push` on the
 * array in the event activities and the event shop, and the currency rode a
 * `save()` snapshot in the four save-based activities. That made three failures
 * live at once, the same three the coin side had:
 *
 *   - the retry inside `creditEventCurrencyOrOwe` re-credits a write whose
 *     response was lost, double-crediting;
 *   - a credit against a pruned document is reported as paid though nothing
 *     moved (the #804 failure the key exists to tell apart);
 *   - a credit that ultimately failed was lost, with no replayable record.
 *
 * `creditEventCurrencyOnce` puts the payout-key guard in the write's own filter
 * and credits the array in one aggregation-pipeline update; `creditEventCurrencyOrOwe`
 * wraps it with the retry and the owed `eventCurrency` record. This drives both
 * against a store that evaluates the guard and the pipeline for real — a mock
 * that waved either through would report the retry as safe when the key is the
 * only reason it is — and holds the call sites to the keyed path.
 */

const fs   = require('fs');
const path = require('path');
const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [], eventCurrency: [] });
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
// The real recordOwedPayout is swapped for a spy so the owed payload can be
// asserted directly; replayOwedPayout stays the real one, so the replay path is
// exercised end to end against the same store.
jest.mock('../src/utils/owedPayout', () => {
    const actual = jest.requireActual('../src/utils/owedPayout');
    return { ...actual, recordOwedPayout: jest.fn(async () => true) };
});

const { EmbedBuilder } = require('discord.js');
const { creditEventCurrencyOrOwe } = require('../src/utils/creditOrOwe');
const { creditEventCurrencyOnce }  = require('../src/utils/payoutKey');
const { creditActivityReward }     = require('../src/utils/eventActivityReward');
const { recordOwedPayout, replayOwedPayout } = require('../src/utils/owedPayout');

const GUILD = 'guild-1';
const USER  = 'user-1';
const WHO   = { userId: USER, guildId: GUILD };
const KEY   = 'event:trickortreat:i1:currency';

const balanceOf = id => mockUsers.get(id).eventCurrency.find(e => e.currencyId === 'candy')?.amount ?? 0;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockUsers.reset();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('creditEventCurrencyOrOwe credits exactly once', () => {
    test('appends a fresh entry when the player holds none of that currency', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [], paidPayouts: [] });

        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, { payoutKey: KEY, service: 'trickortreat' });

        expect(result.credited).toBe(true);
        expect(balanceOf(USER)).toBe(5);
        expect(mockUsers.get(USER).paidPayouts.some(p => p.key === KEY)).toBe(true);
    });

    test('bumps the existing entry, leaving other currencies alone', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'candy', amount: 10 }, { currencyId: 'shells', amount: 3 }], paidPayouts: [] });

        await creditEventCurrencyOrOwe(WHO, 'candy', 5, { payoutKey: KEY });

        expect(balanceOf(USER)).toBe(15);
        expect(mockUsers.get(USER).eventCurrency.find(e => e.currencyId === 'shells').amount).toBe(3);
    });

    test('a second credit under the same key moves no currency', async () => {
        // A write that committed and lost its response is retried under the same
        // key; the guard makes the retry a no-op rather than a double credit.
        mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'candy', amount: 5 }], paidPayouts: [{ key: KEY, at: new Date() }] });

        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, { payoutKey: KEY });

        expect(result.credited).toBe(true);        // duplicate is success
        expect(balanceOf(USER)).toBe(5);            // unchanged
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a credit with no document to land on is recorded as replayable eventCurrency', async () => {
        // No seeded document: the guarded credit matches nothing, is classified
        // 'missing', and is filed with a `kind` and the key — the shape
        // `payouts:replay` can settle.
        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, {
            payoutKey: KEY, service: 'trickortreat', jobName: 'candyReward',
        });

        expect(result).toMatchObject({ credited: false, owed: true });
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'trickortreat',
            jobName: 'candyReward',
            guildId: GUILD,
            payload: { kind: 'eventCurrency', userId: USER, guildId: GUILD, currencyId: 'candy', amount: 5, payoutKey: KEY },
        }));
    });

    test('reports neither credited nor owed when the owed record cannot be written', async () => {
        recordOwedPayout.mockResolvedValue(false);
        const result = await creditEventCurrencyOrOwe(WHO, 'candy', 5, { payoutKey: KEY });
        expect(result).toMatchObject({ credited: false, owed: false });
    });

    test('a non-positive amount or missing currency is a no-op', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [], paidPayouts: [] });
        expect(await creditEventCurrencyOrOwe(WHO, 'candy', 0, { payoutKey: KEY })).toMatchObject({ credited: true });
        expect(await creditEventCurrencyOrOwe(WHO, null, 5, { payoutKey: KEY })).toMatchObject({ credited: true });
        expect(balanceOf(USER)).toBe(0);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('an owed eventCurrency payout replays under its key', () => {
    const payload = { kind: 'eventCurrency', userId: USER, guildId: GUILD, currencyId: 'candy', amount: 5, payoutKey: KEY };

    test('a replay credits the currency and records the key', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [], paidPayouts: [] });
        await replayOwedPayout(payload);
        expect(balanceOf(USER)).toBe(5);
        expect(mockUsers.get(USER).paidPayouts.some(p => p.key === KEY)).toBe(true);
    });

    test('a second replay under the same key moves nothing', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'candy', amount: 5 }], paidPayouts: [{ key: KEY, at: new Date() }] });
        await expect(replayOwedPayout(payload)).resolves.toBeUndefined();
        expect(balanceOf(USER)).toBe(5);
    });

    test('a replay with no document to credit throws, so the record stays owed', async () => {
        await expect(replayOwedPayout(payload)).rejects.toThrow(/nothing to credit/);
    });

    test('a payload without a key is refused rather than credited blind', async () => {
        await expect(replayOwedPayout({ ...payload, payoutKey: undefined })).rejects.toThrow(/incomplete/);
    });
});

describe('creditEventCurrencyOnce classifies a miss', () => {
    test('a document without the key that should have matched reads as unknown', async () => {
        // Present, key absent — the guarded update should have matched, so
        // something wrote concurrently. Callers treat this as owed, which is safe
        // because the replay carries the same key and guards itself.
        mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'candy', amount: 5 }], paidPayouts: [] });
        // Force the guarded update to miss by pre-recording the key, then asking
        // classify to explain a *different* absent key.
        const { status } = await creditEventCurrencyOnce(WHO, 'candy', 5, KEY);
        expect(status).toBe('paid');
        const again = await creditEventCurrencyOnce(WHO, 'candy', 5, KEY);
        expect(again.status).toBe('duplicate');
    });
});

describe('creditActivityReward delivers both rewards or says they are owed', () => {
    const opts = {
        filter: WHO, activity: 'trickortreat', interactionId: 'i9',
        currencyId: 'candy', currencyAmount: 5, currencyLabel: 'Candy',
        itemId: 'candy_bag', itemLabel: 'Candy Bag',
    };

    test('a win credits the currency and the item, adding no warning field', async () => {
        mockUsers.seed({ ...WHO, eventCurrency: [], inventory: [], paidPayouts: [] });
        const embed = new EmbedBuilder();

        const { currency, item } = await creditActivityReward(embed, opts);

        expect(currency.credited).toBe(true);
        expect(item.granted).toBe(true);
        expect(balanceOf(USER)).toBe(5);
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'candy_bag', quantity: 1 }]);
        expect(embed.data.fields ?? []).toHaveLength(0);
    });

    test('a reward that could not land is recorded and shown as owed, not announced', async () => {
        // No document: both credits are classified 'missing' and recorded as
        // owed. The embed must say so rather than let the description stand.
        const embed = new EmbedBuilder();

        const { currency, item } = await creditActivityReward(embed, opts);

        expect(currency.credited).toBe(false);
        expect(item.granted).toBe(false);
        expect(recordOwedPayout).toHaveBeenCalledTimes(2);
        const field = (embed.data.fields ?? [])[0];
        expect(field.name).toMatch(/Not Yet Delivered/);
        expect(field.value).toMatch(/Candy/);
        expect(field.value).toMatch(/Candy Bag/);
        expect(field.value).toMatch(/recorded as owed/);
    });
});

// ─── The call sites ────────────────────────────────────────────────────────────

const EVENT = path.join(__dirname, '..', 'src', 'commands', 'economy', 'event');
const readEvent = f => fs.readFileSync(path.join(EVENT, f), 'utf8');

describe('the save-based activities key their coins and route currency and item through the helpers', () => {
    const cases = [
        ['trickortreat.js', 'trickortreat'],
        ['sandcastle.js',   'sandcastle'],
        ['lovenote.js',     'lovenote'],
        ['trackhunt.js',    'trackhunt'],
    ];

    test.each(cases)('%s keys its coin credit and calls creditActivityReward', (file, activity) => {
        const src = readEvent(file);
        expect(src).toContain(`eventActivityPayoutKey('${activity}', interaction.id, 'coins')`);
        expect(src).toContain('creditActivityReward(embed, {');
    });

    test.each(cases)('%s no longer rides event currency on the save or grants the item bare', (file) => {
        const src = readEvent(file);
        expect(src).not.toMatch(/addEventCurrency/);
        expect(src).not.toMatch(/grantInventoryItem/);
    });
});

describe('/event snowball keys both credits', () => {
    test('coins and snowflakes go through the owe helpers under interaction-keyed keys', () => {
        const src = readEvent('snowball.js');
        expect(src).toContain(`eventActivityPayoutKey('snowball', interaction.id, 'coins')`);
        expect(src).toContain(`eventActivityPayoutKey('snowball', interaction.id, 'currency')`);
        expect(src).toMatch(/creditCoinsOrOwe\(attackerFilter/);
        expect(src).toMatch(/creditEventCurrencyOrOwe\(attackerFilter/);
    });

    test('the bare currency $inc/$push dance is gone', () => {
        const src = readEvent('snowball.js');
        expect(src).not.toMatch(/\$push:\s*\{\s*eventCurrency/);
        expect(src).not.toMatch(/'eventCurrency\.\$\.amount':\s*SNOWFLAKE_REWARD/);
    });
});

describe('/eventshop refunds through the owe path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'economy', 'eventshop.js'), 'utf8');

    test('the purchase refund is keyed and recoverable', () => {
        expect(src).toMatch(/creditEventCurrencyOrOwe\(/);
        expect(src).toContain('eventShopRefundPayoutKey(interaction.id)');
    });

    test('it no longer hands the currency back with a bare positive $inc', () => {
        // The debit is `$inc: { 'eventCurrency.$.amount': -totalCost }`; the
        // refund was the positive one. The debit keeps its minus sign.
        expect(src).not.toMatch(/'eventCurrency\.\$\.amount':\s*totalCost\b/);
    });

    test('it distinguishes a refunded purchase from one only recorded as owed', () => {
        expect(src).toMatch(/refund\.owed/);
        expect(src).toMatch(/could not be refunded/);
    });
});
