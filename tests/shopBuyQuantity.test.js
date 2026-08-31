'use strict';

const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

// Exercises /shop buy's quantity option end to end: the confirm flow, the
// atomic charge/stock/inventory writes, and the guards that reject a bulk buy
// before any coins move.

const PET_FOOD_PRICE = 250;

// Mutable per-test mockWorld, reset in beforeEach.
let mockWorld;

function mockQuery(value) {
    // Stands in for a mongoose Query: awaitable directly and via .lean().
    return {
        lean: async () => value,
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    };
}

jest.mock('../src/models/Guild', () => ({
    findOneAndUpdate: jest.fn(async (query, update) => {
        // Stock decrement path: { shop: { $elemMatch: { _id, stock: { $gte: n } } } }
        const elem = query.shop?.$elemMatch;
        if (elem) {
            const item = mockWorld.guild.shop.find(i => i._id === elem._id);
            const need = elem.stock?.$gte ?? 1;
            if (!item || item.stock < need) return null;
            item.stock += update.$inc['shop.$.stock'];
            mockWorld.stockWrites.push({ itemId: item.itemId, delta: update.$inc['shop.$.stock'] });
            return mockWorld.guild;
        }
        return mockWorld.guild;
    }),
    findOne: jest.fn(() => mockQuery(mockWorld.guild)),
    updateOne: jest.fn(async (query, update) => {
        if (update.$inc?.['shop.$.demandScore'] != null) {
            const item = mockWorld.guild.shop.find(i => i._id === query['shop._id']);
            if (item) item.demandScore = (item.demandScore ?? 0) + update.$inc['shop.$.demandScore'];
        }
        if (update.$inc?.['shop.$.stock'] != null) {
            const item = mockWorld.guild.shop.find(i => i._id === query['shop._id']);
            if (item) item.stock += update.$inc['shop.$.stock'];
        }
        return {};
    }),
}));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

jest.mock('../src/models/User', () => ({
    findOneAndUpdate: jest.fn(async (query, update) => {
        // Inventory grant is an aggregation-pipeline update. Run it rather than
        // reading values out of its shape: reaching into the expression coupled
        // this mock to one spelling of the pipeline, and it broke the moment the
        // credit was rewritten to stop paying into every duplicate slot.
        if (Array.isArray(update)) {
            // Required inside the factory: jest forbids a mock factory from
            // closing over an out-of-scope binding.
            require('./helpers/pipelineUpdate').applyPipelineUpdate(mockWorld.user, update);
            return mockWorld.user;
        }
        // Balance charge / refund.
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
    updateOne: jest.fn(async (query, update) => {
        if (update.$inc?.balance != null) {
            mockWorld.user.balance += update.$inc.balance;
            mockWorld.balanceWrites.push(update.$inc.balance);
        }
        return {};
    }),
}));

jest.mock('../src/models/Transaction', () => ({
    create: jest.fn(async (doc) => { mockWorld.transactions.push(doc); return doc; }),
    aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/utils/itemImageHelper', () => ({
    getItemImageAttachment: jest.fn().mockResolvedValue(null),
}));

const shopCommand = require('../src/commands/economy/shop.js');

function buildWorld({ petFoodStock = -1, balance = 100_000, dynamicPricing = false } = {}) {
    return {
        guild: {
            guildId: 'g1',
            name: 'Test Guild',
            shopDefaultsSeeded: true,
            economy: { currency: '💰' },
            dynamicPricing: { enabled: dynamicPricing },
            shop: [
                { _id: 'oid_petfood', name: 'Pet Food', itemId: 'pet_food', description: '🍖 Feeds any pet.', price: PET_FOOD_PRICE, stock: petFoodStock, roleId: null, demandScore: 0 },
                { _id: 'oid_vip',     name: 'VIP Pass', itemId: 'vip_pass',  description: '💎 A role.',       price: 1000,           stock: -1,           roleId: 'role_vip', demandScore: 0 },
                // Listed before the item whose itemId is 'padlock' so a
                // partial-name match would grab the wrong one.
                { _id: 'oid_kit',     name: 'Padlock Repair Kit',  itemId: 'repair_kit', description: '🔧 Fixes locks.', price: 100, stock: -1, roleId: null, demandScore: 0 },
                { _id: 'oid_padlock', name: 'Reinforced Padlock',  itemId: 'padlock',    description: '🔒 Locks up.',    price: 100, stock: -1, roleId: null, demandScore: 0 },
            ],
            save: jest.fn().mockResolvedValue(true),
        },
        user: { userId: 'u1', guildId: 'g1', balance, inventory: [], accountPrestige: { rank: 0 } },
        stockWrites: [],
        balanceWrites: [],
        transactions: [],
    };
}

function buildInteraction({ item, quantity }) {
    const state = { replies: [], editReplies: [], collectHandler: null };
    const message = {
        createMessageComponentCollector: () => ({
            on: (event, cb) => { if (event === 'collect') state.collectHandler = cb; },
            stop: () => {},
        }),
    };
    const interaction = {
        guild:   { id: 'g1', name: 'Test Guild' },
        guildId: 'g1',
        user:    { id: 'u1', username: 'tester' },
        member:  { roles: { add: jest.fn().mockResolvedValue(true) } },
        options: {
            getSubcommand: () => 'buy',
            getString:  (name) => (name === 'item' ? item : null),
            getInteger: (name) => (name === 'quantity' ? quantity ?? null : null),
        },
        reply:      jest.fn(async (payload) => { state.replies.push(payload); return message; }),
        deferReply: jest.fn().mockResolvedValue(),
        editReply:  jest.fn(async (payload) => { state.editReplies.push(payload); return message; }),
    };
    return { interaction, state };
}

async function confirm(state) {
    expect(state.collectHandler).toBeTruthy();
    await state.collectHandler({
        user: { id: 'u1' },
        customId: 'shop_confirm',
        deferUpdate: jest.fn().mockResolvedValue(),
        update: jest.fn().mockResolvedValue(),
    });
}

beforeEach(() => {
    mockWorld = buildWorld();
    jest.clearAllMocks();
});

test('buying 10 Pet Food charges the total once and grants all 10', async () => {
    const { interaction, state } = buildInteraction({ item: 'Pet Food', quantity: 10 });
    await shopCommand.execute(interaction);

    // 10 × 250 = 2500, over CONFIRM_THRESHOLD, so it asks first.
    const confirmEmbed = state.replies[0].embeds[0].data;
    expect(confirmEmbed.description).toContain('10× **Pet Food**');
    expect(confirmEmbed.description).toContain('2,500');
    expect(confirmEmbed.fields.find(f => f.name === 'Total Cost').value).toBe('💰2,500');
    expect(confirmEmbed.fields.find(f => f.name === 'Unit Price').value).toBe('💰250');

    await confirm(state);

    expect(mockWorld.balanceWrites).toEqual([-2500]);
    expect(mockWorld.user.balance).toBe(97_500);
    expect(mockWorld.user.inventory).toEqual([{ itemId: 'pet_food', quantity: 10 }]);
    expect(mockWorld.transactions).toHaveLength(1);
    expect(mockWorld.transactions[0]).toMatchObject({ type: 'shop_buy', amount: -2500, note: 'pet_food' });

    const success = state.editReplies.at(-1).embeds[0].data;
    expect(success.title).toBe('Purchase Successful');
    expect(success.description).toContain('10× **Pet Food**');
    expect(success.fields.find(f => f.name === 'In Inventory').value).toBe('10× Pet Food');
});

test('a bulk buy decrements limited stock by the full quantity', async () => {
    mockWorld = buildWorld({ petFoodStock: 12 });
    const { interaction, state } = buildInteraction({ item: 'Pet Food', quantity: 10 });
    await shopCommand.execute(interaction);
    await confirm(state);

    expect(mockWorld.stockWrites).toEqual([{ itemId: 'pet_food', delta: -10 }]);
    expect(mockWorld.guild.shop.find(i => i.itemId === 'pet_food').stock).toBe(2);
});

test('asking for more than the remaining stock is rejected before any charge', async () => {
    mockWorld = buildWorld({ petFoodStock: 3 });
    const { interaction, state } = buildInteraction({ item: 'Pet Food', quantity: 10 });
    await shopCommand.execute(interaction);

    expect(state.replies[0].content).toContain('Only **3× Pet Food** left in stock');
    expect(mockWorld.balanceWrites).toEqual([]);
    expect(mockWorld.user.inventory).toEqual([]);
});

test('an unaffordable bulk buy reports the total and how many are affordable', async () => {
    mockWorld = buildWorld({ balance: 900 });
    const { interaction, state } = buildInteraction({ item: 'Pet Food', quantity: 10 });
    await shopCommand.execute(interaction);

    expect(state.replies[0].content).toContain('💰2,500 for 10× **Pet Food**');
    expect(state.replies[0].content).toContain('You can afford **3**');
    expect(mockWorld.balanceWrites).toEqual([]);
});

test('role rewards cannot be bought in bulk', async () => {
    const { interaction, state } = buildInteraction({ item: 'VIP Pass', quantity: 3 });
    await shopCommand.execute(interaction);

    expect(state.replies[0].content).toContain('grants a role');
    expect(mockWorld.balanceWrites).toEqual([]);
});

test('omitting quantity still buys exactly one', async () => {
    const { interaction, state } = buildInteraction({ item: 'Pet Food' });
    await shopCommand.execute(interaction);

    // 250 is under CONFIRM_THRESHOLD, so it buys straight away.
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(mockWorld.balanceWrites).toEqual([-250]);
    expect(mockWorld.user.inventory).toEqual([{ itemId: 'pet_food', quantity: 1 }]);

    const success = state.editReplies.at(-1).embeds[0].data;
    expect(success.description).toContain('**Pet Food**');
    expect(success.description).not.toContain('1× **Pet Food**');
    expect(success.fields.find(f => f.name === 'Unit Price')).toBeUndefined();
});

test('an exact itemId wins over another item whose name contains it', async () => {
    const { interaction } = buildInteraction({ item: 'padlock' });
    await shopCommand.execute(interaction);

    // 'Padlock Repair Kit' contains "padlock" and comes first in the shop array,
    // but the exact itemId match must win.
    expect(mockWorld.user.inventory).toEqual([{ itemId: 'padlock', quantity: 1 }]);
});

test('a partial name still resolves when nothing matches exactly', async () => {
    const { interaction } = buildInteraction({ item: 'repair kit' });
    await shopCommand.execute(interaction);

    expect(mockWorld.user.inventory).toEqual([{ itemId: 'repair_kit', quantity: 1 }]);
});

test('a price rise between quote and confirm cancels the purchase', async () => {
    mockWorld = buildWorld({ dynamicPricing: true });
    const { interaction, state } = buildInteraction({ item: 'Pet Food', quantity: 10 });
    await shopCommand.execute(interaction);

    expect(state.replies[0].embeds[0].data.description).toContain('2,500');

    // Dynamic pricing recalculates while the confirmation is still open.
    mockWorld.guild.shop.find(i => i.itemId === 'pet_food').currentPrice = 400;
    await confirm(state);

    expect(state.editReplies.at(-1).content).toContain('price of **Pet Food** changed');
    expect(mockWorld.balanceWrites).toEqual([]);
    expect(mockWorld.user.inventory).toEqual([]);
    expect(mockWorld.transactions).toEqual([]);
});

test('a price drop between quote and confirm is honoured at the lower total', async () => {
    mockWorld = buildWorld({ dynamicPricing: true });
    const { interaction, state } = buildInteraction({ item: 'Pet Food', quantity: 10 });
    await shopCommand.execute(interaction);

    mockWorld.guild.shop.find(i => i.itemId === 'pet_food').currentPrice = 200;
    await confirm(state);

    expect(mockWorld.balanceWrites).toEqual([-2000]);
    expect(mockWorld.user.inventory).toEqual([{ itemId: 'pet_food', quantity: 10 }]);
});

// Every purchase path — including the sold-out refunds — leaves the buyer solvent.
afterEach(() => {
    expectNonNegativeBalance(mockWorld.user, 'shop buy');
});
