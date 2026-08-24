'use strict';

// #603: the fifteen-minute price recalc read every dynamic-pricing guild in
// full, mutated the shop array in JavaScript, and wrote it back with
// `markModified('shop')` + `save()`. Shop items store their icon inline as an
// `imageData` Buffer, so that shape rewrote every uploaded icon in the guild,
// four times an hour, to change a handful of numbers.
//
// The job now names the pricing fields in its projection and writes the new
// prices back as per-item `$set`s. These tests pin both halves: what it asks
// for, and what it sends back.

jest.mock('discord.js', () => ({
    EmbedBuilder: class {
        setColor() { return this; }
        setTitle() { return this; }
        setDescription() { return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
    },
}));

jest.mock('../src/models/Guild', () => ({
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    bulkWrite: jest.fn(),
}));
jest.mock('../src/models/User', () => ({ find: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), bulkWrite: jest.fn() }));

const Guild = require('../src/models/Guild');
const { HISTORY_CAP } = require('../src/utils/dynamicPricing');
const { recalcShopPrices } = require('../src/services/schedulerService');

const client = { guilds: { fetch: async () => null } };

/** Fields named anywhere in a mongoose string projection. */
function projected(projection) {
    return String(projection).split(/\s+/).filter(Boolean);
}

function stubGuild({ shop, dynamicPricing = { enabled: true, priceBand: 0.5, volatility: 'medium' }, economy = {} }) {
    const seen = {};
    Guild.find.mockImplementation((filter, projection) => {
        seen.sweepFilter = filter;
        seen.sweepProjection = projection;
        return { lean: async () => [{ guildId: 'g1', dynamicPricing: { recalcMinutes: 15 } }] };
    });
    Guild.findOneAndUpdate.mockImplementation((filter, update, options) => {
        seen.claimFilter = filter;
        seen.claimUpdate = update;
        seen.claimOptions = options;
        return { lean: async () => ({ guildId: 'g1', shop, dynamicPricing, economy }) };
    });
    Guild.bulkWrite.mockImplementation(async ops => { seen.writes = ops; });
    return seen;
}

const items = () => ([
    { _id: 'item-a', name: 'Sword',  price: 100, basePrice: 100, currentPrice: 100, demandScore: 40 },
    { _id: 'item-b', name: 'Shield', price: 200, basePrice: 200, currentPrice: 200, demandScore: 0 },
]);

beforeEach(() => jest.clearAllMocks());

describe('recalcShopPrices reads', () => {
    it('projects both reads down to the pricing fields', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        // The sweep only needs an id and the lease window.
        expect(projected(seen.sweepProjection)).toEqual(['guildId', 'dynamicPricing.recalcMinutes']);

        // The claim reads the shop, but only the fields the recalc computes on.
        const fields = projected(seen.claimOptions.projection);
        expect(fields).toEqual(expect.arrayContaining([
            'shop._id', 'shop.name', 'shop.price', 'shop.basePrice', 'shop.currentPrice', 'shop.demandScore',
        ]));
        expect(fields).not.toContain('shop');
        expect(fields).not.toContain('shop.imageData');
        // Appended to by the write, so there is no reason to read it back.
        expect(fields).not.toContain('shop.priceHistory');
    });

    it('still claims the recalc window atomically', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        expect(seen.claimFilter['dynamicPricing.enabled']).toBe(true);
        expect(seen.claimFilter.$or).toHaveLength(2);
        expect(Object.keys(seen.claimUpdate.$set)).toEqual(['dynamicPricing.lastRecalcAt']);
        expect(seen.claimOptions.new).toBe(true);
    });

    it('does nothing when another worker holds the window', async () => {
        stubGuild({ shop: items() });
        Guild.findOneAndUpdate.mockReturnValue({ lean: async () => null });

        await recalcShopPrices(client);

        expect(Guild.bulkWrite).not.toHaveBeenCalled();
    });
});

describe('recalcShopPrices writes', () => {
    it('sets only the price fields, addressing items by subdocument id', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        expect(seen.writes).toHaveLength(2);
        const [first] = seen.writes;
        expect(first.updateOne.filter).toEqual({ guildId: 'g1', 'shop._id': 'item-a' });
        // Nothing in the write mentions the image, or the shop array as a whole.
        const serialised = JSON.stringify(seen.writes);
        expect(serialised).not.toContain('imageData');
        expect(serialised).not.toMatch(/"shop":/);
    });

    it('leaves an already-set basePrice alone', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        // basePrice belongs to whoever edits the shop in the dashboard. Writing
        // back the value we read would undo an edit made while we computed, so
        // the only field this job claims outright is the one it authors.
        for (const op of seen.writes) {
            expect(Object.keys(op.updateOne.update.$set)).toEqual(['shop.$.currentPrice']);
        }
    });

    it('decays demand with $mul so a concurrent buy is not swallowed', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        // /shop buy bumps this field with $inc while the recalc is in flight.
        // Multiplying applies the decay to whatever is stored at write time;
        // $set-ing a value read a moment earlier would drop the buy.
        for (const op of seen.writes) {
            expect(op.updateOne.update.$mul).toEqual({ 'shop.$.demandScore': 1 - 0.10 });
            expect(op.updateOne.update.$set).not.toHaveProperty('shop.$.demandScore');
        }
    });

    it('uses the volatility tier\'s decay factor', async () => {
        const seen = stubGuild({
            shop: items(),
            dynamicPricing: { enabled: true, priceBand: 0.5, volatility: 'high' },
        });

        await recalcShopPrices(client);

        expect(seen.writes[0].updateOne.update.$mul['shop.$.demandScore']).toBeCloseTo(1 - 0.15);
    });

    it('seeds rather than multiplies a demand score that was never stored', async () => {
        const seen = stubGuild({
            // Predates demand tracking: $mul would reject the null outright, and
            // treat an absent field as zero without ever seeding it.
            shop: [
                { _id: 'old-1', name: 'Relic', price: 10, basePrice: 10, currentPrice: 10, demandScore: null },
                { _id: 'old-2', name: 'Idol',  price: 10, basePrice: 10, currentPrice: 10 },
            ],
        });

        await recalcShopPrices(client);

        for (const op of seen.writes) {
            expect(op.updateOne.update.$mul).toBeUndefined();
            expect(op.updateOne.update.$set['shop.$.demandScore']).toBe(0);
        }
    });

    it('never names one field in both $set and $mul', async () => {
        const seen = stubGuild({
            shop: [...items(), { _id: 'old-1', name: 'Relic', price: 10 }],
        });

        await recalcShopPrices(client);

        // Mongo rejects the whole update if it does.
        for (const op of seen.writes) {
            const setKeys = Object.keys(op.updateOne.update.$set || {});
            const mulKeys = Object.keys(op.updateOne.update.$mul || {});
            expect(setKeys.filter(k => mulKeys.includes(k))).toEqual([]);
        }
    });

    it('appends one history entry per item and caps it in the database', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        for (const op of seen.writes) {
            const push = op.updateOne.update.$push['shop.$.priceHistory'];
            expect(push.$each).toHaveLength(1);
            expect(push.$slice).toBe(-HISTORY_CAP);
            expect(push.$each[0].price).toEqual(op.updateOne.update.$set['shop.$.currentPrice']);
        }
    });

    it('moves a high-demand item up and leaves a neutral one alone', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        const [sword, shield] = seen.writes.map(op => op.updateOne.update.$set['shop.$.currentPrice']);
        expect(sword).toBeGreaterThan(100);
        expect(shield).toBe(200);
    });

    it('backfills basePrice for an item that predates dynamic pricing', async () => {
        const seen = stubGuild({
            shop: [{ _id: 'item-c', name: 'Potion', price: 50 }],
        });

        await recalcShopPrices(client);

        // The one case where this job does author basePrice: there was none.
        expect(seen.writes[0].updateOne.update.$set['shop.$.basePrice']).toBe(50);
    });

    it('guards the basePrice backfill with a predicate that it is still unset', async () => {
        const seen = stubGuild({
            shop: [{ _id: 'item-c', name: 'Potion', price: 50 }],
        });

        await recalcShopPrices(client);

        // basePrice is the one field here read rather than derived, so an admin
        // setting it between the claim and this write is a real edit to lose. The
        // predicate makes the whole item's update a no-op in that case, and the
        // next tick recomputes from the admin's value.
        expect(seen.writes[0].updateOne.filter).toEqual({
            guildId: 'g1',
            shop: { $elemMatch: { _id: 'item-c', basePrice: null } },
        });
    });

    it('does not add that predicate for an item that already has a basePrice', async () => {
        const seen = stubGuild({ shop: items() });

        await recalcShopPrices(client);

        for (const op of seen.writes) {
            expect(Object.keys(op.updateOne.filter).sort()).toEqual(['guildId', 'shop._id']);
        }
    });

    it('issues no write for a guild with an empty shop', async () => {
        stubGuild({ shop: [] });

        await recalcShopPrices(client);

        expect(Guild.bulkWrite).not.toHaveBeenCalled();
    });
});
