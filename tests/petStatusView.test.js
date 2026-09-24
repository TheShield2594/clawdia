'use strict';

// The /pet status-card view (issue #1082): the embed one pet renders into, its
// nav buttons, and the portrait art that rides with them. Split out of pet.js
// so the command file stays under its size cap — which means it needs its own
// coverage rather than riding on pet.js's tests.

jest.mock('../src/utils/itemImageHelper', () => ({
    getItemImageAttachment: jest.fn(),
}));
const { getItemImageAttachment } = require('../src/utils/itemImageHelper');

const {
    HUNGER_BAR_LENGTH,
    hungerBar,
    petArt,
    buildPetEmbed,
    buildNavComponents,
    renderPetStatus,
} = require('../src/services/petStatusView');

const DAY = 86400000;

/** A pet with every field the card reads; overrides tweak one branch at a time. */
function makePet(overrides = {}) {
    return {
        petId: 'dog',
        name: 'Rex',
        personality: 'loyal',
        adoptedAt: new Date(Date.now() - 40 * DAY),
        lastFed: new Date(Date.now() - 2 * 3600000),
        lastDecayAt: new Date(),
        hunger: 80,
        level: 12,
        evolutionStage: 2,
        xp: 900,
        battleWins: 3,
        battleLosses: 1,
        potw: true,
        restUntil: new Date(Date.now() + 3600000),
        ...overrides,
    };
}

describe('hungerBar', () => {
    test('renders a full-length bar ending in a percentage', () => {
        const bar = hungerBar(80);
        // One cell per HUNGER_BAR_LENGTH, plus the trailing " NN%".
        expect([...bar].filter(c => c === '🟩' || c === '🟥' || c === '⬛')).toHaveLength(HUNGER_BAR_LENGTH);
        expect(bar).toMatch(/ 80%$/);
    });

    test('is green when fed and red when starving', () => {
        expect(hungerBar(90)).toContain('🟩');
        expect(hungerBar(5)).toContain('🟥');
    });

    test('clamps junk input to 0', () => {
        expect(hungerBar(NaN)).toMatch(/ 0%$/);
        expect(hungerBar(999)).toMatch(/ 100%$/);
    });
});

describe('buildPetEmbed', () => {
    test('a fed, resting, POTW pet renders an active bonus and a thumbnail', () => {
        const json = buildPetEmbed(makePet(), 0, 2, 'https://avatar', 'attachment://pet.png').toJSON();
        expect(json.author.name).toContain('Dog');
        expect(json.thumbnail.url).toBe('attachment://pet.png');
        expect(json.description).toContain('🌟'); // POTW line
        expect(json.description).toContain('Resting');
        const bonus = json.fields.find(f => f.name.startsWith('✅'));
        expect(bonus).toBeTruthy();
        expect(json.footer.text).toContain('Pet 1 of 2');
    });

    test('a starving pet with no personality marks the bonus inactive and sets no thumbnail', () => {
        const json = buildPetEmbed(
            makePet({ hunger: 0, lastFed: new Date(Date.now() - 30 * DAY), lastDecayAt: new Date(Date.now() - 30 * DAY), personality: null, potw: false, restUntil: null }),
            0, 1, 'https://avatar',
        ).toJSON();
        expect(json.fields.find(f => f.name.startsWith('❌'))).toBeTruthy();
        expect(json.thumbnail).toBeUndefined();
    });

    test('a max-level pet shows (MAX) and a just-fed footer', () => {
        const json = buildPetEmbed(
            makePet({ level: 30, evolutionStage: 3, xp: 999999, lastFed: new Date() }),
            0, 1, 'https://avatar',
        ).toJSON();
        expect(json.fields.find(f => f.value.includes('(MAX)'))).toBeTruthy();
        expect(json.footer.text).toContain('just now');
    });

    test('an unknown species falls back rather than throwing', () => {
        const json = buildPetEmbed(makePet({ petId: 'nonesuch', name: null }), 0, 1, 'https://avatar').toJSON();
        // Favourite-food line has no definition to draw from.
        expect(json.fields.find(f => f.name.includes('Favourite Food')).value).toBe('—');
    });

    test('a day-old feeding reads as days ago', () => {
        const json = buildPetEmbed(makePet({ lastFed: new Date(Date.now() - 3 * DAY) }), 0, 1, 'https://avatar').toJSON();
        expect(json.footer.text).toMatch(/Last fed \d+d ago/);
    });
});

describe('buildNavComponents', () => {
    test('a single pet gets no prev/next row', () => {
        const rows = buildNavComponents('u1', 0, 1);
        expect(rows).toHaveLength(1); // just the action row
        const ids = rows[0].toJSON().components.map(c => c.custom_id);
        expect(ids).toEqual(['pet_play:u1:0', 'pet_rest:u1:0', 'pet_showcase:u1:0']);
    });

    test("the action buttons carry the pet's id when given one", () => {
        const ids = buildNavComponents('u1', 2, 3, 'abc123')[1].toJSON().components.map(c => c.custom_id);
        expect(ids).toEqual(['pet_play:u1:2:abc123', 'pet_rest:u1:2:abc123', 'pet_showcase:u1:2:abc123']);
    });

    test('multiple pets get a nav row, with the ends disabled at the ends', () => {
        const first = buildNavComponents('u1', 0, 3)[0].toJSON().components;
        expect(first[0].disabled).toBe(true);  // prev at index 0
        expect(first[1].disabled).toBe(false); // next
        const last = buildNavComponents('u1', 2, 3)[0].toJSON().components;
        expect(last[0].disabled).toBe(false);
        expect(last[1].disabled).toBe(true);   // next at the last index
    });
});

describe('petArt / renderPetStatus', () => {
    beforeEach(() => getItemImageAttachment.mockReset());

    test('petArt asks for the pet namespace key', async () => {
        getItemImageAttachment.mockResolvedValue({ attachment: {}, url: 'attachment://a.png' });
        const art = await petArt('crystal_fox', 'g1', 'Sparkle');
        expect(getItemImageAttachment).toHaveBeenCalledWith('pet:crystal_fox', 'g1', { label: 'Sparkle' });
        expect(art.url).toBe('attachment://a.png');
    });

    test('petArt swallows a lookup error into null', async () => {
        getItemImageAttachment.mockRejectedValue(new Error('boom'));
        expect(await petArt('dog', 'g1', 'Rex')).toBeNull();
    });

    test('renderPetStatus attaches the portrait when art exists', async () => {
        const attachment = { name: 'item-pet_dog.png' };
        getItemImageAttachment.mockResolvedValue({ attachment, url: 'attachment://item-pet_dog.png' });
        const payload = await renderPetStatus(makePet(), 0, 2, 'https://avatar', 'g1', 'u1');
        expect(payload.files).toEqual([attachment]);
        expect(payload.attachments).toEqual([]);
        expect(payload.embeds[0].toJSON().thumbnail.url).toBe('attachment://item-pet_dog.png');
        expect(payload.components.length).toBeGreaterThan(0);
    });

    test('renderPetStatus falls back to no files when no art ships', async () => {
        getItemImageAttachment.mockResolvedValue(null);
        const payload = await renderPetStatus(makePet({ name: null }), 0, 1, 'https://avatar', 'g1', 'u1');
        expect(payload.files).toEqual([]);
        expect(payload.embeds[0].toJSON().thumbnail).toBeUndefined();
    });
});
