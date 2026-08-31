'use strict';

/**
 * #786. `/market` is 195 lines at 15.9% lines and 0% branches. It is the one
 * economy command where coins and items cross between two players, and none of
 * the guards that keep the two sides consistent — the compare-and-set that
 * takes stock out of a seller's bag, the `balance: { $gte: total }` on the
 * buyer's debit, the refund when the listing is gone — had ever run.
 *
 * `list` and `cancel` are driven directly. `buy` under the confirmation
 * threshold is too; over it the harness presses the confirm button.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, inventory: [], activeEffects: [], pets: [] });
const mockGuilds = fakeCollection('Guild');
const mockListings = fakeCollection('MarketListing', {}, { unique: [] });
const mockTransactions = fakeCollection('Transaction', {}, { unique: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/models/MarketListing', () => mockListings.model);
jest.mock('../src/models/Transaction', () => mockTransactions.model);
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/inventoryGrant', () => ({
    grantInventoryItem: jest.fn(),
    inventoryAddExpr: jest.fn(() => ({})),
}));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));

const market = require('../src/commands/economy/market');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { logTransaction } = require('../src/utils/logTransaction');

const GUILD_ID = 'guild-1';
const BUYER_ID = 'user-1';      // the harness's own user
const SELLER_ID = 'seller-1';

const seedGuild = (economy = {}) => mockGuilds.seed({
    guildId: GUILD_ID, economy: { currency: '💰', ...economy },
});

const seedUser = (userId, fields = {}) => mockUsers.seed({ userId, guildId: GUILD_ID, ...fields });

const seedListing = (fields = {}) => {
    const listing = {
        _id: 'listing-1', guildId: GUILD_ID, sellerId: SELLER_ID,
        itemId: 'lucky_charm', quantity: 2, pricePerUnit: 100,
        expiresAt: new Date(Date.now() + 3_600_000),
        ...fields,
    };
    mockListings.seed(listing);
    return listing;
};

/**
 * The confirmation flow returns as soon as it has wired its collector on, so
 * the press lands after execute() has already resolved. Draining the queue is
 * what turns "the button was offered" into "the button was pressed".
 */
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

const run = async ({ subcommand, options = {}, components = [] }) => {
    const interaction = makeInteraction({ subcommand, options, components, userId: BUYER_ID });
    await market.execute(interaction);
    await settle();
    return interaction;
};

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    mockListings.reset();
    mockTransactions.reset();
    jest.clearAllMocks();
    // The default: the credit lands. Individual tests make it fail.
    grantInventoryItem.mockImplementation(async (userId, guildId, itemId, quantity) => {
        const doc = mockUsers.get(userId);
        if (!doc) return false;
        const slot = doc.inventory.find(s => s.itemId === itemId);
        if (slot) slot.quantity += quantity;
        else doc.inventory.push({ itemId, quantity });
        return true;
    });
});

describe('listing an item', () => {
    it('takes the stock out of the bag and creates the listing', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 5 }] });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 3 }]);
        expect(await mockListings.model.countDocuments({})).toBe(1);
        expect(repliedText(interaction)).toContain('Item Listed');
    });

    it('takes the stock as a compare-and-set, not a read then a save', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 5 }] });

        await run({ subcommand: 'list', options: { item: 'lucky_charm', quantity: 2, price: 100 } });

        const debit = mockUsers.writes.find(w => w.update?.$inc?.['inventory.$.quantity']);
        expect(debit.query.inventory.$elemMatch).toEqual({ itemId: 'lucky_charm', quantity: { $gte: 2 } });
    });

    it('refuses a quantity the player does not have, and takes nothing', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 1 }] });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(repliedText(interaction)).toContain("You don't have 2x");
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 1 }]);
        expect(await mockListings.model.countDocuments({})).toBe(0);
    });

    it('refuses a soulbound item outright', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lifesaver', quantity: 3 }] });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lifesaver', quantity: 1, price: 100 },
        });

        expect(repliedText(interaction)).toContain('soulbound');
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lifesaver', quantity: 3 }]);
    });

    it('caps a seller at five open listings', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 9 }] });
        for (let i = 0; i < 5; i++) seedListing({ _id: `open-${i}`, sellerId: BUYER_ID });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 1, price: 100 },
        });

        expect(repliedText(interaction)).toContain('only have 5 active listings');
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 9 }]);
    });

    // #926: the cap was a `countDocuments` followed by an insert, which two
    // concurrent calls could both pass. It is a property of the data now — each
    // listing claims one of the seller's five slots, and the unique index on
    // { guildId, sellerId, slot } is what makes a sixth impossible rather than
    // merely unlikely.
    it('claims the seller a slot, and the next listing takes the one after it', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 9 }] });

        await run({ subcommand: 'list', options: { item: 'lucky_charm', quantity: 1, price: 100 } });
        await run({ subcommand: 'list', options: { item: 'lucky_charm', quantity: 1, price: 100 } });

        expect(mockListings.all().map(l => l.slot)).toEqual([1, 2]);
    });

    it('reuses the slot a cancelled or sold listing left behind', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 9 }] });
        seedListing({ _id: 'open-1', sellerId: BUYER_ID, slot: 1 });
        seedListing({ _id: 'open-3', sellerId: BUYER_ID, slot: 3 });

        await run({ subcommand: 'list', options: { item: 'lucky_charm', quantity: 1, price: 100 } });

        expect(mockListings.all().find(l => l._id === 'id-3').slot).toBe(2);
    });

    it('takes another slot when it loses the race for the one it picked', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 9 }] });
        // The rival's insert lands first and the index refuses this one, which is
        // exactly what a lost race looks like from here.
        mockListings.model.create.mockImplementationOnce(async () => {
            seedListing({ _id: 'rival', sellerId: BUYER_ID, slot: 1 });
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(repliedText(interaction)).toContain('Item Listed');
        expect(mockListings.all().find(l => l._id !== 'rival').slot).toBe(2);
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 7 }]);
    });

    it('refuses, and returns the stock, when the race filled the last slot', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 9 }] });
        for (const slot of [1, 2, 3, 4]) seedListing({ _id: `open-${slot}`, sellerId: BUYER_ID, slot });
        // Four listings pass the pre-check; the fifth slot goes to somebody else
        // in the moment between that check and this insert.
        mockListings.model.create.mockImplementationOnce(async () => {
            seedListing({ _id: 'rival', sellerId: BUYER_ID, slot: 5 });
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(repliedText(interaction)).toContain('only have 5 active listings');
        expect(grantInventoryItem).toHaveBeenCalledWith(BUYER_ID, GUILD_ID, 'lucky_charm', 2);
        expect(mockListings.all().filter(l => l.sellerId === BUYER_ID)).toHaveLength(5);
    });

    // Legacy rows carry no slot and the unique index skips them, so they have to
    // be counted against the seller's five some other way — otherwise a seller
    // holding four of them could open five more.
    it('counts listings written before slots existed against the seller\'s five', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 9 }] });
        for (let i = 0; i < 4; i++) seedListing({ _id: `legacy-${i}`, sellerId: BUYER_ID, slot: undefined });

        await run({ subcommand: 'list', options: { item: 'lucky_charm', quantity: 1, price: 100 } });

        expect(mockListings.all().filter(l => l.sellerId === BUYER_ID)).toHaveLength(5);
        // The one number the four legacy rows have not reserved.
        expect(mockListings.all().find(l => l.slot != null).slot).toBe(5);
    });

    it('refuses the seller a sixth when the race for it is against a legacy listing', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 9 }] });
        for (let i = 0; i < 4; i++) seedListing({ _id: `legacy-${i}`, sellerId: BUYER_ID, slot: undefined });
        // Four legacy rows pass the pre-check; the one numbered slot they leave
        // goes to somebody else between that check and this insert.
        mockListings.model.create.mockImplementationOnce(async () => {
            seedListing({ _id: 'rival', sellerId: BUYER_ID, slot: 5 });
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(repliedText(interaction)).toContain('only have 5 active listings');
        expect(mockListings.all().filter(l => l.sellerId === BUYER_ID)).toHaveLength(5);
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 9 }]);
    });

    // The debit has committed by the time the return runs, so a return that does
    // not land leaves the player without the item and without a listing. Saying
    // it came back is the one answer that gives them no reason to mention it.
    it.each([
        ['the update rejects', () => grantInventoryItem.mockRejectedValueOnce(new Error('write failed'))],
        ['the update matches no document', () => grantInventoryItem.mockResolvedValueOnce(false)],
    ])('records the stock as owed, and says so, when %s', async (_case, breakReturn) => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 5 }] });
        mockListings.model.create.mockRejectedValueOnce(new Error('write failed'));
        breakReturn();
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(repliedText(interaction)).toContain('recorded as owed');
        expect(repliedText(interaction)).not.toContain('has been returned');
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            payload: {
                kind: 'items', userId: BUYER_ID, guildId: GUILD_ID, itemId: 'lucky_charm', quantity: 2,
            },
        }));
        console.error.mockRestore();
    });

    it('hands the stock back when the listing cannot be written', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 5 }] });
        mockListings.model.create.mockRejectedValueOnce(new Error('write failed'));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(repliedText(interaction)).toContain('item has been returned');
        expect(grantInventoryItem).toHaveBeenCalledWith(BUYER_ID, GUILD_ID, 'lucky_charm', 2);
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 5 }]);
        // The stock is back, so there is nothing owed to write down.
        expect(recordOwedPayout).not.toHaveBeenCalled();
        console.error.mockRestore();
    });
});

describe('buying a listing', () => {
    it('moves coins one way and the item the other, minus the fee', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });   // 200 total, under the confirm threshold

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(mockUsers.get(BUYER_ID).balance).toBe(800);
        // 5% of 200 is burned, so the seller sees 190.
        expect(mockUsers.get(SELLER_ID).balance).toBe(190);
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(await mockListings.model.countDocuments({})).toBe(0);
        expect(repliedText(interaction)).toContain('Purchase Complete');
        expectNonNegativeBalance([mockUsers.get(BUYER_ID), mockUsers.get(SELLER_ID)], 'market buy');
    });

    it('debits the buyer behind a balance guard, so an empty wallet cannot pay', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 199 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('You need');
        expect(mockUsers.get(BUYER_ID).balance).toBe(199);
        expect(mockUsers.get(SELLER_ID).balance).toBe(0);
        expect(await mockListings.model.countDocuments({})).toBe(1);
    });

    it('carries the guard on the debit itself, not on a prior read', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        const debit = mockUsers.writes.find(w => w.update?.$inc?.balance === -200);
        expect(debit.query.balance).toEqual({ $gte: 200 });
    });

    it('refunds the buyer when the listing is taken between the debit and the delete', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        mockListings.model.findOneAndDelete.mockResolvedValueOnce(null);

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('just sold');
        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
        expect(mockUsers.get(SELLER_ID).balance).toBe(0);
    });

    it('refunds the buyer when the item cannot be credited', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        grantInventoryItem.mockResolvedValueOnce(false);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('coins have been refunded');
        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
        // The seller must not be paid for a sale that did not complete.
        expect(mockUsers.get(SELLER_ID).balance).toBe(0);
        console.error.mockRestore();
    });

    it('refuses a listing that is gone', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'no-such-listing' } });

        expect(repliedText(interaction)).toContain('Listing not found');
        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
    });

    it("refuses a seller buying their own listing", async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedListing({ sellerId: BUYER_ID });

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain("can't buy your own listing");
        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
    });

    it('asks before a purchase over the threshold, and goes through on confirm', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 10_000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 400 });   // 800, over the 500 threshold

        const interaction = await run({
            subcommand: 'buy',
            options: { listing_id: 'listing-1' },
            components: [{ customId: 'mkt_buy_confirm' }],
        });

        expect(repliedText(interaction)).toContain('Purchase Complete');
        expect(mockUsers.get(BUYER_ID).balance).toBe(9_200);
    });

    it('takes nothing when the confirmation is cancelled', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 10_000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 400 });

        await run({
            subcommand: 'buy',
            options: { listing_id: 'listing-1' },
            components: [{ customId: 'mkt_buy_cancel' }],
        });

        expect(mockUsers.get(BUYER_ID).balance).toBe(10_000);
        expect(await mockListings.model.countDocuments({})).toBe(1);
    });

    it('takes nothing when the confirmation window closes unanswered', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 10_000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 400 });

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(mockUsers.get(BUYER_ID).balance).toBe(10_000);
        expect(await mockListings.model.countDocuments({})).toBe(1);
    });

    it('logs both sides of a completed sale', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'market_sell', amount: 190 }));
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'market_buy', amount: -200 }));
    });
});

describe('cancelling a listing', () => {
    it('returns the stock and removes the listing', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [] });
        seedListing({ sellerId: BUYER_ID, quantity: 2 });

        const interaction = await run({ subcommand: 'cancel', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('Listing Cancelled');
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(await mockListings.model.countDocuments({})).toBe(0);
    });

    it("refuses to cancel somebody else's listing", async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [] });
        seedListing({ sellerId: SELLER_ID });

        const interaction = await run({ subcommand: 'cancel', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('not yours');
        expect(await mockListings.model.countDocuments({})).toBe(1);
    });

    it('says the items are owed when the return fails after the delete', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [] });
        seedListing({ sellerId: BUYER_ID });
        grantInventoryItem.mockRejectedValueOnce(new Error('credit failed'));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'cancel', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('recoverable');
        console.error.mockRestore();
    });
});

describe('the economy switch', () => {
    it('refuses every subcommand when the economy is off', async () => {
        seedGuild({ enabled: false });
        seedUser(BUYER_ID, { balance: 1000, inventory: [{ itemId: 'lucky_charm', quantity: 5 }] });

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 1, price: 100 },
        });

        expect(repliedText(interaction)).toContain('economy is disabled');
        expect(mockUsers.writes).toEqual([]);
    });
});

// The slot allocation above is only half of the cap: the other half is the
// unique index that makes two listings in one slot impossible, and an index is
// not something the command can assert about itself. Read off the compiled
// schema — the real one, past the mock — so a malformed declaration fails here
// rather than at autoIndex time in production.
describe('the MarketListing schema backs the cap', () => {
    const declared = jest.requireActual('../src/models/MarketListing').schema.indexes();
    const slotIndex = declared.find(([, opts]) => opts?.name === 'idx_market_seller_slot');

    it('keeps one listing per seller slot', () => {
        expect(slotIndex).toBeDefined();
        expect(slotIndex[0]).toEqual({ guildId: 1, sellerId: 1, slot: 1 });
        expect(slotIndex[1].unique).toBe(true);
    });

    // Rows written before the field existed carry no slot. A sparse index would
    // still index them — sparse skips a document only when it has none of the
    // keys, and these have guildId and sellerId — and every one of a seller's
    // legacy rows would then collide on `slot: null`, failing the index build.
    it('indexes only the rows that carry a slot', () => {
        expect(slotIndex[1].partialFilterExpression).toEqual({ slot: { $gte: 1 } });
        expect(slotIndex[1].sparse).toBeUndefined();
    });
});
