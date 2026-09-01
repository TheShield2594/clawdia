'use strict';

// The parts of /gift a player actually touches: the item picker, the way a
// typed id is resolved against the bag, and the refusals that have to survive
// that resolution. The transfer mechanics themselves are covered by
// tests/giftItemTransfer.test.js.

let mockStore;

function mockFindDoc(query) {
    const doc = mockStore[query.userId];
    if (!doc || doc.guildId !== query.guildId) return null;
    return doc;
}

jest.mock('../src/models/User', () => ({
    findOne: jest.fn((query) => {
        const doc = mockFindDoc(query);
        return { lean: async () => doc, then: (res, rej) => Promise.resolve(doc).then(res, rej) };
    }),
    findOneAndUpdate: jest.fn(async (query) => mockFindDoc(query)),
    updateOne: jest.fn(async () => ({})),
}));

jest.mock('../src/models/AiItem', () => ({
    find: jest.fn(() => ({ lean: async () => [{ itemId: 'ai_beta', name: 'Sunspike', emoji: '🌞', rarity: 'Mythic' }] })),
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(async () => ({
        guildId: 'g1',
        economy: { currency: '💰', enabled: true },
        shop: [{ itemId: 'pet_food', name: 'Pet Food', price: 250, description: '🍖 Feeds any pet.' }],
    })),
}));
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const giftCommand = require('../src/commands/economy/gift.js');

const OLD_ACCOUNT = Date.now() - 365 * 24 * 60 * 60 * 1000;

function buildAutocomplete(focusedValue = '') {
    const responses = [];
    return {
        responses,
        interaction: {
            guild: { id: 'g1' },
            user: { id: 'sender' },
            options: {
                getFocused: (withDetail) => (withDetail ? { name: 'item', value: focusedValue } : focusedValue),
            },
            respond: jest.fn(async (choices) => { responses.push(choices); }),
        },
    };
}

function buildExecute({ item = null, type = 'item', quantity = null, amount = null } = {}) {
    const state = { replies: [] };
    return {
        state,
        interaction: {
            guild: { id: 'g1' },
            guildId: 'g1',
            user: {
                id: 'sender',
                username: 'sender',
                createdTimestamp: OLD_ACCOUNT,
                displayAvatarURL: () => 'https://cdn.example/sender.png',
            },
            options: {
                getUser: () => ({
                    id: 'recipient',
                    username: 'recipient',
                    bot: false,
                    createdTimestamp: OLD_ACCOUNT,
                    displayAvatarURL: () => 'https://cdn.example/recipient.png',
                }),
                getString: (name) => (name === 'type' ? type : name === 'item' ? item : null),
                getInteger: (name) => (name === 'quantity' ? quantity : name === 'amount' ? amount : null),
            },
            reply: jest.fn(async (p) => { state.replies.push(p); }),
            followUp: jest.fn(async () => {}),
        },
    };
}

beforeEach(() => {
    mockStore = {
        sender: {
            userId: 'sender',
            guildId: 'g1',
            balance: 0,
            inventory: [
                { itemId: 'pet_food',      quantity: 3 },
                { itemId: 'lifesaver',     quantity: 1 },
                { itemId: 'The Tenth Owl', quantity: 1 },
                { itemId: 'ai_beta',       quantity: 2 },
                { itemId: 'lucky_charm',   quantity: 1 },
                { itemId: 'padlock',       quantity: 0 },
            ],
            activeEffects: [{ type: 'lucky_charm' }],
        },
        recipient: { userId: 'recipient', guildId: 'g1', balance: 0, inventory: [], activeEffects: [] },
    };
    jest.clearAllMocks();
});

describe('the item picker', () => {
    test('offers what you hold, by display name and count', async () => {
        const { interaction, responses } = buildAutocomplete();
        await giftCommand.autocomplete(interaction);

        const choices = responses[0];
        expect(choices.map(c => c.value)).toEqual(
            expect.arrayContaining(['pet_food', 'The Tenth Owl', 'ai_beta'])
        );
        const petFood = choices.find(c => c.value === 'pet_food');
        // The label is what the player recognises, not the id they would
        // otherwise have had to guess, and it says how many they have.
        expect(petFood.name).toContain('Pet Food');
        expect(petFood.name).toContain('3 held');
    });

    test('resolves a forged item to its name instead of its ai_ id', async () => {
        const { interaction, responses } = buildAutocomplete();
        await giftCommand.autocomplete(interaction);
        expect(responses[0].find(c => c.value === 'ai_beta').name).toContain('Sunspike');
    });

    test('never offers something the command would refuse', async () => {
        const { interaction, responses } = buildAutocomplete();
        await giftCommand.autocomplete(interaction);

        const ids = responses[0].map(c => c.value);
        expect(ids).not.toContain('lifesaver');    // soulbound
        expect(ids).not.toContain('lucky_charm');  // its effect is running
        expect(ids).not.toContain('padlock');      // an empty slot
    });

    test('matches on the display name, not only on the id', async () => {
        const { interaction, responses } = buildAutocomplete('pet f');
        await giftCommand.autocomplete(interaction);
        expect(responses[0].map(c => c.value)).toEqual(['pet_food']);
    });

    test('stays silent on any option other than item', async () => {
        const { interaction, responses } = buildAutocomplete();
        interaction.options.getFocused = (withDetail) => (withDetail ? { name: 'quantity', value: '' } : '');
        await giftCommand.autocomplete(interaction);
        expect(responses[0]).toEqual([]);
    });

    test('an empty response, not a crash, when the lookup fails', async () => {
        const User = require('../src/models/User');
        User.findOne.mockImplementationOnce(() => { throw new Error('db down'); });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const { interaction, responses } = buildAutocomplete();
        await giftCommand.autocomplete(interaction);

        expect(responses[0]).toEqual([]);
        errorSpy.mockRestore();
    });
});

describe('resolving what was typed', () => {
    // Inventory ids are not uniformly cased — relics are stored under their
    // prose name and a custom shop item under its display name — so an exact
    // match refused items the player was plainly holding.
    test('a differently-cased id still finds the item', async () => {
        const { interaction, state } = buildExecute({ item: 'PET_FOOD', quantity: 1 });
        await giftCommand.execute(interaction);
        expect(state.replies.at(-1).content ?? '').not.toContain("don't have");
    });

    test('a relic name is matched without exact capitalisation', async () => {
        const { interaction, state } = buildExecute({ item: 'the tenth owl', quantity: 1 });
        await giftCommand.execute(interaction);
        expect(state.replies.at(-1).content ?? '').not.toContain("don't have");
    });

    test('a soulbound item is refused as soulbound however it is typed', async () => {
        const { interaction, state } = buildExecute({ item: 'LifeSaver', quantity: 1 });
        await giftCommand.execute(interaction);
        // Not "you don't have it" — the old exact-match check let the wrong
        // refusal answer for the right one.
        expect(state.replies.at(-1).content).toContain('soulbound');
    });

    test('an item whose effect is running is refused by name', async () => {
        const { interaction, state } = buildExecute({ item: 'lucky_charm', quantity: 1 });
        await giftCommand.execute(interaction);
        expect(state.replies.at(-1).content).toContain('Lucky Charm');
        expect(state.replies.at(-1).content).toContain('active as an effect');
    });

    test('asking for more than you hold says how many you have', async () => {
        const { interaction, state } = buildExecute({ item: 'pet_food', quantity: 9 });
        await giftCommand.execute(interaction);
        expect(state.replies.at(-1).content).toContain('3×');
        expect(state.replies.at(-1).content).toContain('Pet Food');
    });

    test('several stacks that only add up together say so', async () => {
        // Duplicate stacks for one item are a reachable legacy state, and a
        // gift comes out of one stack — so "you have 4" would be true and
        // useless here.
        mockStore.sender.inventory = [
            { itemId: 'pet_food', quantity: 2 },
            { itemId: 'pet_food', quantity: 2 },
        ];
        const { interaction, state } = buildExecute({ item: 'pet_food', quantity: 3 });
        await giftCommand.execute(interaction);

        expect(state.replies.at(-1).content).toContain('no single stack holds 3');
        expect(state.replies.at(-1).content).toContain('largest holds **2×**');
    });

    test('an item you do not hold points at the picker', async () => {
        const { interaction, state } = buildExecute({ item: 'shield', quantity: 1 });
        await giftCommand.execute(interaction);
        expect(state.replies.at(-1).content).toContain('Start typing in the `item` box');
    });
});

describe('mismatched options', () => {
    test('an amount filled in on an item gift is called out, not ignored', async () => {
        const { interaction, state } = buildExecute({ type: 'item', item: 'pet_food', amount: 500 });
        await giftCommand.execute(interaction);
        expect(state.replies.at(-1).content).toContain('`amount`');
        expect(state.replies.at(-1).flags).toBeDefined();
    });

    test('an item filled in on a coin gift is called out, not ignored', async () => {
        const { interaction, state } = buildExecute({ type: 'coins', item: 'pet_food', amount: null });
        await giftCommand.execute(interaction);
        expect(state.replies.at(-1).content).toContain('`item`');
    });
});
