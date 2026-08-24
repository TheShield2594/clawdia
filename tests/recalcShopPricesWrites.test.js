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
        expect(Object.keys(first.updateOne.update.$set).sort()).toEqual([
            'shop.$.basePrice', 'shop.$.currentPrice', 'shop.$.demandScore',
        ]);
        // Nothing in the write mentions the image, or the shop array as a whole.
        const serialised = JSON.stringify(seen.writes);
        expect(serialised).not.toContain('imageData');
        expect(serialised).not.toMatch(/"shop":/);
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

        expect(seen.writes[0].updateOne.update.$set['shop.$.basePrice']).toBe(50);
    });

    it('issues no write for a guild with an empty shop', async () => {
        stubGuild({ shop: [] });

        await recalcShopPrices(client);

        expect(Guild.bulkWrite).not.toHaveBeenCalled();
    });
});
