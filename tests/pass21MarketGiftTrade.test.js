'use strict';

/**
 * #873, pass 21 — what pass 3 left of `/market` and `/gift`, and `/trade`, the
 * third place one player hands something to another, which no pass had read.
 *
 * Pass 3 audited the unwinds and the money paths are still sound. The findings
 * here are in what surrounds them:
 *
 *   - `/market browse` bucketed any item outside the default catalogue by the
 *     seller's asking price, so a Common relic listed dear was shown, and sorted,
 *     as Mythic. (The `/market` split on main fixed this independently; the
 *     board test below still pins it.)
 *   - A listing past its expiry stayed on the board and buyable until the sweep
 *     reached it.
 *   - `/gift` and `/bank transfer` would send to someone who is not in the
 *     server, into a document nobody will see.
 *   - `/trade` took a Confirm pressed on an offer that had since changed as a
 *     confirmation of the new one; its "two minutes idle" window was an absolute
 *     two minutes; and an expiry landing mid-settle announced "nothing was
 *     exchanged" over a swap that then completed.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, bank: 0, inventory: [], activeEffects: [], paidPayouts: [], spentDebits: [],
    dailyGiftSent: 0, dailyGiftReceived: 0, dailyGiftItemValueSent: 0, dailyGiftItemValueReceived: 0,
});
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });
const mockListings = fakeCollection('MarketListing', {}, { unique: [] });
const mockTransactions = fakeCollection('Transaction', {}, { unique: [] });
const mockAiItems = fakeCollection('AiItem', {}, { unique: ['itemId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/MarketListing', () => mockListings.model);
jest.mock('../src/models/Transaction', () => mockTransactions.model);
jest.mock('../src/models/AiItem', () => mockAiItems.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/models/FailedJob', () => ({ create: jest.fn(async () => ({})) }));

const market = require('../src/commands/economy/market');
const gift = require('../src/commands/economy/gift');
const bank = require('../src/commands/economy/bank');
const trade = require('../src/commands/economy/trade');
const { nonMemberRefusal } = require('../src/utils/coinTransfer');

const GUILD = 'guild-1';
const ME = 'user-1';
const OTHER = 'user-2';
const HOUR = 3_600_000;
const OLD = Date.now() - 365 * 24 * HOUR;

const seedGuild = (economy = {}, extra = {}) =>
    mockGuilds.seed({ guildId: GUILD, economy: { currency: '💰', ...economy }, ...extra });
const seedUser = (userId, fields = {}) => mockUsers.seed({ userId, guildId: GUILD, ...fields });

let listingSeq = 0;
function seedListing(fields = {}) {
    const listing = {
        _id: `listing-${++listingSeq}`, guildId: GUILD, sellerId: OTHER,
        itemId: 'lucky_charm', quantity: 1, pricePerUnit: 100,
        expiresAt: new Date(Date.now() + HOUR),
        ...fields,
    };
    mockListings.seed(listing);
    return listing;
}

const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

const shown = interaction => JSON.stringify(interaction.replies);

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const c of [mockUsers, mockGuilds, mockListings, mockTransactions, mockAiItems]) c.reset();
    mockTransactions.model.aggregate = jest.fn(async () => []);
});

afterEach(() => jest.restoreAllMocks());

// ── /market browse: rarity is the item's, not the asking price's ────────────

describe('/market browse', () => {
    const shopItems = [{ itemId: 'glow_stick', name: 'Glow Stick', price: 100, description: '✨ A stick.' }];

    test('renders the listing under its rarity and name, and leaves an expired listing off the board', async () => {
        seedGuild({}, { shop: shopItems });
        seedListing({ itemId: 'glow_stick', pricePerUnit: 9_500 });
        seedListing({ itemId: 'lucky_charm', expiresAt: new Date(Date.now() - 1000) });

        const interaction = makeInteraction({ subcommand: 'browse', userId: ME });
        await market.execute(interaction);
        await settle();

        const text = shown(interaction);
        expect(text).toContain('Glow Stick');
        expect(text).toContain('Common');
        expect(text).not.toContain('Epic');
        expect(text).not.toContain('Lucky Charm');
        expect(text).toContain('1 listings');
    });

    test('says when it is showing only the cheapest page of a larger market', async () => {
        seedGuild();
        for (let i = 0; i < 201; i++) seedListing({ pricePerUnit: 10 + i });

        const interaction = makeInteraction({ subcommand: 'browse', userId: ME });
        await market.execute(interaction);
        await settle();

        expect(shown(interaction)).toContain('cheapest 200 of 201 listings');
    });

    test('caps the item filter, so an over-long value cannot overflow the reply that echoes it', () => {
        const opts = market.data.toJSON().options;
        const item = sub => opts.find(o => o.name === sub).options.find(o => o.name === 'item');
        expect(item('browse').max_length).toBe(100);
        expect(item('list').max_length).toBe(100);
        expect(gift.data.toJSON().options.find(o => o.name === 'item').max_length).toBe(100);
    });
});

// ── /market buy: an expired listing is the sweep's ───────────────────────────

describe('/market buy', () => {
    test('an expired listing cannot be bought, and nothing is charged', async () => {
        seedGuild();
        seedUser(ME, { balance: 1_000 });
        const listing = seedListing({ expiresAt: new Date(Date.now() - 1000) });

        const interaction = makeInteraction({ subcommand: 'buy', options: { listing_id: listing._id }, userId: ME });
        await market.execute(interaction);
        await settle();

        expect(repliedText(interaction)).toContain('Listing not found or already expired/sold.');
        expect(mockUsers.get(ME).balance).toBe(1_000);
        expect(mockListings.writes.some(w => w.op === 'findOneAndDelete')).toBe(false);
    });

    test('the buy picker offers no expired listing, and the cancel picker still offers the seller theirs', async () => {
        seedGuild();
        seedListing({ _id: 'fresh', sellerId: OTHER });
        seedListing({ _id: 'stale', sellerId: OTHER, expiresAt: new Date(Date.now() - 1000) });
        seedListing({ _id: 'mine-stale', sellerId: ME, expiresAt: new Date(Date.now() - 1000) });

        const offered = async sub => {
            const interaction = makeInteraction({ subcommand: sub, options: { focused: '' }, userId: ME });
            interaction.options.getFocused = full => (full ? { name: 'listing_id', value: '' } : '');
            interaction.respond = jest.fn(async () => {});
            await market.autocomplete(interaction);
            return interaction.respond.mock.calls[0][0].map(c => c.value);
        };

        expect(await offered('buy')).toEqual(['fresh']);
        expect(await offered('cancel')).toEqual(['mine-stale']);
    });
});

// ── Transfers to somebody who is not here ────────────────────────────────────

describe('a recipient who is not a member of the server', () => {
    const stranger = { id: OTHER, username: 'gone', bot: false, createdTimestamp: OLD, displayAvatarURL: () => '' };

    test('nonMemberRefusal names them, and passes a member', () => {
        expect(nonMemberRefusal(null, stranger, { noun: 'gifts' })).toContain("**gone** isn't a member of this server");
        expect(nonMemberRefusal({ id: OTHER }, stranger)).toBeNull();
    });

    test('/gift refuses before anything moves', async () => {
        seedGuild();
        seedUser(ME, { balance: 1_000, inventory: [{ itemId: 'lucky_charm', quantity: 1 }] });

        for (const options of [{ user: stranger, type: 'coins', amount: 100 }, { user: stranger, type: 'item', item: 'lucky_charm' }]) {
            const interaction = makeInteraction({ options, userId: ME });
            interaction.options.getMember = () => null;
            await gift.execute(interaction);
            expect(repliedText(interaction)).toContain("isn't a member of this server");
        }
        expect(mockUsers.get(ME)).toMatchObject({ balance: 1_000, inventory: [{ itemId: 'lucky_charm', quantity: 1 }] });
        expect(mockUsers.get(OTHER)).toBeFalsy();
    });

    test('/bank transfer refuses before anything moves', async () => {
        seedGuild();
        seedUser(ME, { balance: 1_000 });

        const interaction = makeInteraction({ subcommand: 'transfer', options: { user: stranger, amount: 100 }, userId: ME });
        interaction.options.getMember = () => null;
        await bank.execute(interaction);

        expect(repliedText(interaction)).toContain("isn't a member of this server");
        expect(mockUsers.get(ME).balance).toBe(1_000);
        expect(mockUsers.get(OTHER)).toBeFalsy();
    });
});

// ── /trade ───────────────────────────────────────────────────────────────────

describe('/trade', () => {
    const B = { id: OTHER, username: 'Bo', bot: false, createdTimestamp: OLD };

    /** The custom ids on the most recently drawn controls. */
    function controls(interaction) {
        const drawn = interaction.replies.filter(r => r?.components?.length).at(-1);
        const ids = drawn.components.flatMap(row => row.toJSON().components.map(c => c.custom_id));
        const find = prefix => ids.find(id => id.startsWith(`trade_${prefix}`));
        return { coins: find('coins_'), item: find('item_'), confirm: find('confirm-') };
    }

    async function openTrade(economy = {}) {
        seedGuild(economy);
        const interaction = makeInteraction({ options: { user: B }, userId: ME, holdCollectors: true });
        await trade.execute(interaction);
        return interaction;
    }

    test('a Confirm pressed on an offer that has since changed is refused, not counted', async () => {
        seedUser(ME, { balance: 1_000 });
        seedUser(OTHER, { balance: 0 });
        const interaction = await openTrade();

        const stale = controls(interaction).confirm;
        await interaction.press({ customId: controls(interaction).coins, user: ME, modal: { amount: '500' } });

        // Bo's client was still showing the empty offer when he pressed.
        const bo = await interaction.press({ customId: stale, user: OTHER });
        expect(JSON.stringify(bo.followUp.mock.calls)).toContain('The offer changed before your confirmation arrived');

        // Ana confirms; with Bo's stale press refused, nothing settles.
        await interaction.press({ customId: controls(interaction).confirm, user: ME });
        expect(mockUsers.get(ME).balance).toBe(1_000);

        // Bo confirms what he can now see, and it goes through.
        await interaction.press({ customId: controls(interaction).confirm, user: OTHER });
        expect(mockUsers.get(ME).balance).toBe(500);
        expect(mockUsers.get(OTHER).balance).toBe(500);
        interaction.endCollectors('done');
    });

    test('an expiry landing while the swap settles does not announce that nothing was exchanged', async () => {
        seedUser(ME, { balance: 1_000 });
        seedUser(OTHER, { balance: 0 });
        const interaction = await openTrade();
        await interaction.press({ customId: controls(interaction).coins, user: ME, modal: { amount: '300' } });
        await interaction.press({ customId: controls(interaction).confirm, user: ME });

        const confirming = interaction.press({ customId: controls(interaction).confirm, user: OTHER });
        interaction.endCollectors('idle');
        await confirming;
        await settle();

        expect(mockUsers.get(OTHER).balance).toBe(300);
        expect(shown(interaction)).not.toContain('Trade expired');
        expect(shown(interaction)).toContain('Trade complete.');
    });

    test('a forged item is priced from its own row, not as a Legendary', async () => {
        mockAiItems.seed({ itemId: 'ai_pebble', name: 'Pebble of Note', emoji: '🪨', rarity: 'Common' });
        seedUser(ME, { inventory: [{ itemId: 'ai_pebble', quantity: 1 }] });
        seedUser(OTHER, {});
        // Room for a Common forge (500), not for the 25,000 a Legendary costs.
        const interaction = await openTrade({ giftItemValueCapDaily: 1_000 });

        await interaction.press({ customId: controls(interaction).item, user: ME, modal: { item: 'ai_pebble', qty: '1' } });
        expect(shown(interaction)).toContain('Pebble of Note');
        await interaction.press({ customId: controls(interaction).confirm, user: ME });
        await interaction.press({ customId: controls(interaction).confirm, user: OTHER });

        expect(mockUsers.get(OTHER).inventory).toEqual([expect.objectContaining({ itemId: 'ai_pebble', quantity: 1 })]);
        interaction.endCollectors('done');
    });

    test('the window is idle time, as the embed says', () => {
        const src = require('fs').readFileSync(require.resolve('../src/commands/economy/trade'), 'utf8');
        expect(src).toMatch(/idle: WINDOW_MS/);
        expect(src).not.toMatch(/time: WINDOW_MS/);
    });
});
