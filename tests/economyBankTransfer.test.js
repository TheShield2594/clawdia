'use strict';

/**
 * #897. `/bank transfer` moved coins between two players with none of the guards
 * `/gift type:coins` puts on the identical operation — no daily cap, no
 * account-age gate, no accounting. The caps exist to stop alt-account funnelling,
 * so an unlimited funnel sitting next to them made them decorative: anyone who
 * hit the gift cap simply used transfer instead.
 *
 * It also debited the sender and then credited the receiver with nothing
 * watching the second write (#868), which is covered against the shared path in
 * tests/coinTransfer.test.js. These drive the command, which is where the
 * question "does the cap apply here at all" is actually answered.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, inventory: [] });
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));

const bank = require('../src/commands/economy/bank');
const { logTransaction } = require('../src/utils/logTransaction');

const GUILD_ID = 'guild-1';
const SENDER_ID = 'user-1';        // the harness's own user
const RECIPIENT_ID = 'friend-1';

const OLD_ACCOUNT = Date.now() - 365 * 24 * 3_600_000;

const seedGuild = (economy = {}) => mockGuilds.seed({
    guildId: GUILD_ID, economy: { currency: '💰', ...economy },
});

const seedUser = (userId, fields = {}) => mockUsers.seed({ userId, guildId: GUILD_ID, ...fields });

const recipient = (overrides = {}) => ({
    id: RECIPIENT_ID, username: 'friend', bot: false,
    createdTimestamp: OLD_ACCOUNT, ...overrides,
});

const run = async (options) => {
    const interaction = makeInteraction({ subcommand: 'transfer', options, userId: SENDER_ID });
    await bank.execute(interaction);
    return interaction;
};

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
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

describe('/bank transfer', () => {
    it('moves the coins and logs both sides', async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 5_000 });
        seedUser(RECIPIENT_ID, { balance: 0 });

        const interaction = await run({ user: recipient(), amount: 1_000 });

        expect(mockUsers.get(SENDER_ID).balance).toBe(4_000);
        expect(mockUsers.get(RECIPIENT_ID).balance).toBe(1_000);
        expect(repliedText(interaction)).toContain('Transfer Successful');
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'transfer_send', amount: -1_000 }));
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'transfer_receive', amount: 1_000 }));
        expectNonNegativeBalance([mockUsers.get(SENDER_ID), mockUsers.get(RECIPIENT_ID)], 'bank transfer');
    });

    it('acknowledges the interaction before touching the database', async () => {
        // Two reads and up to three writes against Discord's three-second
        // acknowledgement window: without a defer a slow database shows the
        // member "the application did not respond" with the coins already moved.
        seedGuild();
        seedUser(SENDER_ID, { balance: 5_000 });
        seedUser(RECIPIENT_ID, { balance: 0 });

        const interaction = await run({ user: recipient(), amount: 1_000 });

        expect(interaction.deferReply).toHaveBeenCalledWith(expect.objectContaining({
            flags: expect.anything(),
        }));
        expect(interaction.reply).not.toHaveBeenCalled();
        // The transfer is still announced in the channel the way it always was;
        // only the sender's receipt and the refusals are private.
        expect(interaction.followUp).toHaveBeenCalled();
    });

    it('spends the same daily budget /gift does, rather than one of its own', async () => {
        // The whole point: a transfer is not a way around the gift cap, so it
        // has to write to the counter the gift cap reads.
        seedGuild();
        seedUser(SENDER_ID, { balance: 50_000 });
        seedUser(RECIPIENT_ID, { balance: 0 });

        await run({ user: recipient(), amount: 4_000 });

        expect(mockUsers.get(SENDER_ID).dailyGiftSent).toBe(4_000);
        expect(mockUsers.get(RECIPIENT_ID).dailyGiftReceived).toBe(4_000);
    });

    it('refuses a transfer past the daily send cap', async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 500_000, dailyGiftSent: 9_500, dailyGiftReset: new Date() });
        seedUser(RECIPIENT_ID, { balance: 0 });

        const interaction = await run({ user: recipient(), amount: 1_000 });

        expect(repliedText(interaction)).toContain('Daily transfer cap reached');
        expect(mockUsers.get(SENDER_ID).balance).toBe(500_000);
        expect(mockUsers.get(RECIPIENT_ID).balance).toBe(0);
    });

    it("refuses a transfer past the recipient's daily receiving cap", async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 500_000 });
        seedUser(RECIPIENT_ID, { balance: 0, dailyGiftReceived: 24_500, dailyGiftReceivedReset: new Date() });

        const interaction = await run({ user: recipient(), amount: 1_000 });

        expect(repliedText(interaction)).toContain('daily receiving cap');
        expect(mockUsers.get(SENDER_ID).balance).toBe(500_000);
    });

    it('honours a guild that has raised or removed the cap', async () => {
        seedGuild({ giftCoinCapDaily: 0, giftCoinReceiveCapDaily: 0 });
        seedUser(SENDER_ID, { balance: 500_000 });
        seedUser(RECIPIENT_ID, { balance: 0 });

        await run({ user: recipient(), amount: 400_000 });

        expect(mockUsers.get(RECIPIENT_ID).balance).toBe(400_000);
    });

    it('turns away an account too new to be sending coins', async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 5_000 });

        const interaction = makeInteraction({
            subcommand: 'transfer',
            options: { user: recipient(), amount: 1_000 },
            userId: SENDER_ID,
            user: { createdTimestamp: Date.now() - 3_600_000 },
        });
        await bank.execute(interaction);

        expect(repliedText(interaction)).toMatch(/too new to send/);
        expect(mockUsers.get(SENDER_ID).balance).toBe(5_000);
    });

    it('turns away a recipient too new to be receiving them', async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 5_000 });

        const interaction = await run({
            user: recipient({ createdTimestamp: Date.now() - 3_600_000 }),
            amount: 1_000,
        });

        expect(repliedText(interaction)).toMatch(/too new to receive/);
        expect(mockUsers.get(SENDER_ID).balance).toBe(5_000);
    });

    it('refuses more than the wallet holds', async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 100 });
        seedUser(RECIPIENT_ID, { balance: 0 });

        const interaction = await run({ user: recipient(), amount: 500 });

        expect(repliedText(interaction)).toContain("don't have enough coins");
        expect(mockUsers.get(SENDER_ID).balance).toBe(100);
        expect(mockUsers.get(RECIPIENT_ID).balance).toBe(0);
    });

    it('refuses a bot and refuses yourself', async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 5_000 });

        const toBot = await run({ user: recipient({ bot: true }), amount: 100 });
        expect(repliedText(toBot)).toContain('cannot transfer coins to bots');

        const toSelf = await run({
            user: recipient({ id: SENDER_ID, username: 'player' }),
            amount: 100,
        });
        expect(repliedText(toSelf)).toContain('cannot transfer coins to yourself');

        expect(mockUsers.get(SENDER_ID).balance).toBe(5_000);
    });

    it('returns the coins and says so when the credit cannot be made', async () => {
        // #868: this used to reply "Failed to transfer coins" with the sender
        // already debited and nothing refunding them.
        seedGuild();
        seedUser(SENDER_ID, { balance: 5_000 });
        seedUser(RECIPIENT_ID, { balance: 0 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const real = mockUsers.model.findOneAndUpdate;
        mockUsers.model.findOneAndUpdate = jest.fn(async (query, update, options) => {
            if (query.userId === RECIPIENT_ID) throw new Error('connection reset');
            return real(query, update, options);
        });

        const interaction = await run({ user: recipient(), amount: 1_000 });

        expect(repliedText(interaction)).toContain('coins were returned');
        expect(mockUsers.get(SENDER_ID).balance).toBe(5_000);
        expect(mockUsers.get(SENDER_ID).dailyGiftSent).toBe(0);
        expect(mockUsers.get(RECIPIENT_ID).balance).toBe(0);

        console.error.mockRestore();
    });

    it('says the coins are recorded when they can be neither sent nor returned', async () => {
        seedGuild();
        seedUser(SENDER_ID, { balance: 5_000 });
        seedUser(RECIPIENT_ID, { balance: 0 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const real = mockUsers.model.findOneAndUpdate;
        mockUsers.model.findOneAndUpdate = jest.fn(async (query, update, options) => {
            if (query.userId === RECIPIENT_ID) throw new Error('connection reset');
            return real(query, update, options);
        });
        mockUsers.model.updateOne = jest.fn(async () => { throw new Error('still down'); });

        const interaction = await run({ user: recipient(), amount: 1_000 });

        // Not "failed": the sender's coins are somewhere, and telling them so is
        // the difference between a bug report and a silent loss.
        expect(repliedText(interaction)).toContain('It is recorded and an admin can restore it');

        console.error.mockRestore();
    });
});
