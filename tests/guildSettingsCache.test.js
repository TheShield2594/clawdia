'use strict';

// The cache reaches the model through a lazy require, so a plain jest.mock of
// the module path is enough to stand in for Mongoose here.
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));

const Guild = require('../src/models/Guild');
const {
    getGuildSettings,
    invalidateGuildSettings,
    clearGuildSettingsCache,
    setGuildSettingsTtl,
    getGuildSettingsCacheStats,
} = require('../src/utils/guildSettingsCache');

// Stands in for a hydrated Mongoose document: the cache calls toObject() on it.
function makeDoc(guildId, overrides = {}) {
    const plain = { guildId, leveling: { enabled: true, xpRate: 1 }, ...overrides };
    return { ...plain, toObject: () => JSON.parse(JSON.stringify(plain)) };
}

beforeEach(() => {
    jest.clearAllMocks();
    clearGuildSettingsCache();
    setGuildSettingsTtl(30_000);
});

describe('getGuildSettings', () => {
    it('reads through to the model on a cold entry, then serves from cache', async () => {
        Guild.findOne.mockResolvedValue(makeDoc('g1'));

        const first = await getGuildSettings('g1');
        const second = await getGuildSettings('g1');
        const third = await getGuildSettings('g1');

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
        expect(first.guildId).toBe('g1');
        expect(second).toBe(first);
        expect(third).toBe(first);
    });

    it('returns a plain object with no save(), so a caller cannot persist a shared view', async () => {
        Guild.findOne.mockResolvedValue(makeDoc('g1'));
        const settings = await getGuildSettings('g1');

        expect(settings.save).toBeUndefined();
        expect(settings.toObject).toBeUndefined();
        // Schema defaults survive because the document is hydrated before conversion.
        expect(settings.leveling.xpRate).toBe(1);
    });

    it('keeps guilds isolated from one another', async () => {
        Guild.findOne
            .mockResolvedValueOnce(makeDoc('g1', { name: 'One' }))
            .mockResolvedValueOnce(makeDoc('g2', { name: 'Two' }));

        expect((await getGuildSettings('g1')).name).toBe('One');
        expect((await getGuildSettings('g2')).name).toBe('Two');
        expect((await getGuildSettings('g1')).name).toBe('One');
        expect(Guild.findOne).toHaveBeenCalledTimes(2);
    });

    it('re-reads once the entry expires', async () => {
        setGuildSettingsTtl(-1); // every entry is already stale
        Guild.findOne.mockResolvedValue(makeDoc('g1'));

        await getGuildSettings('g1');
        await getGuildSettings('g1');

        expect(Guild.findOne).toHaveBeenCalledTimes(2);
    });

    it('collapses a burst of concurrent misses into a single query', async () => {
        // The load this cache exists for: many messages arriving at once on a
        // cold entry must not each issue their own findOne.
        let resolveFind;
        Guild.findOne.mockReturnValue(new Promise(res => { resolveFind = res; }));

        const inFlight = Promise.all(
            Array.from({ length: 25 }, () => getGuildSettings('g1'))
        );
        resolveFind(makeDoc('g1'));
        const results = await inFlight;

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
        results.forEach(r => expect(r.guildId).toBe('g1'));
    });

    it('does not cache a missing document', async () => {
        Guild.findOne.mockResolvedValue(null);

        expect(await getGuildSettings('ghost')).toBeNull();
        expect(await getGuildSettings('ghost')).toBeNull();

        // Caching the absence would hide the settings created moments later on
        // a guild's very first message.
        expect(Guild.findOne).toHaveBeenCalledTimes(2);
    });

    it('returns null without querying when given no guild id', async () => {
        expect(await getGuildSettings(undefined)).toBeNull();
        expect(Guild.findOne).not.toHaveBeenCalled();
    });
});

describe('invalidation', () => {
    it('forces a re-read for the invalidated guild only', async () => {
        Guild.findOne.mockResolvedValue(makeDoc('g1'));
        await getGuildSettings('g1');
        Guild.findOne.mockResolvedValue(makeDoc('g2'));
        await getGuildSettings('g2');
        expect(Guild.findOne).toHaveBeenCalledTimes(2);

        invalidateGuildSettings('g1');

        await getGuildSettings('g2');
        expect(Guild.findOne).toHaveBeenCalledTimes(2); // g2 still cached

        await getGuildSettings('g1');
        expect(Guild.findOne).toHaveBeenCalledTimes(3); // g1 re-read
    });

    it('serves a write-through value on the next read', async () => {
        Guild.findOne.mockResolvedValue(makeDoc('g1', { leveling: { enabled: true, xpRate: 1 } }));
        expect((await getGuildSettings('g1')).leveling.xpRate).toBe(1);

        Guild.findOne.mockResolvedValue(makeDoc('g1', { leveling: { enabled: true, xpRate: 5 } }));
        invalidateGuildSettings('g1');

        expect((await getGuildSettings('g1')).leveling.xpRate).toBe(5);
    });

    it('does not cache a read that a write overtook while it was in flight', async () => {
        // The read starts, a write lands and invalidates, then the read resolves
        // holding a pre-write snapshot. Deleting a cache entry cannot undo a read
        // that has not stored one yet, so without explicit handling the stale
        // snapshot is installed after the invalidation and served for a full TTL.
        let resolveFind;
        Guild.findOne.mockReturnValue(new Promise(res => { resolveFind = res; }));

        const reading = getGuildSettings('g1');
        invalidateGuildSettings('g1');           // write lands mid-flight
        resolveFind(makeDoc('g1', { leveling: { enabled: true, xpRate: 1 } }));

        // Waiters still get a value rather than an error.
        expect((await reading).leveling.xpRate).toBe(1);
        // ...but it must not have been cached.
        expect(getGuildSettingsCacheStats().size).toBe(0);

        Guild.findOne.mockResolvedValue(makeDoc('g1', { leveling: { enabled: true, xpRate: 9 } }));
        expect((await getGuildSettings('g1')).leveling.xpRate).toBe(9);
    });

    it('does not cache an in-flight read overtaken by a full clear', async () => {
        let resolveFind;
        Guild.findOne.mockReturnValue(new Promise(res => { resolveFind = res; }));

        const reading = getGuildSettings('g1');
        clearGuildSettingsCache();
        resolveFind(makeDoc('g1'));
        await reading;

        expect(getGuildSettingsCacheStats().size).toBe(0);
    });

    it('still caches normally when no write intervenes', async () => {
        let resolveFind;
        Guild.findOne.mockReturnValue(new Promise(res => { resolveFind = res; }));

        const reading = getGuildSettings('g1');
        resolveFind(makeDoc('g1'));
        await reading;

        expect(getGuildSettingsCacheStats().size).toBe(1);
    });

    it('clearGuildSettingsCache drops every entry', async () => {
        Guild.findOne.mockResolvedValue(makeDoc('g1'));
        await getGuildSettings('g1');
        Guild.findOne.mockResolvedValue(makeDoc('g2'));
        await getGuildSettings('g2');
        expect(getGuildSettingsCacheStats().size).toBe(2);

        clearGuildSettingsCache();

        expect(getGuildSettingsCacheStats().size).toBe(0);
    });
});

describe('write hooks', () => {
    const {
        onGuildDocumentSaved,
        onGuildQueryWrite,
    } = require('../src/utils/guildSettingsCache');

    async function warm(...guildIds) {
        for (const id of guildIds) {
            Guild.findOne.mockResolvedValue(makeDoc(id));
            await getGuildSettings(id);
        }
    }

    it('a saved document drops only that guild', async () => {
        await warm('g1', 'g2');
        onGuildDocumentSaved({ guildId: 'g1' });
        expect(getGuildSettingsCacheStats().size).toBe(1);
    });

    it('tolerates a save hook firing without a document', () => {
        expect(() => onGuildDocumentSaved(undefined)).not.toThrow();
    });

    it('a guild-scoped query write drops only that guild', async () => {
        await warm('g1', 'g2');
        onGuildQueryWrite({ getFilter: () => ({ guildId: 'g2' }) });
        expect(getGuildSettingsCacheStats().size).toBe(1);
    });

    it('an unattributable write clears everything rather than serving stale data', async () => {
        await warm('g1', 'g2', 'g3');

        // A bulk update, or one filtered on something other than guildId, could
        // have touched any cached guild.
        onGuildQueryWrite({ getFilter: () => ({ 'giveaways.ended': false }) });

        expect(getGuildSettingsCacheStats().size).toBe(0);
    });

    it('clears everything when the filter is unavailable', async () => {
        await warm('g1', 'g2');
        onGuildQueryWrite({});
        expect(getGuildSettingsCacheStats().size).toBe(0);
    });
    it('does not evict for an analytics-only write', async () => {
        await warm('g1');

        // logCommandMetric runs this after every slash command. Nothing on the
        // cached read paths reads analytics, so evicting here would keep the
        // cache permanently cold on any active guild.
        onGuildQueryWrite({
            getFilter: () => ({ guildId: 'g1' }),
            getUpdate: () => ({
                $push: { 'analytics.commandUsage': { $each: [{ command: 'ping' }], $slice: -3000 } },
                $setOnInsert: { guildId: 'g1', name: 'Test Guild' },
            }),
        });

        expect(getGuildSettingsCacheStats().size).toBe(1);
    });

    it('does not evict for the member-event counters', async () => {
        await warm('g1');
        onGuildQueryWrite({
            getFilter: () => ({ guildId: 'g1' }),
            getUpdate: () => ({ $inc: { 'analytics.memberEvents.$.joins': 1 } }),
        });
        expect(getGuildSettingsCacheStats().size).toBe(1);
    });

    it('still evicts when a write mixes analytics with a real setting', async () => {
        await warm('g1');
        onGuildQueryWrite({
            getFilter: () => ({ guildId: 'g1' }),
            getUpdate: () => ({
                $push: { 'analytics.commandUsage': { command: 'ping' } },
                $set: { 'leveling.xpRate': 5 },
            }),
        });
        expect(getGuildSettingsCacheStats().size).toBe(0);
    });

    it('evicts for a settings write', async () => {
        await warm('g1');
        onGuildQueryWrite({
            getFilter: () => ({ guildId: 'g1' }),
            getUpdate: () => ({ $set: { 'moderation.enabled': false } }),
        });
        expect(getGuildSettingsCacheStats().size).toBe(0);
    });

    it('evicts when the update cannot be inspected', async () => {
        await warm('g1');
        onGuildQueryWrite({ getFilter: () => ({ guildId: 'g1' }) });
        expect(getGuildSettingsCacheStats().size).toBe(0);
    });
});
