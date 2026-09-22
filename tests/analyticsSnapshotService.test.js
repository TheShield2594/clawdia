'use strict';

// Daily KPI snapshots (#1076). The three overview tiles without an event stream
// — economy active-users, AI request volume, top level — get a week-over-week
// delta and a sparkline from a dated row this job writes once a day. The job is
// arithmetic over three reads and a capped push, so the tests pin exactly that:
// the metrics it computes, the overwrite-or-push shape of the write, and the
// per-shard partition it shares with every other guild-scoped job.

jest.mock('../src/models/Guild', () => ({ find: jest.fn() }));
jest.mock('../src/models/GuildAnalytics', () => ({ aggregate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ countDocuments: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/utils/sharding', () => ({ handlesGuild: jest.fn(() => true) }));

const Guild = require('../src/models/Guild');
const GuildAnalytics = require('../src/models/GuildAnalytics');
const User = require('../src/models/User');
const { handlesGuild } = require('../src/utils/sharding');
const {
    recordDailyMetricSnapshots,
    computeSnapshot,
    writeSnapshot,
    AI_COMMANDS,
    SNAPSHOT_CAP,
} = require('../src/services/analyticsSnapshotService');

// User.findOne(...).select(...).sort(...).lean() — a chainable stub whose leaf
// resolves to the top user (or null).
function findOneChain(topUser) {
    const chain = {
        select: jest.fn(() => chain),
        sort: jest.fn(() => chain),
        lean: jest.fn().mockResolvedValue(topUser),
    };
    return chain;
}

beforeEach(() => {
    jest.clearAllMocks();
    handlesGuild.mockReturnValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('computeSnapshot', () => {
    test('reads active-users, AI request volume and top level for one guild', async () => {
        User.countDocuments.mockResolvedValue(42);
        User.findOne.mockReturnValue(findOneChain({ level: 17 }));
        GuildAnalytics.aggregate.mockResolvedValue([{ aiRequests: 9 }]);

        const snap = await computeSnapshot('g1');

        expect(snap).toEqual({ economyActiveUsers: 42, aiRequests: 9, topLevel: 17 });

        // Active-users is the 7-day window over the economy last-action fields —
        // the same question /stats asks, so the trend and the headline agree.
        const activeFilter = User.countDocuments.mock.calls[0][0];
        expect(activeFilter.guildId).toBe('g1');
        expect(Array.isArray(activeFilter.$or)).toBe(true);
        expect(activeFilter.$or.some(c => c.lastWork)).toBe(true);

        // AI volume is counted in the pipeline, not by hydrating commandUsage.
        const pipeline = GuildAnalytics.aggregate.mock.calls[0][0];
        expect(JSON.stringify(pipeline)).toContain('$size');
        expect(pipeline[1].$project.aiRequests.$size.$filter.cond.$in[1]).toEqual(AI_COMMANDS);
    });

    test('degrades to zeroes for a guild with no users, no analytics doc', async () => {
        User.countDocuments.mockResolvedValue(0);
        User.findOne.mockReturnValue(findOneChain(null));
        GuildAnalytics.aggregate.mockResolvedValue([]);

        expect(await computeSnapshot('g1')).toEqual({ economyActiveUsers: 0, aiRequests: 0, topLevel: 0 });
    });
});

describe('writeSnapshot', () => {
    const metrics = { economyActiveUsers: 5, aiRequests: 3, topLevel: 8 };

    test("overwrites today's row in place when it already exists", async () => {
        GuildAnalytics.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

        await writeSnapshot('g1', '2026-09-22', metrics);

        // Only the in-place $set update — no push branch, so a re-run within a
        // day refreshes the values rather than duplicating the row.
        expect(GuildAnalytics.updateOne).toHaveBeenCalledTimes(1);
        const [filter, update] = GuildAnalytics.updateOne.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', 'metricSnapshots.date': '2026-09-22' });
        expect(update.$set['metricSnapshots.$.economyActiveUsers']).toBe(5);
        expect(update.$set['metricSnapshots.$.aiRequests']).toBe(3);
        expect(update.$set['metricSnapshots.$.topLevel']).toBe(8);
    });

    test('pushes a new capped row when there is none for today', async () => {
        GuildAnalytics.updateOne
            .mockResolvedValueOnce({ matchedCount: 0 })   // no in-place match
            .mockResolvedValueOnce({ matchedCount: 1 });  // the push/upsert

        await writeSnapshot('g1', '2026-09-22', metrics);

        expect(GuildAnalytics.updateOne).toHaveBeenCalledTimes(2);
        const [filter, update, options] = GuildAnalytics.updateOne.mock.calls[1];
        // The $ne guard stops two racing runs both inserting today's row.
        expect(filter).toEqual({ guildId: 'g1', 'metricSnapshots.date': { $ne: '2026-09-22' } });
        const push = update.$push.metricSnapshots;
        expect(push.$each).toEqual([{ date: '2026-09-22', ...metrics }]);
        expect(push.$slice).toBe(-SNAPSHOT_CAP);
        expect(update.$setOnInsert).toEqual({ guildId: 'g1' });
        expect(options).toEqual({ upsert: true });
    });
});

describe('recordDailyMetricSnapshots', () => {
    const client = { shard: null };

    function stubCompute(byGuild) {
        User.countDocuments.mockImplementation(f => Promise.resolve(byGuild[f.guildId]?.active ?? 0));
        User.findOne.mockImplementation(({ guildId }) => findOneChain({ level: byGuild[guildId]?.level ?? 0 }));
        GuildAnalytics.aggregate.mockImplementation(([{ $match }]) =>
            Promise.resolve([{ aiRequests: byGuild[$match.guildId]?.ai ?? 0 }]));
    }

    test('writes one row per guild this shard handles, skipping the rest', async () => {
        Guild.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
            { guildId: 'mine-1' }, { guildId: 'other' }, { guildId: 'mine-2' },
        ]) }) });
        handlesGuild.mockImplementation(id => id.startsWith('mine'));
        stubCompute({ 'mine-1': { active: 1 }, 'mine-2': { active: 2 } });
        GuildAnalytics.updateOne.mockResolvedValue({ matchedCount: 1 });

        await recordDailyMetricSnapshots(client);

        const written = GuildAnalytics.updateOne.mock.calls.map(c => c[0].guildId);
        expect(new Set(written)).toEqual(new Set(['mine-1', 'mine-2']));
        expect(written).not.toContain('other');
    });

    test('does nothing when the shard handles no guilds', async () => {
        Guild.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ guildId: 'g' }]) }) });
        handlesGuild.mockReturnValue(false);

        await recordDailyMetricSnapshots(client);
        expect(GuildAnalytics.updateOne).not.toHaveBeenCalled();
    });

    test('a failing guild is logged and counted, and the run still throws', async () => {
        Guild.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
            { guildId: 'ok' }, { guildId: 'boom' },
        ]) }) });
        stubCompute({ ok: { active: 1 }, boom: { active: 1 } });
        GuildAnalytics.updateOne.mockImplementation(filter =>
            filter.guildId === 'boom'
                ? Promise.reject(new Error('write failed'))
                : Promise.resolve({ matchedCount: 1 }));

        await expect(recordDailyMetricSnapshots(client)).rejects.toThrow(/1 of 2 metric snapshot/);
        // The healthy guild was still written — one bad guild does not strand
        // the rest of the sweep.
        expect(GuildAnalytics.updateOne.mock.calls.some(c => c[0].guildId === 'ok')).toBe(true);
    });
});
