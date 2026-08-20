'use strict';

/**
 * A stand-in ChatInputCommandInteraction for driving `src/games/casino/*`.
 *
 * The games reply, edit, fetch the reply and open collectors on it, and several
 * of them read `interaction.user.displayAvatarURL()` into an embed author —
 * which discord.js validates as a real URL, so it has to look like one. Every
 * payload the game renders is pushed onto `replies`, which is what assertions
 * about "what did the player actually see" read.
 *
 * Shared by the two suites that drive whole games: the bet guard
 * (tests/casinoBetGuard.test.js) and the wager signal
 * (tests/casinoWagerSignal.test.js).
 */

const GUILD_ID   = 'guild-1';
const USER_ID    = 'user-1';
const CHANNEL_ID = 'channel-1';
const BET        = 100;
// Comfortably above the bet: every game reads this first and decides the player
// can afford the hand.
const WALLET     = 10_000;

/** The user document a game reads before it commits to anything. */
const walletDoc = (overrides = {}) => ({
    userId: USER_ID,
    guildId: GUILD_ID,
    balance: WALLET,
    activeEffects: [],
    casinoStats: {},
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
});

function makeInteraction(options) {
    const replies = [];
    const record = payload => { replies.push(payload); return Promise.resolve(payload); };

    const message = {
        createMessageComponentCollector: () => ({ on() { return this; }, stop() {} }),
        // Nobody presses anything in these tests. A rejection is what discord.js
        // hands back when the window closes, and the games all treat it as "no
        // response"; a promise that never settles would just hang them.
        awaitMessageComponent: () => Promise.reject(new Error('no response')),
        edit: record,
    };

    return {
        replies,
        id: 'interaction-1',
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

/** Every game's opening bet, with whatever options it reads to get there. */
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

module.exports = { GUILD_ID, USER_ID, CHANNEL_ID, BET, WALLET, walletDoc, makeInteraction, GAMES, stakeFor };
