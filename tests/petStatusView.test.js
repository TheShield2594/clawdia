'use strict';

// The /pet status-card view (issue #1082): the embed one pet renders into, its
// nav buttons, and the portrait art that rides with them. Split out of pet.js
// so the command file stays under its size cap — which means it needs its own
// coverage rather than riding on pet.js's tests.

jest.mock('../src/utils/itemImageHelper', () => ({
    getItemImageAttachment: jest.fn(),
}));
const { getItemImageAttachment } = require('../src/utils/itemImageHelper');
// The canvas itself is covered by tests/petStatusCard.test.js; here it is a
// stub, so these tests are about what the view does with a card or without one.
jest.mock('../src/utils/petStatusCard', () => ({ createPetStatusCard: jest.fn(async () => Buffer.from('card')) }));
const { createPetStatusCard } = require('../src/utils/petStatusCard');

const {
    HUNGER_BAR_LENGTH,
    hungerBar,
    petArt,
    buildPetEmbed,
    buildNavComponents,
    renderPetStatus,
    petCardOptions,
    cardAltText,
    buildPetCardEmbed,
} = require('../src/services/petStatusView');

const DAY = 86400000;

/** A pet with every field the card reads; overrides tweak one branch at a time. */
function makePet(overrides = {}) {
    return {
        petId: 'dog',
        name: 'Rex',
        personality: 'loyal',
        adoptedAt: new Date(Date.now() - 40 * DAY),
        // Friendly: its 1% passive boost rounds away at this level.
        bond: 20,
        lastFed: new Date(Date.now() - 2 * 3600000),
        lastDecayAt: new Date(),
        hunger: 80,
        level: 12,
        evolutionStage: 2,
        xp: 900,
        battleWins: 3,
        battleLosses: 1,
        potw: true,
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
        // Orange while it is asking but the bonus still holds, red once it lapses.
        expect(hungerBar(45)).toContain('🟧');
        expect(hungerBar(30)).toContain('🟧');
        expect(hungerBar(29)).toContain('🟥');
    });

    test('clamps junk input to 0', () => {
        expect(hungerBar(NaN)).toMatch(/ 0%$/);
        expect(hungerBar(999)).toMatch(/ 100%$/);
    });
});

describe('buildPetEmbed', () => {
    test('a fed POTW pet renders an active bonus, its move, its training and a thumbnail', () => {
        const json = buildPetEmbed(makePet(), 0, 2, 'https://avatar', 'attachment://pet.png').toJSON();
        expect(json.author.name).toContain('Dog');
        expect(json.thumbnail.url).toBe('attachment://pet.png');
        expect(json.description).toContain('🌟'); // POTW line
        expect(json.description).not.toContain('Resting');
        expect(json.fields.find(f => f.name.includes('Signature Move')).value).toBe('**Stand Firm** — Sometimes braces and shrugs off a quarter of a hit.');
        expect(json.fields.find(f => f.name.includes('Training')).value).toBe('Untrained — use the Train buttons below');
        const bonus = json.fields.find(f => f.name.startsWith('✅'));
        expect(bonus).toBeTruthy();
        expect(json.footer.text).toContain('Pet 1 of 2');
    });

    test('a starving pet with no personality marks the bonus inactive and sets no thumbnail', () => {
        const json = buildPetEmbed(
            makePet({ hunger: 0, lastFed: new Date(Date.now() - 30 * DAY), lastDecayAt: new Date(Date.now() - 30 * DAY), personality: null, potw: false }),
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
        expect(rows).toHaveLength(2); // the action row and the training row
        const ids = rows.flatMap(r => r.toJSON().components.map(c => c.custom_id));
        expect(ids).toEqual(['pet_play:u1:0', 'pet_showcase:u1:0', 'pet_train_power:u1:0', 'pet_train_guard:u1:0', 'pet_train_agility:u1:0']);
    });

    test("the action buttons carry the pet's id when given one", () => {
        const ids = buildNavComponents('u1', 2, 3, 'abc123').slice(1).flatMap(r => r.toJSON().components.map(c => c.custom_id));
        expect(ids).toEqual([
            'pet_play:u1:2:abc123', 'pet_showcase:u1:2:abc123',
            'pet_train_power:u1:2:abc123', 'pet_train_guard:u1:2:abc123', 'pet_train_agility:u1:2:abc123',
        ]);
    });

    test('given the pet, each Train button shows its sessions and a maxed one is disabled (#1182)', () => {
        const train = buildNavComponents('u1', 0, 1, 'p', { training: { power: 3, guard: 10 } })[1].toJSON().components;
        expect(train.map(b => b.label)).toEqual(['💪 Train Power 3/10', '🛡️ Train Guard 10/10', '💨 Train Agility 0/10']);
        expect(train.map(b => !!b.disabled)).toEqual([false, true, false]);
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

    test('renderPetStatus leads with the companion card, every number still in the text', async () => {
        const payload = await renderPetStatus(makePet(), 0, 2, 'https://avatar', 'g1', 'u1', 'TheShield');

        expect(payload.files).toHaveLength(1);
        expect(payload.files[0].name).toBe('pet-card.png');
        expect(payload.files[0].description)
            .toBe('Companion card for Seasoned Rex, a level 12 loyal Dog, Pet of the Week: hunger 80%, bond friendly 20/100, '
                + 'passive +9.2% work earnings active, signature move Stand Firm, record 3 wins and 1 loss.');
        expect(payload.attachments).toEqual([]);
        const json = payload.embeds[0].toJSON();
        expect(json.image.url).toBe('attachment://pet-card.png');
        expect(json.thumbnail).toBeUndefined();
        expect(json.description).toMatch(/📈 Lv \*\*\d+\*\*/);
        expect(json.description).toContain('Favourite food `rabbits_foot`');
        expect(json.description).toContain('🌀 **Stand Firm**');
        expect(json.description).toContain('🏋️ Untrained');
        expect(json.footer.text).toMatch(/^Pet 1 of 2 • Last fed/);
        expect(createPetStatusCard).toHaveBeenCalledWith(expect.objectContaining({
            kicker: "TheShield's companion", footerLeft: 'Pet 1 of 2',
        }));
        // The card is drawn from the bundled portrait, not a per-guild lookup.
        expect(getItemImageAttachment).not.toHaveBeenCalled();
    });

    test('renderPetStatus attaches the portrait when the card cannot be drawn', async () => {
        createPetStatusCard.mockRejectedValueOnce(new Error('no canvas'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const attachment = { name: 'item-pet_dog.png' };
        getItemImageAttachment.mockResolvedValue({ attachment, url: 'attachment://item-pet_dog.png' });
        const payload = await renderPetStatus(makePet(), 0, 2, 'https://avatar', 'g1', 'u1');
        expect(payload.files).toEqual([attachment]);
        expect(payload.attachments).toEqual([]);
        expect(payload.embeds[0].toJSON().thumbnail.url).toBe('attachment://item-pet_dog.png');
        expect(payload.components.length).toBeGreaterThan(0);
    });

    test('renderPetStatus falls back to no files when neither card nor art is available', async () => {
        createPetStatusCard.mockRejectedValueOnce(new Error('no canvas'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        getItemImageAttachment.mockResolvedValue(null);
        const payload = await renderPetStatus(makePet({ name: null }), 0, 1, 'https://avatar', 'g1', 'u1');
        expect(payload.files).toEqual([]);
        expect(payload.embeds[0].toJSON().thumbnail).toBeUndefined();
    });
});

describe('petCardOptions', () => {
    test('reads the pet the way the text does', () => {
        const now = Date.now();
        const o = petCardOptions(makePet({ personality: 'mischievous', level: 12, evolutionStage: 2, potw: true }),
            { kicker: 'K', footerLeft: 'L', footerRight: 'R' }, now);

        expect(o).toEqual(expect.objectContaining({
            petId: 'dog', iconId: 'pet:dog', kicker: 'K', titledName: 'Seasoned Rex', species: 'Dog',
            personality: 'Mischievous', rare: false, potw: true, stage: 2, stageName: 'Stage 2 - Seasoned',
            level: 12, maxed: false, threshold: 30, footerLeft: 'L', footerRight: 'R',
        }));
        expect(o.boosted.sort()).toEqual(['atk', 'crit']);
        expect(o.stats.crit).toBeCloseTo(0.2);
        expect(o.bonus).toEqual({ pct: expect.any(Number), unit: '%', label: 'work earnings', active: true });
    });

    test('XP past the level is clamped, never printed as more than the level needs', () => {
        const o = petCardOptions(makePet({ level: 17, xp: 999_999, evolutionStage: 2 }), { kicker: 'K' });
        expect(o.xpInLevel).toBe(o.xpToNext);
    });

    test('a rare companion at max level is flagged as such', () => {
        const o = petCardOptions(makePet({ petId: 'lantern_owl', level: 30, evolutionStage: 3 }), { kicker: 'K' });
        expect(o.rare).toBe(true);
        expect(o.maxed).toBe(true);
        expect(o.xpToNext).toBe(0);
    });

    test('the alt text names the pet and its state', () => {
        const o = petCardOptions(makePet({ potw: false, hunger: 10, battleWins: 1, battleLosses: 0 }), { kicker: 'K' });
        expect(cardAltText(o)).toMatch(/^Companion card for Seasoned Rex, a level 12 loyal Dog: hunger \d+%, bond friendly \d+\/100, passive \+9\.2% work earnings inactive, signature move Stand Firm, record 1 win and 0 losses\.$/);
    });

    test('training and the move reach the card (#1182, #1183)', () => {
        const o = petCardOptions(makePet({ petId: 'wolf', training: { power: 5, agility: 4 } }), { kicker: 'K' });
        expect(o.move).toBe('Pack Howl');
        expect(o.trained).toEqual({ atk: '+2%', spd: '+12%', crit: '+2 pts' });
        expect(o.stats.crit).toBeCloseTo(0.10 + 0.02, 6); // base 10%, +2 pts from four Agility sessions
    });
});

// #1181: a fed pet on vacation earns nothing, so no part of the view may say
// its passive is on — nor tell the owner to feed it to turn the passive back on.
describe('a pet on vacation', () => {
    const away = () => makePet({ hunger: 90, vacationFrom: new Date(Date.now() - DAY), vacationUntil: new Date(Date.now() + DAY) });

    test('the text card shows the passive as inactive and says why', () => {
        const json = buildPetEmbed(away(), 0, 1, null).toJSON();
        const bonus = json.fields.find(f => f.name.includes('Bonus'));
        expect(bonus.name).toContain('❌');
        expect(bonus.value).toContain('*(inactive)*');
        expect(json.description).toContain('On vacation');
    });

    test('the companion card and its embed agree', () => {
        expect(petCardOptions(away(), { kicker: 'x' }).bonus.active).toBe(false);
        const text = buildPetCardEmbed(away(), 0, 1, null, 'pet-card.png').toJSON().description;
        expect(text).toContain('❌');
        expect(text).not.toContain('feed above');
        expect(text).toContain('On vacation');
    });
});
