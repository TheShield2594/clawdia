'use strict';

// End-to-end wiring for the general /shop browse-view click-to-buy (#1049
// Phase 1): `/shop view` must attach an onBuy to each page, and invoking it
// must run the same purchase as `/shop buy` but privately (ephemeral). The
// heavy purchase mechanics are covered by shopBuyQuantity.test.js; this proves
// the browse handoff and the ephemeral flag.

const { MessageFlags } = require('discord.js');

let mockWorld;

function mockQuery(value) {
    return {
        lean: async () => value,
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    };
}

jest.mock('../src/models/Guild', () => ({
    findOneAndUpdate: jest.fn(async (query, update) => {
        const elem = query.shop?.$elemMatch;
        if (elem) {
            const item = mockWorld.guild.shop.find(i => i._id === elem._id);
            const need = elem.stock?.$gte ?? 1;
            if (!item || item.stock < need) return null;
            item.stock += update.$inc['shop.$.stock'];
            return mockWorld.guild;
        }
        return mockWorld.guild;
    }),
    findOne: jest.fn(() => mockQuery(mockWorld.guild)),
    updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

jest.mock('../src/models/User', () => ({
    findOneAndUpdate: jest.fn(async (query, update) => {
        if (Array.isArray(update)) {
            require('./helpers/pipelineUpdate').applyPipelineUpdate(mockWorld.user, update);
            return mockWorld.user;
        }
        if (update.$inc?.balance != null) {
            const floor = query.balance?.$gte;
            if (floor != null && mockWorld.user.balance < floor) return null;
            mockWorld.user.balance += update.$inc.balance;
            mockWorld.balanceWrites.push(update.$inc.balance);
            return mockWorld.user;
        }
        return mockWorld.user;
    }),
    findOne: jest.fn(() => mockQuery(mockWorld.user)),
    updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/models/Transaction', () => ({
    create: jest.fn(async (doc) => { mockWorld.transactions.push(doc); return doc; }),
    aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/utils/itemImageHelper', () => ({
    getItemImageAttachment: jest.fn().mockResolvedValue(null),
}));

// Capture the config /shop view hands the browse renderer so the test can reach
// the onBuy it wired onto the pages, without rendering a banner.
const mockRunShopBrowse = jest.fn().mockResolvedValue();
jest.mock('../src/utils/shopBrowse', () => ({ runShopBrowse: mockRunShopBrowse, getTheme: jest.fn() }));

const shopCommand = require('../src/commands/economy/shop.js');

function buildWorld() {
    return {
        guild: {
            guildId: 'g1',
            name: 'Test Guild',
            shopDefaultsSeeded: true,
            economy: { currency: '💰' },
            dynamicPricing: { enabled: false },
            shop: [
                { _id: 'oid_kit', name: 'Repair Kit', itemId: 'repair_kit', description: '🔧 Fixes locks.', price: 100, stock: -1, roleId: null, demandScore: 0 },
            ],
            save: jest.fn().mockResolvedValue(true),
        },
        user: { userId: 'u1', guildId: 'g1', balance: 5_000, inventory: [], accountPrestige: { rank: 0 } },
        balanceWrites: [],
        transactions: [],
    };
}

function buildViewInteraction() {
    const interaction = {
        guild:   { id: 'g1', name: 'Test Guild' },
        guildId: 'g1',
        user:    { id: 'u1', username: 'tester' },
        member:  { roles: { add: jest.fn().mockResolvedValue(true) } },
        options: { getSubcommand: () => 'view' },
        reply:      jest.fn().mockResolvedValue(),
        deferReply: jest.fn().mockResolvedValue(),
        editReply:  jest.fn().mockResolvedValue(),
    };
    return interaction;
}

// Stands in for the select-menu interaction the browse view hands to onBuy.
function buildBuyInteraction() {
    const state = { replies: [], editReplies: [], deferOpts: undefined };
    const interaction = {
        guild:   { id: 'g1', name: 'Test Guild' },
        guildId: 'g1',
        user:    { id: 'u1', username: 'tester' },
        member:  { roles: { add: jest.fn().mockResolvedValue(true) } },
        reply:      jest.fn(async (p) => { state.replies.push(p); return {}; }),
        deferReply: jest.fn(async (opts) => { state.deferOpts = opts; }),
        editReply:  jest.fn(async (p) => { state.editReplies.push(p); return {}; }),
    };
    return { interaction, state };
}

beforeEach(() => {
    mockWorld = buildWorld();
    jest.clearAllMocks();
});

test('/shop view attaches an onBuy to every page', async () => {
    await shopCommand.execute(buildViewInteraction());

    expect(mockRunShopBrowse).toHaveBeenCalledTimes(1);
    const config = mockRunShopBrowse.mock.calls[0][1];
    expect(config.pages.length).toBeGreaterThan(0);
    for (const page of config.pages) {
        expect(typeof page.onBuy).toBe('function');
        // Buyable items carry the display name as their buy id.
        for (const item of page.items) expect(item.buyId).toBe(item.name);
    }
});

test('invoking a page onBuy buys the item privately (ephemeral) and charges once', async () => {
    await shopCommand.execute(buildViewInteraction());
    const { pages } = mockRunShopBrowse.mock.calls[0][1];
    const onBuy = pages[0].onBuy;

    const { interaction, state } = buildBuyInteraction();
    await onBuy(interaction, 'Repair Kit');

    // Below the confirm threshold → straight to a deferred purchase, made
    // ephemeral so a public storefront isn't spammed with receipts.
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(state.deferOpts).toEqual({ flags: MessageFlags.Ephemeral });

    expect(mockWorld.balanceWrites).toEqual([-100]);
    expect(mockWorld.user.inventory).toEqual([{ itemId: 'repair_kit', quantity: 1 }]);

    const success = state.editReplies.at(-1);
    expect(success.embeds[0].data.title).toBe('Purchase Successful');
});
