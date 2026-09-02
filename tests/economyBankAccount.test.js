'use strict';

/**
 * #890. `/bank` was at 18.1% statement coverage and a **branch floor of 0** —
 * with two filed defects against it (#868, the gift-cap bypass) in code that
 * moves coins between a wallet and a bank on every call. `/bank transfer` is
 * covered by tests/economyBankTransfer.test.js; deposit and withdraw, which are
 * the other two thirds of the command and the two that own the atomic `$inc`
 * pairs, had never been executed by a test at all.
 *
 * What matters about them is that each is one guarded `$inc` pair, not a read
 * followed by a write: `balance: { $gte: amount }` on the filter is the entire
 * defence against a concurrent spend, and `'all'` is resolved from a preview
 * read that can be stale by the time the guarded update runs. So the cases are
 * the round trip, the guard refusing, and `'all'` — including `'all'` on an
 * empty side, which resolves to 0 and must be refused rather than written.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0 });
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const bank = require('../src/commands/economy/bank');
const { logTransaction } = require('../src/utils/logTransaction');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

const seedUser = (fields = {}) => mockUsers.seed({ userId: USER_ID, guildId: GUILD_ID, ...fields });
const me = () => mockUsers.get(USER_ID);

const run = async (subcommand, amount) => {
    const interaction = makeInteraction({ subcommand, options: { amount }, userId: USER_ID });
    await bank.execute(interaction);
    return interaction;
};

/** The `$inc` a guarded transfer applied, or undefined if the guard refused. */
const incFor = () => mockUsers.writes.find(w => w.update?.$inc)?.update.$inc;

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    jest.clearAllMocks();
    mockGuilds.seed({ guildId: GUILD_ID, economy: { currency: '💰' } });
});

describe('/bank deposit', () => {
    it('moves coins out of the wallet and into the bank', async () => {
        seedUser({ balance: 500, bank: 100 });

        const interaction = await run('deposit', '200');

        expect(me()).toMatchObject({ balance: 300, bank: 300 });
        expect(repliedText(interaction)).toContain('Deposit Successful');
        expectNonNegativeBalance(me());
    });

    it('takes and gives in one guarded update, not a read and a write', async () => {
        // The `$gte` filter is the whole defence against a concurrent spend
        // landing between the preview read and the transfer, and both halves
        // have to ride the same update or a failure between them destroys or
        // mints coins.
        seedUser({ balance: 500 });

        await run('deposit', '200');

        expect(incFor()).toEqual({ balance: -200, bank: 200 });
        const guarded = mockUsers.writes.find(w => w.update?.$inc);
        expect(guarded.query.balance).toEqual({ $gte: 200 });
    });

    it('refuses more than the wallet holds and moves nothing', async () => {
        seedUser({ balance: 50, bank: 0 });

        const interaction = await run('deposit', '200');

        expect(me()).toMatchObject({ balance: 50, bank: 0 });
        expect(repliedText(interaction)).toContain('You only have');
        expect(logTransaction).not.toHaveBeenCalled();
    });

    it("deposits the whole wallet for 'all'", async () => {
        seedUser({ balance: 750, bank: 250 });

        await run('deposit', 'all');

        expect(me()).toMatchObject({ balance: 0, bank: 1000 });
    });

    it("refuses 'all' on an empty wallet rather than writing a zero transfer", async () => {
        // 'all' resolves to the balance, so an empty wallet resolves to 0 — and
        // a zero-amount `$inc` would log a deposit of nothing and reply as if
        // something had happened.
        seedUser({ balance: 0, bank: 400 });

        const interaction = await run('deposit', 'all');

        expect(repliedText(interaction)).toContain('valid positive amount');
        expect(incFor()).toBeUndefined();
        expect(logTransaction).not.toHaveBeenCalled();
    });

    it.each([['nonsense'], ['-50'], ['0']])('refuses %s', async input => {
        seedUser({ balance: 500 });

        const interaction = await run('deposit', input);

        expect(repliedText(interaction)).toContain('valid positive amount');
        expect(me()).toMatchObject({ balance: 500, bank: 0 });
    });

    it('creates the account for a first-time depositor rather than failing', async () => {
        // No seeded document at all: the preview read upserts, and 'all' on the
        // new document is 0, which the amount check turns away.
        const interaction = await run('deposit', 'all');

        expect(me()).toMatchObject({ balance: 0 });
        expect(repliedText(interaction)).toContain('valid positive amount');
    });

    it('records the deposit as a negative wallet movement', async () => {
        seedUser({ balance: 500 });

        await run('deposit', '200');

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'deposit', amount: -200, balance: 300, bank: 200,
        }));
    });

    it('calls a large deposit a vault', async () => {
        seedUser({ balance: 20000 });

        const interaction = await run('deposit', '10000');

        expect(repliedText(interaction)).toContain('Vault Secured');
    });
});

describe('/bank withdraw', () => {
    it('moves coins out of the bank and into the wallet', async () => {
        seedUser({ balance: 100, bank: 500 });

        const interaction = await run('withdraw', '200');

        expect(me()).toMatchObject({ balance: 300, bank: 300 });
        expect(repliedText(interaction)).toContain('Withdrawal Successful');
        expectNonNegativeBalance(me());
    });

    it('guards on the bank side, not the wallet', async () => {
        seedUser({ balance: 0, bank: 500 });

        await run('withdraw', '200');

        expect(incFor()).toEqual({ bank: -200, balance: 200 });
        expect(mockUsers.writes.find(w => w.update?.$inc).query.bank).toEqual({ $gte: 200 });
    });

    it('refuses more than the bank holds and moves nothing', async () => {
        seedUser({ balance: 900, bank: 50 });

        const interaction = await run('withdraw', '200');

        expect(me()).toMatchObject({ balance: 900, bank: 50 });
        expect(repliedText(interaction)).toContain('You only have');
        expect(logTransaction).not.toHaveBeenCalled();
    });

    it("withdraws the whole bank for 'all'", async () => {
        seedUser({ balance: 250, bank: 750 });

        await run('withdraw', 'all');

        expect(me()).toMatchObject({ balance: 1000, bank: 0 });
    });

    it("refuses 'all' on an empty bank", async () => {
        seedUser({ balance: 400, bank: 0 });

        const interaction = await run('withdraw', 'all');

        expect(repliedText(interaction)).toContain('valid positive amount');
        expect(incFor()).toBeUndefined();
    });

    it('records the withdrawal as a positive wallet movement', async () => {
        seedUser({ balance: 100, bank: 500 });

        await run('withdraw', '200');

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'withdraw', amount: 200, balance: 300, bank: 300,
        }));
    });
});

describe('/bank round trips', () => {
    it('a deposit and a withdrawal of the same amount leave the totals alone', async () => {
        // The invariant the two halves share: coins move between two fields of
        // one document and are neither created nor destroyed on the way.
        seedUser({ balance: 1000, bank: 250 });

        await run('deposit', '400');
        await run('withdraw', '400');

        expect(me()).toMatchObject({ balance: 1000, bank: 250 });
    });

    it("'all' out and back is the same coins", async () => {
        seedUser({ balance: 1234, bank: 0 });

        await run('deposit', 'all');
        expect(me()).toMatchObject({ balance: 0, bank: 1234 });

        await run('withdraw', 'all');
        expect(me()).toMatchObject({ balance: 1234, bank: 0 });
    });

    it('never leaves either side negative, whatever order the two are called in', async () => {
        seedUser({ balance: 300, bank: 300 });

        await run('withdraw', '500');
        await run('deposit', '500');
        await run('deposit', 'all');
        await run('withdraw', 'all');

        expect(me().balance + me().bank).toBe(600);
        expect(me().bank).toBeGreaterThanOrEqual(0);
        expectNonNegativeBalance(me());
    });
});
