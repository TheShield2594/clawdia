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
        expect(textOf(interaction)).toMatch(/Dog evolved!\*\* Now an \*\*Seasoned Dog\*\* \(Stage 2\)/);
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
        expect(interaction.channel.sent[0].content).toMatch(/player\*\*'s pet 🐱 \*\*Ghost\*\* passed away/);
        expect(textOf(interaction)).toContain('Your pet died from starvation: 🐱 **Ghost**');
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
        expect(interaction.channel.sent[0].content).toContain("'s pets 🐱 **Cat**, 🐦 **Bird** passed away");
        expect(textOf(interaction)).toContain('Your pets died from starvation');
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
});

// ─── /pet release ───────────────────────────────────────────────────────────────

describe('/pet release', () => {
    const confirm = { customId: 'pet_release_yes:interaction-1' };
    const cancel  = { customId: 'pet_release_no:interaction-1' };

    test('asks first, and a confirmed release removes the pet', async () => {
        seedUser({
            pets: [makePet({ _id: 'p-dog', name: 'Rex', level: 12, battleWins: 3, battleLosses: 1 }), makePet({ _id: 'p-cat', petId: 'cat' })],
        });

        const interaction = await run('release', { slot: 'p-dog' }, { components: [confirm] });

        const prompt = interaction.replies[0];
        expect(prompt.embeds[0].data.title).toBe('Release Rex?');
        expect(prompt.embeds[0].data.description).toMatch(/Lv\.12, 10 days of bond, 3W \/ 1L/);
        expect(prompt.components[0].components.map(c => c.data.custom_id))
            .toEqual(['pet_release_yes:interaction-1', 'pet_release_no:interaction-1']);
        expect(interaction.replies.at(-1).content).toBe('🐶 **Rex** has been released. Goodbye, friend!');
        expect(stored().pets.map(p => p._id)).toEqual(['p-cat']);
    });

    test('a bond of exactly one day is singular', async () => {
        seedUser({ pets: [makePet({ adoptedAt: new Date(Date.now() - DAY - HOUR) })] });

        const interaction = await run('release', { slot: '0' }, { components: [cancel] });

        expect(interaction.replies[0].embeds[0].data.description).toContain('1 day of bond');
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

    test('a pet that is not there is refused', async () => {
        seedUser({ pets: [] });

        const interaction = await run('rename', { slot: '0', name: 'Rex' });

        expect(textOf(interaction)).toContain("Couldn't find that pet");
    });
});

// ─── /pet list ──────────────────────────────────────────────────────────────────

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

    test('defaults to bond days, with medals, the POTW star and a numbered fourth place', async () => {
        mockUsers.model.aggregate.mockResolvedValueOnce([
            { userId: 'u1', bondDays: 40, pet: { petId: 'dog', name: 'Rex', potw: true } },
            { userId: 'u2', bondDays: 20, pet: { petId: 'cat' } },
            { userId: 'u3', bondDays: 10, pet: { petId: 'mystery' } },
            { userId: 'u4', bondDays: 1, pet: { petId: 'fox' } },
        ]);

        const interaction = await run('leaderboard');

        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.title).toBe('🐾 Pet Leaderboard — Most Bonded Pets');
        const lines = embed.description.split('\n');
        expect(lines[0]).toMatch(/^🥇 🐶 \*\*Rex\*\* 🌟 — .* 40d — <@u1>$/);
        expect(lines[1]).toMatch(/^🥈 🐱 \*\*Cat\*\* — /);
        expect(lines[2]).toMatch(/^🥉 🐾 \*\*mystery\*\* — /);
        expect(lines[3]).toMatch(/^4\. 🦊 \*\*Fox\*\* — /);
        expect(pipelineOf()[0]).toEqual({ $match: { guildId: GUILD, 'pets.0': { $exists: true } } });
        expect(pipelineOf()[3]).toEqual({ $sort: { bondDays: -1 } });
    });

    test('by level marks evolved stages', async () => {
        mockUsers.model.aggregate.mockResolvedValueOnce([
            { userId: 'u1', pet: { petId: 'wolf', name: 'Alpha', level: 25, evolutionStage: 3 } },
            { userId: 'u2', pet: { petId: 'dog', level: 12, evolutionStage: 2 } },
            { userId: 'u3', pet: { petId: 'nope' } },
        ]);

        const interaction = await run('leaderboard', { type: 'level' });

        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.title).toContain('Highest Level Pets');
        expect(embed.description.split('\n')).toEqual([
            '🥇 🐺 **Alpha** 🌟 — Lv**25** — <@u1>',
            '🥈 🐶 **Dog** ✨ — Lv**12** — <@u2>',
            '🥉 🐾 **nope**  — Lv**1** — <@u3>',
        ]);
        expect(pipelineOf()[3]).toEqual({ $sort: { petLevel: -1 } });
    });

    test('by wins shows each record', async () => {
        mockUsers.model.aggregate.mockResolvedValueOnce([
            { userId: 'u1', pet: { petId: 'fox', name: 'Red', battleWins: 9, battleLosses: 2 } },
            { userId: 'u2', pet: { petId: 'bogus' } },
        ]);

        const interaction = await run('leaderboard', { type: 'wins' });

        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.title).toContain('Most Battle Wins');
        expect(embed.description.split('\n')).toEqual([
            '🥇 🦊 **Red** — ⚔️ 9W / 2L — <@u1>',
            '🥈 🐾 **bogus** — ⚔️ 0W / 0L — <@u2>',
        ]);
    });

    test('an empty server says so', async () => {
        const interaction = await run('leaderboard');

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe('*No pets in this server yet!*');
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
        expect(json.options.map(o => o.name)).toEqual(['adopt', 'status', 'feed', 'release', 'rename', 'list', 'leaderboard', 'battle']);
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
