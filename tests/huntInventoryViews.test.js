'use strict';

// The /hunt inv render surface: the overview embed and each focused-category
// builder. They are pure — a hunt-data object in, embeds out, no database — so
// they are tested directly, the way buildWeaponPages is in huntEmbedFields.
// Collapsing the old per-subcommand views into these builders (one /hunt inv
// with a category option) is what this covers.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { __test__ } = require('../src/commands/economy/hunt/inventory');
const { orderedWeapons, weaponsPages, ammoEmbed, consumablesEmbed, materialsPages, overviewEmbed, overviewPayload, inventoryStock } = __test__;
const { WEAPON_BY_TIER } = require('../src/data/huntData');

const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;

function weapon(tier, overrides = {}) {
    const def = WEAPON_BY_TIER[tier];
    return {
        tier,
        name: def.name,
        status: 'good',
        currentDurability: def.baseDurability,
        maxDurability: def.baseDurability,
        baseDurability: def.baseDurability,
        repairCount: 0,
        upgrade: null,
        ...overrides,
    };
}

// A hunt with something in every category, so the "has items" branch of each
// builder runs.
function fullHunt() {
    return {
        weapons: [weapon(2), weapon(3, { upgrade: 'scope', status: 'worn', currentDurability: 40 })],
        equippedWeaponIndex: 0,
        ammo: { iron_shot: 12, steel_shot: 3 },
        consumables: { premium_bait: 2, luck_charm: 1 },
        activeBait: 'premium_bait', activeBaitHuntsLeft: 3,
        activeCharm: 'luck_charm', activeCharmHuntsLeft: 1,
        activeFocus: true, activeXpScroll: true,
        materials: { rabbits_foot: 4, feather: 9 },
    };
}

const emptyHunt = () => ({
    weapons: [], equippedWeaponIndex: -1,
    ammo: {}, consumables: {}, materials: {},
    activeBait: null, activeCharm: null, activeFocus: false, activeXpScroll: false,
});

const interaction = { user: { username: 'Hunter' } };
const fieldsOf = embed => embed.data.fields ?? [];
const textOf = embed => JSON.stringify(embed.data);

describe('hunt inventory builders', () => {
    test('orderedWeapons puts the equipped weapon first and keeps original indices', () => {
        const h = fullHunt();
        h.equippedWeaponIndex = 1;
        const ordered = orderedWeapons(h);
        expect(ordered[0].index).toBe(1);
        expect(ordered.map(o => o.index).sort()).toEqual([0, 1]);
    });

    test('weaponsPages renders owned weapons and every field stays in budget', () => {
        const pages = weaponsPages(fullHunt());
        expect(pages.length).toBeGreaterThanOrEqual(1);
        for (const page of pages) {
            expect(page.data.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        }
        expect(pages[0].data.description).toContain('[EQUIPPED]');
    });

    test('weaponsPages tells an empty inventory where to buy one', () => {
        const pages = weaponsPages(emptyHunt());
        expect(pages).toHaveLength(1);
        expect(pages[0].data.description).toMatch(/shop weapon/);
    });

    test('ammoEmbed lists every ammo type and flags the equipped weapon feed', () => {
        const embed = ammoEmbed(fullHunt());
        expect(embed.data.description).toMatch(/Iron Shot/);
        expect(fieldsOf(embed).some(f => /Equipped Weapon Ammo/.test(f.name))).toBe(true);
    });

    test('consumablesEmbed shows stock and active buffs', () => {
        const embed = consumablesEmbed(fullHunt());
        const fields = fieldsOf(embed);
        expect(fields.some(f => f.name === 'In Stock' && f.value !== 'None')).toBe(true);
        expect(fields.some(f => /Active Buffs/.test(f.name))).toBe(true);
    });

    test('consumablesEmbed reports None for an empty stock', () => {
        const embed = consumablesEmbed(emptyHunt());
        expect(fieldsOf(embed).find(f => f.name === 'In Stock').value).toBe('None');
    });

    test('materialsPages lists materials, and reassures when there are none', () => {
        expect(materialsPages(fullHunt())[0].data.description).toMatch(/rabbit|feather/i);
        expect(materialsPages(emptyHunt())[0].data.description).toMatch(/No materials yet/);
    });

    test('overviewEmbed carries every section in one embed within field limits', () => {
        const embed = overviewEmbed(interaction, fullHunt());
        const names = fieldsOf(embed).map(f => f.name).join(' ');
        expect(names).toMatch(/Weapons/);
        expect(names).toMatch(/Ammo/);
        expect(names).toMatch(/Consumables/);
        expect(names).toMatch(/Materials/);
        for (const field of fieldsOf(embed)) {
            expect(field.value.length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
        }
    });

    test('overviewEmbed previews a long weapon list and points at the full view', () => {
        const h = fullHunt();
        h.weapons = Array.from({ length: 12 }, (_, i) => weapon(2, { name: `Rifle ${i}` }));
        h.equippedWeaponIndex = 0;
        const embed = overviewEmbed(interaction, h);
        expect(textOf(embed)).toMatch(/category:weapons/);
    });

    test('overviewEmbed handles a completely empty inventory', () => {
        const embed = overviewEmbed(interaction, emptyHunt());
        const weaponsField = fieldsOf(embed).find(f => /Weapons/.test(f.name));
        expect(weaponsField.value).toMatch(/shop weapon/);
    });

    test('inventoryStock maps held stock to art keys and skips empty stacks', () => {
        const { ammo, consumables, materials } = inventoryStock(fullHunt());
        for (const e of [...ammo, ...consumables, ...materials]) {
            expect(e.count).toBeGreaterThan(0);
            expect(e.iconId).toMatch(/^hunt:/);
        }
    });

    test('overviewPayload attaches the gun-rack card as the embed image', async () => {
        const payload = await overviewPayload(interaction, fullHunt());
        expect(payload.files).toHaveLength(1);
        expect(payload.files[0].name).toBe('hunt-inventory.png');
        expect(payload.embeds[0].toJSON().image.url).toBe('attachment://hunt-inventory.png');
    });

    test('overviewPayload renders an empty inventory too', async () => {
        const payload = await overviewPayload(interaction, emptyHunt());
        expect(payload.files).toHaveLength(1);
    });

    test('a huge material stock stays inside the field limit', () => {
        const h = fullHunt();
        h.materials = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`material_number_${i}`, 1000 + i]));
        for (const field of fieldsOf(overviewEmbed(interaction, h))) {
            expect(field.value.length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
        }
        expect(textOf(overviewEmbed(interaction, h))).toMatch(/…and \d+ more/);
    });
});
