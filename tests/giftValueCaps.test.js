'use strict';

// /gift end to end against the limits: the item-value budget that did not exist
// before, the coin caps now that they come from guild settings rather than from
// constants, and the confirmation an irreversible transfer asks for.
//
// The store here understands the `$expr` guards these paths carry, so a cap is
// tested as the atomic filter that enforces it and not only as the message shown
// before the write.

const { applyPipelineUpdate, evaluate } = require('./helpers/pipelineUpdate');

let mockStore;
let mockEconomy;

function mockFindDoc(query) {
    const doc = mockStore[query.userId];
    if (!doc || doc.guildId !== query.guildId) return null;
    return doc;
}

function mockMatches(doc, query) {
    if (!doc) return false;
    const elem = query.inventory?.$elemMatch;
    if (elem) {
        const idx = doc.inventory.findIndex(s => s.itemId === elem.itemId && s.quantity >= elem.quantity.$gte);
        if (idx === -1) return false;
        doc._matchedIndex = idx;
    }
    if (query.balance?.$gte !== undefined && (doc.balance ?? 0) < query.balance.$gte) return false;
    // The cap guards. Evaluated for real — a mock that waved these through would
    // report every cap as working.
    if (query.$expr && !evaluate(query.$expr, doc)) return false;
    return true;
}

function mockApplyUpdate(doc, update) {
    if (Array.isArray(update)) return applyPipelineUpdate(doc, update);
    if (update.$inc) {
        for (const [path, delta] of Object.entries(update.$inc)) {
            if (path === 'inventory.$.quantity') doc.inventory[doc._matchedIndex].quantity += delta;
            else doc[path] = (doc[path] ?? 0) + delta;
        }
    }
    if (update.$set) for (const [path, value] of Object.entries(update.$set)) doc[path] = value;
    if (update.$pull?.inventory) {
        const { itemId, quantity } = update.$pull.inventory;
        doc.inventory = doc.inventory.filter(s => !(s.itemId === itemId && s.quantity <= quantity.$lte));
    }
    return doc;
}

jest.mock('../src/models/User', () => ({
    findOne: jest.fn((query) => {
        const doc = mockFindDoc(query);
        return { lean: async () => doc, then: (res, rej) => Promise.resolve(doc).then(res, rej) };
    }),
    findOneAndUpdate: jest.fn(async (query, update, options = {}) => {
        let doc = mockFindDoc(query);
        if (!doc && options.upsert) {
            doc = { userId: query.userId, guildId: query.guildId, balance: 0, inventory: [], activeEffects: [] };
            mockStore[query.userId] = doc;
        }
        if (!mockMatches(doc, query)) return null;
        mockApplyUpdate(doc, update);
        return doc;
    }),
    updateOne: jest.fn(async (query, update, options = {}) => {
        let doc = mockFindDoc(query);
        if (!doc && options.upsert) {
            doc = { userId: query.userId, guildId: query.guildId, balance: 0, inventory: [], activeEffects: [] };
            mockStore[query.userId] = doc;
        }
        if (doc && mockMatches(doc, query)) mockApplyUpdate(doc, update);
        return {};
    }),
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(async () => ({ guildId: 'g1', economy: { currency: '💰', enabled: true, ...mockEconomy } })),
}));
jest.mock('../src/models/ItemImage', () => ({ findOne: jest.fn(async () => null) }));
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const giftCommand = require('../src/commands/economy/gift.js');

const OLD_ACCOUNT = Date.now() - 365 * 24 * 60 * 60 * 1000;

function buildExecute({ type = 'item', item = null, quantity = null, amount = null, confirm = 'confirm' } = {}) {
    const state = { replies: [], followUps: [], prompted: false };
    return {
        state,
        interaction: {
            guild: { id: 'g1' },
            guildId: 'g1',
            user: { id: 'sender', username: 'sender', createdTimestamp: OLD_ACCOUNT, displayAvatarURL: () => 'https://cdn.example/sender.png' },
            options: {
                getUser: () => ({ id: 'recipient', username: 'recipient', bot: false, createdTimestamp: OLD_ACCOUNT, displayAvatarURL: () => 'https://cdn.example/recipient.png' }),
                getString: (name) => (name === 'type' ? type : name === 'item' ? item : null),
                getInteger: (name) => (name === 'quantity' ? quantity : name === 'amount' ? amount : null),
            },
            deferReply: jest.fn(async () => {}),
            editReply: jest.fn(async (p) => {
                state.replies.push(p);
                return {
                    awaitMessageComponent: async () => {
                        state.prompted = true;
                        if (confirm === 'timeout') throw new Error('collector ended');
                        return {
                            customId: confirm === 'cancel' ? 'gift_cancel' : 'gift_confirm',
                            update: async (payload) => { state.replies.push(payload); },
                        };
                    },
                };
            }),
            reply: jest.fn(async (p) => { state.replies.push(p); }),
            followUp: jest.fn(async (p) => { state.followUps.push(p); }),
        },
    };
}

const lastContent = state => state.replies.map(r => r.content).filter(Boolean).at(-1) ?? '';

beforeEach(() => {
    mockEconomy = {};
    mockStore = {
        sender: {
            userId: 'sender', guildId: 'g1', balance: 100_000, activeEffects: [],
            inventory: [
                { itemId: 'pet_food',           quantity: 40 },     //     250 each
                { itemId: 'prestige_accelerator', quantity: 2 },    // 200,000 each
                { itemId: 'grand_master_badge', quantity: 1 },      // 25,000,000
            ],
        },
        recipient: { userId: 'recipient', guildId: 'g1', balance: 0, inventory: [], activeEffects: [] },
    };
    jest.clearAllMocks();
});

describe('the daily item-value budget', () => {
    test('an item worth more than the whole daily cap can never be gifted', async () => {
        // "Buy the item, gift the item, sell it on the market" was the coin cap
        // with one extra step, and a 25,000,000-coin badge moved freely.
        const { interaction, state } = buildExecute({ item: 'grand_master_badge', quantity: 1 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.inventory).toEqual([]);
        expect(mockStore.sender.inventory.find(i => i.itemId === 'grand_master_badge').quantity).toBe(1);
        expect(lastContent(state)).toContain('can never be gifted');
    });

    test('gifts accumulate against the budget until it refuses the next one', async () => {
        const first = buildExecute({ item: 'prestige_accelerator', quantity: 1 });
        await giftCommand.execute(first.interaction);
        expect(mockStore.sender.dailyGiftItemValueSent).toBe(200_000);
        expect(mockStore.recipient.inventory).toEqual([{ itemId: 'prestige_accelerator', quantity: 1 }]);

        // 200,000 spent of 250,000 — the second one does not fit.
        const second = buildExecute({ item: 'prestige_accelerator', quantity: 1 });
        await giftCommand.execute(second.interaction);
        expect(mockStore.sender.dailyGiftItemValueSent).toBe(200_000);
        expect(mockStore.recipient.inventory).toEqual([{ itemId: 'prestige_accelerator', quantity: 1 }]);
        expect(lastContent(second.state)).toContain('worth today');
    });

    test('the recipient has a budget of their own', async () => {
        mockStore.recipient.dailyGiftItemValueReceived = 499_000;
        mockStore.recipient.dailyGiftItemValueReceivedReset = new Date();

        const { interaction, state } = buildExecute({ item: 'prestige_accelerator', quantity: 1 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.inventory).toEqual([]);
        expect(lastContent(state)).toContain('can only receive');
    });

    test('an admin can switch the cap off entirely', async () => {
        mockEconomy = { giftItemValueCapDaily: 0, giftItemValueReceiveCapDaily: 0, giftConfirmThreshold: 0 };
        const { interaction } = buildExecute({ item: 'grand_master_badge', quantity: 1 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.inventory).toEqual([{ itemId: 'grand_master_badge', quantity: 1 }]);
    });

    test('a cheap stack still moves without touching the ceiling', async () => {
        mockEconomy = { giftConfirmThreshold: 0 };
        const { interaction } = buildExecute({ item: 'pet_food', quantity: 4 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.inventory).toEqual([{ itemId: 'pet_food', quantity: 4 }]);
        expect(mockStore.sender.dailyGiftItemValueSent).toBe(1_000);
    });
});

describe('configurable coin caps', () => {
    test('a guild that raises the cap allows the bigger gift', async () => {
        // 20,000 is over the default send cap of 10,000 and under the default
        // receive cap of 25,000, so only the raised limit is under test here.
        mockEconomy = { giftCoinCapDaily: 50_000, giftConfirmThreshold: 0 };
        const { interaction } = buildExecute({ type: 'coins', amount: 20_000 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.balance).toBe(20_000);
        expect(mockStore.sender.balance).toBe(80_000);
        expect(mockStore.sender.dailyGiftSent).toBe(20_000);
    });

    test('the default cap still refuses what it always refused', async () => {
        const { interaction, state } = buildExecute({ type: 'coins', amount: 30_000 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.balance).toBe(0);
        expect(lastContent(state)).toContain('Daily gift cap reached');
    });

    test('a cap of 0 removes the limit', async () => {
        mockEconomy = { giftCoinCapDaily: 0, giftCoinReceiveCapDaily: 0, giftConfirmThreshold: 0 };
        const { interaction } = buildExecute({ type: 'coins', amount: 90_000 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.balance).toBe(90_000);
        // Nothing is counted against a budget that is switched off.
        expect(mockStore.sender.dailyGiftSent).toBeUndefined();
    });
});

describe('the confirmation prompt', () => {
    test('a gift at the threshold asks before it moves anything', async () => {
        const { interaction, state } = buildExecute({ type: 'coins', amount: 5_000 });
        await giftCommand.execute(interaction);

        expect(state.prompted).toBe(true);
        expect(mockStore.recipient.balance).toBe(5_000);
    });

    test('cancelling moves nothing', async () => {
        const { interaction, state } = buildExecute({ type: 'coins', amount: 8_000, confirm: 'cancel' });
        await giftCommand.execute(interaction);

        expect(state.prompted).toBe(true);
        expect(mockStore.sender.balance).toBe(100_000);
        expect(mockStore.recipient.balance).toBe(0);
        expect(state.followUps).toEqual([]);
    });

    test('a prompt left to expire moves nothing', async () => {
        const { interaction, state } = buildExecute({ type: 'coins', amount: 8_000, confirm: 'timeout' });
        await giftCommand.execute(interaction);

        expect(mockStore.sender.balance).toBe(100_000);
        expect(lastContent(state)).toContain('timed out');
    });

    test('a small gift is not interrupted', async () => {
        const { interaction, state } = buildExecute({ type: 'coins', amount: 100 });
        await giftCommand.execute(interaction);

        expect(state.prompted).toBe(false);
        expect(mockStore.recipient.balance).toBe(100);
    });

    test('the threshold reads an item gift by its worth, not its count', async () => {
        // Ten pet foods are 2,500 coins and pass; one accelerator is 200,000
        // and does not.
        const cheap = buildExecute({ item: 'pet_food', quantity: 10 });
        await giftCommand.execute(cheap.interaction);
        expect(cheap.state.prompted).toBe(false);

        const dear = buildExecute({ item: 'prestige_accelerator', quantity: 1 });
        await giftCommand.execute(dear.interaction);
        expect(dear.state.prompted).toBe(true);
    });

    test('an admin can switch the prompt off', async () => {
        mockEconomy = { giftConfirmThreshold: 0 };
        const { interaction, state } = buildExecute({ type: 'coins', amount: 9_000 });
        await giftCommand.execute(interaction);

        expect(state.prompted).toBe(false);
        expect(mockStore.recipient.balance).toBe(9_000);
    });
});

describe('the deferred reply', () => {
    test('the interaction is acknowledged before any database work', async () => {
        // Up to four reads and three writes used to run inside Discord's
        // three-second window, and a slow database turned that into "the
        // application did not respond" with the gift already half applied.
        const { interaction } = buildExecute({ type: 'coins', amount: 100 });
        await giftCommand.execute(interaction);

        expect(interaction.deferReply).toHaveBeenCalled();
        expect(interaction.deferReply.mock.invocationCallOrder[0])
            .toBeLessThan(interaction.editReply.mock.invocationCallOrder[0]);
        expect(interaction.reply).not.toHaveBeenCalled();
    });

    test('the sender gets a private receipt and the channel gets the announcement', async () => {
        const { interaction, state } = buildExecute({ type: 'coins', amount: 100 });
        await giftCommand.execute(interaction);

        expect(lastContent(state)).toContain('Sent');
        expect(state.followUps).toHaveLength(1);
        expect(state.followUps[0].content).toBe('<@recipient>');
        expect(state.followUps[0].embeds).toHaveLength(1);
    });
});
