'use strict';

// `resolving` was set before the first await and nothing put it back. A Guild
// read that threw — or a Discord send, or the payout loop — left the flag true
// and the guild's entry in `activeHeists` forever, so `/heist start` answered
// "a heist is already in progress" there until the process restarted. The
// rejection also travelled out through the setTimeout callbacks that call this,
// where nothing awaited it: an unhandled rejection, which the process guard in
// src/index.js counts toward its exit threshold.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/balanceDebit', () => ({ debitUpTo: jest.fn() }));

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { logTransaction } = require('../src/utils/logTransaction');
const {
    resolveHeist, createLobby, joinLobby, getHeist, clearHeist,
} = require('../src/services/heistService');

const GUILD = 'guild1';
const lean = value => ({ lean: () => Promise.resolve(value) });

function liveHeist() {
    const heist = createLobby({
        guildId: GUILD, channelId: 'chan1', initiatorId: 'u1',
        target: 'bank', lobbyDurationSeconds: 60, maxPayout: 1000,
    });
    joinLobby(GUILD, 'u1', 'one', 'hacker');
    joinLobby(GUILD, 'u2', 'two', 'driver');
    for (const player of heist.players.values()) player.skillPassed = true;
    return heist;
}

const client = { guilds: { fetch: jest.fn().mockResolvedValue(null) } };

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    clearHeist(GUILD);
    Guild.findOne.mockReturnValue(lean({ economy: { currency: '💰' }, heist: {} }));
    User.findOne.mockReturnValue(lean({ balance: 100 }));
    User.findOneAndUpdate.mockResolvedValue({});
});

afterEach(() => { clearHeist(GUILD); jest.restoreAllMocks(); });

describe('when resolution cannot finish', () => {
    test('the failure does not escape as a rejection', async () => {
        Guild.findOne.mockImplementation(() => { throw new Error('mongo is down'); });

        await expect(resolveHeist(client, liveHeist())).resolves.toBeUndefined();
    });

    test('the guild is not left holding an unresolvable heist', async () => {
        Guild.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('mongo is down')) });

        await resolveHeist(client, liveHeist());

        // Terminated, not retried: some players may already have been paid, so
        // re-running would pay them twice. Clearing frees the guild.
        expect(getHeist(GUILD)).toBeNull();
    });
});

describe('when one player\'s economy write fails', () => {
    test('it is reported rather than swallowed, and the rest are still paid', async () => {
        const heist = liveHeist();
        User.findOneAndUpdate
            .mockRejectedValueOnce(new Error('write failed'))
            .mockResolvedValue({});

        await resolveHeist(client, heist);

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('payout'), expect.any(String));
        // The second player's payout still went through and was recorded.
        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(2);
        expect(logTransaction).toHaveBeenCalledTimes(1);
        expect(getHeist(GUILD)).toBeNull();
    });
});

describe('the once-only guard still holds', () => {
    test('a second call while the first is in flight does nothing', async () => {
        const heist = liveHeist();
        let releaseGuildRead;
        Guild.findOne.mockReturnValue({
            lean: () => new Promise(resolve => { releaseGuildRead = () => resolve({ economy: {}, heist: {} }); }),
        });

        const first = resolveHeist(client, heist);
        await Promise.resolve();
        await resolveHeist(client, heist);

        releaseGuildRead();
        await first;

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });
});
