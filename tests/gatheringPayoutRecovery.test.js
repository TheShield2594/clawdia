'use strict';

/**
 * #873, pass 6 — the gathering payouts and detached item grants are keyed.
 *
 * `/hunt`, `/fish`, `/mine` and `/explore` are the highest-volume coin credits
 * in the economy and were the last to go unkeyed. Each read the user, mutated
 * `balance` across an interactive window, and credited the net change through
 * `commitBalanceDelta` with no key — which made three failures live at once:
 *
 *   - the retry inside `commitBalanceDelta` re-credited a write whose response
 *     was lost, double-paying;
 *   - a run against a pruned document was reported as paid though no coins
 *     moved (the #804 failure the keyed path exists to tell apart);
 *   - a payout that ultimately failed was filed as a keyless `FailedJob` that
 *     carries no `kind`, so `payouts:replay` could not settle it.
 *
 * Keyed (`gatherPayoutKey`), the credit is exactly-once, a missing document is
 * recorded as a replayable owed `coins` payload, and a replay guards itself.
 * The relic an expedition turns up and the item a `/use` loot box pays are the
 * item side of the same fix (`grantItemsOrOwe`).
 *
 * The behavioural half drives the service commit functions against a store that
 * evaluates the payout-key guard for real, because a mock that waved it through
 * would report the retry as safe when the key is the only reason it is. The
 * static half holds the call sites — the four commands and the seven shop
 * handlers — to the keyed path, since their collector flows are awkward to drive
 * and the contract is "spell this correctly at the call site".
 */

const fs   = require('fs');
const path = require('path');
const { fakeCollection } = require('./helpers/fakeCollection');
const { grindCommandSource } = require('./helpers/grindSources');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [], inventory: [] });
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const { commitHunt }            = require('../src/services/huntService');
const { commitCast }            = require('../src/services/fishService');
const { commitDig }             = require('../src/services/mineService');
const { commitExpeditionRelic } = require('../src/services/exploreService');
const { recordOwedPayout }      = require('../src/utils/owedPayout');

const GUILD = 'guild-1';
const USER  = 'user-1';
const WHO   = { userId: USER, guildId: GUILD };

/** The in-memory user document a grind command hands the commit — its own
 *  `balance` is detached before the save, so only the store's balance matters. */
function makeDoc(balance) {
    return {
        userId: USER, guildId: GUILD, balance,
        save: async () => {}, unmarkModified() {}, markModified() {},
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

// The three grind services share one commit contract, so they share the test.
const COMMITS = [
    { name: 'hunt', commit: commitHunt, jobName: 'huntPayout' },
    { name: 'fish', commit: commitCast, jobName: 'castPayout' },
    { name: 'mine', commit: commitDig,  jobName: 'minePayout' },
];

describe.each(COMMITS)('/%s credits its haul exactly once', ({ name, commit, jobName }) => {
    const KEY = `gather:${name}:i1:run`;

    test('the payout lands under its key, which is written on the document', async () => {
        mockUsers.seed({ ...WHO, balance: 1000, paidPayouts: [] });

        const doc = makeDoc(1500);                       // a 500-coin haul, in memory
        const result = await commit(doc, 1000, { payoutKey: KEY });

        expect(result.payoutOwed).toBe(0);
        expect(mockUsers.get(USER).balance).toBe(1500);
        expect(mockUsers.get(USER).paidPayouts.some(p => p.key === KEY)).toBe(true);
    });

    test('a second credit under the same key moves no coins', async () => {
        // A write that committed and lost its response is retried under the same
        // key; the guard makes the retry a no-op rather than a double payment.
        mockUsers.seed({ ...WHO, balance: 1500, paidPayouts: [{ key: KEY, at: new Date() }] });

        const doc = makeDoc(2000);                       // would credit another 500
        const result = await commit(doc, 1500, { payoutKey: KEY });

        expect(result.payoutOwed).toBe(0);               // duplicate is success
        expect(mockUsers.get(USER).balance).toBe(1500);  // unchanged
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a payout with no document to land on is recorded as replayable coins', async () => {
        // No seeded document: the guarded credit matches nothing, is classified
        // 'missing', and is filed with a `kind` and the key — the shape
        // `payouts:replay` can settle, not the keyless FailedJob it used to be.
        const doc = makeDoc(500);
        const result = await commit(doc, 0, { payoutKey: KEY });

        expect(result.payoutOwed).toBe(500);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: name,
            jobName,
            guildId: GUILD,
            payload: { kind: 'coins', userId: USER, guildId: GUILD, amount: 500, payoutKey: KEY },
        }));
    });

    test('a net-zero run issues no credit and owes nothing', async () => {
        mockUsers.seed({ ...WHO, balance: 1000, paidPayouts: [] });

        const doc = makeDoc(1000);                       // a blank run, no coins moved
        const result = await commit(doc, 1000, { payoutKey: KEY });

        expect(result.payoutOwed).toBe(0);
        expect(mockUsers.get(USER).balance).toBe(1000);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('an expedition relic is granted or recorded as owed', () => {
    const KEY = 'explore:i5:relic';

    test('a relic that lands is in the bag and owes nothing', async () => {
        mockUsers.seed({ ...WHO, inventory: [], paidPayouts: [] });

        const result = await commitExpeditionRelic({ ...WHO }, { itemId: 'ancient_coin' }, 'i5');

        expect(result.granted).toBe(true);
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: 'ancient_coin', quantity: 1 }]);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a relic that cannot be granted is recorded as owed, not announced', async () => {
        // No document: the bare grant this replaced would have read the absence
        // of a throw as success and announced a relic in an empty bag.
        const result = await commitExpeditionRelic({ ...WHO }, { itemId: 'ancient_coin' }, 'i5');

        expect(result.granted).toBe(false);
        expect(result.owed).toBe(true);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'explore',
            jobName: 'relicGrant',
            payload: expect.objectContaining({
                kind: 'items', itemId: 'ancient_coin', quantity: 1, payoutKey: KEY,
            }),
        }));
    });

    // The double failure the three-way message exists for: the grant misses AND
    // the owed record cannot be written, so there is nothing to replay. The
    // caller must not tell the player it was recorded.
    test('reports neither granted nor owed when the owed record cannot be written', async () => {
        recordOwedPayout.mockResolvedValue(false);

        const result = await commitExpeditionRelic({ ...WHO }, { itemId: 'ancient_coin' }, 'i5');

        expect(result).toMatchObject({ granted: false, owed: false });
    });
});

// ─── The call sites ────────────────────────────────────────────────────────────

describe('the gathering commands key their payouts', () => {
    const cases = [
        ['hunt', [`gatherPayoutKey('hunt', interaction.id, 'run')`, `gatherPayoutKey('hunt', interaction.id, 'apex')`]],
        ['fish', [`gatherPayoutKey('fish', interaction.id, 'run')`, `gatherPayoutKey('fish', interaction.id, 'boss')`]],
        ['mine', [`gatherPayoutKey('mine', interaction.id, 'run')`]],
        ['explore', [`gatherPayoutKey('explore', interaction.id, 'find')`, `gatherPayoutKey('explore', interaction.id, 'encounter')`]],
    ];

    test.each(cases)('/%s builds a gatherPayoutKey for every credit it makes', (command, keys) => {
        const src = grindCommandSource(command);
        for (const key of keys) expect(src).toContain(key);
    });
});

describe('the gathering shops refund through the owe path', () => {
    const ECONOMY = path.join(__dirname, '..', 'src', 'commands', 'economy');
    const SHOP_FILES = [
        'hunt/shop/buy.js', 'hunt/shop/weapon.js',
        'fish/shop/buy.js', 'fish/shop/rod.js', 'fish/shop/upgrade.js',
        'mine/shop/buy.js', 'mine/shop/pickaxe.js',
    ];
    const read = f => fs.readFileSync(path.join(ECONOMY, f), 'utf8');

    test.each(SHOP_FILES)('%s refunds through creditCoinsOrOwe under a shop key', f => {
        const src = read(f);
        expect(src).toMatch(/creditCoinsOrOwe/);
        expect(src).toMatch(/shopRefundPayoutKey/);
    });

    test.each(SHOP_FILES)('%s no longer hands coins back with a bare positive $inc', f => {
        // The debit is `$inc: { balance: -cost }`; the refund was the positive
        // `$inc: { balance: cost }` that read nothing back. The debit keeps its
        // minus sign, so this catches only the refund.
        const src = read(f);
        expect(src).not.toMatch(/\$inc:\s*\{\s*balance:\s*(totalCost|cost|rodData\.cost|weaponData\.cost|pickaxeData\.cost)\s*\}/);
    });

    // The three-way the rest of the economy uses (market/invest/crime): a refund
    // that is neither returned nor recorded (`recordOwedPayout` failed too) must
    // not be reported as owed. Each handler branches on `owed` and falls through
    // to a terminal "contact an admin" line.
    test.each(SHOP_FILES)('%s distinguishes an owed refund from one that could not be recorded', f => {
        const src = read(f);
        expect(src).toMatch(/\.owed/);
        expect(src).toMatch(/could not be returned or recorded/);
    });
});

describe('the detached item grants say when a prize is only owed', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'economy', rel), 'utf8');

    test('an owed expedition relic is not announced as in the bag', () => {
        const src = read('explore/go.js');
        expect(src).toMatch(/commitExpeditionRelic/);
        expect(src).toMatch(/relicOwed/);
        // Three-way: owed and unrecorded read differently.
        expect(src).toMatch(/please contact a server admin/);
    });

    test('a loot-box prize that could not be granted is shown as owed', () => {
        const src = read('use.js');
        expect(src).toMatch(/grantItemsOrOwe/);
        expect(src).toMatch(/lootBoxItemPayoutKey/);
        expect(src).toMatch(/Not Yet in Your Inventory/);
        expect(src).toMatch(/wonGrant\.owed/);
        expect(src).toMatch(/could not be recorded/);
    });
});
