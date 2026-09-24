'use strict';

/**
 * #998 — /pet status, driven end to end: the status card, its prev/next
 * navigation, and the play / rest / showcase buttons, each of which re-reads the
 * player and writes back through the shared fakeCollection store.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, pets: [], deceasedPets: [], inventory: [], paidPayouts: [], level: 1, xp: 0,
});
mockUsers.model.DECEASED_PET_LIMIT = 5;
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async user => user) }));
jest.mock('../src/utils/itemImageHelper', () => ({ getItemImageAttachment: jest.fn(async () => null) }));
jest.mock('../src/utils/cardGenerator', () => ({ generatePetSprite: jest.fn(async () => Buffer.from('png')) }));
jest.mock('../src/utils/petStatusCard', () => ({ createPetStatusCard: jest.fn(async () => Buffer.from('card')) }));
jest.mock('../src/services/questService', () => ({
    onPetCare: jest.fn(async () => ({ completed: [] })),
    notifyQuestComplete: jest.fn(async () => {}),
}));
jest.mock('../src/services/achievementService', () => ({
    checkAndAward: jest.fn(async () => []),
    announceAchievements: jest.fn(async () => {}),
}));
jest.mock('../src/services/levelingService', () => ({
    ...jest.requireActual('../src/services/levelingService'),
    announceLevelUp: jest.fn(async () => {}),
}));

const pet = require('../src/commands/economy/pet');
const { generatePetSprite } = require('../src/utils/cardGenerator');
const { createPetStatusCard } = require('../src/utils/petStatusCard');
const { announceLevelUp } = require('../src/services/levelingService');
const { xpForLevel, REST_DURATION_MS } = require('../src/services/petService');

const GUILD = 'guild-1';
const USER = 'user-1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const stored = () => mockUsers.get(USER);

const makePet = (overrides = {}) => ({
    _id: `pet-${overrides.petId ?? 'dog'}`,
    petId: 'dog',
    name: null,
    hunger: 80,
    lastFed: new Date(),
    lastDecayAt: new Date(),
    adoptedAt: new Date(Date.now() - 10 * DAY),
    starving: false,
    starvingStartAt: null,
    personality: 'loyal',
    level: 1,
    xp: 0,
    evolutionStage: 1,
    ...overrides,
});

const seedUser = (fields = {}) => mockUsers.seed({ userId: USER, guildId: GUILD, ...fields });

const textOf = interaction => interaction.replies
    .map(p => (typeof p === 'string' ? p : repliedText({ replies: [p] })))
    .join('\n');

/** Opens /pet status with its collector held open, so buttons can be pressed in order. */
async function openStatus() {
    const interaction = makeInteraction({ subcommand: 'status', holdCollectors: true });
    await pet.execute(interaction);
    return interaction;
}

const btn = (action, idx) => ({ customId: `pet_${action}:${USER}:${idx}` });

/** The component interaction a press produced, for reading its own replies. */
async function press(interaction, action, idx, extra = {}) {
    const before = interaction.replies.length;
    const i = await interaction.press({ ...btn(action, idx), ...extra });
    return { i, shown: interaction.replies.slice(before) };
}

/** Makes the next `User.findOne` hand back a document whose save throws `err`. */
function failNextFreshSave(err) {
    const real = mockUsers.model.findOne.getMockImplementation();
    mockUsers.model.findOne.mockImplementationOnce((...args) => {
        const query = real(...args);
        return query.then(doc => {
            if (doc) doc.save = jest.fn(async () => { throw err; });
            return doc;
        });
    });
}

const versionError = () => Object.assign(new Error('stale'), { name: 'VersionError' });

beforeEach(() => {
    jest.clearAllMocks();
    mockUsers.reset();
    mockGuilds.reset();
    mockGuilds.seed({ guildId: GUILD, economy: { enabled: true } });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('/pet status card', () => {
    test('with no pets it points at adopt', async () => {
        seedUser();

        const interaction = await openStatus();

        expect(textOf(interaction)).toContain('You have no pets. Use `/pet adopt` to get one!');
    });

    test("renders the first pet with the owner's buttons and saves the decayed hunger", async () => {
        seedUser({ pets: [makePet({ name: 'Rex', lastDecayAt: new Date(Date.now() - DAY) })] });

        const interaction = await openStatus();

        const card = interaction.replies.at(-1);
        expect(card.embeds).toHaveLength(1);
        expect(repliedText({ replies: [card] })).toContain('Pet 1 of 1');
        expect(card.components.flatMap(r => r.components.map(c => c.data.custom_id)))
            .toEqual([`pet_play:${USER}:0:pet-dog`, `pet_rest:${USER}:0:pet-dog`, `pet_showcase:${USER}:0:pet-dog`]);
        // A day of decay at 10/day, written back by the status save.
        expect(stored().pets[0].hunger).toBeCloseTo(70, 3);
    });

    test('a failed save is reported rather than rendering a card that was not persisted', async () => {
        seedUser({ pets: [makePet()] });
        const real = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate.mockImplementationOnce(async (...args) => {
            const doc = await real(...args);
            doc.save = jest.fn(async () => { throw new Error('disk full'); });
            return doc;
        });

        const interaction = await openStatus();

        expect(textOf(interaction)).toContain('Something went wrong updating your pets. Please try again.');
    });

    test('closing the window disables every button', async () => {
        seedUser({ pets: [makePet(), makePet({ _id: 'p2', petId: 'cat' })] });

        const interaction = await openStatus();
        interaction.endCollectors();
        await new Promise(r => setImmediate(r));

        const last = interaction.replies.at(-1);
        const buttons = last.components.flatMap(r => r.components);
        expect(buttons).toHaveLength(5);
        expect(buttons.every(b => b.data.disabled === true)).toBe(true);
    });

    test('next and prev page through the roster and clamp at the ends', async () => {
        seedUser({ pets: [makePet({ name: 'First' }), makePet({ _id: 'p2', petId: 'cat', name: 'Second' })] });
        const interaction = await openStatus();

        const next = await press(interaction, 'next', 0);
        expect(next.i.update).toHaveBeenCalledTimes(1);
        expect(repliedText({ replies: next.shown })).toContain('Pet 2 of 2');

        const pastEnd = await press(interaction, 'next', 1);
        expect(repliedText({ replies: pastEnd.shown })).toContain('Pet 2 of 2');

        const prev = await press(interaction, 'prev', 1);
        expect(repliedText({ replies: prev.shown })).toContain('Pet 1 of 2');

        const pastStart = await press(interaction, 'prev', 0);
        expect(repliedText({ replies: pastStart.shown })).toContain('Pet 1 of 2');
    });

    test("a pet that is no longer there says so", async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        const { i } = await press(interaction, 'play', 3);

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Pet not found.' }));
    });

    test("another member's click is turned away", async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        const delivered = await interaction.press({ ...btn('play', 0), user: 'someone-else' });

        expect(delivered).toBeNull();
        expect(stored().pets[0].lastPlay).toBeUndefined();
    });
});

describe('/pet status — play', () => {
    test('awards player XP and pet XP and records the interaction', async () => {
        seedUser({ pets: [makePet({ name: 'Rex' })] });
        const interaction = await openStatus();

        const { i } = await press(interaction, 'play', 0);

        // 15 + floor(0.5 * 11) = 20 player XP; a dog grants no XP bonus.
        expect(stored().xp).toBe(20);
        expect(stored().pets[0].xp).toBe(10);
        expect(stored().pets[0].weeklyInteractions).toBe(1);
        expect(stored().pets[0].lastPlay).toBeInstanceOf(Date);
        expect(i.reply.mock.calls[0][0].content).toBe('🎾 You played with **Rex**! They loved it.\n✨ **+20 XP** for you, **+10 XP** for Rex!');
        expect(announceLevelUp).not.toHaveBeenCalled();
    });

    test('player XP from Play is once an hour across all pets; the pet still gets its XP', async () => {
        seedUser({ pets: [
            makePet({ petId: 'dog', lastPlay: new Date(Date.now() - 10 * 60_000) }),
            makePet({ petId: 'cat', name: 'Tom' }),
        ] });
        const interaction = await openStatus();

        const i = await interaction.press({ customId: `pet_play:${USER}:1:pet-cat` });

        expect(stored().xp).toBe(0);
        expect(stored().pets[1].xp).toBe(10);
        expect(i.reply.mock.calls[0][0].content)
            .toBe("🎾 You played with **Tom**! They loved it.\n✨ **+10 XP** for Tom! *(You've had your play XP for this hour.)*");
    });

    test('a player level-up and a pet level-up are both announced', async () => {
        seedUser({ level: 1, xp: 1_000_000, pets: [makePet({ xp: xpForLevel(2) - 5 })] });
        const interaction = await openStatus();

        const { i } = await press(interaction, 'play', 0);

        expect(stored().level).toBeGreaterThan(1);
        expect(stored().pets[0].level).toBe(2);
        const content = i.reply.mock.calls[0][0].content;
        expect(content).toMatch(/Level up! You're now level \d+!/);
        expect(content).toContain('Dog reached pet Level 2!');
        expect(announceLevelUp).toHaveBeenCalledTimes(1);
    });

    test('an evolution is announced by its new title', async () => {
        seedUser({ pets: [makePet({ level: 9, xp: xpForLevel(10) - 5 })] });
        const interaction = await openStatus();

        const { i } = await press(interaction, 'play', 0);

        expect(stored().pets[0].evolutionStage).toBe(2);
        expect(i.reply.mock.calls[0][0].content).toContain('Dog evolved to Seasoned Dog!');
    });

    test('is refused within the hour after the last play', async () => {
        seedUser({ pets: [makePet({ lastPlay: new Date(Date.now() - 20 * 60_000) })] });
        const interaction = await openStatus();

        const { i } = await press(interaction, 'play', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('🎾 **Dog** is tired from playing! Try again in **40m**.');
        expect(stored().xp).toBe(0);
    });

    test('a lost version race asks for a retry', async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        failNextFreshSave(versionError());
        const { i } = await press(interaction, 'play', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('⚠️ Action conflict — please try again.');
        expect(stored().xp).toBe(0);
    });

    test('any other save failure is reported', async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        failNextFreshSave(new Error('disk full'));
        const { i } = await press(interaction, 'play', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('❌ Failed to save. Please try again.');
    });
});

describe('/pet status — rest', () => {
    test('puts the pet to rest for two hours', async () => {
        seedUser({ pets: [makePet({ name: 'Rex' })] });
        const interaction = await openStatus();
        const before = Date.now();

        const { i } = await press(interaction, 'rest', 0);

        const until = stored().pets[0].restUntil.getTime();
        expect(until).toBeGreaterThanOrEqual(before + REST_DURATION_MS);
        expect(until).toBeLessThanOrEqual(Date.now() + REST_DURATION_MS);
        expect(stored().pets[0].weeklyInteractions).toBe(1);
        expect(i.reply.mock.calls[0][0].content).toBe('🛏️ **Rex** is now resting! Hunger will decay at half speed for **2 hours**.');
    });

    test('a pet already resting is refused with the time left', async () => {
        seedUser({ pets: [makePet({ restUntil: new Date(Date.now() + 30 * 60_000) })] });
        const interaction = await openStatus();

        const { i } = await press(interaction, 'rest', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('🛏️ **Dog** is already resting! 30m remaining.');
        expect(stored().pets[0].weeklyInteractions).toBeUndefined();
    });

    test('a lost version race asks for a retry', async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        failNextFreshSave(versionError());
        const { i } = await press(interaction, 'rest', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('⚠️ Action conflict — please try again.');
        expect(stored().pets[0].restUntil).toBeUndefined();
    });

    test('any other save failure is reported', async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        failNextFreshSave(new Error('disk full'));
        const { i } = await press(interaction, 'rest', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('❌ Failed to save. Please try again.');
    });
});

describe('/pet status — showcase', () => {
    test('posts the companion card publicly and counts the interaction', async () => {
        seedUser({ pets: [makePet({ name: 'Rex', potw: true })] });
        const interaction = await openStatus();

        const { i } = await press(interaction, 'showcase', 0);

        const payload = i.reply.mock.calls[0][0];
        const embed = payload.embeds[0].data;
        expect(embed.title).toBe('🐶 Rex');
        expect(embed.author.name).toBe('Owned by player');
        expect(embed.description).toContain('🌟 **Pet of the Week**');
        expect(embed.fields.map(f => f.name)).toEqual(['❤️ Bond', '🍖 Hunger', '✅ Bonus']);
        expect(embed.fields[0].value).toMatch(/ 10d$/);
        expect(embed.image.url).toBe('attachment://pet-showcase.png');
        expect(embed.thumbnail).toBeUndefined();
        expect(payload.files.map(f => f.name)).toEqual(['pet-showcase.png']);
        expect(createPetStatusCard).toHaveBeenLastCalledWith(expect.objectContaining({ kicker: 'Showcased by player', footerLeft: 'Showcase' }));
        expect(generatePetSprite).not.toHaveBeenCalled();
        expect(stored().pets[0].weeklyInteractions).toBe(1);
    });

    test('falls back to the sprite when the card cannot be drawn', async () => {
        seedUser({ pets: [makePet({ name: 'Rex' })] });
        const interaction = await openStatus();

        createPetStatusCard.mockRejectedValueOnce(new Error('no canvas'));
        const { i } = await press(interaction, 'showcase', 0);

        const payload = i.reply.mock.calls[0][0];
        expect(payload.embeds[0].data.thumbnail.url).toBe('attachment://pet_sprite.png');
        expect(payload.files).toHaveLength(1);
    });

    test('a hungry pet shows its bonus as off, and with no card and no sprite nothing is attached', async () => {
        seedUser({ pets: [makePet({ hunger: 10 })] });
        generatePetSprite.mockRejectedValueOnce(new Error('no canvas'));
        const interaction = await openStatus();
        createPetStatusCard.mockRejectedValueOnce(new Error('no canvas'));

        const { i } = await press(interaction, 'showcase', 0);

        const payload = i.reply.mock.calls[0][0];
        expect(payload.embeds[0].data.fields[2].name).toBe('❌ Bonus');
        expect(payload.embeds[0].data.thumbnail).toBeUndefined();
        expect(payload.files).toEqual([]);
    });

    test('a lost version race asks for a retry', async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        failNextFreshSave(versionError());
        const { i } = await press(interaction, 'showcase', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('⚠️ Action conflict — please try again.');
    });

    test('any other save failure is reported', async () => {
        seedUser({ pets: [makePet()] });
        const interaction = await openStatus();

        failNextFreshSave(new Error('disk full'));
        const { i } = await press(interaction, 'showcase', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('❌ Failed to save. Please try again.');
    });
});

describe('/pet status — review fixes', () => {
    const pressId = (interaction, action, idx, petId) => interaction.press({ customId: `pet_${action}:${USER}:${idx}:${petId}` });

    test('an action button follows its pet by id when the roster shifts under the open card', async () => {
        seedUser({ pets: [makePet({ petId: 'cat' }), makePet({ petId: 'dog' }), makePet({ petId: 'fish' })] });
        const interaction = await openStatus();

        // The cat is released while the card is open: the dog moves from index 1
        // to 0 and the fish takes index 1.
        stored().pets.splice(0, 1);
        await pressId(interaction, 'play', 1, 'pet-dog');

        const [dog, fish] = stored().pets;
        expect(dog.lastPlay).toBeInstanceOf(Date);
        expect(fish.lastPlay).toBeUndefined();
    });

    test('an action button for a pet that is gone says so rather than picking another', async () => {
        seedUser({ pets: [makePet({ petId: 'cat' }), makePet({ petId: 'dog' })] });
        const interaction = await openStatus();

        stored().pets.splice(1, 1);
        const i = await pressId(interaction, 'play', 0, 'pet-dog');

        expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Pet not found.' }));
        expect(stored().pets[0].lastPlay).toBeUndefined();
    });

    test('showcase is on a per-pet cooldown, so it cannot be mashed', async () => {
        seedUser({ pets: [makePet({ name: 'Rex' })] });
        const interaction = await openStatus();

        await press(interaction, 'showcase', 0);
        const { i } = await press(interaction, 'showcase', 0);

        expect(i.reply.mock.calls[0][0].content).toBe('📷 **Rex** was just shown off! Showcase again in **10m**.');
        expect(stored().pets[0].weeklyInteractions).toBe(1);
    });

    test('Pet of the Week credit stops at the daily cap, but the care still happens', async () => {
        const today = Math.floor(Date.now() / DAY);
        seedUser({ pets: [makePet({ weeklyInteractions: 7, interactionDay: today, interactionsToday: 3 })] });
        const interaction = await openStatus();

        await press(interaction, 'play', 0);

        expect(stored().pets[0].lastPlay).toBeInstanceOf(Date);
        expect(stored().pets[0].xp).toBe(10);
        expect(stored().pets[0].weeklyInteractions).toBe(7);
    });

    test('resting settles pending decay first, so an earlier rest window keeps its half-speed credit', async () => {
        seedUser({ pets: [makePet({ hunger: 80 })] });
        const interaction = await openStatus();

        // Three hours of decay still owed, two of them inside a rest that ended
        // an hour ago: 2h at 5/day plus 1h at 10/day.
        const now = Date.now();
        stored().pets[0].hunger      = 80;
        stored().pets[0].lastDecayAt = new Date(now - 3 * HOUR);
        stored().pets[0].restUntil   = new Date(now - HOUR);
        await press(interaction, 'rest', 0);

        expect(stored().pets[0].hunger).toBeCloseTo(80 - 20 / 24, 2);
        expect(stored().pets[0].lastDecayAt.getTime()).toBeGreaterThanOrEqual(now);
        expect(stored().pets[0].restUntil.getTime()).toBeGreaterThan(now);
    });
});
