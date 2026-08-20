'use strict';

/**
 * What counts as "a bet was placed", and who is told.
 *
 * `casino.js` used to answer that question by reading the bet straight off the
 * command options:
 *
 *     const bet = interaction.options.getInteger(...) ?? 0;
 *     if (bet > 0) { processJackpotBet(...); advanceMissions(..., 'casino', 1); }
 *     return await game.execute(interaction, { releaseLock });
 *
 * Both calls fired *before* the game validated anything. A bet larger than the
 * wallet, or over the guild's casinoMaxBet, or refused for any other game-level
 * reason still contributed to the progressive jackpot pool and still ticked
 * "Play 5 casino games" — for a hand that never happened.
 *
 * The fix is a signal the games raise once their debit actually lands. Three
 * things have to hold for it to be worth anything, and each is a separate
 * describe below:
 *
 *   1. utils/placeWager only raises it when the coins moved.
 *   2. casino.js does nothing until it is raised, and then does both.
 *   3. All eight games actually raise it for the wager that opens a hand — and
 *      only for that one, so a double-down is not a second game played.
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
// /casino takes the shared economy lock before it dispatches; without this the
// query buffers against a connection that never arrives and no game ever runs.
jest.mock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));
// casino.js destructures both of these at require time, so they have to be
// replaced in the registry — a spy installed afterwards would not be the
// function it calls.
jest.mock('../src/services/casinoJackpotService', () => ({
    processJackpotBet: jest.fn().mockResolvedValue({ triggered: false }),
    getJackpotDisplay: jest.fn().mockResolvedValue({ pool: 0, hot: false, display: '0' }),
}));
jest.mock('../src/services/seasonMissionService', () => ({
    advanceMissions: jest.fn().mockResolvedValue([]),
}));
// The real lobby store, with the seat claim observable so a lobby that fills
// between the debit and the claim can be forced.
jest.mock('../src/utils/crashLobby', () => {
    const actual = jest.requireActual('../src/utils/crashLobby');
    return { ...actual, addPlayer: jest.fn(actual.addPlayer) };
});

const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const { GUILD_ID, USER_ID, BET, walletDoc, makeInteraction, GAMES, stakeFor } = require('./helpers/casinoInteraction');

const { placeWager } = require('../src/utils/placeWager');

describe('placeWager — the debit is the signal', () => {
    beforeEach(() => jest.clearAllMocks());

    const filter = { userId: USER_ID, guildId: GUILD_ID };

    test('takes the stake with the same compare-and-set the games hand-wrote', () => {
        User.findOneAndUpdate.mockResolvedValue(walletDoc());
        return placeWager(filter, BET).then(() => {
            expect(User.findOneAndUpdate).toHaveBeenCalledWith(
                { userId: USER_ID, guildId: GUILD_ID, balance: { $gte: BET } },
                { $inc: { balance: -BET } },
                { new: true },
            );
        });
    });

    test('commits a stake and its bookkeeping in one write', async () => {
        User.findOneAndUpdate.mockResolvedValue(walletDoc());
        await placeWager(filter, BET, { extraInc: { lifetimeGambled: BET } });

        const [, update] = User.findOneAndUpdate.mock.calls[0];
        expect(update).toEqual({ $inc: { balance: -BET, lifetimeGambled: BET } });
    });

    test('reports the wager once the coins have moved', async () => {
        User.findOneAndUpdate.mockResolvedValue(walletDoc());
        const onWager = jest.fn();

        await placeWager(filter, BET, { onWager });

        expect(onWager).toHaveBeenCalledTimes(1);
        expect(onWager).toHaveBeenCalledWith({ amount: BET, user: null, source: null });
    });

    test('says nothing when the guard misses — the whole point', async () => {
        // The player spent the coins between the pre-check and the write. No
        // hand starts, so nothing may be told one did.
        User.findOneAndUpdate.mockResolvedValue(null);
        const onWager = jest.fn();

        await expect(placeWager(filter, BET, { onWager })).resolves.toBeNull();
        expect(onWager).not.toHaveBeenCalled();
    });

    test('carries the better and their interaction, for bets placed on someone else’s command', async () => {
        // A crash lobby takes stakes from joiners: the jackpot has to be
        // credited to whoever actually bet, not to the host who opened it.
        User.findOneAndUpdate.mockResolvedValue(walletDoc());
        const onWager = jest.fn();
        const joiner  = { id: 'user-2', username: 'joiner' };
        const source  = { id: 'button-1' };

        await placeWager({ userId: joiner.id, guildId: GUILD_ID }, BET, { onWager, user: joiner, source });

        expect(onWager).toHaveBeenCalledWith({ amount: BET, user: joiner, source });
    });

    test('refuses a non-positive stake without touching the database', async () => {
        const onWager = jest.fn();

        await expect(placeWager(filter, 0, { onWager })).resolves.toBeNull();
        await expect(placeWager(filter, -50, { onWager })).resolves.toBeNull();

        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(onWager).not.toHaveBeenCalled();
    });
});

describe('/casino — the jackpot and the mission wait for the signal', () => {
    const jackpot  = require('../src/services/casinoJackpotService');
    const missions = require('../src/services/seasonMissionService');
    const slots    = require('../src/games/casino/slots');
    const casino   = require('../src/commands/economy/casino');

    beforeEach(() => {
        jest.clearAllMocks();
        require('./helpers/fakeActiveLock').__locks.clear();
        Guild.findOne.mockResolvedValue({ guildId: GUILD_ID, economy: {} });
        jackpot.processJackpotBet.mockResolvedValue({ triggered: false });
        missions.advanceMissions.mockResolvedValue([]);
    });

    afterEach(() => jest.restoreAllMocks());

    /** Runs /casino slots with a game stubbed to behave as `play` describes. */
    async function playSlots(play) {
        jest.spyOn(slots, 'execute').mockImplementation(play);
        const interaction = makeInteraction({ bet: BET });
        interaction.options.getSubcommand = () => 'slots';
        interaction.memberPermissions     = { has: () => true };
        await casino.execute(interaction);
        return interaction;
    }

    test('a hand that never gets a bet down contributes nothing and scores nothing', async () => {
        // The bug, stated as a test: the player asked to bet, the game refused,
        // and under the old code the jackpot pool and the season mission had
        // both already moved.
        await playSlots(async (interaction, { releaseLock }) => { releaseLock(); });

        expect(jackpot.processJackpotBet).not.toHaveBeenCalled();
        expect(missions.advanceMissions).not.toHaveBeenCalled();
    });

    test('a bet that lands contributes and scores, once', async () => {
        await playSlots(async (interaction, { onWager }) => { onWager({ amount: BET }); });

        expect(jackpot.processJackpotBet).toHaveBeenCalledTimes(1);
        expect(jackpot.processJackpotBet).toHaveBeenCalledWith(expect.objectContaining({
            guildId: GUILD_ID, userId: USER_ID, bet: BET,
        }));
        expect(missions.advanceMissions).toHaveBeenCalledTimes(1);
        expect(missions.advanceMissions).toHaveBeenCalledWith(
            expect.anything(), { userId: USER_ID, guildId: GUILD_ID }, 'casino', 1, expect.anything(),
        );
    });

    test('the contribution is the stake that was actually taken', async () => {
        // A reroll or a discounted replay reports its own price, not the number
        // the player originally typed.
        await playSlots(async (interaction, { onWager }) => { onWager({ amount: 37 }); });

        expect(jackpot.processJackpotBet).toHaveBeenCalledWith(expect.objectContaining({ bet: 37 }));
    });

    test('a second hand on the same command reports again', async () => {
        // "Play Again" re-debits, so it is another game played.
        await playSlots(async (interaction, { onWager }) => {
            onWager({ amount: BET });
            onWager({ amount: BET });
        });

        expect(missions.advanceMissions).toHaveBeenCalledTimes(2);
    });

    test('a wager placed by someone other than the invoker is credited to them', async () => {
        const joiner = { id: 'user-2', username: 'joiner' };
        const source = { id: 'button-1' };

        await playSlots(async (interaction, { onWager }) => { onWager({ amount: BET, user: joiner, source }); });

        expect(jackpot.processJackpotBet).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-2', username: 'joiner', interaction: source,
        }));
        expect(missions.advanceMissions).toHaveBeenCalledWith(
            expect.anything(), { userId: 'user-2', guildId: GUILD_ID }, 'casino', 1, expect.anything(),
        );
    });
});

describe.each(GAMES)('/$name reports the wager that opens a hand', (game) => {
    // placeWager is stubbed to refuse, which aborts each game the same way the
    // bet-guard suite does — the call itself is what is being inspected, and a
    // refusal keeps eight full games from playing themselves out in a unit test.
    //
    // Every module is loaded fresh inside the test: the games destructure
    // `placeWager` at require time, so a stub installed after they were first
    // loaded would never be the function they call. Resetting the registry also
    // hands back new model mocks, which is why those are configured here rather
    // than from the file-level bindings.
    const stake = stakeFor(game);

    test('the opening stake is taken through the shared helper, carrying the signal', async () => {
        jest.resetModules();
        jest.doMock('../src/utils/placeWager', () => ({ placeWager: jest.fn().mockResolvedValue(null) }));

        const errorSpy   = jest.spyOn(console, 'error').mockImplementation(() => {});
        const freshUser  = require('../src/models/User');
        const freshGuild = require('../src/models/Guild');
        const { placeWager: placeWagerMock } = require('../src/utils/placeWager');

        freshGuild.findOne.mockReturnValue(Object.assign(
            Promise.resolve({ guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true } }),
            { lean: () => ({ catch: () => Promise.resolve(null) }) },
        ));
        freshGuild.findOneAndUpdate.mockResolvedValue(null);
        freshGuild.updateOne.mockResolvedValue({});
        freshUser.findOne.mockResolvedValue(walletDoc());
        freshUser.create.mockResolvedValue(walletDoc());
        freshUser.updateOne.mockResolvedValue({});
        freshUser.findOneAndUpdate.mockResolvedValue(walletDoc());

        const onWager = jest.fn();
        await require(`../src/games/casino/${game.name}`)
            .execute(makeInteraction(game.options), { releaseLock: jest.fn(), onWager });

        const opening = placeWagerMock.mock.calls.find(([, amount]) => amount === stake);
        expect(opening).toBeDefined();
        expect(opening[0]).toMatchObject({ userId: USER_ID, guildId: GUILD_ID });
        // A game that forgot to thread it through would still debit correctly
        // and still never be counted — which is the failure this pins.
        expect(opening[2]).toEqual(expect.objectContaining({ onWager }));

        errorSpy.mockRestore();
        jest.dontMock('../src/utils/placeWager');
        jest.resetModules();
    });
});

describe('/crash — a joiner is counted only once the seat is theirs', () => {
    // The debit is not the last thing that can fail on a join: the seat is
    // claimed after it, and a lobby that filled in between refunds the stake.
    // Reporting the wager from inside the debit contributed to the jackpot and
    // ticked the mission for a bet that was handed straight back — the same
    // "counted a hand that never happened" the signal exists to stop.
    const { deleteLobby, addPlayer } = require('../src/utils/crashLobby');
    const { CHANNEL_ID } = require('./helpers/casinoInteraction');
    const crash = require('../src/games/casino/crash');

    let errorSpy;

    /** An interaction whose editReply hands back a message that keeps its collectors. */
    function hostInteraction() {
        const interaction = makeInteraction({ bet: BET, auto_cashout: null });
        const handlers = {};
        const message = {
            createMessageComponentCollector: () => ({
                on(event, fn) { handlers[event] = fn; return this; },
                stop() {},
            }),
        };
        const record = interaction.editReply;
        interaction.editReply = jest.fn(payload => { record(payload); return Promise.resolve(message); });
        interaction.client = { users: { fetch: async () => ({ username: 'joiner' }) } };
        interaction.handlers = handlers;
        return interaction;
    }

    /** The button press of a second player hitting Join. */
    const joinPress = () => ({
        user:  { id: 'user-2', username: 'joiner' },
        customId: 'crash_join_channel-1_0',
        reply: jest.fn().mockResolvedValue(undefined),
        deferUpdate: jest.fn().mockResolvedValue(undefined),
    });

    /** Opens a lobby and returns the join collector's collect handler. */
    async function openLobby(onWager) {
        Guild.findOne.mockReturnValue(Object.assign(
            Promise.resolve({ guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true } }),
            { lean: () => ({ catch: () => Promise.resolve(null) }) },
        ));
        User.findOne.mockResolvedValue(walletDoc());
        User.findOneAndUpdate.mockResolvedValue(walletDoc());
        User.updateOne.mockResolvedValue({});

        const interaction = hostInteraction();
        await crash.execute(interaction, { releaseLock: jest.fn(), onWager });
        // The host's own stake is reported and their own seat claimed on the
        // way in; this suite is about the joiner's, so start counting here.
        onWager.mockClear();
        addPlayer.mockClear();
        return { collect: interaction.handlers.collect, interaction };
    }

    beforeEach(() => {
        // openLobby arms a 30s join-window timeout that nothing in this test
        // path ever fires; faked, it is never a real handle to leak.
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        jest.clearAllMocks();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        deleteLobby(CHANNEL_ID);
    });

    afterEach(() => {
        deleteLobby(CHANNEL_ID);
        errorSpy.mockRestore();
        jest.useRealTimers();
    });

    test('a joiner who gets a seat is reported, and reported as themselves', async () => {
        const onWager = jest.fn();
        const { collect } = await openLobby(onWager);

        await collect(joinPress());

        expect(onWager).toHaveBeenCalledTimes(1);
        expect(onWager).toHaveBeenCalledWith(expect.objectContaining({
            amount: BET,
            user: expect.objectContaining({ id: 'user-2' }),
        }));
    });

    test('a joiner whose seat is gone is refunded and never counted', async () => {
        const onWager = jest.fn();
        const { collect } = await openLobby(onWager);

        // The lobby filled between the debit landing and the seat being claimed.
        // Once, so the real implementation survives for the next test.
        addPlayer.mockImplementationOnce(() => false);
        const press = joinPress();
        await collect(press);

        expect(onWager).not.toHaveBeenCalled();
        // The stake really did come back, so counting it would have been
        // counting a bet nobody ended up making.
        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'user-2', guildId: GUILD_ID },
            { $inc: { balance: BET, pendingCrashRefund: -BET } },
        );
        expect(press.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringMatching(/refunded/i),
        }));
    });

    test('a joiner who cannot cover the bet is neither seated nor counted', async () => {
        const onWager = jest.fn();
        const { collect } = await openLobby(onWager);

        User.findOneAndUpdate.mockResolvedValue(null); // guarded debit misses
        const press = joinPress();
        await collect(press);

        expect(onWager).not.toHaveBeenCalled();
        expect(addPlayer).not.toHaveBeenCalled();
        expect(press.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringMatching(/coins to join/i),
        }));
    });
});
