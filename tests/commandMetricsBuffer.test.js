'use strict';

/**
 * #895. `logCommandMetric` ran one `$push` with `$slice: -3000` against
 * GuildAnalytics.commandUsage per slash command, awaited before the reply. A
 * capped push is not an append — MongoDB rewrites the capped region every time,
 * so the write scaled with the cap rather than the entry — which made it the
 * largest per-interaction write the bot did, on the path nobody should be
 * waiting on.
 *
 * The buffer is what replaces it, so what has to hold is: recording never
 * touches the database, a flush collapses an interval into one push per guild,
 * nothing is silently lost when a flush fails, and neither the map nor any
 * guild's queue can grow without a bound.
 */

// Named `mock*` so jest.mock's hoisting lets the factory close over it.
const mockBulkWrite = jest.fn();
jest.mock('../src/models/GuildAnalytics', () => ({ bulkWrite: mockBulkWrite }));
const bulkWrite = mockBulkWrite;

const metrics = require('../src/utils/commandMetricsBuffer');
const {
    recordCommandMetric,
    flushCommandMetrics,
    stopCommandMetrics,
    getCommandMetricsStats,
    resetCommandMetrics,
    MAX_ENTRIES_PER_GUILD,
    MAX_BUFFERED_GUILDS,
} = metrics;
const FLUSH_AT_ENTRIES = 5_000;

const entry = (command = 'ping', success = true) => ({
    command, channelId: '333', hour: 4, success, reason: null,
});

/** The ops from the most recent bulkWrite, or [] if there was none. */
const lastOps = () => (bulkWrite.mock.calls.at(-1)?.[0] ?? []);
const entriesFor = (ops, guildId) =>
    ops.find(op => op.updateOne.filter.guildId === guildId)?.updateOne.update.$push.commandUsage.$each ?? [];

beforeEach(() => {
    bulkWrite.mockReset();
    bulkWrite.mockResolvedValue({});
    resetCommandMetrics();
});

afterAll(() => resetCommandMetrics());

describe('recording', () => {
    it('writes nothing until something flushes', async () => {
        recordCommandMetric('g1', entry());
        recordCommandMetric('g1', entry('daily'));

        expect(bulkWrite).not.toHaveBeenCalled();
        expect(getCommandMetricsStats().pendingEntries).toBe(2);
    });

    it('stamps the time the command ran, not the time it is written', async () => {
        // The schema's `default: Date.now` would resolve at flush, putting a
        // whole interval's entries within milliseconds of each other — and the
        // dashboard buckets these by day and by hour.
        const before = Date.now();
        recordCommandMetric('g1', entry());
        const after = Date.now();

        await flushCommandMetrics();
        const [written] = entriesFor(lastOps(), 'g1');
        expect(written.createdAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(written.createdAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('ignores a call with no guild', async () => {
        // interactionCreate returns before this for a DM, but a metric with no
        // guildId would upsert a GuildAnalytics document keyed on undefined.
        recordCommandMetric(undefined, entry());
        recordCommandMetric('', entry());

        await flushCommandMetrics();
        expect(bulkWrite).not.toHaveBeenCalled();
    });
});

describe('flushing', () => {
    it('collapses a guild\'s interval into a single capped push', async () => {
        for (let i = 0; i < 50; i++) recordCommandMetric('g1', entry());

        const written = await flushCommandMetrics();

        expect(bulkWrite).toHaveBeenCalledTimes(1);
        const ops = lastOps();
        expect(ops).toHaveLength(1);
        expect(ops[0].updateOne.update.$push.commandUsage.$slice).toBe(-3000);
        expect(ops[0].updateOne.upsert).toBe(true);
        expect(ops[0].updateOne.update.$setOnInsert).toEqual({ guildId: 'g1' });
        expect(entriesFor(ops, 'g1')).toHaveLength(50);
        expect(written).toBe(50);
    });

    it('sends one op per guild in one round trip', async () => {
        recordCommandMetric('g1', entry());
        recordCommandMetric('g2', entry());
        recordCommandMetric('g1', entry('daily'));

        await flushCommandMetrics();

        expect(bulkWrite).toHaveBeenCalledTimes(1);
        expect(bulkWrite.mock.calls[0][1]).toEqual({ ordered: false });
        expect(lastOps()).toHaveLength(2);
        expect(entriesFor(lastOps(), 'g1')).toHaveLength(2);
        expect(entriesFor(lastOps(), 'g2')).toHaveLength(1);
    });

    it('is a no-op with nothing buffered', async () => {
        expect(await flushCommandMetrics()).toBe(0);
        expect(bulkWrite).not.toHaveBeenCalled();
    });

    it('keeps entries recorded during a flush for the next one', async () => {
        // The buffer is swapped out, not drained and cleared afterwards: a
        // clear() once the write resolved would drop whatever arrived while it
        // was in flight, which on a busy guild is most of an interval.
        let release;
        bulkWrite.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        recordCommandMetric('g1', entry('first'));
        const inFlight = flushCommandMetrics();

        recordCommandMetric('g1', entry('during'));
        release({});
        await inFlight;

        expect(entriesFor(lastOps(), 'g1').map(e => e.command)).toEqual(['first']);
        await flushCommandMetrics();
        expect(entriesFor(lastOps(), 'g1').map(e => e.command)).toEqual(['during']);
    });

    it('does not start a second write while one is in flight', async () => {
        let release;
        bulkWrite.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        recordCommandMetric('g1', entry());

        const first = flushCommandMetrics();
        const second = flushCommandMetrics();
        release({});
        await Promise.all([first, second]);

        expect(bulkWrite).toHaveBeenCalledTimes(1);
    });

    it('re-buffers a failed flush rather than losing it', async () => {
        bulkWrite.mockRejectedValueOnce(new Error('no primary'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        recordCommandMetric('g1', entry('first'));

        expect(await flushCommandMetrics()).toBe(0);
        expect(getCommandMetricsStats().pendingEntries).toBe(1);
        expect(getCommandMetricsStats().lastError).toBe('no primary');

        recordCommandMetric('g1', entry('second'));
        await flushCommandMetrics();
        expect(entriesFor(lastOps(), 'g1').map(e => e.command)).toEqual(['first', 'second']);
        console.error.mockRestore();
    });
});

describe('bounds', () => {
    it('caps a single guild\'s queue at the newest entries', async () => {
        // The `$slice: -3000` discards all but the newest anyway, so the oldest
        // buffered entries are the right ones to drop — and dropping something
        // is the requirement: an outage plus a busy guild must not grow the
        // heap without limit.
        for (let i = 0; i < MAX_ENTRIES_PER_GUILD + 25; i++) {
            recordCommandMetric('g1', entry(`cmd${i}`));
        }

        await flushCommandMetrics();
        const written = entriesFor(lastOps(), 'g1');
        expect(written).toHaveLength(MAX_ENTRIES_PER_GUILD);
        expect(written.at(-1).command).toBe(`cmd${MAX_ENTRIES_PER_GUILD + 24}`);
        expect(written[0].command).toBe('cmd25');
        expect(getCommandMetricsStats().droppedEntries).toBe(25);
    });

    it('caps how many guilds it will hold at once', async () => {
        // Only reachable while flushes are failing: a healthy process hits
        // FLUSH_AT_ENTRIES and empties the map long before it holds this many
        // guilds. An outage is the case the cap is for.
        bulkWrite.mockRejectedValue(new Error('down'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        recordCommandMetric('seed', entry());
        await flushCommandMetrics();

        for (let i = 0; i < MAX_BUFFERED_GUILDS + 3; i++) recordCommandMetric(`g${i}`, entry());

        expect(getCommandMetricsStats().guilds).toBe(MAX_BUFFERED_GUILDS);
        expect(getCommandMetricsStats().droppedEntries).toBe(4);
        console.error.mockRestore();
    });

    it('flushes a burst rather than making it wait out the interval', async () => {
        // Spread across guilds: one guild alone cannot reach the threshold,
        // because its own queue caps at MAX_ENTRIES_PER_GUILD first.
        for (let i = 0; i < FLUSH_AT_ENTRIES; i++) {
            recordCommandMetric(`g${i % 10}`, entry());
        }
        await Promise.resolve();

        expect(bulkWrite).toHaveBeenCalled();
    });

    it('does not start a write per command while the database is refusing them', async () => {
        // Without the guard, every command past the threshold would launch its
        // own bulkWrite at a database that is already failing.
        bulkWrite.mockRejectedValue(new Error('down'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        for (let i = 0; i < FLUSH_AT_ENTRIES + 200; i++) {
            recordCommandMetric(`g${i % 10}`, entry());
        }
        await Promise.resolve();

        expect(bulkWrite.mock.calls.length).toBeLessThanOrEqual(2);
        console.error.mockRestore();
    });

    it('stays bounded across repeated flush failures', async () => {
        bulkWrite.mockRejectedValue(new Error('still down'));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        for (let round = 0; round < 3; round++) {
            for (let i = 0; i < MAX_ENTRIES_PER_GUILD; i++) recordCommandMetric('g1', entry());
            await flushCommandMetrics();
        }

        expect(getCommandMetricsStats().pendingEntries).toBe(MAX_ENTRIES_PER_GUILD);
        console.error.mockRestore();
    });
});

describe('shutdown', () => {
    it('writes what is buffered', async () => {
        recordCommandMetric('g1', entry());

        expect(await stopCommandMetrics()).toBe(1);
        expect(bulkWrite).toHaveBeenCalledTimes(1);
        expect(getCommandMetricsStats().pendingEntries).toBe(0);
    });

    it('says so when the final flush fails', async () => {
        // There is no next interval to pick these up, so this is the one place
        // a re-buffer means the entries are actually gone.
        bulkWrite.mockRejectedValueOnce(new Error('closing'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        recordCommandMetric('g1', entry());

        await stopCommandMetrics();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('lost at shutdown'));
        error.mockRestore();
    });
});
