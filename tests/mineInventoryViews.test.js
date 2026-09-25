'use strict';

// The /mine inv render surface: the overview embed and each focused-category
// builder (pickaxes, charges, consumables, materials). They are pure — a
// mining-data object in, embeds out, no database — so they are tested directly.
// Collapsing the old /mine inv view / equip / discard group into one /mine inv
// with a category option, plus top-level /mine equip and /mine discard, is what
// this covers.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { __test__ } = require('../src/commands/economy/mine/inventory');
const { overviewEmbed, pickaxePages, chargesEmbed, consumablesEmbed, materialsPages, overviewPayload, inventoryStock, replacementIndex } = __test__;

const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;

function pickaxe(overrides = {}) {
    return {
        name: 'Iron Pickaxe',
        status: 'good',
        currentDurability: 90,
        maxDurability: 100,
        upgrade: null,
        ...overrides,
    };
}

function fullMining() {
    return {
        pickaxes: [pickaxe(), pickaxe({ name: 'Steel Pickaxe', upgrade: 'reinforced', status: 'worn', currentDurability: 20 })],
        equippedPickaxeIndex: 0,
        charges: { iron_blast: 5, steel_blast: 2 },
        consumables: { ore_magnet: 3, miners_lamp: 1 },
        activeMagnet: 'ore_magnet', activeMagnetMinesLeft: 4,
        activeLamp: true, activeLampMinesLeft: 2,
        activeInstinct: true, activeXpScroll: true,
        materials: { rock_fragment: 7, copper_flake: 3 },
    };
}

const emptyMining = () => ({
    pickaxes: [], equippedPickaxeIndex: -1,
    charges: {}, consumables: {}, materials: {},
    activeMagnet: null, activeLamp: false, activeInstinct: false, activeXpScroll: false,
});

const interaction = { user: { username: 'Miner' } };
const fieldsOf = embed => embed.data.fields ?? [];

describe('mine inventory builders', () => {
    test('overviewEmbed carries every section within field limits', () => {
        const embed = overviewEmbed(interaction, fullMining());
        const names = fieldsOf(embed).map(f => f.name).join(' ');
        expect(names).toMatch(/Pickaxes/);
        expect(names).toMatch(/Blast Charges/);
        expect(names).toMatch(/Consumables/);
        expect(names).toMatch(/Materials/);
        for (const field of fieldsOf(embed)) {
            expect(field.value.length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
        }
    });

    test('overviewEmbed spills a long pickaxe list into the full-list hint', () => {
        // The overview packs pickaxes into at most three fields; past what those
        // hold it stops and points at the full list, which is the branch here.
        const m = emptyMining();
        m.pickaxes = Array.from({ length: 100 }, (_, i) => pickaxe({ name: `Pick ${i}`, status: 'broken' }));
        m.equippedPickaxeIndex = 0;
        const embed = overviewEmbed(interaction, m);
        expect(JSON.stringify(embed.data)).toMatch(/category:pickaxes/);
    });

    test('overviewEmbed handles an empty inventory', () => {
        const embed = overviewEmbed(interaction, emptyMining());
        const pickField = fieldsOf(embed).find(f => /Pickaxes/.test(f.name));
        expect(pickField.value).toMatch(/shop pickaxe/);
    });

    test('pickaxePages renders owned pickaxes and stays within the description budget', () => {
        const pages = pickaxePages(fullMining());
        expect(pages.length).toBeGreaterThanOrEqual(1);
        for (const page of pages) {
            expect(page.data.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        }
        expect(pages[0].data.description).toMatch(/equipped/);
    });

    test('pickaxePages points an empty inventory at the shop', () => {
        const pages = pickaxePages(emptyMining());
        expect(pages).toHaveLength(1);
        expect(pages[0].data.description).toMatch(/shop pickaxe/);
    });

    test('chargesEmbed lists every charge type', () => {
        const embed = chargesEmbed(fullMining());
        expect(embed.data.description).toMatch(/iron blast/);
        expect(embed.data.description).toMatch(/void charge/);
    });

    test('consumablesEmbed shows stock and active buffs, None when empty', () => {
        const full = consumablesEmbed(fullMining());
        expect(fieldsOf(full).some(f => /Active Buffs/.test(f.name))).toBe(true);
        const empty = consumablesEmbed(emptyMining());
        expect(fieldsOf(empty).find(f => f.name === 'In Stock').value).toBe('None');
    });

    test('materialsPages lists materials, and reassures when there are none', () => {
        expect(materialsPages(fullMining())[0].data.description).toMatch(/rock|copper/i);
        expect(materialsPages(emptyMining())[0].data.description).toMatch(/None yet/);
    });

    test('inventoryStock maps held stock to art keys and skips empty stacks', () => {
        const { charges, consumables, materials } = inventoryStock(fullMining());
        expect(charges.map(c => c.iconId)).toEqual(['mine:iron_blast_pack', 'mine:steel_blast_pack']);
        expect(consumables.every(c => c.iconId?.startsWith('mine:'))).toBe(true);
        expect(materials.map(m => m.name)).toEqual(['Rock Fragment', 'Copper Flake']);
    });

    test('overviewPayload attaches the tool-belt card as the embed image', async () => {
        const payload = await overviewPayload(interaction, fullMining());
        expect(payload.files).toHaveLength(1);
        expect(payload.files[0].name).toBe('mine-inventory.png');
        expect(payload.embeds[0].toJSON().image.url).toBe('attachment://mine-inventory.png');
    });

    test('overviewPayload renders an empty inventory too', async () => {
        const payload = await overviewPayload(interaction, emptyMining());
        expect(payload.files).toHaveLength(1);
    });
});

describe('pickaxes that cannot dig', () => {
    // Condemned: repairs have ground the ceiling below 20% of the original.
    const condemned = overrides => pickaxe({ baseDurability: 100, maxDurability: 10, ...overrides });

    test('only a broken, condemned pickaxe is offered up for discarding', () => {
        const m = {
            ...emptyMining(),
            pickaxes: [
                pickaxe({ baseDurability: 100 }),
                condemned({ status: 'condemned', currentDurability: 5 }),   // still digs
                condemned({ status: 'broken', currentDurability: 0 }),      // junk
                pickaxe({ baseDurability: 100, status: 'broken', currentDurability: 0 }), // a repair away
            ],
            equippedPickaxeIndex: 0,
        };
        const names = fieldsOf(overviewEmbed(interaction, m)).map(f => f.name);
        const byName = name => fieldsOf(overviewEmbed(interaction, m)).find(f => f.name.includes(name));

        expect(names.some(n => n.includes('Beyond Repair'))).toBe(true);
        expect(byName('Beyond Repair').value).toMatch(/^1 pickaxe is/);
        expect(byName('Broken').value).toContain('/mine shop repair');
    });

    test('discarding the pickaxe in hand equips the best one that can still dig', () => {
        const belt = [
            pickaxe({ tier: 3, status: 'broken', currentDurability: 0 }),
            pickaxe({ tier: 1 }),
            pickaxe({ tier: 2 }),
        ];
        expect(replacementIndex(belt)).toBe(2);
    });

    test('with nothing that can dig, the first slot is equipped so /mine dig can say "repair it"', () => {
        expect(replacementIndex([pickaxe({ status: 'broken', currentDurability: 0 })])).toBe(0);
        expect(replacementIndex([])).toBe(-1);
    });
});
