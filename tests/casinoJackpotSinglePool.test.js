'use strict';

/**
 * One jackpot, one number.
 *
 * The casino used to run two progressive pools at once and give them the same
 * name. `/casino jackpot` reported `casinoJackpot.pool` — seeded at 10,000, fed
 * 0.5% of every casino bet, dropped on a random per-bet trigger. Slots reported
 * `slots.jackpotPool` under the label "🏆 Jackpot Pool" — seeded at 5,000, fed a
 * flat 10 a spin, won on Triple Wild. A single spin paid into both, and the two
 * embeds each showed their own total, so a player who ran `/casino jackpot`
 * (10,309 coins) and then spun (5,420 coins) was told two different things about
 * what looked like one prize. Neither figure was wrong; the pools were.
 *
 * Slots now plays for the shared pool like every other game. What has to hold:
 *
 *   1. Both commands read the same field, so both print the same number.
 *   2. A Triple Wild claims that pool — once. The service credits the winner, so
 *      the spin's own payout must not pay it a second time.
 *   3. A claim whose credit has not landed yet pays nothing in its place and
 *      says so. The pot is out of the pool and recorded against the player under
 *      its payout key (#873); a consolation payout on top of a pot that is still
 *      going to arrive is the second payment, not a fallback. The fallback is
 *      for the one case where nothing was claimed at all.
 *   4. Whatever the retired pool had accumulated is folded in, not deleted — and
 *      the 5,000 of house seed money is not minted into every guild.
 */

jest.mock('../src/models/User', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
    create:           jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
}));
jest.mock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));
jest.mock('../src/utils/placeWager', () => ({ placeWager: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const { makeInteraction, walletDoc, GUILD_ID, USER_ID, BET } = require('./helpers/casinoInteraction');

const slots   = require('../src/games/casino/slots');
const casino  = require('../src/commands/economy/casino');

// Reel weights run 28/22/18/12/8/5 for the six regular symbols, then 4 for Wild,
// out of 102 — so Wild is the band from 93 to 97. spinReel takes a single
// Math.random() per reel, which makes a pinned value a pinned set of reels.
const ALL_WILD    = 94 / 102;  // 🃏🃏🃏 — the jackpot hand
const ALL_CHERRY  = 5 / 102;   // 🍒🍒🍒 — an ordinary three-of-a-kind

const POOL = 12_345;
const SEED = 10_000;

/** A Guild query result that answers both `await` and `.lean()`. */
const guildQuery = doc => Object.assign(Promise.resolve(doc), { lean: () => Promise.resolve(doc) });

const guildDoc = (overrides = {}) => ({
    guildId: GUILD_ID,
    economy: { enabled: true, gamesEnabled: true, casinoEnabled: true },
    casinoJackpot: { pool: POOL, seedAmount: SEED, contributionRate: 0.005, betsCount: 0 },
    ...overrides,
});

/** The jackpot figure slots showed the player, off whichever embed carried it. */
function poolShownBySlots(interaction) {
    for (const payload of [...interaction.replies].reverse()) {
        for (const embed of payload?.embeds ?? []) {
            const field = (embed.data?.fields ?? []).find(f => f.name.includes('Jackpot'));
            if (field) return field.value;
        }
    }
    return null;
}

/** Every coin the spin itself credited, through its own `$inc` payout write. */
const totalCredited = () => User.findOneAndUpdate.mock.calls
    .filter(([, update]) => update?.$inc?.balance !== undefined)
    .reduce((sum, [, update]) => sum + update.$inc.balance, 0);

/**
 * The keyed credits the jackpot service issued — pipeline updates, because the
 * payout key has to go in the same write as the coins (src/utils/payoutKey.js).
 */
const keyedCredits = () => User.findOneAndUpdate.mock.calls.filter(([, update]) => Array.isArray(update));

let randomSpy;
let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Guild.findOne.mockImplementation(() => guildQuery(guildDoc()));
    Guild.updateOne.mockResolvedValue({});
    Guild.findOneAndUpdate.mockResolvedValue(null);
    // The opening upsert has to hand back a real wallet; the balance writes that
    // follow are what individual tests care about.
    User.findOneAndUpdate.mockImplementation((_filter, update) =>
        Promise.resolve(update?.$setOnInsert ? walletDoc() : walletDoc()));
    User.findOne.mockResolvedValue(walletDoc());
    User.updateOne.mockResolvedValue({});
});

afterEach(() => {
    randomSpy?.mockRestore();
    errorSpy.mockRestore();
});

describe('the two commands report the same pool', () => {
    test('`/casino jackpot` and a spin quote the same figure from the same field', async () => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(ALL_CHERRY);

        const lookup = makeInteraction({});
        lookup.options.getSubcommand = () => 'jackpot';
        await casino.execute(lookup);
        const lookupText = lookup.replies.at(-1).embeds[0].data.description;

        const spin = makeInteraction({ bet: BET });
        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });

        // The exact total matters less than the two agreeing: under the old code
        // this pair read different documents and could not agree by construction.
        expect(lookupText).toContain(POOL.toLocaleString());
        expect(poolShownBySlots(spin)).toContain(POOL.toLocaleString());
    }, 20_000);

    test('slots keeps no pool of its own to diverge from', () => {
        const source = require('fs').readFileSync(require.resolve('../src/games/casino/slots.js'), 'utf8');
        // The retired fields. A read is as bad as a write here — either one puts a
        // second number back on the screen.
        expect(source).not.toMatch(/slots\.jackpotPool/);
        expect(source).not.toMatch(/slots\.lastJackpot/);
    });
});

describe('a Triple Wild claims the shared pool', () => {
    const CLAIMED = 42_000;

    beforeEach(() => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(ALL_WILD);
        // findOneAndUpdate on the guild is the atomic claim: it reseeds the pool
        // and records what it took in the same write, and answers with the
        // document that update produced.
        Guild.findOneAndUpdate.mockResolvedValue({
            guildId: GUILD_ID,
            casinoJackpot: { pool: SEED, lastWonAmount: CLAIMED, pendingPayoutKey: `jackpot:${GUILD_ID}:claim-1` },
        });
    });

    test('the winner is paid the pool exactly once', async () => {
        const spin = makeInteraction({ bet: BET });
        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });

        // casinoJackpotService credits the win itself, under the claim's payout
        // key. Slots crediting its own result.payout on top — which is what it
        // does for every other outcome — would hand the player the whole pot
        // twice, so the spin's own write has to be for nothing.
        expect(keyedCredits()).toHaveLength(1);
        expect(totalCredited()).toBe(0);
        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER_ID, guildId: GUILD_ID }),
            { $inc: { balance: 0 } },
            expect.anything(),
        );
    }, 20_000);

    test('the pool is reseeded, and the reseeded figure is what the spin reports', async () => {
        const spin = makeInteraction({ bet: BET });
        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });

        const [filter, update, options] = Guild.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: GUILD_ID });
        expect(update.flatMap(stage => Object.keys(stage.$set))).toContain('casinoJackpot.pool');
        expect(options).toMatchObject({ updatePipeline: true, new: true });
        expect(poolShownBySlots(spin)).toContain(SEED.toLocaleString());
    }, 20_000);

    test('a claim that cannot be credited pays nothing in its place, and says so', async () => {
        // Every credit attempt matches nothing, so the pot is claimed and owed.
        User.findOneAndUpdate.mockImplementation((_filter, update) =>
            Promise.resolve(update?.$setOnInsert ? walletDoc() : null));

        const spin = makeInteraction({ bet: BET });
        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });

        // The pot is out of the pool and recorded against the player under its
        // key. Paying the 25x fallback on top of that pays the same Triple Wild
        // twice — and it used to, over a rolled-back pool and a credit that may
        // well have committed and only lost its response.
        expect(totalCredited()).toBe(0);
        expect(Guild.updateOne).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ $inc: expect.objectContaining({ 'casinoJackpot.pool': expect.anything() }) }),
        );
        // And the player is told, rather than shown a pot that is in their
        // balance according to the embed and not according to the database.
        const description = spin.replies.at(-1).embeds[0].data.description;
        expect(description).toContain('could not be paid out just now');
        expect(description).toContain('recorded');
    }, 20_000);

    test('a guild with no document has no pool to win', async () => {
        // awardPool's claim matches nothing here, falls back to the seed and would
        // credit a five-figure pot nobody ever paid into. A spin can reach this: it
        // reads the guild without upserting one, and tolerates not finding it.
        Guild.findOne.mockImplementation(() => guildQuery(null));

        const spin = makeInteraction({ bet: BET });
        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });

        expect(Guild.findOneAndUpdate).not.toHaveBeenCalled();
        expect(totalCredited()).toBe(BET * 25);
    }, 20_000);

    test('an unpaid claim keeps the marker the restart reconciler settles it from', async () => {
        User.findOneAndUpdate.mockImplementation((_filter, update) =>
            Promise.resolve(update?.$setOnInsert ? walletDoc() : null));

        await slots.execute(makeInteraction({ bet: BET }), { releaseLock: jest.fn(), onWager: jest.fn() });

        // `pendingPayoutKey` is the only thing that says a pot left the pool and
        // never reached its winner. Clearing it here — which the rollback this
        // replaced did — is what left the coins with nowhere to be recovered
        // from, and the credit is guarded by that same key, so the reconciler
        // and `payouts:replay` cannot double it between them.
        const cleared = Guild.updateOne.mock.calls
            .some(([, u]) => u?.$set?.['casinoJackpot.pendingPayoutKey'] === null);
        expect(cleared).toBe(false);
    }, 20_000);
});

describe('the retired slots pool is folded in, not dropped', () => {
    // Migration 017. Driven against a stub collection rather than a database:
    // what is being pinned is the shape of the update it issues, because a
    // careless one here either loses the players' coins or mints new ones.
    test('only the players’ contributions carry over, and the field is retired', async () => {
        const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 3 });
        const mongoose = require('mongoose');
        const connection = { db: { collection: jest.fn(() => ({ updateMany })) } };
        // `connection` is a getter up the Mongoose prototype chain, so it is
        // shadowed with an own property and the shadow deleted afterwards.
        Object.defineProperty(mongoose, 'connection', { value: connection, configurable: true });

        try {
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            await require('../src/migrations/017_merge_slots_jackpot_pool').up();
            logSpy.mockRestore();
        } finally {
            delete mongoose.connection;
        }

        expect(connection.db.collection).toHaveBeenCalledWith('guilds');
        const [filter, pipeline] = updateMany.mock.calls[0];
        // Idempotent by construction: once the field is unset the filter stops
        // matching, so a re-run cannot fold the same pool twice.
        expect(filter).toEqual({ 'slots.jackpotPool': { $exists: true } });

        const [addStage, unsetStage] = pipeline;
        const carried = addStage.$set['casinoJackpot.pool'].$add[1];
        // 5,000 was the old pool's house seed, and Mongoose stamped that default
        // onto every Guild document it ever created. Carrying it would mint 5,000
        // coins into servers that never spun a reel; $max pins the floor at zero
        // rather than at a debt.
        expect(carried).toEqual({ $max: [0, { $subtract: [{ $ifNull: ['$slots.jackpotPool', 0] }, 5000] }] });
        expect(unsetStage.$unset).toEqual(expect.arrayContaining(['slots.jackpotPool']));
    });
});
