'use strict';

/**
 * A casino replay is a new hand, and answers to the guild as a new hand does
 * (#873, pass 12).
 *
 * The bet guards — the casino's three switches and `casinoMaxBet` — ran once per
 * *command*. Every game but blackjack, coinflip and dice ends its hand with a
 * "Play Again" that stakes the same bet again from a button whose collector
 * re-arms itself on every replay, and none of those replays asked again. An
 * admin who closed the casino or lowered the limit did so for new commands
 * only; a player holding a replay button kept playing at the old stake.
 *
 * Also here, because they are the same pass over the same collectors: the two
 * replays that took a stake and then acknowledged the press with a call that
 * could throw before anything that could return the stake had started, and
 * slots' Hot Reel, whose loss streak two spins in flight at once could both
 * spend.
 */

const fs   = require('fs');
const path = require('path');

jest.mock('../src/models/User', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
    updateMany:       jest.fn(),
    create:           jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
}));
jest.mock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
// A replay reads the settings as they are *now*; the first hand read them off
// its own Guild query. Mocking the cache is what lets a test change them in
// between, the way an admin does.
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));

const { MessageFlags } = require('discord.js');
const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { casinoRefusal, replayRefusal } = require('../src/games/casino/betGuard');
const { makeInteraction } = require('./helpers/fakeInteraction');
const { walletDoc, GUILD_ID, USER_ID, BET } = require('./helpers/casinoInteraction');

const OPEN = { guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true, casinoEnabled: true } };

const guildQuery = doc => Object.assign(Promise.resolve(doc), {
    lean: () => Object.assign(Promise.resolve(doc), { catch: () => Promise.resolve(doc) }),
});

/** The compare-and-set that takes a stake. */
const guardedDebits = () => User.findOneAndUpdate.mock.calls.filter(([filter]) => filter?.balance?.$gte !== undefined);

let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Guild.findOne.mockImplementation(() => guildQuery(OPEN));
    Guild.updateOne.mockResolvedValue({});
    Guild.findOneAndUpdate.mockResolvedValue(null);
    User.findOneAndUpdate.mockImplementation(async () => walletDoc());
    User.findOne.mockImplementation(() => guildQuery(walletDoc()));
    User.updateOne.mockResolvedValue({});
    User.updateMany.mockResolvedValue({});
    getGuildSettings.mockResolvedValue(OPEN);
});

afterEach(() => errorSpy.mockRestore());

// ─── The rule ──────────────────────────────────────────────────────────────────

describe('casinoRefusal', () => {
    test.each([
        ['the economy is off',       { enabled: false },       /economy is disabled/],
        ['economy games are off',    { gamesEnabled: false },  /games are disabled/],
        ['the casino is off',        { casinoEnabled: false }, /Casino games are disabled/],
        ['the bet is over the limit', { casinoMaxBet: BET - 1 }, /bet limit on this server is \*\*99\*\*/],
    ])('refuses when %s', (_, economy, reason) => {
        expect(casinoRefusal({ economy: { ...OPEN.economy, ...economy } }, BET)).toMatch(reason);
    });

    test.each([
        ['an open casino',              OPEN],
        ['a bet exactly at the limit',  { economy: { ...OPEN.economy, casinoMaxBet: BET } }],
        ['a limit of 0, which is none', { economy: { ...OPEN.economy, casinoMaxBet: 0 } }],
        ['a guild with no settings yet', null],
    ])('takes the bet for %s', (_, settings) => {
        expect(casinoRefusal(settings, BET)).toBeNull();
    });
});

describe('replayRefusal', () => {
    test('reads the settings as they are now', async () => {
        getGuildSettings.mockResolvedValue({ economy: { casinoEnabled: false } });
        expect(await replayRefusal(GUILD_ID, BET)).toMatch(/Casino games are disabled/);
        expect(getGuildSettings).toHaveBeenCalledWith(GUILD_ID);
    });

    test('fails closed when the settings cannot be read', async () => {
        // A refused replay costs one press; one let through on a failed read is
        // the bypass itself.
        getGuildSettings.mockRejectedValue(new Error('mongo is down'));
        expect(await replayRefusal(GUILD_ID, BET)).toMatch(/could not check/);
    });
});

// ─── The replays ───────────────────────────────────────────────────────────────

/**
 * Plays one hand, then presses its replay button.
 *
 * The replay button's id carries `Date.now()`, so it is read off the hand's
 * own final render at the moment the press is delivered rather than guessed.
 */
async function playThenReplay(game, options, replayPrefix) {
    const replayIdNow = interaction => interaction.replies
        .flatMap(r => r?.components ?? [])
        .flatMap(row => row.components ?? [])
        .map(c => c.data?.custom_id)
        .filter(id => id?.startsWith(replayPrefix))
        .at(-1);

    let interaction = null;
    const press = { get customId() { return interaction ? replayIdNow(interaction) : undefined; } };
    interaction = makeInteraction({ options, userId: USER_ID, guildId: GUILD_ID, components: [press] });

    const run = require(`../src/games/casino/${game}`).execute(interaction, { releaseLock: jest.fn(), onWager: jest.fn() });
    for (let i = 0; i < 400; i++) await jest.advanceTimersByTimeAsync(250);
    await run;
    return interaction;
}

const REPLAYS = [
    ['slots',    { bet: BET },                                   'slots_replay_'],
    ['roulette', { bet: 'red', amount: BET, number: null },      'roulette_replay_'],
    ['keno',     { bet: BET, numbers: '3 12 21 33 39' },         'keno_replay_'],
];

describe.each(REPLAYS)('/casino %s — the replay asks again', (game, options, prefix) => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('a replay still plays while the casino is open', async () => {
        // The control: without it, "no second debit" below would also pass for
        // a press that never reached the handler.
        await playThenReplay(game, options, prefix);
        expect(guardedDebits()).toHaveLength(2);
    }, 30_000);

    test('a replay after the casino closes is refused, and takes nothing', async () => {
        getGuildSettings.mockResolvedValue({ economy: { ...OPEN.economy, casinoEnabled: false } });

        const interaction = await playThenReplay(game, options, prefix);

        expect(guardedDebits()).toHaveLength(1);
        expect(interaction.replies).toContainEqual({
            content: 'Casino games are disabled on this server.', flags: MessageFlags.Ephemeral,
        });
    }, 30_000);

    test('a replay over a limit lowered since the first hand is refused', async () => {
        getGuildSettings.mockResolvedValue({ economy: { ...OPEN.economy, casinoMaxBet: BET - 1 } });

        const interaction = await playThenReplay(game, options, prefix);

        expect(guardedDebits()).toHaveLength(1);
        expect(interaction.replies.map(r => r?.content ?? '').join(' ')).toMatch(/bet limit/);
    }, 30_000);
});

describe('every replay site asks before it stakes', () => {
    const SRC  = path.join(__dirname, '..', 'src', 'games', 'casino');
    const read = file => fs.readFileSync(path.join(SRC, file), 'utf8');
    const countOf = (src, needle) => src.split(needle).length - 1;

    // Poker, higher-or-lower and Monte need several presses to reach their
    // replay button, so their sites are held here; the behaviour is the one the
    // three games above drive end to end.
    test.each([
        ['slots.js', 1], ['roulette.js', 1], ['keno.js', 1],
        ['poker.js', 1], ['higherlower.js', 1], ['cupgame.js', 2],
    ])('%s checks each of its replay buttons', (file, sites) => {
        expect(countOf(read(file), 'await replayRefusal(interaction.guild.id,')).toBe(sites);
    });

    test('every game checks its opening bet through the one rule', () => {
        for (const file of fs.readdirSync(SRC).filter(f => read(f).includes('confirmBet('))) {
            const src = read(file);
            expect(src).toContain('casinoRefusal(guildSettings, bet)');
            expect(src).not.toMatch(/bet > casinoMaxBet/);
        }
    });

    test('a replay that has taken its stake cannot throw before the hand starts', () => {
        // keno's reroll and higher-or-lower's replay debit in the collector and
        // only then acknowledge the press. A rejected acknowledgement used to
        // escape with the stake gone and nothing started that could return it.
        expect(read('keno.js')).toMatch(/await i\.deferUpdate\(\)\.catch\(\(\) => \{\}\);\s+await playKeno\(interaction, rerollCost/);
        expect(read('higherlower.js')).toMatch(/await ri\.deferUpdate\(\)\.catch\(\(\) => \{\}\);\s+await playHigherLower\(/);
    });
});

// ─── Slots' Hot Reel ───────────────────────────────────────────────────────────

describe('/casino slots — the Hot Reel streak is claimed, not read', () => {
    const slots = require('../src/games/casino/slots');
    // Cherry, Lemon, Grape: three different regulars, a loss on every reel the
    // Hot Reel can lock the first one to as well.
    const LOSING_REELS = [0.01, 0.3, 0.6];

    let randomSpy;
    beforeEach(() => {
        jest.useFakeTimers();
        randomSpy = jest.spyOn(Math, 'random');
        for (const r of LOSING_REELS) randomSpy.mockReturnValueOnce(r);
        randomSpy.mockReturnValue(0.5);
    });
    afterEach(() => {
        jest.useRealTimers();
        randomSpy.mockRestore();
    });

    const isClaim = filter => filter?.['casinoStats.slotsLossStreak'] !== undefined;

    async function spinWith(streak, claimWins) {
        User.findOneAndUpdate.mockImplementation(async filter => {
            if (isClaim(filter)) return claimWins ? { _id: 'u' } : null;
            return walletDoc({ casinoStats: { slotsLossStreak: streak } });
        });
        const interaction = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID });
        const run = slots.execute(interaction, { releaseLock: jest.fn(), onWager: jest.fn() });
        for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(250);
        await run;
        const text = interaction.replies.flatMap(r => r?.embeds ?? []).map(e => e.data?.description ?? '').join('\n');
        return { hot: text.includes('Hot Reel activated') };
    }

    const streakWrites = () => User.updateOne.mock.calls
        .map(([, update]) => update)
        .filter(update => JSON.stringify(update).includes('slotsLossStreak'));

    test('the spin that wins the claim locks the reel, and the claim is guarded on the streak', async () => {
        const { hot } = await spinWith(3, true);

        expect(hot).toBe(true);
        const [[filter, update]] = User.findOneAndUpdate.mock.calls.filter(([f]) => isClaim(f));
        expect(filter).toMatchObject({ userId: USER_ID, guildId: GUILD_ID, 'casinoStats.slotsLossStreak': { $gte: 3 } });
        expect(update).toEqual({ $set: { 'casinoStats.slotsLossStreak': 0 } });
    }, 30_000);

    test('a spin that loses the claim to another spin spins cold', async () => {
        // It read three losses, as the other spin did — but the other spin
        // spent them first.
        const { hot } = await spinWith(3, false);
        expect(hot).toBe(false);
    }, 30_000);

    test('a loss is counted with $inc, not written back as the streak read plus one', async () => {
        await spinWith(1, false);
        expect(streakWrites()).toEqual([{ $inc: { 'casinoStats.slotsLossStreak': 1 } }]);
        expect(User.findOneAndUpdate.mock.calls.filter(([f]) => isClaim(f))).toEqual([]);
    }, 30_000);

    test('a losing hot-reel spin leaves the streak where the claim put it', async () => {
        await spinWith(3, true);
        expect(streakWrites()).toEqual([]);
    }, 30_000);
});
