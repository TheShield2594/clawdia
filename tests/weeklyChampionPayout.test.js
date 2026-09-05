'use strict';

/**
 * #784, carried over from the hourly competition this replaced.
 * `announceWeeklyChampions` pays a five-figure prize per category every Monday,
 * unwatched. The only thing standing between it and a double payout is the
 * per-winner `rewarded: false → true` claim; the only thing standing between a
 * champion and silence is a `WEEKLY_CATEGORY_LABELS` entry, which is a separate
 * table a new competition has to be added to. Neither was executed.
 *
 * The weekly selection adds a third: the champion is picked by aggregation
 * rather than stored as a single leader row, and picking it *without* filtering
 * on `rewarded` is what stops a re-run crowning the runner-up and paying twice.
 */

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.fields.push(...f.flat()); return this; }
    }
    return { EmbedBuilder, AttachmentBuilder: class {} };
});

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User',  () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/models/WeeklyChampion', () => ({ aggregate: jest.fn(), find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateMany: jest.fn() }));
// Only recordOwedPayout is stubbed. `owedSummary` lives in the same module
// (#931) and is what the sweep's own error message is built from, so
// replacing the whole module would test the mock's wording rather than the
// one an operator reads.
jest.mock('../src/utils/owedPayout', () => ({
    ...jest.requireActual('../src/utils/owedPayout'),
    recordOwedPayout: jest.fn(),
}));

const Guild          = require('../src/models/Guild');
const User           = require('../src/models/User');
const WeeklyChampion = require('../src/models/WeeklyChampion');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { getPreviousWeekKey } = require('../src/utils/weeklyChampion');
const { announceWeeklyChampions } = require('../src/services/weeklyChampionService');

const REWARD = 10_000;

let sent;
let errorLog;

function fakeClient() {
    sent = [];
    return {
        guilds: {
            fetch: jest.fn(async guildId => ({
                id: guildId,
                channels: {
                    fetch: async channelId => ({
                        isTextBased: () => true,
                        send: async payload => { sent.push({ guildId, channelId, payload }); },
                    }),
                },
            })),
        },
    };
}

function champion(over = {}) {
    return {
        _id: 'w1', guildId: 'g1', userId: 'u1', username: 'Ada', category: 'fish',
        total: 120, runs: 8, best: 40, bestDetails: 'a Coelacanth', rewarded: false, ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    WeeklyChampion.aggregate.mockResolvedValue([champion()]);
    WeeklyChampion.findOneAndUpdate.mockImplementation(async filter => ({ _id: filter._id, rewarded: true }));
    User.findOneAndUpdate.mockResolvedValue({});
    recordOwedPayout.mockResolvedValue(true);
    Guild.findOne.mockReturnValue({ lean: async () => ({ guildId: 'g1', economy: { announcementChannelId: 'c1' } }) });
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('announceWeeklyChampions', () => {
    test('reads the week that just closed, not the one still running', async () => {
        // Frozen for the same reason as the credit below: the week is read once
        // by the job and once by the expectation.
        jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:05:00Z'));
        try {
            const week = getPreviousWeekKey();
            await announceWeeklyChampions(fakeClient());

            const [pipeline] = WeeklyChampion.aggregate.mock.calls[0];
            expect(pipeline[0]).toEqual({ $match: { week } });
        } finally {
            jest.useRealTimers();
        }
    });

    // The selection must see every row, claimed or not. Filtering `rewarded`
    // out of the `$match` does not skip an already-paid competition — it hands
    // the crown to whoever came second, and pays them.
    test('picks the top total per guild and category without filtering on rewarded', async () => {
        await announceWeeklyChampions(fakeClient());

        const [pipeline] = WeeklyChampion.aggregate.mock.calls[0];
        expect(JSON.stringify(pipeline[0].$match)).not.toContain('rewarded');
        expect(pipeline[1]).toEqual({ $sort: { total: -1, runs: -1, createdAt: 1 } });
        expect(pipeline[2].$group._id).toEqual({ guildId: '$guildId', category: '$category' });
        expect(pipeline[2].$group.top).toEqual({ $first: '$$ROOT' });
    });

    test('claims each champion before crediting, so a second run pays nothing', async () => {
        const order = [];
        WeeklyChampion.findOneAndUpdate.mockImplementation(async filter => { order.push('claim'); return { _id: filter._id }; });
        User.findOneAndUpdate.mockImplementation(async () => { order.push('credit'); return {}; });

        await announceWeeklyChampions(fakeClient());

        expect(order).toEqual(['claim', 'credit']);
        const [filter, update] = WeeklyChampion.findOneAndUpdate.mock.calls[0];
        // `rewarded: false` in the filter is the claim: without it the update
        // succeeds every time and every tick re-pays.
        expect(filter).toEqual({ _id: 'w1', rewarded: false });
        expect(update).toEqual({ $set: { rewarded: true } });
    });

    test('a champion another worker already claimed is not paid again', async () => {
        WeeklyChampion.findOneAndUpdate.mockResolvedValue(null);

        await announceWeeklyChampions(fakeClient());

        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
    });

    // The credit is a guarded pipeline update rather than a bare `$inc` (#807):
    // the payout key is in the filter, so a replay of a credit whose response was
    // lost matches nothing and moves no coins.
    test('credits the flat reward to the champion in their own guild', async () => {
        // The clock is frozen because the key is built from the week twice —
        // once inside the job, once in the expectation — and a run that crosses
        // the week boundary between them would fail on nothing but timing.
        jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:05:00Z'));
        try {
            const week = getPreviousWeekKey();
            await announceWeeklyChampions(fakeClient());

            const [filter, update] = User.findOneAndUpdate.mock.calls[0];
            expect(filter).toEqual({
                userId: 'u1', guildId: 'g1',
                'paidPayouts.key': { $ne: `weekly:${week}:fish` },
            });
            expect(update[0].$set.balance).toEqual({ $add: [{ $ifNull: ['$balance', 0] }, REWARD] });
            expect(JSON.stringify(update[0].$set.paidPayouts)).toContain(`weekly:${week}:fish`);
        } finally {
            jest.useRealTimers();
        }
    });

    test('a week with no entries does nothing at all', async () => {
        WeeklyChampion.aggregate.mockResolvedValue([]);

        await announceWeeklyChampions(fakeClient());

        expect(WeeklyChampion.findOneAndUpdate).not.toHaveBeenCalled();
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('pays every champion even when the announcement has nowhere to go', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ guildId: 'g1', economy: {} }) });

        await announceWeeklyChampions(fakeClient());

        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([]);
    });

    // #804. The claim is spent — the champion is `rewarded: true` — so no later
    // tick will find them again. The failure has to be both recorded per winner
    // (so someone can pay it) and raised (so the run is not reported healthy).
    test('a failed credit does not stop the other champions being paid, and is written down as owed', async () => {
        WeeklyChampion.aggregate.mockResolvedValue([champion(), champion({ _id: 'w2', userId: 'u2', category: 'mine' })]);
        User.findOneAndUpdate.mockImplementation(async filter => {
            if (filter.userId === 'u1') throw new Error('mongo down');
            return {};
        });

        await expect(announceWeeklyChampions(fakeClient())).rejects.toThrow('1 of 2 weekly reward(s) could not be credited');

        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(2);
        expect(recordOwedPayout).toHaveBeenCalledTimes(1);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'weeklyChampionService',
            jobName: 'announceWeeklyChampions',
            guildId: 'g1',
            payload: expect.objectContaining({
                kind: 'coins', userId: 'u1', guildId: 'g1', amount: REWARD, category: 'fish',
            }),
        }));
        expect(errorLog).toHaveBeenCalled();
    });

    // The owed payload has to carry the week, not the hour: `payoutKeyForPayload`
    // derives the guard key from it for records written before `payoutKey` was a
    // field, and a payload keyed on the wrong bucket replays unguarded.
    test('records the owed payout against the week it was won in', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:05:00Z'));
        try {
            const week = getPreviousWeekKey();
            User.findOneAndUpdate.mockResolvedValue(null);

            await expect(announceWeeklyChampions(fakeClient())).rejects.toThrow(/1 of 1/);

            expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
                payload: expect.objectContaining({ week, payoutKey: `weekly:${week}:fish` }),
            }));
        } finally {
            jest.useRealTimers();
        }
    });

    // The quiet one. `findOneAndUpdate` with no `upsert` resolves to `null`
    // rather than throwing when the user has no document in that guild, so the
    // old `.catch` never fired: the winner was marked rewarded, paid nothing,
    // and still named in the announcement as rewarded.
    test('a champion with no user document is owed, not silently skipped', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);

        await expect(announceWeeklyChampions(fakeClient())).rejects.toThrow('1 of 1 weekly reward(s) could not be credited');

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ kind: 'coins', userId: 'u1', amount: REWARD }),
        }));
        expect(sent).toEqual([]);
    });

    test('an unpaid champion is left out of the announcement the paid ones still get', async () => {
        WeeklyChampion.aggregate.mockResolvedValue([
            champion(),
            champion({ _id: 'w2', userId: 'u2', username: 'Grace', category: 'mine', total: 900, bestDetails: '90 ore' }),
        ]);
        User.findOneAndUpdate.mockImplementation(async filter => (filter.userId === 'u1' ? null : {}));

        await expect(announceWeeklyChampions(fakeClient())).rejects.toThrow(/1 of 2/);

        expect(sent).toHaveLength(1);
        const description = sent[0].payload.embeds[0].description;
        expect(description).toContain('<@u2> (Grace)');
        expect(description).not.toContain('<@u1>');
    });

    // The owed-queue write fails for the same reason the credit did, often
    // enough. Neither the rest of the week nor the raised failure depends on it.
    test('a failed owed-queue write still leaves the sweep failing', async () => {
        recordOwedPayout.mockResolvedValue(false);
        User.findOneAndUpdate.mockResolvedValue(null);

        await expect(announceWeeklyChampions(fakeClient())).rejects.toThrow(/1 of 1/);
    });

    // What the failure *says* has to match what an operator will find. A payout
    // in the owed queue is one command away from being paid; one that could not
    // be recorded is not there at all, and sending someone to payouts:replay for
    // it wastes the only chance anyone has of noticing.
    test('says a payout is replayable only when it was really recorded', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);

        await expect(announceWeeklyChampions(fakeClient())).rejects.toThrow(/recorded as owed, replay with/);
    });

    test('says so plainly when nothing could be recorded', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        recordOwedPayout.mockResolvedValue(false);

        await expect(announceWeeklyChampions(fakeClient()))
            .rejects.toThrow(/none could be recorded as owed; they must be paid by hand/);
    });

    test('separates the recorded from the unrecorded when the week has both', async () => {
        WeeklyChampion.aggregate.mockResolvedValue([champion(), champion({ _id: 'w2', userId: 'u2', category: 'mine' })]);
        User.findOneAndUpdate.mockResolvedValue(null);
        recordOwedPayout.mockImplementation(async ({ payload }) => payload.userId !== 'u1');

        await expect(announceWeeklyChampions(fakeClient())).rejects.toThrow(
            '2 of 2 weekly reward(s) could not be credited — 1 recorded as owed ' +
            '(replay with `npm run payouts:replay`); 1 could not be recorded and ' +
            'must be paid by hand, see the log above',
        );
    });

    test('groups the week into one announcement per guild', async () => {
        WeeklyChampion.aggregate.mockResolvedValue([
            champion(),
            champion({ _id: 'w2', userId: 'u2', username: 'Grace', category: 'mine', total: 42_500, runs: 61, bestDetails: '💎 Diamond' }),
            champion({ _id: 'w3', guildId: 'g2', userId: 'u3', username: 'Kay', category: 'hunt', total: 3_000, runs: 1, bestDetails: null }),
        ]);

        await announceWeeklyChampions(fakeClient());

        expect(sent.map(s => s.guildId)).toEqual(['g1', 'g2']);
        const g1 = sent[0].payload.embeds[0];
        expect(g1.title).toBe('👑 Champions of the Week');
        expect(g1.description).toContain('<@u1> (Ada) — **120 rarity score** over 8 runs');
        expect(g1.description).toContain('Best of the week: **a Coelacanth**');
        expect(g1.description).toContain('<@u2> (Grace) — **42,500 coins mined** over 61 runs');
        expect(g1.description).toContain('Rewarded **+10,000 coins**');

        const g2 = sent[1].payload.embeds[0];
        // A champion crowned on one run does not read as if they ground for it,
        // and no best recorded reads as a bare total rather than "**null**".
        expect(g2.description).toContain('<@u3> (Kay) — **3,000 coins hunted**');
        expect(g2.description).not.toContain('over 1 runs');
        expect(g2.description).not.toContain('Best of the week');
    });

    // The four lines of an announcement should read the same way every week,
    // whatever order the aggregation grouped them in.
    test('orders a guild\'s categories the same way every week', async () => {
        WeeklyChampion.aggregate.mockResolvedValue([
            champion({ _id: 'w1', category: 'explore', userId: 'u1' }),
            champion({ _id: 'w2', category: 'hunt',    userId: 'u2' }),
            champion({ _id: 'w3', category: 'fish',    userId: 'u3' }),
            champion({ _id: 'w4', category: 'mine',    userId: 'u4' }),
        ]);

        await announceWeeklyChampions(fakeClient());

        const titles = sent[0].payload.embeds[0].description
            .split('\n\n')
            .map(block => block.split('\n')[0]);
        expect(titles).toEqual([
            '🦌 **🏹 Hunter of the Week**',
            '💎 **⛏️ Miner of the Week**',
            '🐟 **🎣 Angler of the Week**',
            '🗺️ **🧭 Explorer of the Week**',
        ]);
    });

    test('a category missing from the label table is paid but not announced', async () => {
        // The label table is a second place a new competition has to be added.
        // Silence is the intended failure here — dropping the payout is not.
        WeeklyChampion.aggregate.mockResolvedValue([champion({ category: 'forage' })]);

        await announceWeeklyChampions(fakeClient());

        const [filter, update] = User.findOneAndUpdate.mock.calls[0];
        expect(filter.userId).toBe('u1');
        expect(filter.guildId).toBe('g1');
        expect(update[0].$set.balance).toEqual({ $add: [{ $ifNull: ['$balance', 0] }, REWARD] });
        expect(sent).toEqual([]);
    });

    test('one guild whose announcement throws does not strand the others', async () => {
        WeeklyChampion.aggregate.mockResolvedValue([champion(), champion({ _id: 'w2', guildId: 'g2', userId: 'u2' })]);
        Guild.findOne.mockImplementation(filter => ({
            lean: async () => {
                if (filter.guildId === 'g1') throw new Error('mongo down');
                return { guildId: 'g2', economy: { announcementChannelId: 'c2' } };
            },
        }));

        await expect(announceWeeklyChampions(fakeClient())).resolves.toBeUndefined();

        expect(sent.map(s => s.guildId)).toEqual(['g2']);
        expect(errorLog).toHaveBeenCalled();
    });
});
