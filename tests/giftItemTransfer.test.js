'use strict';

// /gift item used to write both sides with Promise.all([sender.save(), recipient.save()]):
// if the sender's save lost and the recipient's won, the item was duplicated.
// These tests drive the transfer against an in-memory User mockStore that implements
// the specific query shapes the command issues.

let mockStore;   // userId -> document
let mockWrites;  // ordered log of the inventory mockWrites the command performed

function mockFindDoc(query) {
    const doc = mockStore[query.userId];
    if (!doc || doc.guildId !== query.guildId) return null;
    return doc;
}

// Handles only the query shapes gift.js uses.
function mockMatches(doc, query) {
    if (!doc) return false;
    const elem = query.inventory?.$elemMatch;
    if (elem) {
        const idx = doc.inventory.findIndex(
            s => s.itemId === elem.itemId && s.quantity >= elem.quantity.$gte
        );
        if (idx === -1) return false;
        doc._matchedIndex = idx;
    }
    const byItem = query['inventory.itemId'];
    if (byItem !== undefined) {
        const present = doc.inventory.some(s => s.itemId === (byItem?.$ne ?? byItem));
        if (byItem?.$ne !== undefined ? present : !present) return false;
    }
    return true;
}

function mockApplyUpdate(doc, update, options = {}) {
    if (update.$inc) {
        for (const [path, delta] of Object.entries(update.$inc)) {
            if (path === 'inventory.$[slot].quantity') {
                // An arrayFilter hits EVERY matching element — that is the bug.
                const itemId = options.arrayFilters[0]['slot.itemId'];
                doc.inventory.filter(s => s.itemId === itemId).forEach((s) => {
                    s.quantity += delta;
                    mockWrites.push({ user: doc.userId, itemId, delta });
                });
            } else if (path === 'inventory.$.quantity') {
                // The positional operator binds to the FIRST element the query
                // matched, whether that came from $elemMatch or 'inventory.itemId'.
                const slot = doc.inventory[doc._matchedIndex];
                slot.quantity += delta;
                mockWrites.push({ user: doc.userId, itemId: slot.itemId, delta });
            } else {
                doc[path] = (doc[path] ?? 0) + delta;
            }
        }
    }
    if (update.$push?.inventory) {
        const { itemId, quantity } = update.$push.inventory;
        doc.inventory.push({ itemId, quantity });
        mockWrites.push({ user: doc.userId, itemId, delta: quantity });
    }
    if (update.$pull?.inventory) {
        const { itemId, quantity } = update.$pull.inventory;
        doc.inventory = doc.inventory.filter(
            s => !(s.itemId === itemId && s.quantity <= quantity.$lte)
        );
    }
}

// Set from a test to make the recipient's credit fail.
let mockFailCreditFor = null;

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
        if (query['inventory.itemId'] !== undefined && query['inventory.itemId'].$ne === undefined) {
            doc._matchedIndex = doc.inventory.findIndex(s => s.itemId === query['inventory.itemId']);
        }
        if (mockFailCreditFor && doc.userId === mockFailCreditFor && (update.$inc || update.$push)) {
            throw new Error('simulated write failure');
        }
        mockApplyUpdate(doc, update, options);
        return doc;
    }),
    updateOne: jest.fn(async (query, update, options = {}) => {
        let doc = mockFindDoc(query);
        if (!doc && options.upsert) {
            doc = { userId: query.userId, guildId: query.guildId, balance: 0, inventory: [], activeEffects: [] };
            mockStore[query.userId] = doc;
        }
        if (doc) mockApplyUpdate(doc, update, options);
        return {};
    }),
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(async () => ({ guildId: 'g1', economy: { currency: '💰', enabled: true } })),
}));

jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const giftCommand = require('../src/commands/economy/gift.js');

const OLD_ACCOUNT = Date.now() - 365 * 24 * 60 * 60 * 1000;

function buildInteraction({ itemId = 'pet_food', quantity = 1 } = {}) {
    const state = { replies: [], followUps: [] };
    const interaction = {
        guild: { id: 'g1' },
        guildId: 'g1',
        user: { id: 'sender', username: 'sender', createdTimestamp: OLD_ACCOUNT },
        options: {
            getUser: () => ({ id: 'recipient', username: 'recipient', bot: false, createdTimestamp: OLD_ACCOUNT }),
            getString: (name) => (name === 'type' ? 'item' : name === 'item' ? itemId : null),
            getInteger: (name) => (name === 'quantity' ? quantity : null),
        },
        reply: jest.fn(async (p) => { state.replies.push(p); }),
        followUp: jest.fn(async (p) => { state.followUps.push(p); }),
    };
    return { interaction, state };
}

function mockTotalHeld(itemId) {
    return Object.values(mockStore).reduce(
        (sum, u) => sum + u.inventory
            .filter(s => s.itemId === itemId)
            .reduce((n, s) => n + s.quantity, 0),
        0
    );
}

beforeEach(() => {
    mockFailCreditFor = null;
    mockWrites = [];
    mockStore = {
        sender:    { userId: 'sender',    guildId: 'g1', balance: 0, inventory: [{ itemId: 'pet_food', quantity: 3 }], activeEffects: [] },
        recipient: { userId: 'recipient', guildId: 'g1', balance: 0, inventory: [], activeEffects: [] },
    };
    jest.clearAllMocks();
});

test('a successful gift moves the item exactly once', async () => {
    const { interaction } = buildInteraction({ quantity: 2 });
    await giftCommand.execute(interaction);

    expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 1 }]);
    expect(mockStore.recipient.inventory).toEqual([{ itemId: 'pet_food', quantity: 2 }]);
    expect(mockTotalHeld('pet_food')).toBe(3); // conserved — nothing created or destroyed
    expect(mockWrites).toEqual([
        { user: 'sender',    itemId: 'pet_food', delta: -2 },
        { user: 'recipient', itemId: 'pet_food', delta: 2 },
    ]);
});

test('gifting the whole stack removes the empty slot', async () => {
    const { interaction } = buildInteraction({ quantity: 3 });
    await giftCommand.execute(interaction);

    expect(mockStore.sender.inventory).toEqual([]);
    expect(mockStore.recipient.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
    expect(mockTotalHeld('pet_food')).toBe(3);
});

test('the recipient credit is a delta, so a concurrent slot is not clobbered', async () => {
    mockStore.recipient.inventory = [{ itemId: 'pet_food', quantity: 5 }];
    const { interaction } = buildInteraction({ quantity: 2 });
    await giftCommand.execute(interaction);

    expect(mockStore.recipient.inventory).toEqual([{ itemId: 'pet_food', quantity: 7 }]);
    expect(mockTotalHeld('pet_food')).toBe(8);
});

test('a failed credit rolls the debit back instead of duplicating the item', async () => {
    mockFailCreditFor = 'recipient';
    const { interaction, state } = buildInteraction({ quantity: 2 });
    await giftCommand.execute(interaction);

    expect(mockStore.recipient.inventory).toEqual([]);
    expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
    expect(mockTotalHeld('pet_food')).toBe(3); // no duplication, no loss
    expect(state.replies.at(-1).content).toContain('your item was returned');
});

test('a rolled-back gift of a whole stack restores the slot', async () => {
    mockFailCreditFor = 'recipient';
    const { interaction } = buildInteraction({ quantity: 3 });
    await giftCommand.execute(interaction);

    expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
    expect(mockTotalHeld('pet_food')).toBe(3);
});

test('gifting more than you hold moves nothing', async () => {
    const { interaction, state } = buildInteraction({ quantity: 9 });
    await giftCommand.execute(interaction);

    expect(mockWrites).toEqual([]);
    expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
    expect(mockStore.recipient.inventory).toEqual([]);
    expect(state.replies.at(-1).content).toContain("don't have 9x");
});

test('a duplicate slot for the same item is not double-debited', async () => {
    // Several writers $push without checking for an existing slot, so two slots
    // for one itemId is a reachable state. An arrayFilter would decrement both.
    mockStore.sender.inventory = [
        { itemId: 'pet_food', quantity: 3 },
        { itemId: 'pet_food', quantity: 4 },
    ];
    const { interaction } = buildInteraction({ quantity: 2 });
    await giftCommand.execute(interaction);

    expect(mockStore.sender.inventory).toEqual([
        { itemId: 'pet_food', quantity: 1 },
        { itemId: 'pet_food', quantity: 4 },   // untouched
    ]);
    expect(mockStore.recipient.inventory).toEqual([{ itemId: 'pet_food', quantity: 2 }]);
    expect(mockTotalHeld('pet_food')).toBe(7); // 3 + 4 conserved
});

test('a slot too small to cover the gift is skipped for one that can', async () => {
    mockStore.sender.inventory = [
        { itemId: 'pet_food', quantity: 1 },
        { itemId: 'pet_food', quantity: 6 },
    ];
    const { interaction } = buildInteraction({ quantity: 4 });
    await giftCommand.execute(interaction);

    expect(mockStore.sender.inventory).toEqual([
        { itemId: 'pet_food', quantity: 1 },
        { itemId: 'pet_food', quantity: 2 },
    ]);
    expect(mockTotalHeld('pet_food')).toBe(7);
});
