'use strict';

// The companion card's canvas (utils/petStatusCard.js), drawn for real: that it
// produces a PNG of the right size for every species and for the awkward edges
// (no art, no passive, max level, an empty hunger bar, very long names), and
// that nothing a canvas cannot draw reaches it.

const { loadImage } = require('canvas');
const { createPetStatusCard, CARD_W, CARD_H, SPECIES_ACCENT, __test__: { plain } } = require('../src/utils/petStatusCard');
const { PET_DEFINITIONS } = require('../src/services/petService');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function options(overrides = {}) {
    return {
        petId: 'wolf', iconId: 'pet:wolf', kicker: "TheShield's companion", titledName: 'Apex Ghost',
        species: 'Wolf', personality: 'Loyal', rare: false, potw: false, stage: 3, stageName: 'Stage 3 - Apex',
        level: 24, maxed: false, xpInLevel: 340, xpToNext: 520, hunger: 72, threshold: 30, moodColor: '#cddc39',
        bond: 42, bondMax: 100, bondTitle: 'Trusted', bondFrame: '#cd7f32', bonus: { pct: 22.5, label: 'hunt yield', active: true },
        stats: { hp: 214, atk: 71, def: 38, spd: 29, crit: 0.1 }, boosted: ['hp', 'def'],
        record: { wins: 18, losses: 4, pvpWins: 5, pvpLosses: 2 },
        action: 'a low, contented rumble', quote: '"Life\'s pretty chill right now, honestly."',
        footerLeft: 'Pet 1 of 3', footerRight: 'Last fed 3h ago',
        ...overrides,
    };
}

async function expectCard(buffer) {
    expect(buffer.subarray(0, 4)).toEqual(PNG_MAGIC);
    const img = await loadImage(buffer);
    expect([img.width, img.height]).toEqual([CARD_W, CARD_H]);
}

describe('createPetStatusCard', () => {
    test('every ownable species has its own colour and draws a card', async () => {
        for (const petId of Object.keys(PET_DEFINITIONS)) {
            expect([petId, Boolean(SPECIES_ACCENT[petId])]).toEqual([petId, true]);
            await expectCard(await createPetStatusCard(options({ petId, iconId: `pet:${petId}` })));
        }
    });

    test('the awkward edges still draw: no art, no passive, max level, empty hunger, long name, POTW and rare', async () => {
        await expectCard(await createPetStatusCard(options({
            petId: 'nonesuch', iconId: null, species: 'Nonesuch', personality: null,
            bonus: null, maxed: true, level: 30, xpInLevel: 0, xpToNext: 0, hunger: 0, bond: 0, bondTitle: null, bondFrame: null,
            titledName: 'Seasoned Sir Reginald Fluffington the Third of Somewhere', potw: true, rare: true,
            stats: {}, record: {}, action: null, footerLeft: null, footerRight: null,
        })));
    });

    test('a ladder title draws as the ribbon, however long (#1185)', async () => {
        await expectCard(await createPetStatusCard(options({ ladderTitle: 'S12 Ladder Runner-Up' })));
        await expectCard(await createPetStatusCard(options({ ladderTitle: 'S3 Ladder Champion', rare: true })));
    });

    test('out-of-range numbers are clamped rather than thrown on', async () => {
        await expectCard(await createPetStatusCard(options({ hunger: 250, stage: 9, xpInLevel: 900, xpToNext: 100, bond: 5000 })));
        await expectCard(await createPetStatusCard(options({ hunger: -5, stage: 0, xpInLevel: 0, xpToNext: 0 })));
    });
});

describe('plain', () => {
    test('strips emoji, joiners and Discord formatting, which a canvas cannot draw', () => {
        expect(plain('🐕‍🦺 **Rex** the ~~good~~ _boy_')).toBe('Rex the good boy');
        expect(plain('"*stares at you with big, hollow eyes*"')).toBe('"stares at you with big, hollow eyes"');
        expect(plain(null)).toBe('');
    });
});
