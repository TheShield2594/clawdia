'use strict';

/**
 * #998 — /pet battle, driven end to end: the refusals, a wild fight won and
 * lost, and the PvP challenge — declined, timed out, accepted friendly and
 * accepted for a wager — with the escrow, payout and refunds landing in the
 * shared fakeCollection store, which evaluates their guards for real.
 *
 * Math.random is pinned to 0.5, which makes every roll in the battle engine
 * neutral (no crit, no variance) and picks the Stray Hound at the player's own
 * level as the wild opponent. With that pinned an energetic pet beats a same-
 * level opponent and a lazy level-1 pet loses, which is what the win and loss
 * cases lean on.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, pets: [], deceasedPets: [], inventory: [], paidPayouts: [],
});
mockUsers.model.DECEASED_PET_LIMIT = 5;
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

let mockAfterLoad = null;

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/grindProfile', () => ({
    attachGrind: jest.fn(async user => { if (mockAfterLoad) mockAfterLoad(user); return user; }),
}));
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
const { logTransaction } = require('../src/utils/logTransaction');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { onPetCare } = require('../src/services/questService');
const { getItemImageAttachment } = require('../src/utils/itemImageHelper');

const GUILD = 'guild-1';
const USER = 'user-1';
const RIVAL = 'rival-1';
const DAY = 86_400_000;
const ACCEPT = { customId: 'petb_accept_interaction-1', user: RIVAL };
const DECLINE = { customId: 'petb_decline_interaction-1', user: RIVAL };

const wallet = id => mockUsers.get(id)?.balance;
const petOf = id => mockUsers.get(id).pets[0];

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
    personality: 'energetic',
    level: 5,
    xp: 0,
    evolutionStage: 1,
    battleWins: 0,
    battleLosses: 0,
    ...overrides,
});

const seed = (userId, fields = {}) => mockUsers.seed({ userId, guildId: GUILD, ...fields });

const rival = (overrides = {}) => ({
    id: RIVAL,
    username: 'rival',
    bot: false,
    createdTimestamp: Date.now() - 365 * DAY,
    toString() { return `<@${this.id}>`; },
    ...overrides,
});

const textOf = interaction => interaction.replies
    .map(p => (typeof p === 'string' ? p : repliedText({ replies: [p] })))
    .join('\n');

/** Starts /pet battle. PvP collectors are held open so a test can act before pressing. */
async function battle(options = {}, extra = {}) {
    const interaction = makeInteraction({ subcommand: 'battle', options, holdCollectors: true, ...extra });
    interaction.options.get = name => (options[name] == null ? null : { value: options[name] });
    await pet.execute(interaction);
    return interaction;
}

/** A challenge that has been issued; `press` answers it and waits for the fight to settle. */
async function challenge(options = {}) {
    return battle({ opponent: rival(), ...options });
}

/**
 * The fake's `save()` writes every field back, where Mongoose writes only the
 * paths that changed. PvP re-reads both fighters *after* escrow and saves them
 * *after* the pot is paid on its own keyed write; `saveWithBalanceDelta`
 * rewinds and unmarks `balance` precisely so that save leaves it alone. Written
 * back wholesale, the stale post-escrow figure (and the payout-key ledger read
 * before the payout) would erase the payout — a fake artefact, not the
 * command's behaviour — so those paths are only written here when the command
 * marked them modified, as Mongoose would.
 */
const LEDGER_PATHS = ['balance', 'paidPayouts'];
const baseFindOne = mockUsers.model.findOne.getMockImplementation();
let mockFailSaveFor = null;
function findOneLikeMongoose(query, ...rest) {
    return baseFindOne(query, ...rest).then(doc => {
        if (!doc) return doc;
        const save = doc.save;
        doc.save = jest.fn(async () => {
            if (mockFailSaveFor && doc.userId === mockFailSaveFor) throw new Error('disk full');
            const marked = new Set(doc.markModified.mock.calls.map(([path]) => path));
            const storedDoc = mockUsers.get(doc.userId);
            const kept = LEDGER_PATHS.filter(path => !marked.has(path)).map(path => [path, storedDoc?.[path]]);
            await save();
            if (storedDoc) for (const [path, value] of kept) storedDoc[path] = value;
            return doc;
        });
        return doc;
    });
}

/** Makes every re-read document for `userId` fail its save. */
function failSaveOf(userId) {
    mockFailSaveFor = userId;
}

const realSetTimeout = global.setTimeout;

beforeEach(() => {
    jest.clearAllMocks();
    mockUsers.reset();
    mockGuilds.reset();
    mockAfterLoad = null;
    mockFailSaveFor = null;
    mockUsers.model.findOne.mockImplementation(findOneLikeMongoose);
    mockGuilds.seed({ guildId: GUILD, economy: { enabled: true, currency: '🪙' } });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // The battle's dramatic pauses are real 1.5–1.8s timers; collapse the long
    // ones so the suite does not wait on them. Short ones (the harness's own
    // next-tick delivery) run as they are.
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...args));
});

afterEach(() => jest.restoreAllMocks());

// ─── Refusals before any fight ──────────────────────────────────────────────────

describe('/pet battle refusals', () => {
    test('the economy being off refuses everything', async () => {
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, economy: { enabled: false } });

        const interaction = await battle();

        expect(textOf(interaction)).toBe('The economy is disabled in this server.');
    });

    test('no pet is refused', async () => {
        seed(USER);

        const interaction = await battle();

        expect(textOf(interaction)).toContain("Couldn't find that pet");
    });

    test('a hungry pet is refused', async () => {
        seed(USER, { pets: [makePet({ hunger: 10, name: 'Rex' })] });

        const interaction = await battle();

        expect(textOf(interaction)).toBe('Rex is too hungry to fight (feed it first).');
    });

    test('a pet that fought in the last ten minutes is recovering', async () => {
        seed(USER, { pets: [makePet({ lastBattle: new Date(Date.now() - 3 * 60_000) })] });

        const interaction = await battle();

        expect(textOf(interaction)).toBe('🐶 **Dog** is recovering — ready to battle again in **7m**.');
    });

    test('a wager needs an opponent', async () => {
        seed(USER, { pets: [makePet()], balance: 500 });

        const interaction = await battle({ bet: 100 });

        expect(textOf(interaction)).toBe("You can't wager against a wild pet — challenge a member instead.");
        expect(wallet(USER)).toBe(500);
    });

    test.each([
        ['yourself, wagered',     { opponent: rival({ id: USER }), bet: 10 },            "You can't wager against yourself."],
        ['a bot, wagered',        { opponent: rival({ bot: true }), bet: 10 },           "Bots don't keep pets."],
        ['over the wager cap',    { opponent: rival(), bet: 10_001 },                    'The maximum battle wager here is **10,000** coins.'],
        ['a new account, wagered', { opponent: rival({ createdTimestamp: Date.now() }), bet: 10 }, 'Both accounts must be at least 7 days old for wagered battles.'],
        ['yourself, friendly',    { opponent: rival({ id: USER }) },                     'Pick another member to battle.'],
        ['a bot, friendly',       { opponent: rival({ bot: true }) },                    'Pick another member to battle.'],
    ])('challenging %s is refused', async (_label, options, expected) => {
        seed(USER, { pets: [makePet()], balance: 50_000 });
        seed(RIVAL, { pets: [makePet({ _id: 'rp' })], balance: 50_000 });

        const interaction = await battle(options);

        expect(textOf(interaction)).toBe(expected);
        expect(wallet(USER)).toBe(50_000);
    });

    test('the guild can lower the wager cap', async () => {
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, economy: { enabled: true, duelMaxBet: 50 } });
        seed(USER, { pets: [makePet()], balance: 500 });

        const interaction = await battle({ opponent: rival(), bet: 51 });

        expect(textOf(interaction)).toBe('The maximum battle wager here is **50** coins.');
    });

    test('an opponent with no fed pet is refused', async () => {
        seed(USER, { pets: [makePet()] });
        seed(RIVAL, { pets: [makePet({ _id: 'rp', hunger: 5 })] });

        const interaction = await challenge();

        expect(textOf(interaction)).toBe('rival has no battle-ready pet (they need a fed pet).');
    });

    test('an opponent with no document at all is refused the same way', async () => {
        seed(USER, { pets: [makePet()] });

        const interaction = await challenge();

        expect(textOf(interaction)).toContain('rival has no battle-ready pet');
    });

    test('a wagered match more than five levels apart is refused, friendly is offered', async () => {
        seed(USER, { pets: [makePet({ level: 12 })], balance: 1000 });
        seed(RIVAL, { pets: [makePet({ _id: 'rp', level: 3 })], balance: 1000 });

        const interaction = await challenge({ bet: 100 });

        expect(textOf(interaction)).toMatch(/limited to a \*\*5-level\*\* gap.*\*\*Lv\.3\*\* against your \*\*Lv\.12\*\*/);
        expect(wallet(USER)).toBe(1000);
    });
});

// ─── Wild battles ───────────────────────────────────────────────────────────────

describe('/pet battle against a wild pet', () => {
    test('a win records the win, the XP and the cooldown, and shows the fight', async () => {
        // Low rolls: a Lv.4 Wild Boar, Rex opens, and no crits.
        Math.random.mockReturnValue(0.1);
        seed(USER, { pets: [makePet({ name: 'Rex' })] });

        const interaction = await battle();

        const stored = petOf(USER);
        expect(stored.battleWins).toBe(1);
        expect(stored.battleLosses).toBe(0);
        expect(stored.pvpWins).toBeUndefined(); // wild wins never count toward PvP
        expect(stored.xp).toBe(22);
        expect(stored.lastBattle).toBeInstanceOf(Date);
        expect(interaction.replies[1].embeds[0].data.title).toBe('⚔️ A wild challenger appears!');
        expect(interaction.replies[1].embeds[0].data.description).toContain('Wild Boar** (Lv.4)');
        const result = interaction.replies.at(-1).embeds[0].data;
        expect(result.title).toBe('🏆 Rex won the wild battle!');
        expect(result.description).toContain('✨ **Rex** +22 XP');
        expect(result.description).toMatch(/• \*\*Rex\*\* hits \*\*Wild Boar\*\* for \*\*\d+\*\*/);
        expect(onPetCare).toHaveBeenCalledTimes(1);
    });

    test('the wild opponent shows its own emoji and its portrait when one ships', async () => {
        getItemImageAttachment.mockResolvedValueOnce({ url: 'attachment://wild.png', attachment: { name: 'wild.png' } });
        seed(USER, { pets: [makePet({ name: 'Rex' })] });

        const interaction = await battle();

        const intro = interaction.replies[1];
        expect(intro.embeds[0].data.description).toContain('🐕 **Stray Hound**'); // Math.random pinned at 0.5
        expect(intro.embeds[0].data.thumbnail.url).toBe('attachment://wild.png');
        const last = interaction.replies.at(-1);
        expect(last.embeds[0].data.thumbnail.url).toBe('attachment://wild.png');
        expect(last.files).toHaveLength(1);
    });

    test('a loss records the loss and the smaller XP', async () => {
        seed(USER, { pets: [makePet({ personality: 'lazy', level: 1 })] });

        const interaction = await battle();

        const stored = petOf(USER);
        expect(stored.battleWins).toBe(0);
        expect(stored.battleLosses).toBe(1);
        expect(stored.xp).toBe(8);
        expect(interaction.replies.at(-1).embeds[0].data.title).toBe('💀 Dog was beaten back…');
    });

    test('a win that levels the pet up says so', async () => {
        Math.random.mockReturnValue(0.1); // a Lv.1 Wild Boar, and the Dog opens
        seed(USER, { pets: [makePet({ level: 1, xp: 50 })] });

        const interaction = await battle();

        expect(petOf(USER).level).toBe(2);
        expect(interaction.replies.at(-1).embeds[0].data.description).toContain('📈 **Dog** reached Level 2! (+22 XP)');
    });

    test('the pet named in the slot option is the one that fights', async () => {
        Math.random.mockReturnValue(0.1); // a Lv.4 opponent Red opens on, so Red wins
        seed(USER, { pets: [makePet({ _id: 'a', hunger: 5 }), makePet({ _id: 'b', petId: 'fox', name: 'Red' })] });

        await battle({ slot: 'b' });

        expect(mockUsers.get(USER).pets.map(p => p.battleWins)).toEqual([0, 1]);
    });

    test('a lost version race is reported and nothing is recorded', async () => {
        seed(USER, { pets: [makePet()] });
        mockAfterLoad = user => {
            user.save = jest.fn(async () => { throw Object.assign(new Error('stale'), { name: 'VersionError' }); });
        };

        const interaction = await battle();

        expect(interaction.replies.at(-1).content).toBe('Edit conflict — please try again.');
        expect(petOf(USER).battleWins).toBe(0);
    });

    test('any other save failure reaches the command-wide handler', async () => {
        seed(USER, { pets: [makePet()] });
        mockAfterLoad = user => {
            let saves = 0;
            // The opening save swallows its failure; the result save does not.
            user.save = jest.fn(async () => { if (++saves > 1) throw new Error('disk full'); });
        };

        const interaction = await battle();

        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: 'Something went wrong with the pet command.' }));
    });
});

// ─── PvP ────────────────────────────────────────────────────────────────────────

describe('/pet battle against a member', () => {
    beforeEach(() => {
        // With Math.random pinned at 0.5 the fight is deterministic, and a Loyal
        // Lv.5 beats an Energetic Lv.5 — so Rex wins unless a test says otherwise.
        seed(USER, { pets: [makePet({ _id: 'mine', name: 'Rex', personality: 'loyal' })], balance: 1000 });
        seed(RIVAL, { pets: [makePet({ _id: 'theirs', petId: 'cat', personality: 'energetic', name: 'Tom' })], balance: 1000 });
    });

    test('the challenge names both pets and the terms', async () => {
        const interaction = await challenge();

        const posted = interaction.replies[0];
        expect(posted.content).toBe(`<@${RIVAL}>`);
        const desc = posted.embeds[0].data.description;
        expect(desc).toContain("player's Rex** (Lv.5) challenges <@rival-1> to a battle!");
        expect(desc).toContain('🐱 **Tom** (Lv.5) will answer the call.');
        expect(desc).toContain('*Friendly match — pet XP only.*');
        expect(posted.components[0].components.map(c => c.data.custom_id))
            .toEqual(['petb_accept_interaction-1', 'petb_decline_interaction-1']);
    });

    test('a wagered challenge states the stake', async () => {
        const interaction = await challenge({ bet: 250 });

        expect(interaction.replies[0].embeds[0].data.description).toContain('💰 Wager: **🪙250** each — winner takes the pot.');
    });

    test('declining ends it with no coins moved', async () => {
        const interaction = await challenge({ bet: 100 });

        await interaction.press(DECLINE);

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe('rival declined the battle.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
        expect(petOf(USER).battleWins).toBe(0);
    });

    test('only the challenged member can answer', async () => {
        const interaction = await challenge();

        const delivered = await interaction.press({ ...ACCEPT, user: 'bystander' });

        expect(delivered).toBeNull();
        expect(petOf(USER).battleWins).toBe(0);
    });

    test('no answer in time says so', async () => {
        const interaction = await challenge();

        interaction.endCollectors('time');

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe("rival didn't respond in time.");
    });

    test('a friendly match records both sides and pays nothing', async () => {
        const interaction = await challenge();

        await interaction.press(ACCEPT);

        expect(petOf(USER)).toEqual(expect.objectContaining({ battleWins: 1, battleLosses: 0, pvpWins: 1, xp: 30 }));
        expect(petOf(RIVAL)).toEqual(expect.objectContaining({ battleWins: 0, battleLosses: 1, pvpLosses: 1, xp: 10 }));
        expect(petOf(USER).lastBattle).toBeInstanceOf(Date);
        expect(petOf(RIVAL).lastBattle).toBeInstanceOf(Date);
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
        const result = interaction.replies.at(-1).embeds[0].data;
        expect(result.title).toBe('🏆 Rex wins the battle!');
        expect(result.description).toContain('✨ **Rex** +30 XP');
        expect(result.description).toContain('✨ **Tom** +10 XP');
        expect(result.description).not.toContain('pot');
        expect(interaction.replies.some(p => p.embeds?.[0]?.data?.title === '⚔️ Battle commencing…')).toBe(true);
    });

    test('a wagered win pays the pot less the house cut, and the loser keeps the debit', async () => {
        const interaction = await challenge({ bet: 100 });

        await interaction.press(ACCEPT);

        // Both stakes escrowed (100 each), pot 200, 5% rake → 190 to the winner.
        expect(wallet(USER)).toBe(1090);
        expect(wallet(RIVAL)).toBe(900);
        expect(mockUsers.get(USER).paidPayouts.map(p => p.key)).toContain('pet:battle:interaction-1:user-1:payout');
        expect(interaction.replies.at(-1).embeds[0].data.description)
            .toContain('🏆 **player** takes the pot: **+🪙90**  *(house kept 5%)*');
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ userId: RIVAL, amount: -100, note: 'Pet battle loss' }));
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, amount: 90, balance: 1090, note: 'Pet battle win' }));
    });

    test('a wager is fought level-matched, so a level lead does not decide it', async () => {
        // Rex is five levels up on Tom. Unmatched, that lead wins every time;
        // matched, both fight at Lv.5, where this Loyal Tom beats this Energetic Rex.
        mockUsers.get(USER).pets[0].level = 10;
        mockUsers.get(USER).pets[0].evolutionStage = 2;
        mockUsers.get(USER).pets[0].personality = 'energetic';
        mockUsers.get(RIVAL).pets[0].personality = 'loyal';

        const interaction = await challenge({ bet: 100 });
        expect(textOf(interaction)).toContain('Wagered battles are level-matched');
        await interaction.press(ACCEPT);

        const result = interaction.replies.at(-1).embeds[0].data;
        expect(result.title).toBe('🏆 Tom wins the battle!');
        expect(result.description).toContain('(Lv.5)  🆚');
        expect(result.description).not.toContain('(Lv.10)');
        // The real pets keep their own levels and records.
        expect(petOf(USER).level).toBe(10);
        expect(petOf(RIVAL).battleWins).toBe(1);
    });

    test('a friendly match is not level-matched', async () => {
        mockUsers.get(USER).pets[0].level = 10;
        mockUsers.get(USER).pets[0].evolutionStage = 2;
        mockUsers.get(USER).pets[0].personality = 'energetic';
        mockUsers.get(RIVAL).pets[0].personality = 'loyal';

        const interaction = await challenge();
        await interaction.press(ACCEPT);

        const result = interaction.replies.at(-1).embeds[0].data;
        expect(result.title).toBe('🏆 Seasoned Rex wins the battle!');
        expect(result.description).toContain('(Lv.10)');
    });

    test('the opponent can win, and a guild with no house cut pays the whole pot', async () => {
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, economy: { enabled: true, currency: '🪙', duelHouseCut: 0 } });
        mockUsers.get(USER).pets[0].personality = 'energetic';
        mockUsers.get(RIVAL).pets[0].personality = 'loyal';

        const interaction = await challenge({ bet: 100 });
        await interaction.press(ACCEPT);

        expect(wallet(USER)).toBe(900);
        expect(wallet(RIVAL)).toBe(1100);
        expect(petOf(RIVAL).battleWins).toBe(1);
        expect(petOf(USER).battleLosses).toBe(1);
        const desc = interaction.replies.at(-1).embeds[0].data;
        expect(desc.title).toBe('🏆 Tom wins the battle!');
        expect(desc.description).toContain('🏆 **rival** takes the pot: **+🪙100**');
        expect(desc.description).not.toContain('house kept');
    });

    test('a challenger who spent the stake before the accept is not charged', async () => {
        const interaction = await challenge({ bet: 100 });
        mockUsers.get(USER).balance = 50;

        await interaction.press(ACCEPT);

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe('player can no longer cover the wager.');
        expect(wallet(USER)).toBe(50);
        expect(wallet(RIVAL)).toBe(1000);
        expect(petOf(USER).battleWins).toBe(0);
    });

    test("an opponent who cannot cover the stake gets the challenger's stake refunded", async () => {
        mockUsers.get(RIVAL).balance = 40;
        const interaction = await challenge({ bet: 100 });

        await interaction.press(ACCEPT);

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe("rival can't cover the wager. Your wager was refunded.");
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(40);
        expect(mockUsers.get(USER).paidPayouts.map(p => p.key)).toEqual(['pet:battle:interaction-1:user-1:refund']);
    });

    test('a fighter that left the roster after the challenge cancels and refunds both stakes', async () => {
        const interaction = await challenge({ bet: 100 });
        mockUsers.get(USER).pets = [];

        await interaction.press(ACCEPT);

        expect(interaction.replies.at(-1).embeds[0].data.description)
            .toBe('A pet is no longer available — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
    });

    test('a fighter that went hungry after the challenge cancels it', async () => {
        const interaction = await challenge();
        // Only the challenger's pet is pinned by id; the defender is re-picked
        // from the ready pets, so it is the challenger's that goes hungry.
        mockUsers.get(USER).pets[0].hunger = 5;

        await interaction.press(ACCEPT);

        expect(interaction.replies.at(-1).embeds[0].data.description)
            .toBe('A pet is no longer battle-ready — the battle was cancelled.');
        expect(petOf(RIVAL).battleLosses).toBe(0);
    });

    test('a fighter that battled in the meantime cancels it and refunds', async () => {
        const interaction = await challenge({ bet: 100 });
        mockUsers.get(RIVAL).pets[0].lastBattle = new Date();

        await interaction.press(ACCEPT);

        expect(interaction.replies.at(-1).embeds[0].data.description)
            .toBe('A pet is now recovering from a recent battle — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
    });

    // #873. The wager's 5-level limit was checked only at the challenge, but the
    // defender is re-picked at Accept — so a wager could be fought across any
    // gap, by a pet the challenge never named or one that levelled since.
    test('a wager whose fighters are now over the level gap cancels and refunds both stakes', async () => {
        const interaction = await challenge({ bet: 100 });
        mockUsers.get(RIVAL).pets[0].level = (mockUsers.get(USER).pets[0].level ?? 1) + 6;

        await interaction.press(ACCEPT);

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe(
            'The pets that would fight are now more than 5 levels apart, the limit for a wagered battle — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
    });

    test('a pot that cannot be paid is not announced as a win, and is recorded as owed', async () => {
        const interaction = await challenge({ bet: 100 });
        // The winner's document disappears after the fighters are re-read, so
        // the keyed payout has nothing to land on.
        let reads = 0;
        mockUsers.model.findOne.mockImplementation((...args) => {
            const q = findOneLikeMongoose(...args);
            if (++reads === 2) {
                const all = mockUsers.all();
                all.splice(all.findIndex(d => d.userId === USER), 1);
            }
            return q;
        });

        await interaction.press(ACCEPT);

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'petBattlePayout' }));
        const desc = interaction.replies.at(-1).embeds[0].data.description;
        expect(desc).toContain('🏆 **player** won, but the **🪙190** pot could not be paid out — it is recorded and an admin can restore it.');
        expect(desc).not.toContain('takes the pot');
    });

    test('a result that could not be saved is still reported, with a warning', async () => {
        const interaction = await challenge();
        failSaveOf(RIVAL);

        await interaction.press(ACCEPT);

        const result = interaction.replies.at(-1).embeds[0].data;
        const desc = result.description;
        expect(result.title).toBe('🏆 Rex wins the battle!');
        expect(desc).toContain('⚠️ *The battle result could not be saved — pet XP, records and cooldowns were not updated.*');
        expect(petOf(RIVAL).battleLosses).toBe(0);
        expect(petOf(USER).battleWins).toBe(1);
    });
});
