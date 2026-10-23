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
const mockLadders = fakeCollection('PetLadder', { seasonNumber: 1, rev: 0, ratings: {} }, { unique: ['guildId'] });
const mockPending = fakeCollection('PendingPetBattle', { stakes: [] }, { unique: ['battleId'] });

let mockAfterLoad = null;

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/PetLadder', () => mockLadders.model);
jest.mock('../src/models/PendingPetBattle', () => mockPending.model);
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

const tick = () => new Promise(resolve => realSetTimeout(resolve, 0));

/** Polls `check` across ticks until it holds; false if it never does. */
async function until(check, tries = 400) {
    for (let i = 0; i < tries; i++) {
        if (check()) return true;
        await tick();
    }
    return false;
}

const componentIds = payload => (payload?.components ?? [])
    .flatMap(row => row.components ?? [])
    .map(c => c.data?.custom_id);
// The battle message as it stands: the last payload that was not an ephemeral
// answer to a press (a stance confirmation, a "not yours").
const onMessage = interaction => interaction.replies.filter(p => !p?.flags).at(-1);
const showing = (interaction, prefix) => componentIds(onMessage(interaction)).some(id => id?.startsWith(prefix));

/**
 * Starts /pet battle. A member battle now runs for several presses — the
 * accept, the defender's pick, each stance round — so the command is not
 * awaited to the end: this returns once it has settled or posted its
 * challenge, and `interaction.done` is the rest of it.
 */
async function battle(options = {}, extra = {}) {
    const interaction = makeInteraction({ subcommand: 'battle', options, holdCollectors: true, ...extra });
    interaction.options.get = name => (options[name] == null ? null : { value: options[name] });
    let finished = false;
    interaction.done = pet.execute(interaction).finally(() => { finished = true; });
    interaction.finished = () => finished;
    await until(() => finished || showing(interaction, 'petb_accept_'));
    await tick();
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
const baseUpdateOne = mockUsers.model.updateOne.getMockImplementation();
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
    mockLadders.reset();
    mockPending.reset();
    mockAfterLoad = null;
    mockFailSaveFor = null;
    mockUsers.model.findOne.mockImplementation(findOneLikeMongoose);
    mockUsers.model.updateOne.mockImplementation(baseUpdateOne);
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
        expect(stored.bond).toBe(1); // a fight is training, which counts as care
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

const STANCE = (round, stance, user) => ({ customId: `petb_st_interaction-1_${round}_${stance}`, user });
const PICK = (petId) => ({ customId: 'petb_pick_interaction-1', user: RIVAL, values: [petId] });
const PICK_DEFAULT = { customId: 'petb_pickgo_interaction-1', user: RIVAL };

/**
 * Plays the stance rounds of an accepted battle and waits for it to settle.
 * `mine` and `theirs` are each owner's stance per round; a null leaves that
 * owner silent, and the round's window is then closed as a timeout.
 */
async function play(interaction, { mine = ['guard', 'guard', 'guard'], theirs = ['guard', 'guard', 'guard'] } = {}) {
    for (let r = 1; r <= 3; r++) {
        const prefix = `petb_st_interaction-1_${r}_`;
        if (!await until(() => interaction.finished() || showing(interaction, prefix))) break;
        if (interaction.finished() || !showing(interaction, prefix)) break;
        await tick();
        if (mine[r - 1]) await interaction.press(STANCE(r, mine[r - 1], USER));
        if (theirs[r - 1]) await interaction.press(STANCE(r, theirs[r - 1], RIVAL));
        if (!mine[r - 1] || !theirs[r - 1]) interaction.endCollectors('time');
        // Wait for this round's reveal before looking for the next prompt.
        await until(() => interaction.finished() || !showing(interaction, prefix));
    }
    await interaction.done;
}

/** Accept, then play it out. */
async function acceptAndPlay(interaction, stances) {
    await interaction.press(ACCEPT);
    await play(interaction, stances);
}

const lastEmbed = interaction => interaction.replies.filter(p => p?.embeds?.length && !p.flags).at(-1).embeds[0].data;

describe('/pet battle against a member', () => {
    beforeEach(() => {
        // With Math.random pinned at 0.5 the fight is deterministic, and when
        // both owners pick the same stance a Loyal Lv.5 beats an Energetic
        // Lv.5 — so Rex wins unless a test says otherwise.
        seed(USER, { pets: [makePet({ _id: 'mine', name: 'Rex', personality: 'loyal' })], balance: 1000 });
        seed(RIVAL, { pets: [makePet({ _id: 'theirs', petId: 'cat', personality: 'energetic', name: 'Tom' })], balance: 1000 });
    });

    test('the challenge names both pets, the terms and the stance rule', async () => {
        const interaction = await challenge();

        const posted = interaction.replies[0];
        expect(posted.content).toBe(`<@${RIVAL}>`);
        const desc = posted.embeds[0].data.description;
        expect(desc).toContain("player's Rex** (Lv.5) challenges <@rival-1> to a battle!");
        expect(desc).toContain('🐱 **Tom** (Lv.5) will answer the call.');
        expect(desc).toContain('*Friendly match — pet XP only.*');
        expect(desc).toContain('Strike beats 🎭 Trick');
        expect(posted.components[0].components.map(c => c.data.custom_id))
            .toEqual(['petb_accept_interaction-1', 'petb_decline_interaction-1']);
        interaction.endCollectors('time');
        await interaction.done;
    });

    test('a wagered challenge states the stake', async () => {
        const interaction = await challenge({ bet: 250 });

        expect(interaction.replies[0].embeds[0].data.description).toContain('💰 Wager: **🪙250** each — winner takes the pot.');
        interaction.endCollectors('time');
        await interaction.done;
    });

    test('declining ends it with no coins moved', async () => {
        const interaction = await challenge({ bet: 100 });

        await interaction.press(DECLINE);
        await interaction.done;

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
        interaction.endCollectors('time');
        await interaction.done;
    });

    test('no answer in time says so', async () => {
        const interaction = await challenge();

        interaction.endCollectors('time');
        await interaction.done;

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe("rival didn't respond in time.");
    });

    test('a friendly match plays stance rounds, names both owners and records both sides', async () => {
        const interaction = await challenge();

        await acceptAndPlay(interaction);

        expect(petOf(USER)).toEqual(expect.objectContaining({ battleWins: 1, battleLosses: 0, pvpWins: 1, xp: 30 }));
        expect(petOf(RIVAL)).toEqual(expect.objectContaining({ battleWins: 0, battleLosses: 1, pvpLosses: 1, xp: 10 }));
        expect(petOf(USER).lastBattle).toBeInstanceOf(Date);
        expect(petOf(RIVAL).lastBattle).toBeInstanceOf(Date);
        // Only the challenger chose to fight, so only its pet gains bond.
        expect(petOf(USER).bond).toBe(1);
        expect(petOf(RIVAL).bond ?? 0).toBe(0);
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
        const titles = interaction.replies.map(p => p?.embeds?.[0]?.data?.title).filter(Boolean);
        expect(titles).toContain('⚔️ Battle commencing…');
        expect(titles).toContain('⚔️ Round 1 of 3 — choose your stance');
        expect(titles).toContain('⚔️ Round 1 — 🛡️ Guard vs 🛡️ Guard');
        const result = lastEmbed(interaction);
        expect(result.title).toBe('🏆 Rex wins the battle!');
        // Both owners are named.
        expect(result.description).toContain("**player**'s 🐶 **Rex** (Lv.5)  🆚  **rival**'s 🐱 **Tom** (Lv.5)");
        expect(result.description).toContain('✨ **Rex** +30 XP');
        expect(result.description).toContain('✨ **Tom** +10 XP');
        expect(result.description).toContain('🎯 Rounds won on stance: **player** 0 · **rival** 0');
        expect(result.description).not.toContain('pot');
    });

    test('each pick is confirmed to its owner alone, and a second press does not change it', async () => {
        const interaction = await challenge();
        await interaction.press(ACCEPT);
        await until(() => showing(interaction, 'petb_st_interaction-1_1_'));
        await tick();

        const first = await interaction.press(STANCE(1, 'strike', USER));
        const again = await interaction.press(STANCE(1, 'trick', USER));
        const outsider = await interaction.press(STANCE(1, 'trick', 'bystander'));

        expect(first.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'You chose 🗡️ Strike. Waiting for the reveal…' }));
        expect(again.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'You already chose 🗡️ Strike this round.' }));
        expect(outsider).toBeNull();
        await play(interaction, { mine: [null, 'guard', 'guard'], theirs: ['strike', 'guard', 'guard'] });
        expect(interaction.replies.map(p => p?.embeds?.[0]?.data?.title)).toContain('⚔️ Round 1 — 🗡️ Strike vs 🗡️ Strike');
    });

    test('reading the opponent wins a fight the stats would lose', async () => {
        // On even stances Rex wins (above). Tom's owner reads every round:
        // Trick beats Guard, so Tom hits harder and takes less each round.
        const interaction = await challenge();

        await acceptAndPlay(interaction, { mine: ['guard', 'guard', 'guard'], theirs: ['trick', 'trick', 'trick'] });

        const result = lastEmbed(interaction);
        expect(result.title).toBe('🏆 Tom wins the battle!');
        expect(result.description).toMatch(/Rounds won on stance: \*\*player\*\* 0 · \*\*rival\*\* [23]/);
        expect(interaction.replies.some(p => p?.embeds?.[0]?.data?.description?.includes('🎭 **Tom**\'s Trick slips past 🛡️ **Rex**\'s Guard'))).toBe(true);
        expect(petOf(RIVAL).pvpWins).toBe(1);
    });

    test('a player who does not pick gets a random stance, and the battle still settles', async () => {
        const interaction = await challenge({ bet: 100 });

        await acceptAndPlay(interaction, { mine: ['guard', 'guard', 'guard'], theirs: [null, null, null] });

        // Math.random pinned at 0.5 picks Guard, so the rounds are even and Rex wins.
        expect(interaction.replies.some(p => p?.embeds?.[0]?.data?.description?.includes("rival didn't pick in time — their stance was chosen at random."))).toBe(true);
        expect(lastEmbed(interaction).title).toBe('🏆 Rex wins the battle!');
        expect(wallet(USER)).toBe(1090);
        expect(wallet(RIVAL)).toBe(900);
    });

    test('a round neither owner picks in abandons the battle and refunds both stakes', async () => {
        const interaction = await challenge({ bet: 100 });

        await acceptAndPlay(interaction, { mine: [null], theirs: [null] });

        expect(lastEmbed(interaction).description)
            .toBe('Neither owner picked a stance — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
        expect(petOf(USER).battleWins).toBe(0);
        expect(petOf(RIVAL).battleLosses).toBe(0);
        expect(mockUsers.get(USER).paidPayouts.map(p => p.key)).toEqual(['pet:battle:interaction-1:user-1:refund']);
        expect(mockUsers.get(RIVAL).paidPayouts.map(p => p.key)).toEqual(['pet:battle:interaction-1:rival-1:refund']);
    });

    test('an error mid-battle hands both stakes back', async () => {
        const interaction = await challenge({ bet: 100 });
        // Every read after the escrow fails.
        mockUsers.model.findOne.mockImplementation(() => { throw new Error('db down'); });

        await interaction.press(ACCEPT);
        await interaction.done;

        expect(lastEmbed(interaction).description)
            .toBe('Something went wrong mid-battle — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
    });

    test('a wagered win pays the pot less the house cut, and the loser keeps the debit', async () => {
        const interaction = await challenge({ bet: 100 });

        await acceptAndPlay(interaction);

        // Both stakes escrowed (100 each), pot 200, 5% rake → 190 to the winner.
        expect(wallet(USER)).toBe(1090);
        expect(wallet(RIVAL)).toBe(900);
        expect(mockUsers.get(USER).paidPayouts.map(p => p.key)).toContain('pet:battle:interaction-1:user-1:payout');
        expect(lastEmbed(interaction).description)
            .toContain('🏆 **player** takes the pot: **+🪙90**  *(house kept 5%)*');
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ userId: RIVAL, amount: -100, note: 'Pet battle loss' }));
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, amount: 90, balance: 1090, note: 'Pet battle win' }));
    });

    test('a wager is fought level-matched, whatever the level gap', async () => {
        // Rex is eight levels up on Tom — once too far apart to wager at all.
        // Matched, both fight at Lv.5, where this Loyal Tom beats this Energetic Rex.
        mockUsers.get(USER).pets[0].level = 13;
        mockUsers.get(USER).pets[0].evolutionStage = 2;
        mockUsers.get(USER).pets[0].personality = 'energetic';
        mockUsers.get(RIVAL).pets[0].personality = 'loyal';

        const interaction = await challenge({ bet: 100 });
        expect(textOf(interaction)).toContain('Wagered battles are level-matched');
        await acceptAndPlay(interaction);

        const result = lastEmbed(interaction);
        expect(result.title).toBe('🏆 Tom wins the battle!');
        expect(result.description).toContain('(Lv.5)  🆚');
        expect(result.description).not.toContain('(Lv.13)');
        // The real pets keep their own levels and records.
        expect(petOf(USER).level).toBe(13);
        expect(petOf(RIVAL).battleWins).toBe(1);
    });

    test('a friendly match is not level-matched', async () => {
        mockUsers.get(USER).pets[0].level = 10;
        mockUsers.get(USER).pets[0].evolutionStage = 2;
        mockUsers.get(USER).pets[0].personality = 'energetic';
        mockUsers.get(RIVAL).pets[0].personality = 'loyal';

        const interaction = await challenge();
        await acceptAndPlay(interaction);

        const result = lastEmbed(interaction);
        expect(result.title).toBe('🏆 Seasoned Rex wins the battle!');
        expect(result.description).toContain('(Lv.10)');
    });

    test('the opponent can win, and a guild with no house cut pays the whole pot', async () => {
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, economy: { enabled: true, currency: '🪙', duelHouseCut: 0 } });
        mockUsers.get(USER).pets[0].personality = 'energetic';
        mockUsers.get(RIVAL).pets[0].personality = 'loyal';

        const interaction = await challenge({ bet: 100 });
        await acceptAndPlay(interaction);

        expect(wallet(USER)).toBe(900);
        expect(wallet(RIVAL)).toBe(1100);
        expect(petOf(RIVAL).battleWins).toBe(1);
        expect(petOf(USER).battleLosses).toBe(1);
        const desc = lastEmbed(interaction);
        expect(desc.title).toBe('🏆 Tom wins the battle!');
        expect(desc.description).toContain('🏆 **rival** takes the pot: **+🪙100**');
        expect(desc.description).not.toContain('house kept');
    });

    test('a challenger who spent the stake before the accept is not charged', async () => {
        const interaction = await challenge({ bet: 100 });
        mockUsers.get(USER).balance = 50;

        await interaction.press(ACCEPT);
        await interaction.done;

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe('player can no longer cover the wager.');
        expect(wallet(USER)).toBe(50);
        expect(wallet(RIVAL)).toBe(1000);
        expect(petOf(USER).battleWins).toBe(0);
    });

    test("an opponent who cannot cover the stake gets the challenger's stake refunded", async () => {
        mockUsers.get(RIVAL).balance = 40;
        const interaction = await challenge({ bet: 100 });

        await interaction.press(ACCEPT);
        await interaction.done;

        expect(interaction.replies.at(-1).embeds[0].data.description).toBe("rival can't cover the wager. Your wager was refunded.");
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(40);
        expect(mockUsers.get(USER).paidPayouts.map(p => p.key)).toEqual(['pet:battle:interaction-1:user-1:refund']);
    });

    test('a fighter that left the roster after the challenge cancels and refunds both stakes', async () => {
        const interaction = await challenge({ bet: 100 });
        mockUsers.get(USER).pets = [];

        await interaction.press(ACCEPT);
        await interaction.done;

        expect(lastEmbed(interaction).description)
            .toBe('A pet is no longer available — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
    });

    test('a fighter that went hungry after the challenge cancels it', async () => {
        const interaction = await challenge();
        mockUsers.get(USER).pets[0].hunger = 5;

        await interaction.press(ACCEPT);
        await interaction.done;

        expect(lastEmbed(interaction).description)
            .toBe('A pet is no longer battle-ready — the battle was cancelled.');
        expect(petOf(RIVAL).battleLosses).toBe(0);
    });

    test('a fighter that battled in the meantime cancels it and refunds', async () => {
        const interaction = await challenge({ bet: 100 });
        mockUsers.get(RIVAL).pets[0].lastBattle = new Date();

        await interaction.press(ACCEPT);
        await interaction.done;

        expect(lastEmbed(interaction).description)
            .toBe('A pet is now recovering from a recent battle — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
    });

    test('a wagered battle notes each stake while it runs, and clears the note once settled', async () => {
        const interaction = await challenge({ bet: 100 });
        await interaction.press(ACCEPT);
        await until(() => showing(interaction, 'petb_st_interaction-1_1_'));

        // Mid-battle, both stakes are on record for the restart sweep.
        expect(mockPending.all()).toEqual([expect.objectContaining({
            battleId: 'interaction-1', guildId: GUILD, challengerId: USER, opponentId: RIVAL, amount: 100, stakes: [USER, RIVAL],
        })]);
        await play(interaction);

        expect(mockPending.all()).toEqual([]);
        expect(wallet(USER)).toBe(1090);
    });

    test('an opponent stake debit that throws hands the challenger\'s stake back', async () => {
        const interaction = await challenge({ bet: 100 });
        const real = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate.mockImplementation(async (q, ...rest) => {
            if (q.userId === RIVAL && q.balance) throw new Error('db blip');
            return real(q, ...rest);
        });

        await interaction.press(ACCEPT);
        await interaction.done;
        mockUsers.model.findOneAndUpdate.mockImplementation(real);

        expect(lastEmbed(interaction).description).toBe("rival can't cover the wager. Your wager was refunded.");
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
        expect(mockPending.all()).toEqual([]);
    });

    test('a pet already claimed by another fight cancels this one, refunds it and frees the other pet', async () => {
        const interaction = await challenge({ bet: 100 });
        // The defender's pet is entered into another battle the moment before
        // this one claims it: its claim is lost, the challenger's is handed back.
        mockUsers.model.updateOne.mockImplementation(async (q, u, o) => {
            if (q.userId === RIVAL && u.$set?.['pets.$.lastBattle']) {
                mockUsers.get(RIVAL).pets[0].lastBattle = new Date();
            }
            return baseUpdateOne(q, u, o);
        });

        await interaction.press(ACCEPT);
        await interaction.done;

        expect(lastEmbed(interaction).description)
            .toBe('A pet is now recovering from a recent battle — the battle was cancelled. Both wagers have been refunded.');
        expect(wallet(USER)).toBe(1000);
        expect(wallet(RIVAL)).toBe(1000);
        expect(petOf(USER).lastBattle).toBeNull(); // released
        expect(petOf(USER).battleWins).toBe(0);
    });

    test('a pet claimed for a battle cannot be entered in a second one until it ends', async () => {
        const first = await challenge();
        await first.press(ACCEPT);
        await until(() => showing(first, 'petb_st_interaction-1_1_'));

        // The challenger's pet is now mid-fight; a second challenge sees it recovering.
        const second = await battle({ opponent: rival() });
        expect(textOf(second)).toMatch(/is recovering — ready to battle again in/);

        await play(first);
        expect(petOf(USER).battleWins).toBe(1);
    });

    test('a pot that cannot be paid is not announced as a win, and is recorded as owed', async () => {
        const interaction = await challenge({ bet: 100 });
        // The winner's document disappears once both pets are claimed for the
        // fight, so the keyed payout has nothing to land on.
        let claims = 0;
        mockUsers.model.updateOne.mockImplementation(async (...args) => {
            const res = await baseUpdateOne(...args);
            if (args[1]?.$set?.['pets.$.lastBattle'] && ++claims === 2) {
                const all = mockUsers.all();
                all.splice(all.findIndex(d => d.userId === USER), 1);
            }
            return res;
        });

        await acceptAndPlay(interaction);

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'petBattlePayout' }));
        const desc = lastEmbed(interaction).description;
        expect(desc).toContain('🏆 **player** won, but the **🪙190** pot could not be paid out — it is recorded and an admin can restore it.');
        expect(desc).not.toContain('takes the pot');
    });

    test('a result that could not be saved is still reported, with a warning', async () => {
        const interaction = await challenge();
        failSaveOf(RIVAL);

        await acceptAndPlay(interaction);

        const result = lastEmbed(interaction);
        expect(result.title).toBe('🏆 Rex wins the battle!');
        expect(result.description).toContain('⚠️ *The battle result could not be saved — pet XP, records and cooldowns were not updated.*');
        expect(petOf(RIVAL).battleLosses).toBe(0);
        expect(petOf(USER).battleWins).toBe(1);
    });
});

describe('/pet battle: the defender picks the pet', () => {
    beforeEach(() => {
        seed(USER, { pets: [makePet({ _id: 'mine', name: 'Rex', personality: 'loyal' })], balance: 1000 });
        seed(RIVAL, { pets: [
            makePet({ _id: 'close', petId: 'cat', personality: 'energetic', name: 'Tom' }),
            makePet({ _id: 'far', petId: 'fox', personality: 'lazy', name: 'Red', level: 12, evolutionStage: 2 }),
            makePet({ _id: 'hungry', petId: 'bird', name: 'Tweety', hunger: 5 }),
        ], balance: 1000 });
    });

    test('the challenge suggests the closest match, and accepting opens a menu of the ready pets', async () => {
        const interaction = await challenge();
        expect(interaction.replies[0].embeds[0].data.description)
            .toContain('rival picks which pet answers — the closest match is 🐱 **Tom** (Lv.5).');

        await interaction.press(ACCEPT);
        await until(() => showing(interaction, 'petb_pick_'));

        const menu = onMessage(interaction).components[0].components[0].toJSON();
        expect(menu.options.map(o => [o.value, o.default])).toEqual([['close', true], ['far', false]]);
        expect(onMessage(interaction).components[1].components[0].data.label).toBe('Fight with Tom');
        interaction.endCollectors('time');
        await play(interaction);
    });

    test('the pet the defender chooses is the one that fights', async () => {
        const interaction = await challenge();
        await interaction.press(ACCEPT);
        await until(() => showing(interaction, 'petb_pick_'));
        await tick();

        await interaction.press(PICK('far'));
        await play(interaction);

        const rival = mockUsers.get(RIVAL).pets;
        const far = rival.find(p => p._id === 'far');
        expect((far.pvpWins ?? 0) + (far.pvpLosses ?? 0)).toBe(1);
        expect(rival.find(p => p._id === 'close').pvpWins ?? 0).toBe(0);
        expect(rival.find(p => p._id === 'close').pvpLosses ?? 0).toBe(0);
        expect(lastEmbed(interaction).description).toContain("**rival**'s 🍂 **Seasoned Red** (Lv.12)");
    });

    test('taking the suggestion, or not choosing in time, fights with the closest match', async () => {
        for (const choose of [async i => i.press(PICK_DEFAULT), async i => i.endCollectors('time')]) {
            mockUsers.get(USER).pets[0].lastBattle = null;
            for (const p of mockUsers.get(RIVAL).pets) p.lastBattle = null;
            const interaction = await challenge();
            await interaction.press(ACCEPT);
            await until(() => showing(interaction, 'petb_pick_'));
            await tick();

            await choose(interaction);
            await play(interaction);

            expect(lastEmbed(interaction).description).toContain('🐱 **Tom** (Lv.5)');
        }
    });
});

describe('/pet battle rated (#1185)', () => {
    const ladder = () => mockLadders.get(GUILD);

    beforeEach(() => {
        seed(USER, { pets: [makePet({ _id: 'mine', name: 'Rex', personality: 'loyal' })], balance: 1000 });
        seed(RIVAL, { pets: [makePet({ _id: 'theirs', petId: 'cat', personality: 'energetic', name: 'Tom' })], balance: 1000 });
    });

    test('a rated battle needs a member, and two established accounts', async () => {
        expect(textOf(await battle({ rated: true }))).toBe('Rated battles are against members — challenge someone with `opponent`.');
        expect(textOf(await battle({ rated: true, opponent: rival({ createdTimestamp: Date.now() }) })))
            .toBe('Both accounts must be at least 7 days old for rated battles.');
    });

    test('a rated battle moves both ratings on the ladder in one write, and says so', async () => {
        const interaction = await challenge({ rated: true });
        expect(interaction.replies[0].embeds[0].data.title).toBe('⚔️ Rated Pet Battle Challenge!');

        await acceptAndPlay(interaction);

        expect(ladder().ratings.mine).toEqual(expect.objectContaining({ userId: USER, rating: 1216, wins: 1, losses: 0, games: 1 }));
        expect(ladder().ratings.theirs).toEqual(expect.objectContaining({ userId: RIVAL, rating: 1184, wins: 0, losses: 1, games: 1 }));
        const ratingWrites = mockLadders.writes.filter(w => w.op === 'findOneAndUpdate' && w.update.$set?.['ratings.mine']);
        expect(ratingWrites).toHaveLength(1);
        expect(Object.keys(ratingWrites[0].update.$set)).toEqual(['ratings.mine', 'ratings.theirs']);
        expect(lastEmbed(interaction).description).toContain('📊 **Rated · S1** — Rex 🥈 **1216** (+16) · Tom 🥈 **1184** (−16)');
    });

    test('two owners get three rated battles a day against each other, then friendly only', async () => {
        for (let n = 0; n < 3; n++) {
            mockUsers.get(USER).pets[0].lastBattle = null;
            mockUsers.get(RIVAL).pets[0].lastBattle = null;
            await acceptAndPlay(await challenge({ rated: true }));
        }
        const after3 = ladder().ratings.mine.rating;
        mockUsers.get(USER).pets[0].lastBattle = null;
        mockUsers.get(RIVAL).pets[0].lastBattle = null;

        const fourth = await challenge({ rated: true });

        expect(textOf(fourth)).toContain("you've already fought **3** rated battles against each other today");
        expect(ladder().ratings.mine.rating).toBe(after3);
        expect(ladder().ratings.mine.games).toBe(3);
    });

    test("a defender whose pets are all outside the rating band can't be challenged rated", async () => {
        mockLadders.seed({ guildId: GUILD, seasonNumber: 1, rev: 0, ratings: {
            mine:   { userId: USER,  rating: 1600, peak: 1600, wins: 9, losses: 0, games: 9, recent: [] },
            theirs: { userId: RIVAL, rating: 1200, peak: 1200, wins: 0, losses: 0, games: 1, recent: [] },
        } });

        const interaction = await challenge({ rated: true });

        expect(textOf(interaction)).toBe("None of rival's battle-ready pets is within the rating band of yours.");
    });
});
