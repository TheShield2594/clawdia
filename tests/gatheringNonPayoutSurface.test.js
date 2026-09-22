'use strict';

/**
 * #873, pass 9 — the gathering commands' non-payout surface.
 *
 * The earlier passes keyed the run and bonus payouts and the buy/tool shop
 * refunds. What this pass reaches is the rest of the value-moving writes in the
 * same command trees, and every one had the same shape the audit keeps finding:
 * a refund or credit written without a key and, on the shop unwinds, without
 * reading the write back either.
 *
 *   - The repair/upgrade/unlock shop refunds went through the bare
 *     `refundBalance` (`refundCharge`): an unkeyed `$inc` that swallowed its own
 *     error and read nothing back, under a reply that said "your coins were
 *     refunded" whatever happened. They route through `refundBalanceOrOwe` now —
 *     `creditCoinsOrOwe` under `shopRefundPayoutKey` — and word the reply from
 *     the result, the same three-way the buy handlers use.
 *   - The gathering quest-claim credits rode `saveWithBalanceDelta` with no
 *     `payoutKey` while the quest was already marked claimed, so a failed credit
 *     locked the reward out behind a keyless, unreplayable record. Keyed now,
 *     with the embed saying the reward is owed when it will not land.
 *   - `/forge`'s refund read its own result (so it never announced a refund that
 *     had not happened) but filed nothing and carried no key. Through
 *     `creditCoinsOrOwe` under `forgeRefundPayoutKey` it is exactly-once and
 *     replayable.
 *
 * The behavioural half drives `refundBalanceOrOwe` against a store that
 * evaluates the payout-key guard for real. The static half holds the call sites
 * — the seven shop handlers, the three quest handlers and `/forge` — to the
 * keyed path, since their interactive flows are awkward to drive and the
 * contract is "spell this correctly at the call site". The tournament entry-fee
 * fix is driven behaviourally in tests/tournamentPrizePayout.test.js.
 */

const fs   = require('fs');
const path = require('path');
const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const { grindWallet, shopRefundMessage } = require('../src/utils/grindShop');
const {
    questClaimPayoutKey, tournamentEntryRefundPayoutKey, forgeRefundPayoutKey, shopRefundPayoutKey,
} = require('../src/utils/payoutKey');
const { recordOwedPayout } = require('../src/utils/owedPayout');

const GUILD = 'guild-1';
const USER  = 'user-1';
const interaction = { user: { id: USER }, guild: { id: GUILD }, id: 'i1' };

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

// ─── The keys the live payout and its replay have to agree on ───────────────────

describe('the pass-9 payout keys name their payout and nothing else', () => {
    test('a quest claim is keyed by service, user, quest and the instance expiry', () => {
        // The board re-deals the same template ids each cycle, so the expiry is
        // what keeps tomorrow's reward from being guarded by today's replay.
        expect(questClaimPayoutKey('hunt', 'u1', 'hq_hunt_5', 1_700_000_000_000))
            .toBe('quest:hunt:u1:hq_hunt_5:1700000000000');
        expect(questClaimPayoutKey('fish', 'u1', 'hq_hunt_5', 1_700_000_000_000))
            .not.toBe(questClaimPayoutKey('hunt', 'u1', 'hq_hunt_5', 1_700_000_000_000));
    });

    test('a tournament entry refund is keyed by the tournament and the entrant', () => {
        expect(tournamentEntryRefundPayoutKey('t1', 'u1')).toBe('tournament:t1:entry:u1:refund');
        // Apart from the prize the same wallet can win out of the same tournament.
        expect(tournamentEntryRefundPayoutKey('t1', 'u1')).not.toBe('tournament:t1:place:1');
    });

    test('a forge refund is keyed by the interaction', () => {
        expect(forgeRefundPayoutKey('i9')).toBe('forge:i9:refund');
    });

    test('the shop refund key is the one the handlers spell', () => {
        expect(shopRefundPayoutKey('i1')).toBe('shop:i1:refund');
    });
});

// ─── refundBalanceOrOwe: the keyed shop refund ──────────────────────────────────

describe('refundBalanceOrOwe puts the coins back exactly once', () => {
    const KEY = 'shop:i1:refund';

    test('a refund lands under its key, which is written on the document', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 300, paidPayouts: [] });

        const { refundBalanceOrOwe } = grindWallet('hunt');
        const result = await refundBalanceOrOwe(interaction, 200);

        expect(result.credited).toBe(true);
        expect(mockUsers.get(USER).balance).toBe(500);
        expect(mockUsers.get(USER).paidPayouts.some(p => p.key === KEY)).toBe(true);
    });

    test('a second refund under the same key moves no coins', async () => {
        // A refund that committed and lost its response is retried under the same
        // key — the guard makes the retry a no-op, not a double credit.
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 500, paidPayouts: [{ key: KEY, at: new Date() }] });

        const { refundBalanceOrOwe } = grindWallet('mine');
        const result = await refundBalanceOrOwe(interaction, 200);

        expect(result.credited).toBe(true);           // duplicate is success
        expect(mockUsers.get(USER).balance).toBe(500); // unchanged
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a refund with no document to land on is recorded as replayable coins', async () => {
        const { refundBalanceOrOwe } = grindWallet('fish');
        const result = await refundBalanceOrOwe(interaction, 200);

        expect(result.credited).toBe(false);
        expect(result.owed).toBe(true);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'fish',
            jobName: 'shopRefund',
            payload: { kind: 'coins', userId: USER, guildId: GUILD, amount: 200, payoutKey: KEY },
        }));
    });
});

describe('shopRefundMessage words the reply from the refund', () => {
    const opts = { action: 'The repair failed', currency: '💰', amount: 200 };

    test('a landed refund tells the player their coins came back', () => {
        expect(shopRefundMessage({ credited: true }, opts)).toMatch(/your coins were refunded/i);
    });

    test('an owed refund says it was recorded, not returned', () => {
        const msg = shopRefundMessage({ credited: false, owed: true }, opts);
        expect(msg).toMatch(/recorded as owed/);
        expect(msg).not.toMatch(/your coins were refunded/i);
    });

    test('a refund that could not even be recorded points at an admin', () => {
        const msg = shopRefundMessage({ credited: false, owed: false }, opts);
        expect(msg).toMatch(/could not be returned or recorded/);
        expect(msg).toMatch(/contact a server admin/);
    });
});

// ─── The call sites ─────────────────────────────────────────────────────────────

const ECONOMY = path.join(__dirname, '..', 'src', 'commands', 'economy');
const read = rel => fs.readFileSync(path.join(ECONOMY, rel), 'utf8');

describe('the repair / upgrade / unlock shop refunds go through the keyed path', () => {
    const SHOP_FILES = [
        'hunt/shop/repair.js', 'hunt/shop/upgrade.js', 'hunt/shop/unlock.js',
        'fish/shop/repair.js',
        'mine/shop/repair.js', 'mine/shop/upgrade.js', 'mine/shop/unlock.js',
    ];

    test.each(SHOP_FILES)('%s refunds through refundBalanceOrOwe and words the reply from it', f => {
        const src = read(f);
        expect(src).toMatch(/refundBalanceOrOwe\(/);
        expect(src).toMatch(/shopRefundMessage\(/);
    });

    test.each(SHOP_FILES)('%s no longer hands coins back with the bare refundBalance', f => {
        // The bare `refundBalance(interaction, …)` read nothing back and
        // announced a refund regardless; only `refundBalanceOrOwe` should remain.
        const src = read(f);
        expect(src).not.toMatch(/[^O]refundBalance\(interaction/);
    });
});

describe('the gathering quest claims key their credit and surface an owed reward', () => {
    const QUEST_FILES = [
        ['hunt/quests.js', 'hunt'],
        ['fish/quests.js', 'fish'],
        ['mine/quests.js', 'mine'],
    ];

    test.each(QUEST_FILES)('%s builds a questClaimPayoutKey for the claim credit', f => {
        const src = read(f);
        expect(src).toMatch(/questClaimPayoutKey\(/);
        expect(src).toMatch(/saveWithBalanceDelta/);
    });

    test.each(QUEST_FILES)('%s reads the credit result and shows an owed note', f => {
        const src = read(f);
        expect(src).toMatch(/credited:\s*claimCredited/);
        expect(src).toMatch(/Payout Owed/);
    });
});

describe('the /forge refund is keyed and replayable', () => {
    test('forge.js refunds through creditCoinsOrOwe under forgeRefundPayoutKey', () => {
        const src = read('forge.js');
        expect(src).toMatch(/creditCoinsOrOwe\(/);
        expect(src).toMatch(/forgeRefundPayoutKey\(/);
        // The reply is worded from the refund's outcome, three ways.
        expect(src).toMatch(/refundClause\(/);
        expect(src).not.toMatch(/\$inc:\s*\{\s*balance:\s*cost\s*\}/);
    });
});
