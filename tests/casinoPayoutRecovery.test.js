'use strict';

/**
 * A casino hand that cannot be paid is written down rather than lost (#873).
 *
 * The stake leaves the wallet through `placeWager` the moment a hand opens; the
 * payout arrives minutes later, from a button collector, as a bare
 * `$inc: { balance }` with — at several sites — nothing catching it at all. A
 * write that never landed left no trace: no retry, no record, no mention in the
 * embed, which printed the payout and a balance that had not moved. The
 * progressive jackpot credited from the same spin already went through
 * `creditCoinsOrOwe`, so the pot built from other players' stakes was
 * recoverable and the hand's own winnings beside it were not.
 *
 * What has to hold now:
 *
 *   1. Every coin a casino hand credits goes through a keyed write, so a retry
 *      cannot pay twice and a failure can be replayed.
 *   2. A credit that will not land is recorded as owed, and the player is told
 *      in the same embed that announces the win.
 *   3. A hand and its "Play Again" are different hands. The replay re-enters
 *      each game's play function with the *original* interaction, so a key
 *      built from the interaction would classify the replay's payout as a
 *      duplicate of the first hand's and silently drop it — the failure this
 *      change would have introduced if the key were the obvious one.
 */

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
// The retry inside creditCoinsOrOwe sleeps between attempts; three of those per
// failing payout is the difference between a fast suite and a slow one.
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { newHandId, payHand, payoutNote, settledBalance } = require('../src/games/casino/payout');
const { casinoPayoutKey } = require('../src/utils/payoutKey');
const { walletDoc, makeInteraction, GUILD_ID, USER_ID, BET } = require('./helpers/casinoInteraction');
const { makeInteraction: baseInteraction } = require('./helpers/fakeInteraction');

const FILTER = { userId: USER_ID, guildId: GUILD_ID };

/** Every keyed coin credit attempted, as `{ key, amount }`. */
const keyedCredits = () => User.findOneAndUpdate.mock.calls
    .filter(([filter, update]) => Array.isArray(update) && filter?.['paidPayouts.key']?.$ne)
    .map(([filter, update]) => ({
        key:    filter['paidPayouts.key'].$ne,
        amount: update[0]?.$set?.balance?.$add?.[1],
    }));

/** A Guild query result that answers both `await` and `.lean()`. */
const guildQuery = doc => {
    const query = Promise.resolve(doc);
    query.lean = () => Promise.resolve(doc);
    return query;
};

let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    User.findOneAndUpdate.mockResolvedValue(walletDoc());
    User.updateOne.mockResolvedValue({});
    User.updateMany.mockResolvedValue({});
    User.findOne.mockImplementation(() => {
        const query = Promise.resolve(walletDoc());
        query.lean = () => Promise.resolve(walletDoc());
        return query;
    });
    Guild.findOne.mockImplementation(() => guildQuery({ guildId: GUILD_ID, economy: {} }));
    Guild.updateOne.mockResolvedValue({});
    Guild.findOneAndUpdate.mockResolvedValue(null);
});

afterEach(() => errorSpy.mockRestore());

describe('paying a settled hand', () => {
    test('the credit carries a payout key naming the game, the hand and the settlement', async () => {
        const handId = newHandId();
        await payHand(FILTER, 250, { game: 'blackjack', handId, phase: 'settle' });

        expect(keyedCredits()).toEqual([
            { key: `casino:blackjack:${handId}:settle`, amount: 250 },
        ]);
    });

    test('a credit that matches nothing is retried, then recorded as owed', async () => {
        // Nothing matches and the key is absent, which is `classifyUnmatchedPayout`'s
        // 'unknown' — the case that is worth retrying.
        User.findOneAndUpdate.mockResolvedValue(null);
        User.findOne.mockImplementation(() => {
            const query = Promise.resolve({ ...walletDoc(), paidPayouts: [] });
            query.lean = () => Promise.resolve({ ...walletDoc(), paidPayouts: [] });
            return query;
        });

        const result = await payHand(FILTER, 250, { game: 'keno', handId: 'hand-1', phase: 'settle' });

        expect(result).toMatchObject({ credited: false, owed: true });
        expect(keyedCredits().length).toBeGreaterThan(1);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'casino',
            jobName: 'keno:settle',
            payload: expect.objectContaining({ kind: 'coins', amount: 250, userId: USER_ID }),
        }));
    });

    test('a credit whose key is already on the document is a success, not a second payment', async () => {
        // The write matched nothing because the key is there: an earlier attempt
        // landed and only its response was lost. Paying again is the bug the key
        // exists to prevent.
        User.findOneAndUpdate.mockResolvedValue(null);
        const key = casinoPayoutKey('poker', 'hand-1', 'showdown');
        User.findOne.mockImplementation(() => {
            const doc = { ...walletDoc(), paidPayouts: [{ key }] };
            const query = Promise.resolve(doc);
            query.lean = () => Promise.resolve(doc);
            return query;
        });

        const result = await payHand(FILTER, 250, { game: 'poker', handId: 'hand-1', phase: 'showdown' });

        expect(result).toMatchObject({ credited: true, owed: false });
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a zero payout writes nothing at all', async () => {
        // A loss, or a jackpot spin whose pot the service credits instead. The
        // old code still issued `$inc: { balance: 0 }`, which is a round trip
        // and one more way for a settled hand to fail.
        const result = await payHand(FILTER, 0, { game: 'slots', handId: 'hand-1', phase: 'settle' });

        expect(result).toMatchObject({ credited: true, owed: false });
        expect(keyedCredits()).toHaveLength(0);
    });

    test('a hand id is minted per hand, not per interaction', () => {
        expect(newHandId()).not.toBe(newHandId());
    });

    test('two hands played through one interaction do not share a key', async () => {
        // This is the trap. Every game's "Play Again" re-enters its play
        // function with the *original* interaction, so a key built from
        // `interaction.id` would classify the second hand's payout as a
        // duplicate of the first — and the player would win and not be paid,
        // which is worse than the unkeyed write this replaces.
        const slots = require('../src/games/casino/slots');
        const random = jest.spyOn(Math, 'random').mockReturnValue(5 / 102);
        const spin = makeInteraction({ bet: BET });

        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        random.mockRestore();

        const settles = keyedCredits()
            .map(({ key }) => key)
            .filter(key => key.startsWith('casino:slots:'));
        expect(settles).toHaveLength(2);
        expect(settles[0]).not.toBe(settles[1]);
    }, 20_000);
});

describe('what the player is told', () => {
    test('a credited payout adds nothing to the embed', () => {
        expect(payoutNote({ credited: true, owed: false })).toBe('');
    });

    test('an owed payout says it was recorded and will be paid', () => {
        const note = payoutNote({ credited: false, owed: true });
        expect(note).toContain('recorded');
        expect(note).toContain('paid automatically');
    });

    test('a payout that could not even be recorded says to find an admin', () => {
        const note = payoutNote({ credited: false, owed: false });
        expect(note).toContain('could not be credited and could not be recorded');
    });

    test('the balance shown is read back when the credit returned no document', async () => {
        // The stake left the wallet when the wager was placed, so the figure the
        // game is still holding is higher than the truth. Printing it would tell
        // a player who has not been paid that they have been.
        expect(await settledBalance(FILTER, null)).toBe(walletDoc().balance);
        expect(await settledBalance(FILTER, 4_321)).toBe(4_321);
    });

    test('a balance read that throws does not take the failure message with it', async () => {
        // This runs on the path where a write has already failed, so the next
        // call to the same database is not something to assume well-formed.
        User.findOne.mockImplementation(() => { throw new Error('down'); });
        await expect(settledBalance(FILTER, null)).resolves.toBe(0);
    });
});

describe('a spin whose payout will not land', () => {
    const slots = require('../src/games/casino/slots');

    test('says so in the result rather than printing a balance that never moved', async () => {
        // The wager lands (`$inc`), every keyed credit misses, and the key is
        // absent — so the win is real and unpayable.
        User.findOneAndUpdate.mockImplementation((_filter, update) =>
            Promise.resolve(Array.isArray(update) ? null : walletDoc()));
        User.findOne.mockImplementation(() => {
            const doc = { ...walletDoc(), paidPayouts: [] };
            const query = Promise.resolve(doc);
            query.lean = () => Promise.resolve(doc);
            return query;
        });
        // Three cherries: an ordinary three-of-a-kind, so there is a payout to
        // lose and no jackpot claim to confuse it with.
        const random = jest.spyOn(Math, 'random').mockReturnValue(5 / 102);

        const spin = makeInteraction({ bet: BET });
        await slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        random.mockRestore();

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'casino',
            jobName: 'slots:settle',
        }));
        const description = spin.replies.at(-1).embeds[0].data.description;
        expect(description).toContain('recorded');
    }, 20_000);
});

describe('a crash cash-out whose write does not land', () => {
    const crash    = require('../src/games/casino/crash');
    const { deleteLobby } = require('../src/utils/crashLobby');

    // 0.99 / 0.2 = 4.95x, so the round runs long enough for a 2.00x auto
    // cash-out to fire well before the bust.
    const CRASH_AT_495 = 0.2;
    const CHANNEL_ID   = 'channel-1';

    /** Everyone whose `pendingCrashRefund` the round decided to write off. */
    const sweptIds = () => User.updateMany.mock.calls
        .filter(([, update]) => update?.$inc?.pendingCrashRefund !== undefined && update?.$inc?.balance === undefined)
        .flatMap(([filter]) => filter?.userId?.$in ?? []);

    /**
     * Runs a whole round: the lobby opens, nobody joins, the join collector
     * lapses into `startCrashGame`, and the ticks are driven to the bust.
     */
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

    /**
     * Runs a whole round: the lobby opens, nobody joins, the join collector is
     * closed by hand so `startCrashGame` takes over, and the ticks are driven
     * to the bust.
     *
     * `holdCollectors` is what makes this possible. The round's own collector
     * stops the ticking when it ends, and the harness's default is to end a
     * collector the moment its queue of presses empties — which killed the
     * round before its first tick.
     */
    async function playRound() {
        const spin = baseInteraction({
            options: { bet: BET, auto_cashout: 2.0 },
            userId: USER_ID, guildId: GUILD_ID, holdCollectors: true,
        });
        spin.client.users.fetch = jest.fn().mockResolvedValue({ username: 'player' });
        await crash.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        await jest.advanceTimersByTimeAsync(0);
        await flush();
        spin.endCollectors('time');   // nobody joined — start the round
        await flush();
        for (let step = 0; step < 40; step++) {
            await jest.advanceTimersByTimeAsync(1_200);
            await flush();
        }
        return spin;
    }

    beforeEach(() => {
        deleteLobby(CHANNEL_ID);
        User.updateMany.mockResolvedValue({});
        jest.spyOn(Math, 'random').mockReturnValue(CRASH_AT_495);
        jest.useFakeTimers();
    });

    afterEach(() => {
        deleteLobby(CHANNEL_ID);
        jest.useRealTimers();
        Math.random.mockRestore();
    });

    test('keeps the marker the restart reconciler pays the stake back from', async () => {
        // The wager lands; every keyed credit misses with the key absent, which
        // is a cash-out that resolved for the player and not for the database.
        User.findOneAndUpdate.mockImplementation((_filter, update) =>
            Promise.resolve(Array.isArray(update) ? null : walletDoc()));
        User.findOne.mockImplementation(() => {
            const doc = { ...walletDoc(), paidPayouts: [] };
            const query = Promise.resolve(doc);
            query.lean = () => Promise.resolve(doc);
            return query;
        });
        await playRound();

        // The bug: the bust swept everyone who was not marked cashed-out, and a
        // failed cash-out is deliberately left unmarked so the tick-error path
        // can still see it. That cleared `pendingCrashRefund` for the one player
        // who had already lost the payout, taking the stake with it.
        expect(sweptIds()).not.toContain(USER_ID);
    }, 20_000);

    test('records the winnings owed, not the whole payout the stake is half of', async () => {
        User.findOneAndUpdate.mockImplementation((_filter, update) =>
            Promise.resolve(Array.isArray(update) ? null : walletDoc()));
        User.findOne.mockImplementation(() => {
            const doc = { ...walletDoc(), paidPayouts: [] };
            const query = Promise.resolve(doc);
            query.lean = () => Promise.resolve(doc);
            return query;
        });
        await playRound();

        // `pendingCrashRefund` returns the stake and the owed record returns the
        // winnings on top of it. Recording the whole payout here would have the
        // two mechanisms pay the stake twice between them.
        const [{ payload }] = recordOwedPayout.mock.calls.at(-1);
        expect(payload.amount).toBeLessThan(BET * 2);
        expect(payload.amount).toBeGreaterThan(0);
        expect(payload.payoutKey).toContain('cashout-net');
    }, 20_000);

    test('is reported as a pending payout, not as a player who never cashed out', async () => {
        User.findOneAndUpdate.mockImplementation((_filter, update) =>
            Promise.resolve(Array.isArray(update) ? null : walletDoc()));
        User.findOne.mockImplementation(() => {
            const doc = { ...walletDoc(), paidPayouts: [] };
            const query = Promise.resolve(doc);
            query.lean = () => Promise.resolve(doc);
            return query;
        });

        const spin = await playRound();

        // `cashedOutAt` stays null on purpose — the tick-error refund keys off
        // it — so with nothing else recorded the live lines called this player
        // "still in" and the final embed called them a loser, contradicting the
        // reply they had already been given.
        const final = spin.replies.at(-1).embeds[0].data.description;
        expect(final).not.toContain("didn't cash out");
        expect(final).toMatch(/cashed at/);
        expect(final).toContain('not yet paid');
    }, 20_000);

    test('a round that pays cleanly clears the marker in the same write as the coins', async () => {
        await playRound();

        const [[filter, update]] = User.findOneAndUpdate.mock.calls
            .filter(([f, u]) => Array.isArray(u) && f?.['paidPayouts.key']?.$ne?.includes('cashout'));
        expect(filter['paidPayouts.key'].$ne).toContain('casino:crash:');
        // Decremented rather than zeroed: a player sitting in a second
        // channel's lobby has that stake counted in the same field.
        expect(update[0].$set.pendingCrashRefund).toEqual({
            $add: [{ $ifNull: ['$pendingCrashRefund', 0] }, -BET],
        });
        expect(recordOwedPayout).not.toHaveBeenCalled();
    }, 20_000);
});


describe('a cash-out the player pressed for', () => {
    const crash = require('../src/games/casino/crash');
    const { deleteLobby } = require('../src/utils/crashLobby');

    const CRASH_AT_495 = 0.2;
    const CHANNEL_ID   = 'channel-1';
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

    beforeEach(() => {
        deleteLobby(CHANNEL_ID);
        User.updateMany.mockResolvedValue({});
        jest.spyOn(Math, 'random').mockReturnValue(CRASH_AT_495);
        jest.useFakeTimers();
    });

    afterEach(() => {
        deleteLobby(CHANNEL_ID);
        jest.useRealTimers();
        Math.random.mockRestore();
    });

    test('is told it succeeded, not that it could not be credited', async () => {
        // `cashOutPlayer` answers with a string the handler compares against
        // 'paid'; returning `true` from the success path made every successful
        // manual cash-out fall into the failure wording — the hand paid and the
        // player was told it had not.
        const lobbyId = `${CHANNEL_ID}_${Date.now()}`;
        const spin = baseInteraction({
            options: { bet: BET, auto_cashout: null },
            userId: USER_ID, guildId: GUILD_ID, holdCollectors: true,
            components: [{ customId: `crash_co_${lobbyId}` }],
        });
        spin.client.users.fetch = jest.fn().mockResolvedValue({ username: 'player' });

        await crash.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        await jest.advanceTimersByTimeAsync(0);
        await flush();
        spin.endCollectors('time');   // nobody joined — start the round
        await flush();
        for (let step = 0; step < 40; step++) {
            await jest.advanceTimersByTimeAsync(1_200);
            await flush();
        }

        const cashOutReply = spin.replies.map(r => r.content).filter(Boolean)
            .find(c => c.includes('Cashed out'));
        expect(cashOutReply).toContain('✅');
        expect(cashOutReply).not.toContain('could not be credited');
    }, 20_000);
});

describe('a Lucky Save whose result cannot be rendered', () => {
    const higherlower = require('../src/games/casino/higherlower');

    /**
     * `rollCard` takes two randoms — value then suit — so the sequence is
     * current card, next card, then the save roll. A King followed by an Ace
     * makes "Higher" a loss, and the last value puts the save roll on the true
     * side of both the charm's flat 20% and the streak's 25%.
     */
    const LOSES_THEN_SAVES = [0.99, 0, 0, 0, 0.1];

    test.each(['charm', 'streak'])('settles once for the %s save, not again for the failed render', async (kind) => {
        jest.useFakeTimers();
        const doc = {
            ...walletDoc(),
            activeEffects: [{
                type:      kind === 'charm' ? 'lucky_charm' : 'lucky_streak',
                expiresAt: new Date(Date.now() + 3.6e6),
            }],
        };
        User.findOne.mockImplementation(() => {
            const query = Promise.resolve(doc);
            query.lean = () => Promise.resolve(doc);
            return query;
        });
        const rolls  = [...LOSES_THEN_SAVES];
        const random = jest.spyOn(Math, 'random').mockImplementation(() => rolls.shift() ?? 0);

        // The button ids carry `Date.now()`, which the fake timers pin.
        const now = Date.now();
        const hand = baseInteraction({
            options: { bet: BET },
            userId: USER_ID, guildId: GUILD_ID,
            // One press. The collector takes `max: 1`, and a second queued press
            // would be a second hand, not a second attempt at this one.
            components: [{ customId: `hl_up_interaction-1_${now}`, updateRejects: true }],
        });

        await higherlower.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        await jest.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 40; i++) await Promise.resolve();

        random.mockRestore();
        jest.useRealTimers();

        // The save credits the bet and then renders it. A render that threw
        // dropped into the outer catch, which refunded the bet a *second* time
        // under its own key — a different key, so nothing stopped it.
        const settlements = keyedCredits().filter(({ key }) => key.startsWith('casino:higherlower:'));
        expect(settlements).toHaveLength(1);
        expect(settlements[0].key).toContain('lucky-save');
    }, 20_000);
});
