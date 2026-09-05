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

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, inventory: [], activeEffects: [], pets: [], paidPayouts: [] });
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
// An ambiguous listing claim is filed as a plain FailedJob rather than an owed
// payout, so it reaches an operator without `payouts:replay` acting on it.
jest.mock('../src/models/FailedJob', () => ({ create: jest.fn(async () => ({})) }));

const market = require('../src/commands/economy/market');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const FailedJob = require('../src/models/FailedJob');
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
    FailedJob.create.mockResolvedValue({});
    // `/market browse` renders a seller-reputation column from a Transaction
    // aggregation. Nothing here is about reputation, and the fake collections
    // do not run pipelines, so it answers empty.
    mockTransactions.model.aggregate = jest.fn(async () => []);
    // The default: the credit lands. Individual tests make it fail.
    //
    // The payout-key guard is evaluated for real rather than waved through
    // (#873). Every unwind in this file is keyed, and a mock that ignored the
    // key would report a retry as safe when the key is the only reason it is —
    // and would answer 'unknown' where the real store answers 'duplicate', which
    // is the exact distinction `creditPurchasedItem` turns on.
    grantInventoryItem.mockImplementation(async (userId, guildId, itemId, quantity, options = {}) => {
        const doc = mockUsers.get(userId);
        if (!doc) return false;
        const key = options.guard?.['paidPayouts.key']?.$ne;
        if (key) {
            doc.paidPayouts = doc.paidPayouts ?? [];
            // The guard is `$ne`, so a document already carrying the key matches
            // nothing and the write does not happen.
            if (doc.paidPayouts.some(entry => entry.key === key)) return null;
            doc.paidPayouts.push({ key });
        }
        const slot = doc.inventory.find(s => s.itemId === itemId);
        if (slot) slot.quantity += quantity;
        else doc.inventory.push({ itemId, quantity });
        return true;
    });
});

// Some tests below replace a method on the model outright — the only way to make
// a specific write reject. `jest.clearAllMocks()` clears call history but leaves
// the replacement in place, so a patch that outlives its test (a failed assertion
// skipping an in-body restore, or a stub that never had one) is inherited by
// everything after it. That is an order-dependent failure which reproduces only
// in a full run, so the whole method table is snapshotted and put back.
const pristineUserModel = { ...mockUsers.model };
afterEach(() => { Object.assign(mockUsers.model, pristineUserModel); });

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
        // The bag rather than the call: the return goes through the keyed
        // `grantItemsOrOwe` now, so what matters is that the nine are back.
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 9 }]);
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
    //
    // The failures are persistent rather than one-shot: the return retries now,
    // and a single transient rejection is one the retry is supposed to survive.
    it.each([
        ['the update rejects', () => grantInventoryItem.mockRejectedValue(new Error('write failed'))],
        ['the update matches no document', () => grantInventoryItem.mockResolvedValue(false)],
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
                // Keyed, so a replay cannot hand the seller a second copy of
                // stock whose write had in fact committed.
                payoutKey: 'market:interaction-1:relist',
            },
        }));
        console.error.mockRestore();
    });

    it('does not promise a record that was not written either', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lucky_charm', quantity: 5 }] });
        mockListings.model.create.mockRejectedValueOnce(new Error('write failed'));
        grantInventoryItem.mockResolvedValue(false);
        recordOwedPayout.mockResolvedValueOnce(false);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({
            subcommand: 'list',
            options: { item: 'lucky_charm', quantity: 2, price: 100 },
        });

        expect(repliedText(interaction)).toContain('could not be recorded');
        expect(repliedText(interaction)).not.toContain('recorded as owed');
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
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 5 }]);
        // The stock is back, so there is nothing owed to write down.
        expect(recordOwedPayout).not.toHaveBeenCalled();
        console.error.mockRestore();
    });
});

describe('naming the item', () => {
    // Inventory ids are not uniformly cased. Relics are stored under their prose
    // name and a custom guild item under whatever an admin called it, because
    // shop.js stores an item as `itemId || name`. `handleList` lowercased what
    // was typed and compared it with `===`, so those items could not be listed
    // at all, whatever the seller wrote.
    it('lists a relic despite its capitalisation', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'The Tenth Owl', quantity: 1 }] });

        await run({ subcommand: 'list', options: { item: 'the tenth owl', quantity: 1, price: 5000 } });

        expect(mockUsers.get(BUYER_ID).inventory).toEqual([]);
        expect(await mockListings.model.countDocuments({})).toBe(1);
    });

    it('stores the canonical id, so the item comes back as itself', async () => {
        // A listing that recorded the lowercased spelling handed the stock back
        // into a second stack under a name the player never had.
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'The Tenth Owl', quantity: 1 }] });

        await run({ subcommand: 'list', options: { item: 'THE TENTH OWL', quantity: 1, price: 5000 } });

        const listing = await mockListings.model.findOne({});
        expect(listing.itemId).toBe('The Tenth Owl');
    });

    it('refuses a soulbound item however it is typed', async () => {
        // The check ran on the raw string, so `Lifesaver` missed it and was
        // refused several lines later as "you don't have it".
        seedGuild();
        seedUser(BUYER_ID, { inventory: [{ itemId: 'lifesaver', quantity: 1 }] });

        const interaction = await run({ subcommand: 'list', options: { item: 'LifeSaver', quantity: 1, price: 5000 } });

        expect(repliedText(interaction)).toContain('soulbound');
        expect(await mockListings.model.countDocuments({})).toBe(0);
    });

    it('browses for a relic without exact capitalisation', async () => {
        seedGuild();
        seedListing({ itemId: 'The Tenth Owl', quantity: 1, pricePerUnit: 5000 });

        const interaction = await run({ subcommand: 'browse', options: { item: 'the tenth owl' } });

        expect(repliedText(interaction)).not.toContain('No listings found');
    });

    it('a regex metacharacter in the browse filter is matched literally', async () => {
        seedGuild();
        seedListing({ itemId: 'lucky_charm' });

        const interaction = await run({ subcommand: 'browse', options: { item: 'lucky_charm)' } });

        expect(repliedText(interaction)).toContain('No listings found');
    });
});

describe('the option pickers', () => {
    const autocomplete = async (subcommand, name, value = '') => {
        const responses = [];
        await market.autocomplete({
            guild: { id: GUILD_ID },
            user: { id: BUYER_ID },
            options: {
                getSubcommand: () => subcommand,
                getFocused: (withDetail) => (withDetail ? { name, value } : value),
            },
            respond: async (choices) => { responses.push(choices); },
        });
        return responses[0];
    };

    it('offers what the seller is holding, by name and count', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [
            { itemId: 'lucky_charm', quantity: 5 },
            { itemId: 'lifesaver',   quantity: 1 },   // soulbound
            { itemId: 'padlock',     quantity: 0 },   // an emptied stack
        ] });

        const choices = await autocomplete('list', 'item');

        expect(choices.map(c => c.value)).toEqual(['lucky_charm']);
        expect(choices[0].name).toContain('Lucky Charm');
        expect(choices[0].name).toContain('5 held');
    });

    it('offers only items that are actually listed, for browse', async () => {
        seedGuild();
        seedListing({ _id: 'l1', itemId: 'lucky_charm' });
        seedListing({ _id: 'l2', itemId: 'lucky_charm' });
        seedListing({ _id: 'l3', itemId: 'pet_food' });

        const choices = await autocomplete('browse', 'item');

        expect(choices.map(c => c.value).sort()).toEqual(['lucky_charm', 'pet_food']);
    });

    it('offers other people listings to buy, and never your own', async () => {
        // The picker must not offer what handleBuy would refuse on submit.
        seedGuild();
        seedListing({ _id: 'theirs', sellerId: SELLER_ID });
        seedListing({ _id: 'mine',   sellerId: BUYER_ID });

        const choices = await autocomplete('buy', 'listing_id');

        expect(choices.map(c => c.value)).toEqual(['theirs']);
        expect(choices[0].name).toContain('Lucky Charm');
    });

    it('offers your own listings to cancel, and only yours', async () => {
        seedGuild();
        seedListing({ _id: 'theirs', sellerId: SELLER_ID });
        seedListing({ _id: 'mine',   sellerId: BUYER_ID });

        const choices = await autocomplete('cancel', 'listing_id');

        expect(choices.map(c => c.value)).toEqual(['mine']);
    });

    it('an empty response, not a crash, when the lookup fails', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockListings.model.distinct.mockRejectedValueOnce(new Error('db down'));

        expect(await autocomplete('browse', 'item')).toEqual([]);
        errorSpy.mockRestore();
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

    // #873. Both of the paths above abandon a purchase *after* the buyer's debit
    // has committed, and both used to put the coins back with a bare
    // `User.updateOne` whose result was never read — then say "Your coins have
    // been refunded" whatever it did. An update whose filter matches nothing
    // resolves exactly as happily as one that moved coins.
    it.each([
        ['the listing was taken first', () => mockListings.model.findOneAndDelete.mockResolvedValueOnce(null), 'just sold'],
        ['the item could not be credited', () => grantInventoryItem.mockResolvedValue(false), 'crediting the item'],
    ])('does not claim a refund it could not make when %s', async (_case, breakPurchase, expected) => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        breakPurchase();
        // The buyer's document vanishes between the debit and the refund, which
        // is the case the unread result hid: nothing to match, nothing refunded.
        const realFindOneAndUpdate = mockUsers.model.findOneAndUpdate;
        mockUsers.model.findOneAndUpdate = jest.fn(async (query, ...rest) =>
            (query?.userId === BUYER_ID && Array.isArray(rest[0])
                ? null
                : realFindOneAndUpdate(query, ...rest)));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain(expected);
        expect(repliedText(interaction)).toContain('Returning your coins failed');
        expect(repliedText(interaction)).not.toContain('coins have been refunded');
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            payload: expect.objectContaining({
                kind: 'coins', userId: BUYER_ID, guildId: GUILD_ID, amount: 200,
                // Keyed by the interaction, so the retry above and a later
                // replay of this record cannot refund the same purchase twice.
                payoutKey: 'market:interaction-1:refund',
            }),
        }));
        console.error.mockRestore();
    });

    it('does not let a refund that rejects escape the purchase', async () => {
        // The lost-listing refund had no `catch` at all, so a rejection came out
        // of `executePurchase` with the buyer already charged.
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        mockListings.model.findOneAndDelete.mockResolvedValueOnce(null);
        mockUsers.model.findOneAndUpdate = jest.fn(async (query, ...rest) => {
            if (query?.userId === BUYER_ID && Array.isArray(rest[0])) throw new Error('write failed');
            return pristineUserModel.findOneAndUpdate(query, ...rest);
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('Returning your coins failed');
        expect(recordOwedPayout).toHaveBeenCalled();
        console.error.mockRestore();
    });

    // #873. The listing row was the only place this stock existed — it left the
    // seller's bag when they listed it — and the delete above has removed it. A
    // purchase that then fails to credit the buyer used to refund the coins and
    // stop there, so the item was in nobody's inventory at all: destroyed,
    // silently, with the seller never told.
    it('returns the seller their stock when the item cannot be credited', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        // Only the buyer's credit fails; the seller's return uses the same call.
        grantInventoryItem.mockImplementationOnce(async () => false);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('coins have been refunded');
        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([]);
        // The item is back where it came from rather than nowhere.
        expect(mockUsers.get(SELLER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(mockUsers.get(SELLER_ID).balance).toBe(0);
        console.error.mockRestore();
    });

    it('writes the stock down as owed when it cannot go back to the seller either', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        grantInventoryItem.mockResolvedValue(false);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            jobName: 'buyUnwindStock',
            payload: expect.objectContaining({
                kind: 'items', userId: SELLER_ID, guildId: GUILD_ID,
                itemId: 'lucky_charm', quantity: 2,
                payoutKey: 'listing:listing-1:unwind',
                listingId: 'listing-1',
            }),
        }));
        console.error.mockRestore();
    });

    // #873. The claim is the one write in the flow whose *rejection* says
    // nothing about its outcome, and it had no `catch` at all — so it escaped a
    // purchase that had already taken the buyer's money, with nothing written
    // down anywhere.
    it('refunds the buyer when claiming the listing rejects after the debit', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        mockListings.model.findOneAndDelete.mockRejectedValueOnce(new Error('claim failed'));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('claiming the listing');
        expect(repliedText(interaction)).toContain('coins have been refunded');
        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([]);
        // The listing survived the rejected delete, so the item is still in it —
        // returning stock as well would be a second copy of the same item.
        expect(mockUsers.get(SELLER_ID).inventory).toEqual([]);
        expect(await mockListings.model.countDocuments({})).toBe(1);
        // Written down, not merely logged: the outcome of the claim is unknowable
        // and a console line is not a record anyone can act on later.
        expect(FailedJob.create).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            // No `.owed` suffix: replaying this unattended would grant the stock
            // even in the world where a concurrent buyer legitimately took it.
            jobName: 'buyClaimAmbiguous',
            payload: expect.objectContaining({
                listingId: 'listing-1', sellerId: SELLER_ID, buyerId: BUYER_ID,
                itemId: 'lucky_charm', quantity: 2, stillListed: true,
            }),
        }));
        console.error.mockRestore();
    });

    it('records the stranded stock when the listing is gone after a rejected claim', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        // The delete commits and only its response is lost — so the row really
        // is gone by the time the catch re-reads, and the item is in nobody's
        // bag. Simulated by doing the delete and then throwing, rather than by
        // stubbing the re-read, which `handleBuy` also uses to load the listing.
        const realDelete = mockListings.model.findOneAndDelete.getMockImplementation();
        mockListings.model.findOneAndDelete.mockImplementationOnce(async (...args) => {
            await realDelete(...args);
            throw new Error('claim failed');
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
        // Still not granted — a concurrent buyer may hold it — but the record
        // names the question an operator has to answer.
        expect(mockUsers.get(SELLER_ID).inventory).toEqual([]);
        expect(FailedJob.create).toHaveBeenCalledWith(expect.objectContaining({
            jobName: 'buyClaimAmbiguous',
            payload: expect.objectContaining({
                stillListed: false,
                adjudicate: expect.stringContaining('listing:listing-1:sale'),
            }),
        }));
        console.error.mockRestore();
    });

    // #873, the bound the previous pass left open. A write that commits and
    // loses its response is indistinguishable from one that never ran, so
    // unwinding on that reading hands the seller their stock back while the
    // buyer is holding it — an item minted, not merely misreported. The key on
    // the buyer's credit is what turns that assumption into a question.
    it('does not give the seller the stock back when the buyer already has it', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        // The credit commits and *then* the response is lost.
        const landed = grantInventoryItem.getMockImplementation();
        grantInventoryItem.mockImplementationOnce(async (...args) => {
            await landed(...args);
            throw new Error('connection reset after the write committed');
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        // The purchase is a success: the key says the item arrived.
        expect(repliedText(interaction)).toContain('Purchase Complete');
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(mockUsers.get(BUYER_ID).balance).toBe(800);
        // Neither the coins nor the item come back — the trade completed.
        expect(mockUsers.get(SELLER_ID).inventory).toEqual([]);
        expect(mockUsers.get(SELLER_ID).balance).toBe(190);
        expect(recordOwedPayout).not.toHaveBeenCalled();
        console.error.mockRestore();
    });

    // The other side of the same decision, and the one place where neither
    // guess is safe. When the classification *itself* fails there is no answer
    // to be had, and unwinding on it is the worse of the two: it refunds the
    // buyer **and** hands the seller their stock back, so a credit that had in
    // fact landed leaves the buyer with a free item and the seller with a second
    // copy of it. Two items minted, from the branch meant to prevent one.
    //
    // Nothing is undone. The credit is keyed, so it is filed under that key and
    // settles later whichever way it went — a no-op if it landed, a grant if it
    // did not.
    it('defers rather than unwinding when the buyer credit is indeterminate', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        grantInventoryItem.mockImplementationOnce(async () => { throw new Error('connection reset'); });
        // A Query-shaped stub, not a bare rejected promise: `findOne` is chained
        // `.lean()` here, and a rejection created before anything can attach a
        // handler is an unhandled rejection rather than the failure under test.
        const realFindOne = mockUsers.model.findOne;
        const failedRead = () => Promise.reject(new Error('read failed'));
        mockUsers.model.findOne = jest.fn((query, projection, ...rest) => (projection?.paidPayouts
            ? { lean: failedRead, select() { return this; }, sort() { return this; },
                then: (res, rej) => failedRead().then(res, rej),
                catch: rej => failedRead().catch(rej) }
            : realFindOne(query, projection, ...rest)));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        // The sale stands: the buyer paid, the seller was paid, and neither the
        // coins nor the stock came back.
        expect(mockUsers.get(BUYER_ID).balance).toBe(800);
        expect(mockUsers.get(SELLER_ID).balance).toBe(190);
        expect(mockUsers.get(SELLER_ID).inventory).toEqual([]);

        // The delivery is what is outstanding, filed under the purchase's own
        // key so a replay cannot hand the buyer a second copy.
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            jobName: 'buyItemUnknown',
            payload: expect.objectContaining({
                kind: 'items', userId: BUYER_ID, guildId: GUILD_ID,
                itemId: 'lucky_charm', quantity: 2,
                payoutKey: 'listing:listing-1:buyer',
            }),
        }));
        // And said out loud rather than left to the buyer to notice.
        expect(repliedText(interaction)).toContain('Delivery could not be confirmed');
        console.error.mockRestore();
    });

    it('tells the buyer plainly when an indeterminate delivery is not recorded', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        grantInventoryItem.mockImplementationOnce(async () => { throw new Error('connection reset'); });
        const realFindOne = mockUsers.model.findOne;
        const failedRead = () => Promise.reject(new Error('read failed'));
        mockUsers.model.findOne = jest.fn((query, projection, ...rest) => (projection?.paidPayouts
            ? { lean: failedRead, select() { return this; }, sort() { return this; },
                then: (res, rej) => failedRead().then(res, rej),
                catch: rej => failedRead().catch(rej) }
            : realFindOne(query, projection, ...rest)));
        recordOwedPayout.mockResolvedValueOnce(false);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('could not be recorded');
        console.error.mockRestore();
    });

    it('says so in the log when even the ambiguous-claim record cannot be written', async () => {
        // The last line of defence: the buyer's coins are back either way, but
        // the seller's item is only findable through this record. If the queue
        // write fails too, the log has to say that rather than imply a record
        // exists.
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0, inventory: [] });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        const realDelete = mockListings.model.findOneAndDelete.getMockImplementation();
        mockListings.model.findOneAndDelete.mockImplementationOnce(async (...args) => {
            await realDelete(...args);
            throw new Error('claim failed');
        });
        FailedJob.create.mockRejectedValue(new Error('queue is down'));
        const errors = [];
        jest.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(mockUsers.get(BUYER_ID).balance).toBe(1000);
        expect(errors.some(line => line.includes('NOT RECORDED'))).toBe(true);
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

/**
 * #869. The seller's proceeds were an unguarded, unretried write with no upsert
 * and no check on its result. It ran last — after the buyer had paid, after the
 * item had moved, after the listing was deleted — so both of its failure modes
 * lost the coins outright: a `null` return was ignored (and logged as
 * `balance: 0`), and a throw escaped with the trade already done.
 *
 * Neither left an owed record, so unlike every other credit in the economy there
 * was nothing for `npm run payouts:replay` to settle, and unlike `/bank transfer`
 * there was not even a failure message — the purchase looked successful.
 */
describe('paying the seller', () => {
    const sellerCredit = () => mockUsers.writes.find(w =>
        w.query?.userId === SELLER_ID && Array.isArray(w.update));

    it('is guarded by a key, so a replay cannot pay it twice', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        // Keyed by the listing, which this flow has just deleted, so the id can
        // never come round again.
        expect(sellerCredit().query['paidPayouts.key']).toEqual({ $ne: 'listing:listing-1:sale' });
        expect(mockUsers.get(SELLER_ID).paidPayouts.map(p => p.key)).toEqual(['listing:listing-1:sale']);
        expect(mockUsers.get(SELLER_ID).balance).toBe(190);
    });

    // #873. `balance` is required on the Transaction schema, and the figure used
    // to fall back to `0` when it could not be read — a number nobody observed,
    // filed in the ledger as though somebody had. A missing row is a gap an
    // operator can see; a fabricated balance is one they cannot.
    it('files no ledger row rather than a fabricated balance when the read fails', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        // Already paid, so the guarded credit returns no document and the
        // balance has to be read rather than assumed.
        seedUser(SELLER_ID, { balance: 190, paidPayouts: [{ key: 'listing:listing-1:sale', at: new Date() }] });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        const realFindOne = mockUsers.model.findOne;
        const failedRead = () => Promise.reject(new Error('read failed'));
        mockUsers.model.findOne = jest.fn((query, projection, ...rest) => (projection?.balance
            ? { lean: failedRead, select() { return this; }, sort() { return this; },
                then: (res, rej) => failedRead().then(res, rej),
                catch: rej => failedRead().catch(rej) }
            : realFindOne(query, projection, ...rest)));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('Purchase Complete');
        expect(logTransaction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'market_sell' }));
        // The buyer's own row is unaffected — their balance was read from the debit.
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'market_buy' }));
        console.error.mockRestore();
    });

    it('moves no coins a second time when the key is already on the document', async () => {
        // The write that committed without its response arriving, replayed.
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 190, paidPayouts: [{ key: 'listing:listing-1:sale', at: new Date() }] });
        seedListing({ quantity: 2, pricePerUnit: 100 });

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(mockUsers.get(SELLER_ID).balance).toBe(190);
        // A duplicate is a success, not an owed payout: the coins are there.
        expect(recordOwedPayout).not.toHaveBeenCalled();
        expect(repliedText(interaction)).toContain('Purchase Complete');
    });

    it('records the payout as owed when the seller has no document to credit', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        // No seller document at all — the `null` return that used to be dropped.
        seedListing({ quantity: 2, pricePerUnit: 100 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            jobName: 'buyListing',
            guildId: GUILD_ID,
            payload: expect.objectContaining({
                kind: 'coins', userId: SELLER_ID, guildId: GUILD_ID,
                amount: 190, payoutKey: 'listing:listing-1:sale',
            }),
        }));
        // No document is created for them: crediting a user who has never
        // played would resurrect a pruned account.
        expect(mockUsers.get(SELLER_ID)).toBeNull();
        console.error.mockRestore();
    });

    it('records the payout as owed when the credit throws', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedUser(SELLER_ID, { balance: 0 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const real = mockUsers.model.findOneAndUpdate;
        mockUsers.model.findOneAndUpdate = jest.fn(async (query, update, options) => {
            if (query.userId === SELLER_ID) throw new Error('connection reset');
            return real(query, update, options);
        });

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ amount: 190, payoutKey: 'listing:listing-1:sale' }),
            error: expect.objectContaining({ message: 'connection reset' }),
        }));
        // The buyer's side stands — they paid and they have the item — so the
        // throw must not take the whole purchase with it.
        expect(mockUsers.get(BUYER_ID).balance).toBe(800);
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(repliedText(interaction)).toContain('Purchase Complete');

        console.error.mockRestore();
    });

    it('does not tell the buyer the seller was paid when they were not', async () => {
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('recorded as owed');
        expect(repliedText(interaction)).not.toContain('Seller Received');
        console.error.mockRestore();
    });

    it('does not claim the payout is recorded when the queue write failed too', async () => {
        // recordOwedPayout returns false when the FailedJob write fails. Saying
        // "recorded as owed" then would tell the buyer the seller's coins are
        // tracked when nothing is tracking them.
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        recordOwedPayout.mockResolvedValueOnce(false);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('not recorded');
        expect(repliedText(interaction)).not.toContain('recorded as owed');
        console.error.mockRestore();
    });

    it('still writes the sale to the audit log, saying the payout is owed', async () => {
        // A row that only appears when the credit lands leaves the coins
        // unaccounted for exactly when someone goes looking for them.
        seedGuild();
        seedUser(BUYER_ID, { balance: 1000 });
        seedListing({ quantity: 2, pricePerUnit: 100 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await run({ subcommand: 'buy', options: { listing_id: 'listing-1' } });

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'market_sell', amount: 190,
            note: expect.stringContaining('payout owed'),
        }));
        console.error.mockRestore();
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

    // The delete is the claim: nothing will find this return again, on this tick
    // or any later one. So a return that does not land has to be written down
    // where `npm run payouts:replay` can settle it — which is what the
    // `returnStock` in `handleList`, three hundred lines above, has always done
    // for the identical failure (#873).
    //
    // Both failure modes, because the old code only had a `catch`:
    // `grantInventoryItem` answers `null` for a seller with no document rather
    // than throwing, and that return value was never read.
    it.each([
        ['the return rejects', () => grantInventoryItem.mockRejectedValue(new Error('credit failed'))],
        ['the return matches no document', () => grantInventoryItem.mockResolvedValue(false)],
    ])('records the items as owed, and says so, when %s', async (_case, breakReturn) => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [] });
        seedListing({ sellerId: BUYER_ID, quantity: 2 });
        breakReturn();
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'cancel', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('recorded');
        // The one thing it must never say when the item is not there.
        expect(repliedText(interaction)).not.toContain('Returned');
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'market',
            jobName: 'cancelListing',
            payload: expect.objectContaining({
                kind: 'items', userId: BUYER_ID, guildId: GUILD_ID,
                itemId: 'lucky_charm', quantity: 2,
                payoutKey: 'listing:listing-1:cancel',
            }),
        }));
        console.error.mockRestore();
    });

    it('tells the seller when the owed record could not be written either', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [] });
        seedListing({ sellerId: BUYER_ID, quantity: 2 });
        grantInventoryItem.mockResolvedValue(false);
        recordOwedPayout.mockResolvedValueOnce(false);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'cancel', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('contact a server admin');
        console.error.mockRestore();
    });

    it('survives a return that fails once and lands on the retry', async () => {
        seedGuild();
        seedUser(BUYER_ID, { inventory: [] });
        seedListing({ sellerId: BUYER_ID, quantity: 2 });
        grantInventoryItem.mockRejectedValueOnce(new Error('transient'));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const interaction = await run({ subcommand: 'cancel', options: { listing_id: 'listing-1' } });

        expect(repliedText(interaction)).toContain('Listing Cancelled');
        expect(mockUsers.get(BUYER_ID).inventory).toEqual([{ itemId: 'lucky_charm', quantity: 2 }]);
        expect(recordOwedPayout).not.toHaveBeenCalled();
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
