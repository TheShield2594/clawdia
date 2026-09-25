'use strict';

/**
 * #998 — /pet's care subcommands, driven end to end through the real command
 * module: adopt, feed, release, rename, list, leaderboard and the autocomplete
 * pickers, plus the dispatcher's error handler.
 *
 * The User store is the shared fakeCollection, so every guarded write the
 * command issues — the adopt fee's `balance: { $gte: cost }` debit, the keyed
 * refund, the save that persists a fed pet — is evaluated for real, and the
 * assertions read what landed in the store rather than which mock was called.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, pets: [], deceasedPets: [], inventory: [], paidPayouts: [],
});
// shared.js reads this constant off the model at require time.
mockUsers.model.DECEASED_PET_LIMIT = 5;
// The leaderboard's aggregation pipeline is not something the fake evaluates;
// each test hands back the rows it wants rendered.
mockUsers.model.aggregate = jest.fn(async () => []);
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });
const mockLadders = fakeCollection('PetLadder', { seasonNumber: 1, rev: 0, ratings: {} }, { unique: ['guildId'] });

// Called with every user resolveUser / the autocomplete loads, after the store
// has handed it over — the seam a test uses to make a save fail or to change
// the stored document behind the command's back.
let mockAfterLoad = null;

/** Mongoose arrays carry `pull(id)`; the runaway sweep uses it. */
function mockAsDocument(user) {
    if (user && Array.isArray(user.pets)) {
        Object.defineProperty(user.pets, 'pull', {
            enumerable: false,
            value(id) {
                const i = this.findIndex(p => String(p._id) === String(id));
                if (i !== -1) this.splice(i, 1);
            },
        });
    }
    if (user && mockAfterLoad) mockAfterLoad(user);
    return user;
}

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/PetLadder', () => mockLadders.model);
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async user => mockAsDocument(user)) }));
jest.mock('../src/utils/itemImageHelper', () => ({ getItemImageAttachment: jest.fn(async () => null) }));
jest.mock('../src/services/questService', () => ({
    onPetCare: jest.fn(async () => ({ completed: [] })),
    notifyQuestComplete: jest.fn(async () => {}),
}));
jest.mock('../src/services/achievementService', () => ({
    checkAndAward: jest.fn(async () => []),
    announceAchievements: jest.fn(async () => {}),
}));

const pet = require('../src/commands/economy/pet');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { getItemImageAttachment } = require('../src/utils/itemImageHelper');
const { onPetCare, notifyQuestComplete } = require('../src/services/questService');
const { checkAndAward, announceAchievements } = require('../src/services/achievementService');
const { xpForLevel } = require('../src/services/petService');

const GUILD = 'guild-1';
const USER = 'user-1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const stored = () => mockUsers.get(USER);

/** A pet as the store holds one: fed, freshly decayed, level 1. */
const makePet = (overrides = {}) => ({
    _id: `pet-${overrides.petId ?? 'dog'}`,
    petId: 'dog',
    name: null,
    hunger: 100,
    lastFed: new Date(),
    lastDecayAt: new Date(),
    adoptedAt: new Date(Date.now() - 10 * DAY),
    starving: false,
    starvingStartAt: null,
    personality: 'loyal',
    level: 1,
    xp: 0,
    evolutionStage: 1,
    battleWins: 0,
    battleLosses: 0,
    ...overrides,
});

const seedUser = (fields = {}) => mockUsers.seed({ userId: USER, guildId: GUILD, ...fields });

/** The harness has no `options.get`; readSlotOption reads the raw option through it. */
function interactionFor(subcommand, options = {}, extra = {}) {
    const interaction = makeInteraction({ subcommand, options, ...extra });
    interaction.options.get = name => (options[name] == null ? null : { value: options[name] });
    return interaction;
}

async function run(subcommand, options = {}, extra = {}) {
    const interaction = interactionFor(subcommand, options, extra);
    await pet.execute(interaction);
    return interaction;
}

/** Everything shown, as text — `editReply` is also called with a bare string here. */
const textOf = interaction => interaction.replies
    .map(p => (typeof p === 'string' ? p : repliedText({ replies: [p] })))
    .join('\n');

const versionError = () => Object.assign(new Error('No matching document found'), { name: 'VersionError' });

beforeEach(() => {
    jest.clearAllMocks();
    mockUsers.reset();
    mockGuilds.reset();
    mockAfterLoad = null;
    mockUsers.model.aggregate.mockImplementation(async () => []);
    mockGuilds.seed({ guildId: GUILD, economy: { enabled: true, currency: '🪙' } });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ─── /pet adopt ─────────────────────────────────────────────────────────────────

describe('/pet adopt', () => {
    test('charges the fee, adds the pet with its name and shows the welcome card', async () => {
        seedUser({ balance: 5000 });

        const interaction = await run('adopt', { type: 'dog', name: '  Rex  ' });

        expect(stored().balance).toBe(3000);
        expect(stored().pets).toHaveLength(1);
        expect(stored().pets[0]).toEqual(expect.objectContaining({
            petId: 'dog', name: 'Rex', hunger: 100, level: 1, xp: 0,
            // Math.random is pinned to 0.5, which picks the third trait.
            personality: 'mischievous',
        }));
        const text = textOf(interaction);
        expect(text).toContain('New Pet Adopted!');
        expect(text).toContain('Welcome **Rex**');
        expect(text).toContain('Mischievous');
        expect(text).toContain('2,000 🪙');
        expect(checkAndAward).toHaveBeenCalledTimes(1);
        expect(announceAchievements).not.toHaveBeenCalled(); // nothing earned
    });

    test('an unnamed pet is welcomed by its species and the art is attached when it exists', async () => {
        seedUser({ balance: 10_000 });
        getItemImageAttachment.mockResolvedValueOnce({ url: 'attachment://wolf.png', attachment: { name: 'wolf.png' } });
        checkAndAward.mockResolvedValueOnce([{ id: 'first_pet' }]);

        const interaction = await run('adopt', { type: 'wolf' });

        expect(stored().balance).toBe(2000);
        expect(stored().pets[0]).toEqual(expect.objectContaining({ petId: 'wolf', name: null }));
        const payload = interaction.replies.at(-1);
        expect(payload.embeds[0].data.description).toContain('Welcome **Wolf**');
        expect(payload.embeds[0].data.thumbnail.url).toBe('attachment://wolf.png');
        expect(payload.files).toEqual([{ name: 'wolf.png' }]);
        expect(announceAchievements).toHaveBeenCalledTimes(1);
    });

    test('an adoption name has mentions and formatting taken out', async () => {
        seedUser({ balance: 5000 });

        await run('adopt', { type: 'dog', name: '**Rex**_the_<@123>' });

        expect(stored().pets[0].name).toBe('Rex the');
    });

    test('an adoption name with nothing usable left is refused before any charge', async () => {
        seedUser({ balance: 5000 });

        const interaction = await run('adopt', { type: 'dog', name: '<@1> ~~' });

        expect(textOf(interaction)).toContain('That name has nothing left');
        expect(stored().balance).toBe(5000);
        expect(stored().pets).toHaveLength(0);
    });

    test('an unknown type is refused before anything is read', async () => {
        const interaction = await run('adopt', { type: 'dragon' });

        expect(textOf(interaction)).toBe('Unknown pet type.');
        expect(mockUsers.all()).toHaveLength(0);
    });

    test('a legendary companion cannot be bought', async () => {
        seedUser({ balance: 1_000_000 });

        const interaction = await run('adopt', { type: 'eagle' });

        expect(textOf(interaction)).toMatch(/Eagle\*\* can only be obtained as a legendary drop/);
        expect(stored().balance).toBe(1_000_000);
        expect(stored().pets).toHaveLength(0);
    });

    test('is refused when the economy is disabled', async () => {
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, economy: { enabled: false } });
        seedUser({ balance: 5000 });

        const interaction = await run('adopt', { type: 'dog' });

        expect(textOf(interaction)).toBe('The economy is disabled in this server.');
        expect(stored().balance).toBe(5000);
    });

    test('a species the player already owns is refused', async () => {
        seedUser({ balance: 5000, pets: [makePet({ petId: 'dog' })] });

        const interaction = await run('adopt', { type: 'dog' });

        expect(textOf(interaction)).toMatch(/You already own a 🐶 \*\*Dog\*\*/);
        expect(stored().balance).toBe(5000);
        expect(stored().pets).toHaveLength(1);
    });

    test('a full roster is refused and points at release and the slot expansion', async () => {
        seedUser({
            balance: 50_000,
            pets: [makePet({ petId: 'cat' }), makePet({ petId: 'bird' }), makePet({ petId: 'fox' })],
        });

        const interaction = await run('adopt', { type: 'dog' });

        expect(textOf(interaction)).toMatch(/caring for \*\*3\*\* pets and have room for \*\*3\*\*/);
        expect(textOf(interaction)).toContain('Pet Slot Expansion');
        expect(stored().balance).toBe(50_000);
        expect(stored().pets).toHaveLength(3);
    });

    test('a bought slot expansion makes room for a fourth pet', async () => {
        seedUser({
            balance: 50_000, petSlots: 1,
            pets: [makePet({ petId: 'cat' }), makePet({ petId: 'bird' }), makePet({ petId: 'fox' })],
        });

        await run('adopt', { type: 'dog' });

        expect(stored().pets.map(p => p.petId)).toEqual(['cat', 'bird', 'fox', 'dog']);
        expect(stored().balance).toBe(48_000);
    });

    test('rare companions do not take up a slot', async () => {
        seedUser({
            balance: 5000,
            pets: [makePet({ petId: 'cat' }), makePet({ petId: 'bird' }), makePet({ petId: 'eagle' })],
        });

        await run('adopt', { type: 'dog' });

        expect(stored().pets).toHaveLength(4);
    });

    test('too few coins is refused with the shortfall', async () => {
        seedUser({ balance: 1500 });

        const interaction = await run('adopt', { type: 'dog' });

        expect(textOf(interaction)).toMatch(/need \*\*2,000\*\* 🪙 .* only have \*\*1,500\*\*/);
        expect(stored().balance).toBe(1500);
        expect(stored().pets).toHaveLength(0);
    });

    test('coins spent between the read and the charge fail the guarded debit, not the balance', async () => {
        seedUser({ balance: 2500 });
        // The command read 2,500; something else spends it before the fee lands.
        mockAfterLoad = () => { stored().balance = 100; };

        const interaction = await run('adopt', { type: 'dog' });

        expect(textOf(interaction)).toMatch(/you no longer have enough/);
        expect(stored().balance).toBe(100);
        expect(stored().pets).toHaveLength(0);
    });

    test('a save that fails hands the fee back under its key and says so', async () => {
        seedUser({ balance: 5000 });
        mockAfterLoad = user => { user.save = jest.fn(async () => { throw new Error('disk full'); }); };

        const interaction = await run('adopt', { type: 'dog', name: 'Rex' });

        expect(stored().balance).toBe(5000);
        expect(stored().pets).toHaveLength(0);
        expect(stored().paidPayouts.map(p => p.key)).toEqual(['pet:adopt:interaction-1:refund']);
        expect(textOf(interaction)).toBe('Something went wrong adopting **Rex** — your coins were refunded.');
    });

    test('a lost version race is reported as a conflict, with the refund', async () => {
        seedUser({ balance: 5000 });
        mockAfterLoad = user => { user.save = jest.fn(async () => { throw versionError(); }); };

        const interaction = await run('adopt', { type: 'cat' });

        expect(stored().balance).toBe(5000);
        expect(textOf(interaction)).toBe('Edit conflict — your coins were refunded. Please try again.');
    });

    test('a refund with no document to land on is recorded as owed and worded that way', async () => {
        seedUser({ balance: 5000 });
        mockAfterLoad = user => {
            user.save = jest.fn(async () => {
                // The document is gone by the time the refund runs.
                mockUsers.all().splice(0);
                throw new Error('gone');
            });
        };

        const interaction = await run('adopt', { type: 'dog' });

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'petAdoptRefund' }));
        expect(textOf(interaction)).toContain('recorded as owed');
        expect(textOf(interaction)).not.toContain('your coins were refunded');
    });
});

// ─── /pet feed ──────────────────────────────────────────────────────────────────

describe('/pet feed', () => {
    test('a favourite food restores 25 hunger, spends one material and grants favourite XP', async () => {
        seedUser({
            pets: [makePet({ hunger: 50, name: 'Rex' })],
            hunt: { materials: { rabbits_foot: 2 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        const fed = stored().pets[0];
        expect(fed.hunger).toBeCloseTo(75, 3);
        expect(fed.xp).toBe(8);
        expect(fed.weeklyInteractions).toBe(1);
        expect(fed.starving).toBe(false);
        expect(fed.starvingStartAt).toBeNull();
        expect(stored().hunt.materials.rabbits_foot).toBe(1);
        const text = textOf(interaction);
        expect(text).toContain('Rex fed!');
        expect(text).toContain('+8 pet XP');
        expect(text).toContain('favorite food — +25 hunger!');
        expect(text).toContain('✅ Active');
        expect(onPetCare).toHaveBeenCalledTimes(1);
    });

    test('any other material restores 10 from the inventory pile and the last unit leaves the bag', async () => {
        seedUser({
            pets: [makePet({ hunger: 5, lastDecayAt: new Date(), starving: true })],
            inventory: [{ itemId: 'pet_food', quantity: 1 }, { itemId: 'lockpick', quantity: 2 }],
        });

        const interaction = await run('feed', { material: 'pet_food' });

        const fed = stored().pets[0];
        expect(fed.hunger).toBeCloseTo(15, 3);
        expect(fed.xp).toBe(4);
        expect(fed.starving).toBe(true);
        expect(stored().inventory).toEqual([{ itemId: 'lockpick', quantity: 2 }]);
        const text = textOf(interaction);
        expect(text).toContain('not favorite — +10 hunger');
        expect(text).toContain('Still inactive (need ≥ 30%)');
    });

    test('a named slot feeds that pet and leaves the other alone', async () => {
        seedUser({
            pets: [makePet({ _id: 'p-dog', hunger: 40 }), makePet({ _id: 'p-cat', petId: 'cat', hunger: 40, name: 'Tom' })],
            fishing: { materials: { feather: 0 } },
            mining: { materials: {} },
            hunt: { materials: { feather: 3 } },
        });

        await run('feed', { material: 'feather', slot: 'p-cat' });

        expect(stored().pets[0].hunger).toBeCloseTo(40, 3);
        expect(stored().pets[1].hunger).toBeCloseTo(65, 3);
        expect(stored().hunt.materials.feather).toBe(2);
    });

    test('an integer slot from a stale client is still understood', async () => {
        seedUser({
            pets: [makePet({ _id: 'p-dog', hunger: 40 }), makePet({ _id: 'p-cat', petId: 'cat', hunger: 40 })],
            hunt: { materials: { feather: 1 } },
        });

        await run('feed', { material: 'feather', slot: 1 });

        expect(stored().pets[1].hunger).toBeCloseTo(65, 3);
    });

    test('crossing a level threshold is announced', async () => {
        seedUser({
            pets: [makePet({ hunger: 50, xp: xpForLevel(2) - 1 })],
            hunt: { materials: { rabbits_foot: 1 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(stored().pets[0].level).toBe(2);
        expect(textOf(interaction)).toContain('Dog reached Level 2!');
    });

    test('crossing an evolution threshold is announced as an evolution', async () => {
        seedUser({
            pets: [makePet({ hunger: 50, level: 9, xp: xpForLevel(10) - 1 })],
            hunt: { materials: { rabbits_foot: 1 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(stored().pets[0]).toEqual(expect.objectContaining({ level: 10, evolutionStage: 2 }));
        expect(textOf(interaction)).toMatch(/Dog evolved!\*\* Say hello to \*\*Seasoned Dog\*\* \(Stage 2\)/);
    });

    test('an evolution posts its own public reveal with the card and the passive before and after', async () => {
        seedUser({
            pets: [makePet({ hunger: 50, level: 9, xp: xpForLevel(10) - 1 })],
            hunt: { materials: { rabbits_foot: 1 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(interaction.followUp).toHaveBeenCalledTimes(1);
        const reveal = interaction.followUp.mock.calls[0][0];
        expect(reveal.flags).toBeUndefined();
        expect(reveal.allowedMentions).toEqual({ parse: [] });
        const embed = reveal.embeds[0].toJSON();
        expect(embed.title).toContain('Evolution!');
        expect(embed.description).toContain('**Dog** evolved into **Seasoned Dog**');
        expect(embed.fields.find(f => f.name.includes('Passive')).value).toMatch(/work earnings → \*\*\+.+work earnings\*\*/);
    });

    test('a level-up that is not an evolution posts no reveal', async () => {
        seedUser({
            pets: [makePet({ hunger: 50, xp: xpForLevel(2) - 1 })],
            hunt: { materials: { rabbits_foot: 1 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(interaction.followUp).not.toHaveBeenCalled();
    });

    test('a reveal that cannot be posted does not fail the feed', async () => {
        seedUser({
            pets: [makePet({ hunger: 50, level: 9, xp: xpForLevel(10) - 1 })],
            hunt: { materials: { rabbits_foot: 1 } },
        });
        const interaction = interactionFor('feed', { material: 'rabbits_foot' });
        interaction.followUp = jest.fn(async () => { throw new Error('Missing Access'); });

        await pet.execute(interaction);

        expect(stored().pets[0].evolutionStage).toBe(2);
        expect(textOf(interaction)).toContain('Seasoned Dog');
    });

    test('with no pets it says so', async () => {
        seedUser({ hunt: { materials: { rabbits_foot: 1 } } });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(textOf(interaction)).toContain('You have no pets to feed!');
        expect(stored().hunt.materials.rabbits_foot).toBe(1);
    });

    test('a slot that matches no pet says so', async () => {
        seedUser({ pets: [makePet()], hunt: { materials: { rabbits_foot: 1 } } });

        const interaction = await run('feed', { material: 'rabbits_foot', slot: 'Nobody' });

        expect(textOf(interaction)).toContain("Couldn't find that pet");
        expect(stored().hunt.materials.rabbits_foot).toBe(1);
    });

    test('an item that is not food is refused rather than destroyed', async () => {
        seedUser({ pets: [makePet({ hunger: 10 })], inventory: [{ itemId: 'tier_skip_token', quantity: 1 }] });

        const interaction = await run('feed', { material: 'tier_skip_token' });

        expect(textOf(interaction)).toContain("`tier_skip_token` isn't something a pet will eat");
        expect(stored().inventory).toEqual([{ itemId: 'tier_skip_token', quantity: 1 }]);
        expect(stored().pets[0].hunger).toBe(10);
    });

    test('a material the player does not hold is refused', async () => {
        seedUser({ pets: [makePet({ hunger: 10 })] });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(textOf(interaction)).toContain("You don't have any `rabbits_foot`");
    });

    test('a full pet is refused and the material kept', async () => {
        // Pin the clock to the decay cursor: a millisecond of decay reads 99.99%.
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        seedUser({ pets: [makePet({ hunger: 100, name: 'Rex', lastDecayAt: new Date(now) })], hunt: { materials: { rabbits_foot: 1 } } });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(textOf(interaction)).toContain('**Rex** is completely full');
        expect(stored().hunt.materials.rabbits_foot).toBe(1);
    });

    test('a pet the bar shows at 100% is refused too, not fed for a fraction of a point', async () => {
        seedUser({
            pets: [makePet({ hunger: 99.7, name: 'Rex', lastDecayAt: new Date() })],
            hunt: { materials: { rabbits_foot: 1 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(textOf(interaction)).toContain('**Rex** is completely full');
        expect(stored().hunt.materials.rabbits_foot).toBe(1);
        expect(stored().pets[0].weeklyInteractions).toBeUndefined();
    });

    test('a favourite fed near full reports the hunger that actually landed', async () => {
        seedUser({
            pets: [makePet({ hunger: 95, name: 'Rex', lastDecayAt: new Date() })],
            hunt: { materials: { rabbits_foot: 1 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot' });

        expect(stored().pets[0].hunger).toBe(100);
        expect(textOf(interaction)).toContain('favorite food — +5 hunger!');
        expect(textOf(interaction)).not.toContain('+25 hunger');
    });

    test('feeding past the daily Pet of the Week cap still feeds, but earns no more credit', async () => {
        seedUser({
            pets: [makePet({
                hunger: 50, weeklyInteractions: 4,
                interactionDay: Math.floor(Date.now() / 86_400_000), interactionsToday: 3,
            })],
            hunt: { materials: { rabbits_foot: 1 } },
        });

        await run('feed', { material: 'rabbits_foot' });

        expect(stored().pets[0].hunger).toBeCloseTo(75, 1);
        expect(stored().pets[0].weeklyInteractions).toBe(4);
    });

    // #1188: one command can use up to ten items, but never more than the pet
    // can take.
    test('quantity 5 on a pet at 60% uses only the four items it takes to fill it', async () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        seedUser({
            pets: [makePet({ hunger: 60, name: 'Rex', lastDecayAt: new Date(now) })],
            inventory: [{ itemId: 'pet_food', quantity: 7 }],
        });

        const interaction = await run('feed', { material: 'pet_food', quantity: 5 });

        const fed = stored().pets[0];
        expect(fed.hunger).toBe(100);
        expect(fed.xp).toBe(4 * 4);
        expect(fed.weeklyInteractions).toBe(1);
        expect(stored().inventory).toEqual([{ itemId: 'pet_food', quantity: 3 }]);
        const text = textOf(interaction);
        expect(text).toContain('`pet_food` ×4');
        expect(text).toContain('not favorite — +40 hunger');
        expect(text).toContain('+16 pet XP');
        expect(text).toContain('Used **4** of 5 — full now · 3 left');
    });

    test('quantity stops at the pile, and the last item may top the pet up past what it needed', async () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        seedUser({
            pets: [makePet({ hunger: 10, lastDecayAt: new Date(now) })],
            hunt: { materials: { rabbits_foot: 2 } },
        });

        const interaction = await run('feed', { material: 'rabbits_foot', quantity: 10 });

        expect(stored().pets[0].hunger).toBe(60);
        expect(stored().pets[0].xp).toBe(16);
        expect(stored().hunt.materials.rabbits_foot).toBe(0);
        expect(textOf(interaction)).toContain('favorite food — +50 hunger!');
        expect(textOf(interaction)).toContain('Used **2** of 10 — that was all you had · 0 left');
    });

    test('a quantity that is all used says so without a reason', async () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        seedUser({
            pets: [makePet({ hunger: 20, lastDecayAt: new Date(now) })],
            inventory: [{ itemId: 'pet_food', quantity: 5 }],
        });

        const interaction = await run('feed', { material: 'pet_food', quantity: 3 });

        expect(stored().pets[0].hunger).toBe(50);
        expect(textOf(interaction)).toContain('Used **3** of 3 · 2 left');
    });

    test('a pet type with no definition cannot be fed', async () => {
        seedUser({ pets: [makePet({ petId: 'unicorn', hunger: 20 })], inventory: [{ itemId: 'pet_food', quantity: 1 }] });

        const interaction = await run('feed', { material: 'pet_food' });

        expect(textOf(interaction)).toContain('Could not feed that pet.');
        expect(stored().inventory).toEqual([{ itemId: 'pet_food', quantity: 1 }]);
    });

    test('a completed care quest is announced', async () => {
        seedUser({ pets: [makePet({ hunger: 20 })], inventory: [{ itemId: 'pet_food', quantity: 2 }] });
        onPetCare.mockResolvedValueOnce({ completed: [{ id: 'q1' }] });

        await run('feed', { material: 'pet_food' });

        expect(notifyQuestComplete).toHaveBeenCalledTimes(1);
    });

    test('a failing quest hook does not stop the feed', async () => {
        seedUser({ pets: [makePet({ hunger: 20 })], inventory: [{ itemId: 'pet_food', quantity: 2 }] });
        onPetCare.mockRejectedValueOnce(new Error('quests down'));
        checkAndAward.mockRejectedValueOnce(new Error('achievements down'));

        const interaction = await run('feed', { material: 'pet_food' });

        expect(stored().pets[0].hunger).toBeCloseTo(30, 3);
        expect(textOf(interaction)).toContain('fed!');
    });

    test('a lost version race is reported as a conflict', async () => {
        seedUser({ pets: [makePet({ hunger: 20 })], inventory: [{ itemId: 'pet_food', quantity: 2 }] });
        mockAfterLoad = user => { user.save = jest.fn(async () => { throw versionError(); }); };

        const interaction = await run('feed', { material: 'pet_food' });

        expect(textOf(interaction)).toContain('Edit conflict — please try again.');
        expect(stored().pets[0].hunger).toBe(20);
    });

    test('any other save failure falls through to the command-wide handler', async () => {
        seedUser({ pets: [makePet({ hunger: 20 })], inventory: [{ itemId: 'pet_food', quantity: 2 }] });
        mockAfterLoad = user => { user.save = jest.fn(async () => { throw new Error('disk full'); }); };

        const interaction = await run('feed', { material: 'pet_food' });

        // Deferred, so the handler answers with a follow-up.
        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({
            content: 'Something went wrong with the pet command.',
        }));
    });

    test('a pet that starved to death is moved to the memorial, announced, and the survivor is fed', async () => {
        const starvedSince = new Date(Date.now() - 5 * DAY);
        seedUser({
            pets: [
                makePet({ _id: 'p-gone', petId: 'cat', name: 'Ghost', hunger: 0, starving: true, starvingStartAt: starvedSince, lastDecayAt: starvedSince }),
                makePet({ _id: 'p-dog', hunger: 40 }),
            ],
            inventory: [{ itemId: 'pet_food', quantity: 1 }],
        });

        const interaction = await run('feed', { material: 'pet_food' });

        expect(stored().pets.map(p => p._id)).toEqual(['p-dog']);
        expect(stored().pets[0].hunger).toBeCloseTo(50, 3);
        expect(stored().deceasedPets).toHaveLength(1);
        expect(stored().deceasedPets[0]).toEqual(expect.objectContaining({ petId: 'cat', name: 'Ghost' }));
        expect(stored().deceasedPets[0]._id).toBeUndefined();
        expect(interaction.channel.sent[0].content).toMatch(/player\*\*'s pet 🐱 \*\*Ghost\*\* got too hungry and ran off/);
        expect(textOf(interaction)).toContain('After days without food, 🐱 **Ghost** ran away.');
    });

    test('two pets starving together are named together', async () => {
        const starvedSince = new Date(Date.now() - 5 * DAY);
        const starving = { hunger: 0, starving: true, starvingStartAt: starvedSince, lastDecayAt: starvedSince };
        seedUser({
            pets: [
                makePet({ _id: 'a', petId: 'cat', ...starving }),
                makePet({ _id: 'b', petId: 'bird', ...starving }),
                makePet({ _id: 'c', hunger: 40 }),
            ],
            inventory: [{ itemId: 'pet_food', quantity: 1 }],
        });

        const interaction = await run('feed', { material: 'pet_food' });

        expect(stored().pets.map(p => p._id)).toEqual(['c']);
        expect(stored().deceasedPets.map(p => p.petId)).toEqual(['bird', 'cat']);
        expect(interaction.channel.sent[0].content).toContain("'s pets 🐱 **Cat**, 🐦 **Bird** got too hungry and ran off");
        expect(textOf(interaction)).toContain('After days without food, 🐱 **Cat**, 🐦 **Bird** ran away.');
    });

    // #873. Every early return in /pet feed skipped its save, so a death was
    // announced and never stored — and announced again on every run after. A
    // player whose only pet starved got "passed away" each time they tried.
    test('a death is stored when announced, so the next feed does not announce it again', async () => {
        const starvedSince = new Date(Date.now() - 5 * DAY);
        seedUser({
            pets: [makePet({ _id: 'p-gone', petId: 'cat', name: 'Ghost', hunger: 0, starving: true, starvingStartAt: starvedSince, lastDecayAt: starvedSince })],
            inventory: [{ itemId: 'pet_food', quantity: 1 }],
        });

        const first = await run('feed', { material: 'pet_food' });
        expect(first.channel.sent).toHaveLength(1);
        expect(textOf(first)).toContain('You have no pets to feed!');
        expect(stored().pets).toEqual([]);
        expect(stored().deceasedPets).toHaveLength(1);

        const second = await run('feed', { material: 'pet_food' });
        expect(second.channel.sent).toHaveLength(0);
        expect(stored().deceasedPets).toHaveLength(1);
    });

    // #1186: running off costs bond — the days starving drain it, and the
    // runaway itself takes a fixed cut the Revive Scroll does not give back.
    test('a pet that runs away loses bond to the hunger and the runaway', async () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const starvedSince = new Date(now - 5 * DAY);
        seedUser({
            pets: [makePet({ _id: 'p-gone', petId: 'cat', bond: 70, hunger: 0, starving: true, starvingStartAt: starvedSince, lastDecayAt: starvedSince })],
        });

        await run('feed', { material: 'pet_food' });

        // 70 − 5 days × 2 − 25.
        expect(stored().deceasedPets[0].bond).toBeCloseTo(35, 6);
    });

    test('feeding raises bond once per command, under the daily cap', async () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        seedUser({
            pets: [makePet({ hunger: 10, bond: 12, lastDecayAt: new Date(now) })],
            inventory: [{ itemId: 'pet_food', quantity: 10 }],
        });

        const first = await run('feed', { material: 'pet_food', quantity: 3 });
        expect(stored().pets[0].bond).toBe(14);
        expect(textOf(first)).toContain('❤️ **+2 bond**');

        await run('feed', { material: 'pet_food' });
        const third = await run('feed', { material: 'pet_food' });
        expect(stored().pets[0].bond).toBe(16);
        expect(textOf(third)).not.toContain('bond**');
    });

    // A death whose save loses a version race is neither stored nor announced,
    // and the player gets feed's own edit-conflict reply rather than the
    // command-wide apology.
    test('a death whose save conflicts is not announced, and reads as an edit conflict', async () => {
        const starvedSince = new Date(Date.now() - 5 * DAY);
        seedUser({
            pets: [makePet({ _id: 'p-gone', petId: 'cat', name: 'Ghost', hunger: 0, starving: true, starvingStartAt: starvedSince, lastDecayAt: starvedSince })],
            inventory: [{ itemId: 'pet_food', quantity: 1 }],
        });
        mockAfterLoad = user => { user.save = jest.fn(async () => { throw versionError(); }); };

        const interaction = await run('feed', { material: 'pet_food' });

        expect(interaction.channel.sent).toHaveLength(0);
        expect(textOf(interaction)).toContain('Edit conflict — please try again.');
        expect(stored().pets.map(p => p._id)).toEqual(['p-gone']);
    });
});

// ─── /pet release ───────────────────────────────────────────────────────────────

describe('/pet release', () => {
    const confirm = { customId: 'pet_release_yes:interaction-1' };
    const cancel  = { customId: 'pet_release_no:interaction-1' };

    test('asks first, and a confirmed release removes the pet', async () => {
        seedUser({
            pets: [makePet({ _id: 'p-dog', name: 'Rex', level: 12, battleWins: 3, battleLosses: 1, bond: 62.5 }), makePet({ _id: 'p-cat', petId: 'cat' })],
        });

        const interaction = await run('release', { slot: 'p-dog' }, { components: [confirm] });

        const prompt = interaction.replies[0];
        expect(prompt.embeds[0].data.title).toBe('Release Rex?');
        expect(prompt.embeds[0].data.description).toMatch(/Lv\.12, Devoted bond \(62\), 3W \/ 1L/);
        expect(prompt.components[0].components.map(c => c.data.custom_id))
            .toEqual(['pet_release_yes:interaction-1', 'pet_release_no:interaction-1']);
        expect(interaction.replies.at(-1).content).toBe('🐶 **Rex** has been released. Goodbye, friend!');
        expect(stored().pets.map(p => p._id)).toEqual(['p-cat']);
    });

    test('bond is what care earned, not how long the pet was kept', async () => {
        seedUser({ pets: [makePet({ adoptedAt: new Date(Date.now() - 400 * DAY) })] });

        const interaction = await run('release', { slot: '0' }, { components: [cancel] });

        expect(interaction.replies[0].embeds[0].data.description).toContain('Wary bond (0)');
    });

    test('keeping the pet leaves the roster alone', async () => {
        seedUser({ pets: [makePet({ name: 'Rex' })] });

        const interaction = await run('release', { slot: 'Rex' }, { components: [cancel] });

        expect(interaction.replies.at(-1).content).toBe('**Rex** stays with you.');
        expect(stored().pets).toHaveLength(1);
    });

    test('no answer in time cancels', async () => {
        seedUser({ pets: [makePet()] });

        const interaction = await run('release', { slot: 'dog' });

        expect(interaction.replies.at(-1).content).toBe('Release cancelled — **Dog** stays with you.');
        expect(stored().pets).toHaveLength(1);
    });

    test("another member's click is turned away and does not release", async () => {
        seedUser({ pets: [makePet()] });

        const interaction = await run('release', { slot: '0' }, { components: [{ ...confirm, user: 'someone-else' }] });

        expect(interaction.replies.at(-1).content).toContain('Release cancelled');
        expect(stored().pets).toHaveLength(1);
    });

    test('a slot with no pet is refused before the prompt', async () => {
        seedUser({ pets: [makePet()] });

        const interaction = await run('release', { slot: '4' });

        expect(interaction.replies).toHaveLength(1);
        expect(textOf(interaction)).toContain("Couldn't find that pet");
    });

    test('a pet that left the roster while the prompt was open is reported, not a crash', async () => {
        seedUser({ pets: [makePet({ _id: 'p-dog' })] });
        let loads = 0;
        mockAfterLoad = () => { if (++loads === 1) stored().pets = []; };

        const interaction = await run('release', { slot: 'p-dog' }, { components: [confirm] });

        expect(interaction.replies.at(-1).content).toBe('**Dog** is no longer in your roster.');
    });

    test('a version race that never settles is reported as a conflict', async () => {
        seedUser({ pets: [makePet()] });
        mockAfterLoad = user => { user.save = jest.fn(async () => { throw versionError(); }); };

        const interaction = await run('release', { slot: '0' }, { components: [confirm] });

        expect(interaction.replies.at(-1).content).toBe('Edit conflict — try again.');
        expect(stored().pets).toHaveLength(1);
    });

    test('with nowhere to show the prompt it stops quietly', async () => {
        seedUser({ pets: [makePet()] });
        const interaction = interactionFor('release', { slot: '0' });
        interaction.reply = jest.fn(async () => { throw new Error('unknown interaction'); });
        interaction.fetchReply = jest.fn(async () => { throw new Error('unknown interaction'); });

        await pet.execute(interaction);

        expect(interaction.message.awaitMessageComponent).not.toHaveBeenCalled();
        expect(stored().pets).toHaveLength(1);
    });
});

// ─── /pet rename ────────────────────────────────────────────────────────────────

describe('/pet rename', () => {
    test('renames the chosen pet, trimmed', async () => {
        seedUser({ pets: [makePet({ _id: 'a' }), makePet({ _id: 'b', petId: 'fox' })] });

        const interaction = await run('rename', { slot: 'b', name: '  Vixen  ' });

        expect(stored().pets.map(p => p.name)).toEqual([null, 'Vixen']);
        expect(textOf(interaction)).toBe('🦊 Pet renamed to **Vixen**!');
    });

    test('mentions and formatting are taken out of the new name', async () => {
        seedUser({ pets: [makePet({ _id: 'a' })] });

        const interaction = await run('rename', { slot: 'a', name: '<@123> **sir_fluff**' });

        expect(stored().pets[0].name).toBe('sir fluff');
        expect(textOf(interaction)).toBe('🐶 Pet renamed to **sir fluff**!');
    });

    test('a name with nothing usable left is refused and the old name kept', async () => {
        seedUser({ pets: [makePet({ _id: 'a', name: 'Rex' })] });

        const interaction = await run('rename', { slot: 'a', name: '<@123> ***' });

        expect(stored().pets[0].name).toBe('Rex');
        expect(textOf(interaction)).toContain('That name has nothing left');
    });

    test('a pet that is not there is refused', async () => {
        seedUser({ pets: [] });

        const interaction = await run('rename', { slot: '0', name: 'Rex' });

        expect(textOf(interaction)).toContain("Couldn't find that pet");
    });
});

// ─── /pet list ──────────────────────────────────────────────────────────────────

// ─── /pet vacation ──────────────────────────────────────────────────────────────

describe('/pet vacation', () => {
    test('on pauses every pet until the end of the window and says when', async () => {
        seedUser({ pets: [makePet({ _id: 'a' }), makePet({ _id: 'b', petId: 'cat' })] });

        const interaction = await run('vacation', { state: 'on', days: 5 });

        const pets = stored().pets;
        const until = new Date(pets[0].vacationUntil).getTime();
        expect(until - new Date(pets[0].vacationFrom).getTime()).toBe(5 * DAY);
        expect(new Date(pets[1].vacationUntil).getTime()).toBe(until);
        const text = textOf(interaction);
        expect(text).toContain('Pets on vacation');
        expect(text).toContain('**2 pets**');
        expect(text).toContain(`<t:${Math.floor(until / 1000)}:R>`);
    });

    test('defaults to the longest vacation', async () => {
        seedUser({ pets: [makePet()] });

        await run('vacation', { state: 'on' });

        const p = stored().pets[0];
        expect(new Date(p.vacationUntil) - new Date(p.vacationFrom)).toBe(14 * DAY);
    });

    test('on while already away is refused rather than extended', async () => {
        const until = new Date(Date.now() + 3 * DAY);
        seedUser({ pets: [makePet({ vacationFrom: new Date(Date.now() - DAY), vacationUntil: until })] });

        const interaction = await run('vacation', { state: 'on' });

        expect(textOf(interaction)).toContain('already on vacation');
        expect(new Date(stored().pets[0].vacationUntil).getTime()).toBe(until.getTime());
    });

    test('off ends it now', async () => {
        seedUser({ pets: [makePet({ vacationFrom: new Date(Date.now() - DAY), vacationUntil: new Date(Date.now() + 3 * DAY) })] });

        const interaction = await run('vacation', { state: 'off' });

        expect(new Date(stored().pets[0].vacationUntil).getTime()).toBeLessThanOrEqual(Date.now());
        expect(textOf(interaction)).toContain('Welcome back');
    });

    test('off with no vacation on says so', async () => {
        seedUser({ pets: [makePet()] });

        const interaction = await run('vacation', { state: 'off' });

        expect(textOf(interaction)).toContain("aren't on vacation");
    });

    test('with no pets it says so', async () => {
        seedUser({});

        const interaction = await run('vacation', { state: 'on' });

        expect(textOf(interaction)).toContain("don't have any pets");
    });

    test('a pet that ran away on the way in leaves nothing to send', async () => {
        seedUser({ pets: [makePet({ hunger: 0, starvingStartAt: new Date(Date.now() - 4 * DAY) })] });

        const interaction = await run('vacation', { state: 'on' });

        expect(stored().pets).toHaveLength(0);
        expect(textOf(interaction)).toContain("don't have any pets");
    });

    test('an edit conflict on the save is answered, not thrown', async () => {
        seedUser({ pets: [makePet()] });
        mockAfterLoad = (user) => { user.save = jest.fn(async () => { throw versionError(); }); };

        const interaction = await run('vacation', { state: 'on' });

        expect(textOf(interaction)).toContain('Edit conflict');
    });
});

// ─── /pet codex ─────────────────────────────────────────────────────────────────

describe('/pet codex', () => {
    test('lists every species, owned or not, with where the rare ones come from', async () => {
        seedUser({ pets: [makePet({ petId: 'wolf' })], petCodex: ['eagle'] });

        const interaction = await run('codex');

        const text = textOf(interaction);
        expect(text).toContain('2 of 10');
        expect(text).toContain('Lantern Owl');
        expect(text).toContain('appears on a legendary expedition (/explore)');
        expect(text).toContain('Eagle');
    });
});

describe('/pet list', () => {
    test('lists every purchasable pet with its price, max-level bonus and favourite food', async () => {
        const interaction = await run('list');

        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toBe('🐾 Pet Shop');
        for (const line of ['🐶 **Dog** — 2,000 coins', '🐺 **Wolf** — 8,000 coins', 'Fave food: `wolf_pelt`', '**+25.0%** at Lv.30']) {
            expect(embed.description).toContain(line);
        }
        expect(embed.description).not.toContain('Eagle');
        expect(embed.footer.text).toMatch(/^Eagle, Shark, Crystal Fox and Lantern Owl aren't sold — each has a 4% chance/);
    });
});

// ─── /pet leaderboard ───────────────────────────────────────────────────────────

describe('/pet leaderboard', () => {
    const pipelineOf = () => mockUsers.model.aggregate.mock.calls[0][0];

    // #1185: the ladder, read from its own document rather than the pets.
    test('by rating ranks rated pets this season, with tiers and records', async () => {
        mockLadders.reset();
        mockLadders.seed({ guildId: GUILD, seasonNumber: 2, seasonEndsAt: new Date(Date.now() + 5 * DAY), ratings: {
            p1: { userId: 'u1', rating: 1340, wins: 6, losses: 2, games: 8 },
            p2: { userId: 'u2', rating: 1512, wins: 9, losses: 1, games: 10 },
        } });
        mockUsers.seed(
            { userId: 'u1', guildId: GUILD, pets: [{ _id: 'p1', petId: 'dog', name: 'Rex' }] },
            { userId: 'u2', guildId: GUILD, pets: [{ _id: 'p2', petId: 'wolf', name: 'Ghost', evolutionStage: 2, level: 12 }] },
        );

        const interaction = await run('leaderboard', { type: 'rating' });

        const embed = interaction.replies.at(-1).embeds.at(-1).data;
        expect(embed.title).toBe('🐾 Pet Ladder — S2');
        const lines = embed.description.split('\n');
        expect(lines[0]).toBe('🥇 🌕 **Seasoned Ghost** — 💎 **1512** · 9W / 1L — <@u2>');
        expect(lines[1]).toBe('🥈 🐶 **Rex** — 🥇 **1340** · 6W / 2L — <@u1>');
        expect(mockUsers.model.aggregate).not.toHaveBeenCalled();
        // The picture card leads, with the same ladder in words.
        const reply = interaction.replies.at(-1);
        expect(reply.embeds[0].data.image.url).toBe('attachment://leaderboard.png');
        expect(reply.files[0].description).toContain('1. Seasoned Ghost, 1512 rating');
        expect(reply.files[0].description).toContain('Platinum · 9W / 1L');
    });

    test('by rating, with no rated battles yet, says how to start one', async () => {
        mockLadders.reset();

        const interaction = await run('leaderboard', { type: 'rating' });

        expect(interaction.replies.at(-1).embeds[0].data.description).toContain('No rated battles this season yet');
    });

    test('defaults to bond, with medals, the POTW star and a numbered fourth place', async () => {
        const fed = { hunger: 100, lastDecayAt: new Date() };
        mockUsers.model.aggregate.mockResolvedValueOnce([
            { userId: 'u1', petBond: 92, pet: { petId: 'dog', name: 'Rex', potw: true, bond: 92, ...fed } },
            { userId: 'u2', petBond: 40, pet: { petId: 'cat', bond: 40, ...fed } },
            { userId: 'u3', petBond: 10, pet: { petId: 'mystery', bond: 10, ...fed } },
            { userId: 'u4', petBond: 0,  pet: { petId: 'fox', ...fed } },
        ]);

        const interaction = await run('leaderboard');

        const embed = interaction.replies.at(-1).embeds.at(-1).data;
        expect(embed.title).toBe('🐾 Pet Leaderboard — Most Bonded Pets');
        const lines = embed.description.split('\n');
        expect(lines[0]).toBe('🥇 🐶 **Rex** 🌟 — ❤️❤️❤️❤️❤️❤️❤️🖤 Soulbound 92 — <@u1>');
        expect(lines[1]).toMatch(/^🥈 🐱 \*\*Cat\*\* — .* Trusted 40 — /);
        expect(lines[2]).toMatch(/^🥉 🐾 \*\*mystery\*\* — .* Wary 10 — /);
        expect(lines[3]).toMatch(/^4\. 🦊 \*\*Fox\*\* — .* Wary 0 — /);
        expect(pipelineOf()[0]).toEqual({ $match: { guildId: GUILD, 'pets.0': { $exists: true } } });
        expect(pipelineOf()[2]).toEqual({ $addFields: { petBond: { $ifNull: ['$pets.bond', 0] } } });
        expect(pipelineOf()[3]).toEqual({ $sort: { petBond: -1, 'pets.adoptedAt': 1 } });
        // The picture card leads, the text board under it.
        const reply = interaction.replies.at(-1);
        expect(reply.files.map(f => f.name)).toEqual(['leaderboard.png']);
        expect(reply.embeds[0].data.image.url).toBe('attachment://leaderboard.png');
        expect(reply.files[0].description).toContain('Pet Leaderboard for ');
    });

    // #1186: the stored bond lags a player who has not run a pet command while
    // their pet went hungry, so the board re-ranks on the decay-aware value.
    test('ranks on bond as it stands now, not as last written', async () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        mockUsers.model.aggregate.mockResolvedValueOnce([
            // Stored higher, but ten days starving since: 50 − 20 = 30.
            { userId: 'u1', petBond: 50, pet: { petId: 'dog', name: 'Starved', bond: 50, hunger: 0, lastDecayAt: new Date(now - 10 * DAY) } },
            { userId: 'u2', petBond: 45, pet: { petId: 'cat', name: 'Kept', bond: 45, hunger: 100, lastDecayAt: new Date(now) } },
        ]);

        const interaction = await run('leaderboard');

        const lines = interaction.replies.at(-1).embeds.at(-1).data.description.split('\n');
        expect(lines[0]).toMatch(/Kept.* Trusted 45 — <@u2>$/);
        expect(lines[1]).toMatch(/Starved.* Friendly 30 — <@u1>$/);
    });

    test('by level marks evolved stages', async () => {
        mockUsers.model.aggregate.mockResolvedValueOnce([
            { userId: 'u1', pet: { petId: 'wolf', name: 'Alpha', level: 25, evolutionStage: 3 } },
            { userId: 'u2', pet: { petId: 'dog', level: 12, evolutionStage: 2 } },
            { userId: 'u3', pet: { petId: 'nope' } },
        ]);

        const interaction = await run('leaderboard', { type: 'level' });

        const embed = interaction.replies.at(-1).embeds.at(-1).data;
        expect(embed.title).toContain('Highest Level Pets');
        expect(embed.description.split('\n')).toEqual([
            '🥇 🌑 **Apex Alpha** ⭐⭐⭐ — Lv**25** — <@u1>',
            '🥈 🐕 **Seasoned Dog** ⭐⭐ — Lv**12** — <@u2>',
            '🥉 🐾 **nope** ⭐ — Lv**1** — <@u3>',
        ]);
        expect(pipelineOf()[3]).toEqual({ $sort: { petLevel: -1 } });
    });

    test('by wins ranks member-vs-member results only', async () => {
        mockUsers.model.aggregate.mockResolvedValueOnce([
            { userId: 'u1', pet: { petId: 'fox', name: 'Red', battleWins: 40, battleLosses: 12, pvpWins: 9, pvpLosses: 2 } },
            { userId: 'u2', pet: { petId: 'bogus' } },
        ]);

        const interaction = await run('leaderboard', { type: 'wins' });

        const embed = interaction.replies.at(-1).embeds.at(-1).data;
        expect(embed.title).toContain('Most PvP Wins');
        expect(embed.description.split('\n')).toEqual([
            '🥇 🦊 **Red** — ⚔️ 9W / 2L vs members — <@u1>',
            '🥈 🐾 **bogus** — ⚔️ 0W / 0L vs members — <@u2>',
        ]);
        expect(pipelineOf()[3]).toEqual({ $sort: { petWins: -1, petLosses: 1 } });
    });

    test('an empty server says so', async () => {
        const interaction = await run('leaderboard');

        expect(interaction.replies.at(-1).embeds.at(-1).data.description).toBe('*No pets in this server yet!*');
    });

    test('a failed query is answered by the dispatcher with a follow-up', async () => {
        mockUsers.model.aggregate.mockRejectedValueOnce(new Error('db down'));

        const interaction = await run('leaderboard');

        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: 'Something went wrong with the pet command.' }));
    });
});

// ─── dispatcher ─────────────────────────────────────────────────────────────────

describe('/pet dispatcher', () => {
    test('an error before any reply is answered with a reply', async () => {
        mockUsers.model.findOneAndUpdate.mockRejectedValueOnce(new Error('db down'));

        const interaction = await run('adopt', { type: 'dog' });

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Something went wrong with the pet command.' }));
        expect(interaction.followUp).not.toHaveBeenCalled();
    });

    test('an unknown subcommand does nothing', async () => {
        const interaction = await run('dance');

        expect(interaction.replies).toHaveLength(0);
    });

    test('the definition carries every subcommand', () => {
        const json = pet.data.toJSON();
        expect(json.name).toBe('pet');
        expect(json.options.map(o => o.name)).toEqual(['adopt', 'status', 'feed', 'release', 'rename', 'list', 'codex', 'vacation', 'leaderboard', 'battle']);
    });
});

// ─── autocomplete ───────────────────────────────────────────────────────────────

describe('/pet autocomplete', () => {
    async function complete(focused, options = {}) {
        const interaction = interactionFor(null, options);
        interaction.options.getFocused = () => focused;
        await pet.autocomplete(interaction);
        return interaction.replies.at(-1).choices;
    }

    test('the slot picker lists each pet by id, with hunger, and filters on what was typed', async () => {
        seedUser({
            pets: [
                makePet({ _id: 'p1', name: 'Rex', level: 4 }),
                makePet({ _id: 'p2', petId: 'cat', hunger: 10 }),
                makePet({ _id: 'p3', petId: 'mystery' }),
            ],
        });

        const all = await complete({ name: 'slot', value: '' });
        expect(all).toEqual([
            { name: 'Rex — Dog Lv4 · 100% fed', value: 'p1' },
            { name: 'Cat — Cat Lv1 · 10% fed · hungry!', value: 'p2' },
            { name: 'mystery — mystery Lv1 · 100% fed', value: 'p3' },
        ]);

        const filtered = await complete({ name: 'slot', value: 'REX' });
        expect(filtered.map(c => c.value)).toEqual(['p1']);
    });

    test('the slot picker is empty for a player with no document', async () => {
        expect(await complete({ name: 'slot' })).toEqual([]);
    });

    test('the food picker lists only edible things held, favourite first, then by quantity', async () => {
        seedUser({
            pets: [makePet({ _id: 'p1' }), makePet({ _id: 'p2', petId: 'cat' })],
            hunt: { materials: { feather: 5, rabbits_foot: 1, wolf_pelt: 0 } },
            fishing: { materials: { fish_scale: 2 } },
            inventory: [
                { itemId: 'pet_food', quantity: 3 },
                { itemId: 'tier_skip_token', quantity: 9 },
                { itemId: 'feather', quantity: 1 },
            ],
        });

        const choices = await complete({ name: 'material', value: '' }, { slot: 'p1' });

        expect(choices.map(c => c.value)).toEqual(['rabbits_foot', 'feather', 'pet_food', 'fish_scale']);
        expect(choices[0].name).toMatch(/1x ⭐ favourite \(\+25\)$/);
        expect(choices[1].name).toMatch(/6x \(\+10\)$/);
        expect(choices[2].name).toBe('🍖 Pet Food — 3x (+10)');
    });

    test('the food picker favours the selected pet and filters on what was typed', async () => {
        seedUser({
            pets: [makePet({ _id: 'p1' }), makePet({ _id: 'p2', petId: 'cat' })],
            hunt: { materials: { feather: 1, rabbits_foot: 4 } },
        });

        const choices = await complete({ name: 'material', value: 'EA' }, { slot: 'p2' });

        expect(choices).toHaveLength(1);
        expect(choices[0].value).toBe('feather');
        expect(choices[0].name).toContain('⭐ favourite');
    });

    test('the food picker is empty for a player with no document', async () => {
        expect(await complete({ name: 'material', value: '' })).toEqual([]);
    });

    test('any other option gets no suggestions', async () => {
        expect(await complete({ name: 'bet', value: '5' })).toEqual([]);
    });

    test('a failed read answers with no suggestions rather than timing out', async () => {
        mockUsers.model.findOne.mockImplementationOnce(() => { throw new Error('db down'); });

        expect(await complete({ name: 'slot', value: '' })).toEqual([]);
    });
});
