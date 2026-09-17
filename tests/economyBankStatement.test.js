'use strict';

// `/bank statement` (#1009): a member reads their own transactions back from
// Discord, newest first, ephemeral and paged — the receipt the bot always kept
// but never showed anyone. Read-only: it writes no Transaction and moves no
// coin, which is the whole point of the ledger being a read side.

const { makeInteraction } = require('./helpers/fakeInteraction');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue({ economy: { currency: '💰' } }) }));
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/ledger', () => ({
    ...jest.requireActual('../src/utils/ledger'),
    fetchTransactions: jest.fn(),
}));

const bank = require('../src/commands/economy/bank');
const { fetchTransactions } = require('../src/utils/ledger');
const { logTransaction } = require('../src/utils/logTransaction');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

const txn = over => ({
    _id: 't', type: 'daily', amount: 100, balance: 500, note: null, relatedUserId: null,
    createdAt: new Date('2026-03-01T00:00:00Z'), ...over,
});

const run = async ({ page, components } = {}) => {
    const interaction = makeInteraction({
        subcommand: 'statement',
        options: page ? { page } : {},
        userId: USER_ID,
        guildId: GUILD_ID,
        components,
    });
    await bank.execute(interaction);
    return interaction;
};

const description = interaction => interaction.replies[0].embeds[0].data.description;

// The fake harness delivers a queued press on the tick after the collector is
// wired, and the collect handler is async — so a pagination test has to let
// both the timer and the handler's awaited reads settle.
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => jest.clearAllMocks());

describe('the subcommand is registered', () => {
    test('statement is a subcommand of /bank', () => {
        const names = bank.data.options.map(o => o.name);
        expect(names).toContain('statement');
    });
});

describe('/bank statement', () => {
    test('renders the caller\'s transactions, newest first, and never writes', async () => {
        fetchTransactions.mockResolvedValue({
            items: [
                txn({ type: 'gift_receive', amount: 500, balance: 1500, relatedUserId: 'friend-1', note: 'Coin gift' }),
                txn({ type: 'shop_buy', amount: -200, balance: 1000 }),
            ],
            total: 2, page: 1, pages: 1, pageSize: 10,
        });

        const interaction = await run();

        expect(fetchTransactions).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, guildId: GUILD_ID, page: 1 }));
        const desc = description(interaction);
        expect(desc).toContain('Gift Receive');
        expect(desc).toContain('+500');
        expect(desc).toContain('-200');
        expect(desc).toContain('with <@friend-1>');
        // The reply is the caller's alone.
        expect(interaction.replies[0].flags).toBeDefined();
        // Read-only.
        expect(logTransaction).not.toHaveBeenCalled();
    });

    test('a single page carries no pager buttons', async () => {
        fetchTransactions.mockResolvedValue({ items: [txn()], total: 1, page: 1, pages: 1, pageSize: 10 });

        const interaction = await run();

        expect(interaction.replies[0].components).toEqual([]);
    });

    test('an empty ledger says so rather than showing a blank embed', async () => {
        fetchTransactions.mockResolvedValue({ items: [], total: 0, page: 1, pages: 1, pageSize: 10 });

        const interaction = await run();

        expect(description(interaction)).toMatch(/No transactions/i);
        expect(interaction.replies[0].components).toEqual([]);
    });

    test('opens the page the caller asked for', async () => {
        fetchTransactions.mockResolvedValue({ items: [txn()], total: 50, page: 3, pages: 5, pageSize: 10 });

        await run({ page: 3 });

        expect(fetchTransactions).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));
    });

    test('a multi-page ledger shows pager buttons, and Older advances a page', async () => {
        fetchTransactions
            .mockResolvedValueOnce({ items: [txn()], total: 25, page: 1, pages: 3, pageSize: 10 })
            .mockResolvedValueOnce({ items: [txn({ type: 'work' })], total: 25, page: 2, pages: 3, pageSize: 10 });

        const interaction = await run({ components: [{ customId: 'stmt_next_interaction-1' }] });
        await flush();

        // Page 1 went out with a control row.
        expect(interaction.replies[0].components).toHaveLength(1);
        // The press asked for the next (older) page.
        expect(fetchTransactions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    });

    // When the window closes the buttons are disabled with a final edit; if the
    // ephemeral reply has already expired that edit rejects, and the command
    // must swallow it rather than crash on a collector that has already ended.
    test('swallows a failed final edit when the window closes', async () => {
        fetchTransactions.mockResolvedValue({ items: [txn()], total: 25, page: 1, pages: 3, pageSize: 10 });
        const interaction = makeInteraction({ subcommand: 'statement', options: {}, userId: USER_ID, guildId: GUILD_ID });
        interaction.editReply = jest.fn(() => Promise.reject(new Error('Unknown Message')));

        await expect(bank.execute(interaction)).resolves.toBeUndefined();
        await flush();

        expect(interaction.editReply).toHaveBeenCalled();
    });
});

describe('rendering helpers', () => {
    const { statementLine, buildStatementEmbed, statementButtons } = bank.__test__;

    test('a line leads with the signed amount and carries the running balance', () => {
        const line = statementLine(txn({ type: 'duel_win', amount: 750, balance: 1750, relatedUserId: 'foe-1' }), '💰');
        expect(line).toContain('`+750`');
        expect(line).toContain('Duel Win');
        expect(line).toContain('bal 💰1,750');
        expect(line).toContain('with <@foe-1>');
    });

    test('a line with neither note nor counterparty has no detail row', () => {
        const line = statementLine(txn({ note: null, relatedUserId: null }), '💰');
        expect(line).not.toContain('╰');
    });

    test('the empty embed explains itself instead of rendering nothing', () => {
        const embed = buildStatementEmbed({ items: [], page: 1, pages: 1, total: 0 }, { currency: '💰', user: { username: 'p', displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' } });
        expect(embed.data.description).toMatch(/No transactions/i);
    });

    test('pager buttons disable at the ends', () => {
        const first = statementButtons('id', { page: 1, pages: 3 });
        expect(first.components[0].data.disabled).toBe(true);   // Newer, at page 1
        expect(first.components[1].data.disabled).toBe(false);  // Older

        const last = statementButtons('id', { page: 3, pages: 3 });
        expect(last.components[1].data.disabled).toBe(true);    // Older, at last page

        const expired = statementButtons('id', { page: 2, pages: 3 }, true);
        expect(expired.components.every(c => c.data.disabled)).toBe(true);
    });
});
