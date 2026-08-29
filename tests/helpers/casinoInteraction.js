'use strict';

/**
 * The casino half of the interaction harness: the wallet document every game
 * reads before it commits, and the eight games with the options each needs to
 * reach its opening bet.
 *
 * The interaction itself is no longer built here. It was general enough to
 * drive any command that takes options, defers, replies and opens a collector,
 * and #786 needed exactly that for the economy commands — so it moved to
 * tests/helpers/fakeInteraction.js and this file passes through to it.
 *
 * Used by the two suites that drive whole games: the bet guard
 * (tests/casinoBetGuard.test.js) and the wager signal
 * (tests/casinoWagerSignal.test.js).
 */

const { makeInteraction: baseInteraction } = require('./fakeInteraction');

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

/** The interaction a game is driven through, with the options it reads. */
const makeInteraction = options => baseInteraction({ options, userId: USER_ID, guildId: GUILD_ID });

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
