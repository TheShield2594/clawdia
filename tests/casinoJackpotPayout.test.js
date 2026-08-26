'use strict';

/**
 * #784. `casinoJackpotService` was at 14.6% lines and **0% branches** — every
 * decision in it unexecuted. It is a payout path: the pool is claimed and reset
 * in one atomic write, and the winner is credited afterwards in a separate,
 * non-transactional one. That gap is deliberate (replica-set transactions are
 * not assumed), and everything that keeps it from losing coins — reading the
 * pre-update pool, retrying the credit, restoring the pool when the credit will
 * not land — lives in branches nothing was taking.
 *
 * `Math.random` is stubbed throughout: the trigger is a probability, and a test
 * that waits for a 0.01% event is not a test.
 */

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setThumbnail(t) { this.thumbnail = t; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setTimestamp() { return this; }
    }
    return { EmbedBuilder };
});

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User',  () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const Guild = require('../src/models/Guild');
const User  = require('../src/models/User');
const { logTransaction } = require('../src/utils/logTransaction');
const { processJackpotBet, getJackpotDisplay, HOT_POOL_THRESHOLD } = require('../src/services/casinoJackpotService');

const BASE_TRIGGER_RATE = 0.0001;
const TRIGGER_INCREMENT = 0.00001;

/** Forces the trigger roll one way or the other, deterministically. */
function roll(trigger) {
    jest.spyOn(Math, 'random').mockReturnValue(trigger ? 0 : 0.9999);
}

function jackpot(over = {}) {
    return { pool: 250_000, betsCount: 40, contributionRate: 0.005, seedAmount: 10_000, ...over };
}

function bet(over = {}) {
    return { guildId: 'g1', userId: 'u1', username: 'Ada', bet: 10_000, ...over };
}

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    Guild.findOne.mockResolvedValue({ guildId: 'g1', casinoJackpot: jackpot() });
    Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1', casinoJackpot: jackpot() });
    Guild.updateOne.mockResolvedValue({});
    User.findOneAndUpdate.mockResolvedValue({ balance: 999 });
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('processJackpotBet — the bet that does not win', () => {
    test('grows the pool by the contribution and counts the bet', async () => {
        roll(false);

        const result = await processJackpotBet(bet());

        expect(Guild.updateOne).toHaveBeenCalledWith({ guildId: 'g1' }, {
            $inc: { 'casinoJackpot.pool': 50, 'casinoJackpot.betsCount': 1 },
        });
        expect(result).toEqual({ triggered: false, newPool: 250_050 });
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a bet too small to round to a contribution still contributes one coin', async () => {
        roll(false);

        // floor(10 * 0.005) is 0, and a pool that never grows is not a jackpot.
        await processJackpotBet(bet({ bet: 10 }));

        expect(Guild.updateOne.mock.calls[0][1].$inc['casinoJackpot.pool']).toBe(1);
    });

    test('an unconfigured guild uses the documented defaults', async () => {
        roll(false);
        Guild.findOne.mockResolvedValue({ guildId: 'g1' });

        const result = await processJackpotBet(bet());

        // 0.5% rate, and a pool that reads as the 10,000 seed.
        expect(Guild.updateOne.mock.calls[0][1].$inc['casinoJackpot.pool']).toBe(50);
        expect(result.newPool).toBe(10_050);
    });

    test('a guild with no document at all is left alone', async () => {
        Guild.findOne.mockResolvedValue(null);

        expect(await processJackpotBet(bet())).toEqual({ triggered: false });
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('the trigger chance climbs with the bets since the last drop', async () => {
        // One roll, held between the two rates: above what a freshly reset pool
        // (betsCount 0) drops at, below what a pool cold for 100 bets does. The
        // same roll therefore has to lose the first and win the second, which is
        // the climb itself rather than a restatement of the formula.
        const between = (BASE_TRIGGER_RATE + (BASE_TRIGGER_RATE + 100 * TRIGGER_INCREMENT)) / 2;
        jest.spyOn(Math, 'random').mockReturnValue(between);

        Guild.findOne.mockResolvedValue({ guildId: 'g1', casinoJackpot: jackpot({ betsCount: 0 }) });
        expect(await processJackpotBet(bet())).toMatchObject({ triggered: false });

        Guild.findOne.mockResolvedValue({ guildId: 'g1', casinoJackpot: jackpot({ betsCount: 100 }) });
        expect(await processJackpotBet(bet())).toMatchObject({ triggered: true });
    });
});

describe('processJackpotBet — the winning bet', () => {
    test('claims the pool and resets it in one atomic write', async () => {
        roll(true);

        await processJackpotBet(bet());

        const [filter, update, options] = Guild.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1' });
        expect(update.$set).toMatchObject({
            'casinoJackpot.pool': 10_000,
            'casinoJackpot.betsCount': 0,
            'casinoJackpot.lastWinnerId': 'u1',
            'casinoJackpot.lastWinnerName': 'Ada',
        });
        // `new: false` is load-bearing: the payout is computed from the pool as
        // it stood at the win, not from the seed the same write just installed.
        expect(options).toEqual({ new: false });
    });

    test('pays the pre-reset pool plus this bet’s contribution', async () => {
        roll(true);

        const result = await processJackpotBet(bet());

        expect(result).toEqual({ triggered: true, wonAmount: 250_050, newPool: 10_000 });
        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' },
            { $inc: { balance: 250_050 } },
            { new: true },
        );
    });

    test('a concurrent bet that claimed first leaves the seed as the payout floor', async () => {
        roll(true);
        Guild.findOneAndUpdate.mockResolvedValue(null);

        const result = await processJackpotBet(bet());

        expect(result.wonAmount).toBe(10_050);
    });

    test('records the amount won and files the ledger entry', async () => {
        roll(true);

        await processJackpotBet(bet());

        expect(Guild.updateOne).toHaveBeenCalledWith({ guildId: 'g1' }, {
            $set: { 'casinoJackpot.lastWonAmount': 250_050 },
        });
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u1', guildId: 'g1', type: 'casino_jackpot', amount: 250_050, balance: 999,
        }));
    });

    test('retries a credit that fails, and pays exactly once when a retry lands', async () => {
        roll(true);
        User.findOneAndUpdate
            .mockRejectedValueOnce(new Error('mongo down'))
            .mockResolvedValueOnce({ balance: 250_999 });

        const result = await processJackpotBet(bet());

        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(2);
        expect(result.triggered).toBe(true);
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ balance: 250_999 }));
    });

    test('restores the pool when the credit will not land at all', async () => {
        roll(true);
        User.findOneAndUpdate.mockRejectedValue(new Error('mongo down'));

        const result = await processJackpotBet(bet());

        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(3);
        const restore = Guild.updateOne.mock.calls.find(([, u]) => u.$inc);
        // A `$inc` delta back to what was claimed, not a `$set`: bets that
        // landed while the credit was failing keep their contributions.
        expect(restore[1]).toEqual({ $inc: { 'casinoJackpot.pool': 240_050 } });
        // And no win is reported, so nothing downstream announces a payout
        // nobody received.
        expect(result).toEqual({ triggered: false, newPool: 250_050 });
        expect(logTransaction).not.toHaveBeenCalled();
    });

    test('a restore that also fails is logged rather than thrown at the caller', async () => {
        roll(true);
        User.findOneAndUpdate.mockRejectedValue(new Error('mongo down'));
        Guild.updateOne.mockRejectedValue(new Error('mongo still down'));

        await expect(processJackpotBet(bet())).resolves.toMatchObject({ triggered: false });

        expect(errorLog.mock.calls.flat().join(' ')).toContain('pool restore also failed');
    });

    test('announces the drop in the configured channel', async () => {
        roll(true);
        const sent = [];
        const announceChannel = { send: async p => sent.push(['announce', p]) };
        Guild.findOneAndUpdate.mockResolvedValue({
            guildId: 'g1',
            casinoJackpot: { ...jackpot(), announceChannelId: 'jackpot-c' },
        });

        await processJackpotBet(bet({ interaction: {
            user: { displayAvatarURL: () => 'avatar', toString: () => '<@u1>' },
            guild: { channels: { cache: new Map([['jackpot-c', announceChannel]]) } },
            channel: { send: async p => sent.push(['fallback', p]) },
        } }));

        expect(sent.map(([where]) => where)).toEqual(['announce']);
        expect(sent[0][1].embeds[0].description).toContain('250,050');
        expect(sent[0][1].embeds[0].description).toContain('10,000');
    });

    test('falls back to the channel the bet was placed in', async () => {
        roll(true);
        const sent = [];

        await processJackpotBet(bet({ interaction: {
            user: { displayAvatarURL: () => 'avatar', toString: () => '<@u1>' },
            guild: { channels: { cache: new Map() } },
            channel: { send: async p => sent.push(p) },
        } }));

        expect(sent).toHaveLength(1);
    });

    test('an announcement that throws does not cost the winner their win', async () => {
        roll(true);

        const result = await processJackpotBet(bet({ interaction: {
            user: { displayAvatarURL: () => { throw new Error('no avatar'); } },
            channel: { send: async () => {} },
        } }));

        expect(result).toEqual({ triggered: true, wonAmount: 250_050, newPool: 10_000 });
    });
});

describe('getJackpotDisplay', () => {
    test('marks a pool hot once it crosses the threshold', async () => {
        Guild.findOne.mockResolvedValue({ casinoJackpot: { pool: HOT_POOL_THRESHOLD } });
        expect(await getJackpotDisplay('g1')).toEqual({
            pool: HOT_POOL_THRESHOLD, hot: true, display: '🔥 **500,000** coins',
        });
    });

    test('a pool just under it is not hot', async () => {
        Guild.findOne.mockResolvedValue({ casinoJackpot: { pool: HOT_POOL_THRESHOLD - 1 } });
        expect(await getJackpotDisplay('g1')).toMatchObject({ hot: false, display: '🏆 **499,999** coins' });
    });

    test('an unconfigured guild reads as the seed rather than as an error', async () => {
        Guild.findOne.mockResolvedValue(null);
        expect(await getJackpotDisplay('g1')).toMatchObject({ pool: 10_000, hot: false });
    });
});
