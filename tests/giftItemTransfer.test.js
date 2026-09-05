'use strict';

const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

// /gift item used to write both sides with Promise.all([sender.save(), recipient.save()]):
// if the sender's save lost and the recipient's won, the item was duplicated.
// These tests drive the transfer against an in-memory User mockStore that implements
// the specific query shapes the command issues.

const { applyPipelineUpdate } = require('./helpers/pipelineUpdate');

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
    // The freeze guard the item debit and the recipient credit both carry
    // (#870). Without it here the mock would wave a frozen party straight
    // through and the two tests below would pass against unguarded writes,
    // which is the bug they exist to catch.
    if (query.economyFrozen?.$ne !== undefined && doc.economyFrozen === query.economyFrozen.$ne) {
        return false;
    }
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
    // Inventory credits now go through a single aggregation-pipeline update
    // instead of a bump-or-push pair, so the mock has to be able to run one.
    if (Array.isArray(update)) {
        const before = doc.inventory.map(s => ({ ...s }));
        applyPipelineUpdate(doc, update);
        for (const slot of doc.inventory) {
            const prior = before.find(s => s.itemId === slot.itemId);
            const delta = slot.quantity - (prior?.quantity ?? 0);
            if (delta !== 0) mockWrites.push({ user: doc.userId, itemId: slot.itemId, delta });
        }
        return;
    }
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
    if (update.$set) {
        // The daily gift-value budget opens its 24h window with a `$set` on the
        // same write as the inventory decrement, so the mock has to apply one.
        for (const [path, value] of Object.entries(update.$set)) doc[path] = value;
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

// Set from a test to make a user's inventory credit answer `null` instead of
// throwing — which is what `grantInventoryItem` does for a document that is not
// there, and the failure mode the rollback used to ignore entirely (#873).
let mockNullCreditFor = null;

// Set from a test to freeze a party *between* the pre-flight read and the write
// that acts on it — the race a read-then-act check cannot see. Called with each
// update just before it is matched, so the filter is evaluated against a
// document that changed after the command decided to proceed.
let mockFreezeOnWrite = null;

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
        if (mockFreezeOnWrite) mockFreezeOnWrite(update);
        if (!mockMatches(doc, query)) return null;
        if (query['inventory.itemId'] !== undefined && query['inventory.itemId'].$ne === undefined) {
            doc._matchedIndex = doc.inventory.findIndex(s => s.itemId === query['inventory.itemId']);
        }
        if (mockFailCreditFor && doc.userId === mockFailCreditFor && (Array.isArray(update) || update.$inc || update.$push)) {
            throw new Error('simulated write failure');
        }
        if (mockNullCreditFor && doc.userId === mockNullCreditFor && Array.isArray(update)) return null;
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

// The gift embed shows the item's artwork where a server has uploaded some.
// No image in these fixtures — the point here is that the lookup does not reach
// for a database connection the suite does not have.
jest.mock('../src/models/ItemImage', () => ({ findOne: jest.fn(async () => null) }));

jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));

const giftCommand = require('../src/commands/economy/gift.js');

const OLD_ACCOUNT = Date.now() - 365 * 24 * 60 * 60 * 1000;

function buildInteraction({ itemId = 'pet_food', quantity = 1 } = {}) {
    const state = { replies: [], followUps: [] };
    const interaction = {
        // The rollback's payout key is built from this, so a fake without one
        // would key every gift the same.
        id: 'interaction-1',
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
            getString: (name) => (name === 'type' ? 'item' : name === 'item' ? itemId : null),
            getInteger: (name) => (name === 'quantity' ? quantity : null),
        },
        // /gift defers ephemerally before touching the database, so every
        // refusal and the sender's receipt arrive through editReply and only
        // the public announcement through followUp.
        deferReply: jest.fn(async () => {}),
        editReply: jest.fn(async (p) => { state.replies.push(p); return { awaitMessageComponent: async () => { throw new Error('no component'); } }; }),
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
    mockNullCreditFor = null;
    mockFreezeOnWrite = null;
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
    expect(state.replies.at(-1).content).toContain('Your item was returned');
});

// #873. `addInventoryItem` answers `null` rather than throwing when no document
// matched, and the rollback never read its return value — so the one case it
// exists to handle was the one it reported as handled. The sender was told
// "Your item was returned" over an item that by then existed nowhere: debited
// from them, refused by the recipient, rolled back into nothing.
describe('a rollback that does not land', () => {
    const { recordOwedPayout } = require('../src/utils/owedPayout');

    beforeEach(() => {
        recordOwedPayout.mockClear();
        recordOwedPayout.mockResolvedValue(true);
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => console.error.mockRestore());

    test('does not tell the sender their item came back', async () => {
        mockFailCreditFor = 'recipient';
        mockNullCreditFor = 'sender';
        const { interaction, state } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        expect(state.replies.at(-1).content).not.toContain('item was returned');
        expect(state.replies.at(-1).content).toContain('is recorded');
    });

    test('writes the item down where payouts:replay can settle it', async () => {
        mockFailCreditFor = 'recipient';
        mockNullCreditFor = 'sender';
        const { interaction } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'gift',
            jobName: 'giftItemRollback',
            payload: expect.objectContaining({
                kind: 'items', userId: 'sender', guildId: 'g1',
                itemId: 'pet_food', quantity: 2,
                // Keyed by the interaction, so neither the retry nor a replay
                // can hand the sender a second copy.
                payoutKey: 'gift:interaction-1:rollback',
            }),
        }));
    });

    // The allowance the debit spent travels with the item, so a replay puts the
    // sender back where they were rather than returning the item and leaving
    // them charged a day's cap for a gift that never arrived (#873).
    test('carries the day\'s item-gift allowance, stamped with its window', async () => {
        mockFailCreditFor = 'recipient';
        mockNullCreditFor = 'sender';
        const { interaction } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        const [{ payload }] = recordOwedPayout.mock.calls.at(-1);
        expect(payload.budgetRefund).toMatchObject({
            usedField:  'dailyGiftItemValueSent',
            resetField: 'dailyGiftItemValueReset',
            amount:     expect.any(Number),
        });
        // The window is the one the debit wrote, read off the document it
        // returned — that is what lets the replay tell whether the allowance it
        // would refund is still the one that was spent.
        expect(payload.budgetRefund.window).toEqual(mockStore.sender.dailyGiftItemValueReset);
    });

    test('replaying it in the same window returns the item and the allowance', async () => {
        mockFailCreditFor = 'recipient';
        mockNullCreditFor = 'sender';
        const { interaction } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        const [{ payload }] = recordOwedPayout.mock.calls.at(-1);
        const spent = mockStore.sender.dailyGiftItemValueSent;
        mockNullCreditFor = null;

        const { replayOwedPayout } = jest.requireActual('../src/utils/owedPayout');
        await replayOwedPayout(payload);

        expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
        expect(mockStore.sender.dailyGiftItemValueSent).toBe(spent - payload.budgetRefund.amount);
    });

    test('replaying it after the window turned over returns only the item', async () => {
        mockFailCreditFor = 'recipient';
        mockNullCreditFor = 'sender';
        const { interaction } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        const [{ payload }] = recordOwedPayout.mock.calls.at(-1);
        mockNullCreditFor = null;
        // A day passes and the counter resets before the replay runs.
        mockStore.sender.dailyGiftItemValueReset = new Date('2099-01-01T00:00:00Z');
        mockStore.sender.dailyGiftItemValueSent = 4_000;

        const { replayOwedPayout } = jest.requireActual('../src/utils/owedPayout');
        await replayOwedPayout(payload);

        expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
        // Untouched: this allowance was never what the gift was charged against.
        expect(mockStore.sender.dailyGiftItemValueSent).toBe(4_000);
    });

    test('says so plainly when even the record could not be written', async () => {
        mockFailCreditFor = 'recipient';
        mockNullCreditFor = 'sender';
        recordOwedPayout.mockResolvedValue(false);
        const { interaction, state } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        expect(state.replies.at(-1).content).toContain('contact a server admin');
    });

    test('still returns the item when the rollback fails once and lands on the retry', async () => {
        // The rollback retries now, so a single transient rejection is not a
        // reason to tell the sender their item is gone.
        mockFailCreditFor = 'recipient';
        let firstSenderCredit = true;
        mockNullCreditFor = null;
        const User = require('../src/models/User');
        const realUpdate = User.findOneAndUpdate.getMockImplementation();
        User.findOneAndUpdate.mockImplementation(async (query, update, options) => {
            if (query.userId === 'sender' && Array.isArray(update) && firstSenderCredit) {
                firstSenderCredit = false;
                throw new Error('transient');
            }
            return realUpdate(query, update, options);
        });

        const { interaction, state } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        User.findOneAndUpdate.mockImplementation(realUpdate);
        expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
        expect(state.replies.at(-1).content).toContain('Your item was returned');
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

test('a rolled-back gift of a whole stack restores the slot', async () => {
    mockFailCreditFor = 'recipient';
    const { interaction } = buildInteraction({ quantity: 3 });
    await giftCommand.execute(interaction);

    expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
    expect(mockTotalHeld('pet_food')).toBe(3);
});

// A frozen party is refused by the read before any of this, so these do not
// seed the flag — they land it *after* that read, which is the only thing the
// guard in the filter is there for. Seeding it up front would pass against
// completely unguarded writes and prove nothing (#870).
describe('a freeze that lands after the pre-flight read', () => {
    /** The debit; the credit is a pipeline update and carries no `$inc`. */
    const isItemDebit = update => !Array.isArray(update) && !!update.$inc?.['inventory.$.quantity'];
    /** The recipient credit, which gift.js issues as a pipeline update. */
    const isItemCredit = update => Array.isArray(update);

    test('takes no item from a sender frozen mid-gift', async () => {
        mockFreezeOnWrite = (update) => {
            if (isItemDebit(update)) mockStore.sender.economyFrozen = true;
        };
        const { interaction } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
        expect(mockStore.recipient.inventory).toEqual([]);
        expect(mockWrites).toEqual([]);
    });

    test('gives the item back when the recipient is frozen mid-gift', async () => {
        // The debit has already landed by the time the credit is refused, so
        // this is the rollback path — and the rollback is deliberately
        // unguarded, because a sanction that ate the refund would destroy the
        // sender's item.
        mockFreezeOnWrite = (update) => {
            if (isItemCredit(update)) mockStore.recipient.economyFrozen = true;
        };
        const { interaction } = buildInteraction({ quantity: 2 });
        await giftCommand.execute(interaction);

        expect(mockStore.recipient.inventory).toEqual([]);
        expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
        expect(mockTotalHeld('pet_food')).toBe(3); // conserved
    });
});

test('gifting more than you hold moves nothing', async () => {
    const { interaction, state } = buildInteraction({ quantity: 9 });
    await giftCommand.execute(interaction);

    expect(mockWrites).toEqual([]);
    expect(mockStore.sender.inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
    expect(mockStore.recipient.inventory).toEqual([]);
    expect(state.replies.at(-1).content).toContain('not enough to gift 9');
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

// A gift debits one side and credits the other; neither may end below zero.
afterEach(() => {
    expectNonNegativeBalance(mockStore, 'gift');
});
