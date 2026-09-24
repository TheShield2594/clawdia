'use strict';

// /inventory's Items tab card: the inventory split into shop / forged / relic
// tiles keyed to the baked art, and active effects as pills. The split is
// pure, so it is tested directly; the render is checked for a PNG and alt text.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/AiItem', () => ({ find: jest.fn() }));

const { __test__ } = require('../src/commands/economy/inventory');
const { buildItemsCard, itemsCardSections } = __test__;
const { DEFAULT_SHOP_ITEMS } = require('../src/data/defaultShopItems');
const { EFFECT_CONFIGS } = require('../src/data/effectConfigs');
const { timeRemaining } = require('../src/services/effectsService');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const target = { username: 'munge' };
const shopItems = [...DEFAULT_SHOP_ITEMS, { name: 'Custom Guild Hat', itemId: 'custom_guild_hat', price: 1500 }];
const inventory = [
    { itemId: 'padlock', quantity: 2 },
    { itemId: 'Lucky Charm', quantity: 1 },          // stored by name
    { itemId: 'custom_guild_hat', quantity: 1 },     // no baked art
    { itemId: 'ai_abc', quantity: 1 },
    { itemId: 'ai_gone', quantity: 1 },              // forged item with no record
    { itemId: 'Whisperwood Charm', quantity: 1 },    // a relic
    { itemId: 'shield', quantity: 0 },               // spent stack
];
const aiItemMap = { ai_abc: { name: 'Emberglass Dagger', rarity: 'Epic' } };

describe('itemsCardSections', () => {
    const { shop, forged, relics } = itemsCardSections(inventory, shopItems, aiItemMap);

    test('shop items resolve to their baked art by id or by name', () => {
        expect(shop.map(e => [e.name, e.iconId])).toEqual([
            ['Padlock', 'padlock'],
            ['Lucky Charm', 'lucky_charm'],
            ['Custom Guild Hat', null],
        ]);
    });

    test('forged items keep their name, or say the record is missing', () => {
        expect(forged.map(e => e.name)).toEqual(['Emberglass Dagger', 'Unknown forged item']);
        expect(forged[0].color).toBe('#9b59b6');
    });

    test('relics use the relic art key and skip empty stacks', () => {
        expect(relics).toEqual([expect.objectContaining({ iconId: 'relic:whisperwood_charm', name: 'Whisperwood Charm', count: 1 })]);
        expect([...shop, ...forged, ...relics].some(e => e.name === 'Shield')).toBe(false);
    });
});

describe('buildItemsCard', () => {
    const effectType = Object.keys(EFFECT_CONFIGS)[0];

    test('renders a PNG whose alt text names every item and effect', async () => {
        const card = await buildItemsCard(inventory, shopItems,
            [{ type: effectType, charges: 2 }], aiItemMap, target);
        expect(card.attachment.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(card.name).toBe('inventory-items.png');
        for (const s of ['Padlock 2', 'Emberglass Dagger 1', 'Whisperwood Charm 1', `${EFFECT_CONFIGS[effectType].label} (2 uses left)`]) {
            expect(card.description).toContain(s);
        }
    });

    test('sends no card when there is nothing to draw', async () => {
        expect(await buildItemsCard([], shopItems, [], {}, target)).toBeNull();
    });
});

describe('timeRemaining', () => {
    const inMs = ms => new Date(Date.now() + ms);

    test('carries a rounded-up minute into the hour', () => {
        expect(timeRemaining(inMs(3 * 3_600_000 - 30_000))).toBe('3h');
        expect(timeRemaining(inMs(2 * 3_600_000 + 5 * 60_000 - 30_000))).toBe('2h 5m');
    });

    test('short, expired and permanent effects', () => {
        expect(timeRemaining(inMs(90_000))).toBe('2m');
        expect(timeRemaining(inMs(-1))).toBe('expired');
        expect(timeRemaining(null)).toBe('permanent');
    });
});
