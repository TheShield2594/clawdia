'use strict';

// The entire anti-duplication defense in src/games/casino is one filter:
//
//     { ...userFilter, balance: { $gte: bet } }   +   { $inc: { balance: -bet } }
//
// The balance a game reads to decide whether a player can cover their bet is
// history by the time the hand starts — spend it in another channel and an
// unguarded debit would take coins that are not there, or worse, hand out a
// payout for a stake that was never actually paid. The filter is what makes the
// debit and the check the same write: if the money moved, the update matches
// nothing, returns null, and the hand must not start.
//
// All eight games are 4,395 lines that no test had ever driven. These run each
// one through exactly the race that matters — the pre-check passes, the money
// leaves, the debit misses — and assert the hand is abandoned rather than
// dealt. The debit's own arguments are captured on the way through, so the
// guard's shape is pinned at the same time.

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

const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');

const GUILD_ID   = 'guild-1';
const USER_ID    = 'user-1';
const CHANNEL_ID = 'channel-1';
const BET        = 100;
// Comfortably above the bet: every game reads this first and decides the player
// can afford the hand. That stale "yes" is the premise of the race.
const WALLET     = 10_000;

/** The stale read every game starts from. */
const walletDoc = () => ({
    userId: USER_ID,
    guildId: GUILD_ID,
    balance: WALLET,
    activeEffects: [],
    casinoStats: {},
    save: jest.fn().mockResolvedValue(undefined),
});

/** True for the compare-and-set that takes a stake. */
const isGuardedDebit = filter => filter?.balance?.$gte !== undefined;

/** True for any write that hands coins back or pays out. */
function credits(update) {
    const inc = update?.$inc?.balance;
    return typeof inc === 'number' && inc > 0;
}

function makeInteraction(options) {
    const replies = [];
    const record = payload => { replies.push(payload); return Promise.resolve(payload); };

    const message = {
        createMessageComponentCollector: () => ({ on() { return this; }, stop() {} }),
        awaitMessageComponent: () => new Promise(() => {}),
        edit: record,
    };

    return {
        replies,
        id: 'interaction-1',
        // discord.js validates author icons as real URLs, so this has to look like one.
        user:    { id: USER_ID, username: 'player', displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' },
        member:  { displayName: 'player' },
        guild:   { id: GUILD_ID, name: 'Guild' },
        channel: { id: CHANNEL_ID, send: record },
        client:  { users: { fetch: () => Promise.resolve(null) } },
        options: {
            getInteger: name => options[name] ?? null,
            getString:  name => options[name] ?? null,
            getNumber:  name => options[name] ?? null,
        },
        deferReply:  jest.fn().mockResolvedValue(undefined),
        reply:       jest.fn(record),
        editReply:   jest.fn(record),
        followUp:    jest.fn(record),
        fetchReply:  jest.fn().mockResolvedValue(message),
    };
}

// Loaded once: `jest.mock` replaces the models for every module in this file, so
// the games see the same mocks the assertions read.
const load = name => require(`../src/games/casino/${name}`);

// Every game's opening bet, with whatever options it reads to get there.
const GAMES = [
    { name: 'blackjack',   options: { bet: BET } },
    { name: 'crash',       options: { bet: BET, auto_cashout: null } },
    { name: 'cupgame',     options: { bet: BET } },
    { name: 'higherlower', options: { bet: BET } },
    { name: 'keno',        options: { bet: BET, numbers: '3 12 21 33 39' } },
    { name: 'poker',       options: { bet: BET } },
    { name: 'roulette',    options: { bet: 'red', amount: BET, number: null } },
    { name: 'slots',       options: { bet: BET } },
];

/** The wager each game's guard must cover — roulette takes its amount elsewhere. */
const stakeFor = game => (game.name === 'roulette' ? game.options.amount : game.options.bet);

describe.each(GAMES)('/$name — the stake is taken with a compare-and-set', (game) => {
    const stake = stakeFor(game);
    let interaction, releaseLock, errorSpy;

    beforeEach(async () => {
        jest.clearAllMocks();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        // /crash chains `.lean().catch()` off its guild read; everything else
        // just awaits it.
        Guild.findOne.mockReturnValue(Object.assign(
            Promise.resolve({ guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true } }),
            { lean: () => ({ catch: () => Promise.resolve(null) }) },
        ));
        Guild.findOneAndUpdate.mockResolvedValue(null);
        Guild.updateOne.mockResolvedValue({});

        User.findOne.mockResolvedValue(walletDoc());
        User.create.mockResolvedValue(walletDoc());
        User.updateOne.mockResolvedValue({});
        // The player could afford the bet a moment ago and can't now: the
        // ensure-the-document-exists upsert still matches, the guarded debit
        // does not.
        User.findOneAndUpdate.mockImplementation(filter =>
            Promise.resolve(isGuardedDebit(filter) ? null : walletDoc()));

        interaction = makeInteraction(game.options);
        releaseLock = jest.fn();

        await load(game.name).execute(interaction, { releaseLock });
    });

    afterEach(() => errorSpy.mockRestore());

    const debitCalls = () => User.findOneAndUpdate.mock.calls.filter(([filter]) => isGuardedDebit(filter));

    test('the bet is debited through a guarded update, not a bare $inc', () => {
        const attempted = debitCalls();
        expect(attempted.length).toBeGreaterThan(0);

        for (const [filter, update] of attempted) {
            expect(filter).toMatchObject({
                userId:  USER_ID,
                guildId: GUILD_ID,
                balance: { $gte: stake },
            });
            expect(update.$inc.balance).toBe(-stake);
        }
    });

    test('the guard covers the whole stake it takes', () => {
        // A guard for less than the debit takes is the same hole with extra steps.
        for (const [filter, update] of debitCalls()) {
            expect(filter.balance.$gte).toBe(-update.$inc.balance);
        }
    });

    test('the hand is abandoned when the guard misses', () => {
        // Nothing may be credited: no payout, no refund of a stake that was
        // never taken, nothing that would let a player leave with coins the
        // debit never removed.
        const credited = User.findOneAndUpdate.mock.calls
            .concat(User.updateOne.mock.calls)
            .filter(([, update]) => credits(update));
        expect(credited).toEqual([]);
    });

    test('nothing is dealt — the refusal is the only thing rendered', () => {
        // Every game draws its hand, reels or wheel into an embed. A run that
        // produced one got past the guard and started playing for a stake the
        // player never paid.
        const rendered = interaction.replies.filter(r => r?.embeds?.length);
        expect(rendered).toEqual([]);
    });

    test('the player is told, and never charged twice trying again', () => {
        const said = interaction.replies.map(r => r?.content ?? '').join(' ');
        expect(said).toMatch(/enough|insufficient/i);
    });

    test('the action lock is released so the player is not stuck', () => {
        // The lock outlives execute() for these games; a hand that never started
        // would otherwise hold it for its full lease.
        expect(releaseLock).toHaveBeenCalled();
    });
});

describe('/crash leaves nothing behind when the host cannot pay', () => {
    const { getLobby } = require('../src/utils/crashLobby');

    test('the lobby it opened for the host is torn down again', async () => {
        // The lobby is created before the debit, and it is one per channel: a
        // stranded one blocks crash in that channel until the process restarts.
        jest.clearAllMocks();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        Guild.findOne.mockReturnValue(Object.assign(
            Promise.resolve({ guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true } }),
            { lean: () => ({ catch: () => Promise.resolve(null) }) },
        ));
        User.findOne.mockResolvedValue(walletDoc());
        User.updateOne.mockResolvedValue({});
        User.findOneAndUpdate.mockImplementation(filter =>
            Promise.resolve(isGuardedDebit(filter) ? null : walletDoc()));

        const interaction = makeInteraction({ bet: BET, auto_cashout: null });
        await load('crash').execute(interaction, { releaseLock: jest.fn() });

        expect(getLobby(CHANNEL_ID)).toBeFalsy();
        errorSpy.mockRestore();
    });
});

// ── Mid-hand debits ──────────────────────────────────────────────────────────
//
// The opening bet is not the only stake a game takes. Blackjack charges a second
// bet for a double down or a split, and each of those is its own guarded update
// running inside a collector callback minutes after execute() returned — where
// nothing above is catching anything. If one of those goes through unguarded,
// the player doubles a bet they can no longer cover.

describe('/blackjack — the second stake is guarded too', () => {
    /** customIds of the buttons a rendered payload offers. */
    const buttonsOf = payload => (payload?.components ?? [])
        .flatMap(row => (row.components ?? []).map(c => c.data?.custom_id))
        .filter(Boolean);

    /**
     * Deals a hand and hands back the collector's collect handler.
     *
     * A natural blackjack settles immediately and never opens a collector, so a
     * deal that ends that way is re-dealt rather than asserted on.
     */
    async function dealUntilPlayable() {
        for (let attempt = 0; attempt < 25; attempt++) {
            jest.clearAllMocks();
            User.findOne.mockResolvedValue(walletDoc());
            User.create.mockResolvedValue(walletDoc());
            User.updateOne.mockResolvedValue({});
            Guild.findOne.mockResolvedValue({ guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true } });
            User.findOneAndUpdate.mockImplementation(() =>
                Promise.resolve({ ...walletDoc(), balance: WALLET - BET }));

            let collect = null;
            const collector = {
                on(event, handler) { if (event === 'collect') collect = handler; return this; },
                stop: jest.fn(),
            };
            const interaction = makeInteraction({ bet: BET });
            interaction.fetchReply.mockResolvedValue({
                createMessageComponentCollector: () => collector,
                awaitMessageComponent: () => new Promise(() => {}),
            });

            await load('blackjack').execute(interaction, { releaseLock: jest.fn() });

            const doubleId = interaction.replies
                .flatMap(buttonsOf)
                .find(id => id.startsWith('bj_double_'));
            if (collect && doubleId) return { interaction, collect, collector, doubleId };
        }
        throw new Error('never got a playable hand');
    }

    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errorSpy.mockRestore());

    test('a double down the player can no longer cover is refused, not dealt', async () => {
        const { interaction, collect, collector, doubleId } = await dealUntilPlayable();

        // Between the deal and the button press, the money left.
        User.findOneAndUpdate.mockImplementation(filter =>
            Promise.resolve(isGuardedDebit(filter) ? null : walletDoc()));

        const before = interaction.replies.length;
        await collect({
            customId: doubleId,
            user: { id: USER_ID },
            deferUpdate: jest.fn().mockResolvedValue(undefined),
            reply: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        });

        const [attemptedFilter, attemptedUpdate] = User.findOneAndUpdate.mock.calls.at(-1);
        expect(attemptedFilter).toMatchObject({ balance: { $gte: BET } });
        expect(attemptedUpdate.$inc.balance).toBe(-BET);

        // The hand carries on at the original stake, and nothing was credited.
        const after = interaction.replies.slice(before);
        expect(after.length).toBeGreaterThan(0);
        expect(JSON.stringify(after)).toMatch(/Not enough balance for double down/);
        expect(User.findOneAndUpdate.mock.calls.filter(([, u]) => credits(u))).toEqual([]);
        expect(collector.stop).not.toHaveBeenCalled();
    });
});

describe('a stake that is available is taken exactly once', () => {
    // The mirror image of the suite above: when the guard matches, the debit is
    // the single write that moves the stake — the game does not "reserve" it
    // with one write and take it with another.
    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errorSpy.mockRestore());

    test('/slots debits the bet once and never re-reads to decide', async () => {
        jest.clearAllMocks();

        Guild.findOne.mockResolvedValue({ guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true } });
        Guild.findOneAndUpdate.mockResolvedValue(null);
        Guild.updateOne.mockResolvedValue({});
        User.findOne.mockResolvedValue(walletDoc());
        User.updateOne.mockResolvedValue({});

        const debits = [];
        User.findOneAndUpdate.mockImplementation((filter, update) => {
            if (isGuardedDebit(filter)) {
                debits.push(update);
                // The spin runs on the document the debit returned, so hand back
                // a wallet that is short by exactly the stake.
                return Promise.resolve({ ...walletDoc(), balance: WALLET - BET });
            }
            return Promise.resolve(walletDoc());
        });

        const interaction = makeInteraction({ bet: BET });
        await load('slots').execute(interaction, { releaseLock: jest.fn() });

        expect(debits).toEqual([{ $inc: { balance: -BET } }]);
    });
});
