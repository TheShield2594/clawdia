'use strict';

// The /fish inv overview: a text embed plus the tackle-box card. The builders
// are pure — fishing data in, payload out — so they are tested directly. Every
// number the card draws has to be in the embed text too (#672).

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { __test__ } = require('../src/commands/economy/fish/profile');
const { overviewEmbed, overviewPayload, inventoryStock } = __test__;

const interaction = { user: { username: 'munge' } };

function fullUser() {
    return {
        fishing: {
            rods: [
                { name: 'Bamboo Rod', tier: 1, slug: 'bamboo_rod', currentDurability: 80, maxDurability: 80, status: 'good' },
                { name: 'Crystal Rod', tier: 5, currentDurability: 52, maxDurability: 240, status: 'degraded', upgrade: 'polarized_lens' },
            ],
            equippedRodIndex: 1,
            bait: { worm_bait: 40, lure: 0 },
            consumables: { chum_bait: 3, mystery_thing: 2 },
            materials: { fish_scale: 24, pearl: 1 },
            activeBait: 'chum_bait', activeBaitCastsLeft: 2, activeLuck: true,
        },
        hunt: { materials: { rabbits_foot: 2 } },
    };
}

const emptyUser = () => ({ fishing: { rods: [], equippedRodIndex: 0, bait: {}, consumables: {}, materials: {} } });

const fieldText = embed => embed.toJSON().fields.map(f => `${f.name}\n${f.value}`).join('\n');

describe('/fish inv overview', () => {
    test('inventoryStock maps held items to art keys and skips empty stacks', () => {
        const { bait, consumables, materials } = inventoryStock(fullUser());
        expect(bait).toEqual([{ iconId: 'fish:worm_bait_pack', name: 'Worm Bait', count: 40 }]);
        expect(consumables.map(c => c.iconId)).toEqual(['fish:chum_bait', null]);
        expect(materials.map(m => m.name)).toEqual(['Fish Scale', 'Pearl', "Rabbit's Foot"]);
        expect(materials.at(-1)).toMatchObject({ iconId: null, source: 'hunt' });
    });

    test('the text carries every count the card draws, without per-item emoji', () => {
        const text = fieldText(overviewEmbed(interaction, fullUser()));
        for (const s of ['Crystal Rod · **equipped**', '52/240', 'Polarized Lens', 'Worm Bait ×40', 'Chum Bait ×3',
            'Fish Scale ×24', 'Pearl ×1', "Rabbit's Foot (hunt) ×2", 'Chum Bait (2 casts left)', "Angler's Luck queued"]) {
            expect(text).toContain(s);
        }
        expect(text).not.toMatch(/🪱 \*\*|🐟 Chum|\[E\]/);
    });

    test('the payload attaches the card as the embed image', async () => {
        const payload = await overviewPayload(interaction, fullUser());
        expect(payload.files).toHaveLength(1);
        expect(payload.files[0].name).toBe('fish-inventory.png');
        expect(payload.files[0].description).toContain('Crystal Rod 52 of 240 (equipped)');
        expect(payload.embeds[0].toJSON().image.url).toBe('attachment://fish-inventory.png');
    });

    test('an empty inventory still renders', async () => {
        const payload = await overviewPayload(interaction, emptyUser());
        expect(payload.files).toHaveLength(1);
        expect(fieldText(payload.embeds[0])).toContain('None — buy one with `/fish shop rod`');
    });
});
