'use strict';

// #585. The fishingtournaments collection was indexed on `guildId` alone while
// every query tournamentService issues pairs the guild with a status — so the
// index narrowed to the guild and then scanned every tournament it had ever
// run, each one carrying its whole entries array.
//
// Two things have to agree for the fix to hold, and neither is visible from the
// other file: the schema declares the compound index, and migration 016 drops
// the single-field one Mongoose built from `index: true`, which Mongoose will
// never drop on its own. Both are checked here, against the queries themselves.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

// Compiled, not parsed: `schema.indexes()` is the list Mongoose hands the driver
// at autoIndex time, so this cannot pass on an index that is written down but
// malformed.
const declared = require('../src/models/FishingTournament').schema.indexes();
const byName = name => declared.find(([, opts]) => opts?.name === name);

describe('the FishingTournament schema indexes what the service asks for', () => {
    test('declares { guildId, status } under an explicit name', () => {
        const entry = byName('idx_tournament_guild_status');
        expect(entry).toBeDefined();
        expect(entry[0]).toEqual({ guildId: 1, status: 1 });
    });

    // An auto-generated name is what makes a schema index and a migration index
    // impossible to line up — it is exactly the conflict 016 has to resolve.
    test('leaves no index unnamed', () => {
        const unnamed = declared.filter(([, opts]) => !opts?.name).map(([keys]) => JSON.stringify(keys));
        expect(unnamed).toEqual([]);
    });

    // The compound index answers a guild-only lookup through its prefix, so the
    // old single-field index is pure write cost. Declaring it again would keep
    // it alive on every deployment regardless of what 016 drops.
    test('no longer declares the single-field index on guildId', () => {
        expect(declared.some(([keys]) => JSON.stringify(keys) === '{"guildId":1}')).toBe(false);
        expect(read('models/FishingTournament.js')).not.toMatch(/guildId:\s*\{[^}]*index/);
    });

    // Each case is a live query paired with the index meant to serve it. A
    // filter edited without its index — or the reverse — fails here.
    test.each([
        ['getActiveTournament', "FishingTournament.findOne({ guildId, status: 'active' })"],
        ['startTournament', "FishingTournament.findOne({ guildId, status: { $in: ['scheduled', 'active'] } })"],
        ['submitCatch', "FishingTournament.findOne({ guildId, status: 'active' })"],
    ])('%s still filters on both indexed fields', (_what, filter) => {
        expect(read('services/tournamentService.js')).toContain(filter);
    });
});

describe('016_fishing_tournament_status_index', () => {
    const source = read('migrations/016_fishing_tournament_status_index.js');

    test('drops the index the old schema declared, by the name Mongoose gave it', () => {
        expect(source).toContain("dropIndex('guildId_1')");
    });

    test('swallows IndexNotFound so a fresh database is not a failure', () => {
        expect(source).toContain("codeName !== 'IndexNotFound'");
    });

    // A guild that has never run a tournament has no collection at all, and a
    // boot must not abort on that.
    test('swallows NamespaceNotFound too', () => {
        expect(source).toContain('code !== 26');
    });

    // The drop costs nothing if it fails — the compound index already serves
    // every query — so it must not be able to hold up a boot.
    test('exports the name its filename promises, and is optional', () => {
        const migration = require('../src/migrations/016_fishing_tournament_status_index');
        expect(migration.name).toBe('016_fishing_tournament_status_index');
        expect(migration.optional).toBe(true);
        expect(typeof migration.down).toBe('function');
    });
});

// The migration is run against a stand-in collection rather than a real one:
// the integration suite needs a mongod binary, and what matters here is the
// order of the two operations and that neither half of the pair is missing.
describe('016 run against a recording collection', () => {
    const mongoose = require('mongoose');
    const migration = require('../src/migrations/016_fishing_tournament_status_index');

    let calls;
    let dropIndex;
    let realDb;

    beforeEach(() => {
        calls = [];
        dropIndex = jest.fn(async name => { calls.push(['dropIndex', name]); });
        realDb = mongoose.connection.db;
        mongoose.connection.db = {
            collection: name => {
                calls.push(['collection', name]);
                return {
                    createIndex: async (keys, opts) => { calls.push(['createIndex', keys, opts]); },
                    dropIndex,
                };
            },
        };
    });

    afterEach(() => {
        mongoose.connection.db = realDb;
    });

    /** An error shaped the way the driver reports the two tolerated cases. */
    const driverError = fields => Object.assign(new Error('index not found'), fields);

    test('up builds the compound index before dropping the one it replaces', async () => {
        await migration.up();

        // Order is the assertion: dropping first would leave a guild's
        // tournament lookups with no index until autoIndex caught up, which
        // nothing awaits.
        expect(calls).toEqual([
            ['collection', 'fishingtournaments'],
            ['createIndex', { guildId: 1, status: 1 }, { name: 'idx_tournament_guild_status' }],
            ['dropIndex', 'guildId_1'],
        ]);
    });

    test('down restores the single-field index and removes the compound one', async () => {
        await migration.down();

        expect(calls).toEqual([
            ['collection', 'fishingtournaments'],
            ['createIndex', { guildId: 1 }, { name: 'guildId_1' }],
            ['dropIndex', 'idx_tournament_guild_status'],
        ]);
    });

    test.each([
        ['up', { codeName: 'IndexNotFound' }],
        ['up', { code: 26 }],
        ['down', { codeName: 'IndexNotFound' }],
        ['down', { code: 26 }],
    ])('%s tolerates a missing index or collection', async (direction, fields) => {
        dropIndex.mockRejectedValueOnce(driverError(fields));
        await expect(migration[direction]()).resolves.toBeUndefined();
    });

    test.each(['up', 'down'])('%s still reports a drop that failed for any other reason', async direction => {
        dropIndex.mockRejectedValueOnce(driverError({ codeName: 'Unauthorized', code: 13 }));
        await expect(migration[direction]()).rejects.toThrow('index not found');
    });
});
