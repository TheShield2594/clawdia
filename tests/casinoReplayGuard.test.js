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
 * slots' Heat meter (the Hot Reel's loss streak, before pass 25), which two
 * spins in flight at once could both spend.
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

// ─── Slots' Heat meter ─────────────────────────────────────────────────────────

describe('/casino slots — a full Heat meter is claimed, not read', () => {
    const slots = require('../src/games/casino/slots');
    const { HEAT_MAX, HIGH_VALUE_SYMBOLS } = jest.requireActual('../src/games/casino/slotsReels');

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const isClaim = filter => filter?.['casinoStats.slotsHeat'] !== undefined;

    async function spinWith(heat, claimWins) {
        User.findOneAndUpdate.mockImplementation(async filter => {
            if (isClaim(filter)) return claimWins ? { _id: 'u' } : null;
            return walletDoc({ casinoStats: { slotsHeat: heat } });
        });
        const interaction = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID });
        const run = slots.execute(interaction, { releaseLock: jest.fn(), onWager: jest.fn() });
        for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(250);
        await run;
        const result = interaction.replies.filter(r => r?.components?.length).at(-1).embeds[0].data;
        const grid = result.description.split('\n');
        return { hot: result.description.includes('Hot Spin'), payline: grid[1] };
    }

    const heatWrites = () => User.updateOne.mock.calls
        .map(([, update]) => update)
        .filter(update => JSON.stringify(update).includes('slotsHeat'));

    test('the spin that wins the claim is hot, and the claim is guarded on a full meter', async () => {
        const { hot, payline } = await spinWith(HEAT_MAX, true);

        expect(hot).toBe(true);
        // Reel 1 of a Hot Spin lands a high-value symbol on the payline.
        const { SYMBOLS } = jest.requireActual('../src/games/casino/slotsReels');
        const highValue = SYMBOLS.filter(s => HIGH_VALUE_SYMBOLS.includes(s.name)).map(s => s.emoji);
        expect(highValue.some(emoji => payline.startsWith(`▶️ ${emoji}`))).toBe(true);

        const [[filter, update]] = User.findOneAndUpdate.mock.calls.filter(([f]) => isClaim(f));
        expect(filter).toMatchObject({ userId: USER_ID, guildId: GUILD_ID, 'casinoStats.slotsHeat': { $gte: HEAT_MAX } });
        expect(update).toEqual({ $set: { 'casinoStats.slotsHeat': 0 } });
    }, 30_000);

    test('a spin that loses the claim to another spin spins cold, and fills the next meter', async () => {
        // It read a full meter, as the other spin did — but the other spin
        // spent it first.
        const { hot } = await spinWith(HEAT_MAX, false);
        expect(hot).toBe(false);
        expect(heatWrites()).toEqual([{ $inc: { 'casinoStats.slotsHeat': 1 } }]);
    }, 30_000);

    test('every cold spin fills the meter with $inc, whatever it paid', async () => {
        // From play, not from losses: the Hot Reel this replaced counted losses
        // in a row, which paid best to whoever kept chasing them.
        await spinWith(3, false);
        expect(heatWrites()).toEqual([{ $inc: { 'casinoStats.slotsHeat': 1 } }]);
        expect(User.findOneAndUpdate.mock.calls.filter(([f]) => isClaim(f))).toEqual([]);
    }, 30_000);

    test('a hot spin leaves the meter where the claim put it', async () => {
        await spinWith(HEAT_MAX, true);
        expect(heatWrites()).toEqual([]);
    }, 30_000);
});
