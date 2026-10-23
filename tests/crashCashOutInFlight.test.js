'use strict';

/**
 * A crash round does not settle a player twice (#873, pass 12).
 *
 * The round is driven by an async `setInterval` callback, and the interval
 * does not wait for it. A tick that awaits a cash-out write is still awaiting
 * when the next tick fires — and when the one after it reaches the crash
 * point. Three things went wrong in that gap:
 *
 *   1. The crash resolution swept the in-flight player as a loser, decrementing
 *      `pendingCrashRefund` — and then the cash-out write decremented it again.
 *      The marker is unclamped, so it went negative and silently absorbed the
 *      next lobby's stake: the stranded stake the restart sweep should return
 *      nets to zero.
 *   2. Every later tick re-fired the same auto cash-out, one credit write per
 *      tick for as long as the first was in flight.
 *   3. The stalled tick woke to a round already resolved and resolved it again.
 *
 * Plus the leaderboard write beside the cash-out, which lost a player's best
 * multiplier of the week to a concurrent cash-out at the Monday rollover.
 */

jest.mock('../src/models/User', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
    updateMany:       jest.fn(),
    find:             jest.fn(),
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

const { mockRandom, restoreRandom } = require('./helpers/secureRandom');
const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const crash = require('../src/games/casino/crash');
const { deleteLobby } = require('../src/utils/crashLobby');
const { updateCrashStats, getCurrentWeekStart } = require('../src/games/casino/crashStats');
const { deferred } = require('./helpers/deferred');
const { walletDoc, GUILD_ID, USER_ID, BET } = require('./helpers/casinoInteraction');
const { makeInteraction } = require('./helpers/fakeInteraction');

// 0.99 / (1 − 0.8) = 4.95x: long enough for a 2.00x auto cash-out to fire well before
// the bust, and for several ticks to pass while its write hangs.
const CRASH_AT_495 = 0.8;
const CHANNEL_ID   = 'channel-1';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

const isCashOutCredit = (filter, update) =>
    Array.isArray(update) && String(filter?.['paidPayouts.key']?.$ne ?? '').includes(':cashout:');

/** Everyone whose marker the round wrote off as a loser, per sweep. */
const sweeps = () => User.updateMany.mock.calls
    .filter(([, update]) => update?.$inc?.pendingCrashRefund !== undefined && update?.$inc?.balance === undefined)
    .map(([filter]) => filter?.userId?.$in ?? []);

/** How many times the round was resolved: each resolution records its crash point. */
const historyPushes = () => Guild.updateOne.mock.calls
    .filter(([, update]) => update?.$push?.['casinoStats.crashHistory']).length;

describe('a cash-out still in flight when the round crashes', () => {
    let errorSpy, write, spin;

    async function startRound() {
        spin = makeInteraction({
            options: { bet: BET, auto_cashout: 2.0 },
            userId: USER_ID, guildId: GUILD_ID, holdCollectors: true,
        });
        spin.client.users.fetch = jest.fn().mockResolvedValue({ username: 'player' });
        await crash.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        await jest.advanceTimersByTimeAsync(0);
        await flush();
        spin.endCollectors('time');   // nobody joined — start the round
        await flush();
    }

    async function tick(times) {
        for (let step = 0; step < times; step++) {
            await jest.advanceTimersByTimeAsync(1_200);
            await flush();
        }
    }

    beforeEach(() => {
        jest.clearAllMocks();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        deleteLobby(CHANNEL_ID);
        mockRandom(CRASH_AT_495);
        jest.useFakeTimers();

        write = deferred();
        User.findOneAndUpdate.mockImplementation((filter, update) =>
            (isCashOutCredit(filter, update) ? write.promise : Promise.resolve(walletDoc())));
        User.updateOne.mockResolvedValue({ matchedCount: 1 });
        User.updateMany.mockResolvedValue({});
        User.findOne.mockImplementation(() => {
            const query = Promise.resolve(walletDoc());
            query.lean = () => Promise.resolve(walletDoc());
            return query;
        });
        Guild.findOne.mockImplementation(() => {
            const doc = { guildId: GUILD_ID, economy: {} };
            const query = Promise.resolve(doc);
            query.lean = () => ({ catch: () => Promise.resolve(doc) });
            return query;
        });
        Guild.updateOne.mockResolvedValue({});
    });

    afterEach(() => {
        deleteLobby(CHANNEL_ID);
        jest.useRealTimers();
        restoreRandom();
        errorSpy.mockRestore();
    });

    test('the crash does not sweep the marker the cash-out write is about to clear', async () => {
        await startRound();
        await tick(40);                 // 2.00x fires, hangs, and the round busts

        // The round did bust while the write was in flight — this is the gap.
        expect(historyPushes()).toBe(1);
        for (const swept of sweeps()) expect(swept).not.toContain(USER_ID);

        write.resolve({ ...walletDoc(), balance: 10_000 + BET });
        await tick(3);
    }, 20_000);

    test('the auto cash-out is written once, not once per tick while it hangs', async () => {
        await startRound();
        await tick(40);

        const credits = User.findOneAndUpdate.mock.calls.filter(([f, u]) => isCashOutCredit(f, u));
        expect(credits).toHaveLength(1);

        write.resolve({ ...walletDoc(), balance: 10_000 + BET });
        await tick(3);
    }, 20_000);

    test('the stalled tick does not resolve the round a second time when it wakes', async () => {
        await startRound();
        await tick(40);
        expect(historyPushes()).toBe(1);

        write.resolve({ ...walletDoc(), balance: 10_000 + BET });
        await tick(3);

        expect(historyPushes()).toBe(1);
    }, 20_000);

    test('the final embed does not call a player whose cash-out is settling a loser', async () => {
        await startRound();
        await tick(40);

        const final = spin.replies.filter(r => r?.embeds?.[0]?.data?.title?.startsWith('💥 Crashed')).at(-1);
        const text = final.embeds[0].data.description;
        expect(text).not.toContain("didn't cash out");
        expect(text).toContain('settling');

        write.resolve({ ...walletDoc(), balance: 10_000 + BET });
        await tick(3);
    }, 20_000);
});

describe('the weekly leaderboard write', () => {
    /**
     * A store for the one field the write touches, evaluating the three
     * filters it issues for real — which is the whole race: the rollover's
     * `$or` misses once the week has been moved on under it.
     */
    function statsStore(initial) {
        const doc = { userId: USER_ID, guildId: GUILD_ID, crashStats: { ...initial } };
        const weekOf = () => doc.crashStats.weekStart ?? null;
        const matches = filter => {
            if (filter['crashStats.weekStart']?.$gte) return weekOf() !== null && weekOf() >= filter['crashStats.weekStart'].$gte;
            if (filter.$or) {
                return filter.$or.some(term => ('$lt' in (term['crashStats.weekStart'] ?? {}))
                    ? weekOf() !== null && weekOf() < term['crashStats.weekStart'].$lt
                    : weekOf() === null);
            }
            return true;
        };
        const apply = update => {
            for (const [path, value] of Object.entries(update.$set ?? {})) doc.crashStats[path.split('.')[1]] = value;
            for (const [path, value] of Object.entries(update.$max ?? {})) {
                const key = path.split('.')[1];
                doc.crashStats[key] = Math.max(doc.crashStats[key] ?? 0, value);
            }
        };
        return { doc, matches, apply };
    }

    beforeEach(() => jest.clearAllMocks());

    test('a cash-out that loses the rollover race still raises the week\'s best', async () => {
        // Two cash-outs on the first day of a new week, both reading last week's
        // `weekStart`: the first rolls the week over at 1.5x, and the second —
        // the higher — finds the rollover already done.
        const lastWeek = new Date(getCurrentWeekStart().getTime() - 7 * 86_400_000);
        const store = statsStore({ weekStart: lastWeek, weekBest: 9, allTimeBest: 9 });

        let first = true;
        User.updateOne.mockImplementation(async (filter, update) => {
            // The racing writer lands between this cash-out's same-week miss and
            // its rollover — exactly once.
            if (first && filter.$or) {
                first = false;
                store.doc.crashStats = { ...store.doc.crashStats, weekStart: getCurrentWeekStart(), weekBest: 1.5 };
            }
            if (!store.matches(filter)) return { matchedCount: 0 };
            store.apply(update);
            return { matchedCount: 1 };
        });

        await updateCrashStats(USER_ID, GUILD_ID, 20, 'player');

        expect(store.doc.crashStats.weekBest).toBe(20);
        expect(store.doc.crashStats.allTimeBest).toBe(20);
    });

    test('an uncontested rollover resets the week to this cash-out', async () => {
        const lastWeek = new Date(getCurrentWeekStart().getTime() - 7 * 86_400_000);
        const store = statsStore({ weekStart: lastWeek, weekBest: 9, allTimeBest: 9 });
        User.updateOne.mockImplementation(async (filter, update) => {
            if (!store.matches(filter)) return { matchedCount: 0 };
            store.apply(update);
            return { matchedCount: 1 };
        });

        await updateCrashStats(USER_ID, GUILD_ID, 2.5, 'player');

        expect(store.doc.crashStats).toMatchObject({ weekBest: 2.5, allTimeBest: 9 });
        expect(store.doc.crashStats.weekStart).toEqual(getCurrentWeekStart());
    });
});
