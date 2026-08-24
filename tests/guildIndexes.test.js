'use strict';

// #576. The Guild model declared one thing — `unique` on guildId — while
// migration 001 created two more indexes on the same collection, so "what is
// indexed on guilds" had no single answer and the two halves had already
// drifted apart: 001's `idx_giveaways_active` covers `giveaways.ended` and
// `giveaways.endsAt`, which no query in the codebase filters on any more.
//
// The schema is the home now, as it already was for User. What keeps that true
// is below: the index list is read off the compiled schema, the sweeps are read
// off the services that run them, and the two are checked against each other.
// An index nobody queries and a sweep with no index are both failures here.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

// The schema is compiled, not parsed: `schema.indexes()` is the same list
// Mongoose hands the driver at autoIndex time, so this cannot pass on an index
// that is written down but malformed.
const guildSchema = require('../src/models/Guild').schema;

/** Every declared index as [keys, options], excluding the _id index. */
const declared = guildSchema.indexes();

/** One declared index by name, or undefined. */
const byName = name => declared.find(([, opts]) => opts?.name === name);

describe('the Guild schema is the single home for guilds indexes', () => {
    // The identity index, declared field-level as `unique: true` on guildId and
    // so carrying Mongoose's generated `guildId_1` name. It is the one index
    // here no migration ever touches, which is why an auto name is fine on it.
    test('keeps guildId unique', () => {
        const entry = declared.find(([keys]) => JSON.stringify(keys) === '{"guildId":1}');
        expect(entry).toBeDefined();
        expect(entry[1].unique).toBe(true);
    });

    test('declares every non-unique index under an explicit name', () => {
        const unnamed = declared
            .filter(([, opts]) => !opts?.name && !opts?.unique)
            .map(([keys]) => JSON.stringify(keys));

        // An auto-generated name is what makes a schema index and a migration
        // index impossible to line up — it is the exact conflict 001's
        // ensureIndex() has to drop an index to work around.
        expect(unnamed).toEqual([]);
    });

    // The one index migration 001 built on guilds that a live query still
    // needs. Declared here under 001's exact name and spec, so an existing
    // deployment already has it and autoIndex finds nothing to do.
    test('re-declares idx_guilds_rssfeeds exactly as migration 001 built it', () => {
        const entry = byName('idx_guilds_rssfeeds');
        expect(entry).toBeDefined();

        const [keys, opts] = entry;
        expect(keys).toEqual({ 'rssFeeds.0': 1 });
        expect(opts.sparse).toBe(true);

        const migration = read('migrations/001_add_indexes.js');
        expect(migration).toContain("{ 'rssFeeds.0': 1 }");
        expect(migration).toContain("name: 'idx_guilds_rssfeeds', sparse: true");
    });

    // Every sweep here scans a collection whose documents carry analytics
    // history and inline image Buffers. A partial or sparse index holds only
    // the guilds with the feature on, so the rest cost nothing to index.
    test.each([
        'idx_guilds_giveaways',
        'idx_guilds_rssfeeds',
        'idx_guilds_tempvoice_active',
        'idx_guilds_dynamic_pricing',
        'idx_guilds_district_active',
    ])('%s is declared', name => {
        expect(byName(name)).toBeDefined();
    });

    test.each([
        ['idx_guilds_giveaways', 'sparse'],
        ['idx_guilds_rssfeeds', 'sparse'],
        ['idx_guilds_tempvoice_active', 'partial'],
        ['idx_guilds_dynamic_pricing', 'partial'],
    ])('%s is %s rather than covering every guild', (name, kind) => {
        const [, opts] = byName(name);
        if (kind === 'sparse') expect(opts.sparse).toBe(true);
        else expect(opts.partialFilterExpression).toBeDefined();
    });
});

// Each case pairs a query that runs on a schedule with the index declared for
// it, and asserts the two still describe the same fields. A sweep whose filter
// is edited without its index — or the reverse — fails here.
describe('each scheduled Guild sweep has an index matching its filter', () => {
    const CASES = [
        {
            what: 'giveawayService.checkGiveaways',
            source: 'services/giveawayService.js',
            filter: "Guild.find({ 'giveaways.0': { $exists: true } })",
            index: 'idx_guilds_giveaways',
            keys: { 'giveaways.0': 1 },
        },
        {
            what: 'rssService.checkFeeds',
            source: 'services/rssService.js',
            filter: "Guild.find({ 'rssFeeds.0': { $exists: true } }",
            index: 'idx_guilds_rssfeeds',
            keys: { 'rssFeeds.0': 1 },
        },
        {
            what: 'tempVoiceService.checkTempVoice',
            source: 'services/tempVoiceService.js',
            filter: "Guild.find({ 'tempVoice.enabled': true, 'tempVoice.activeChannels.0': { $exists: true } })",
            index: 'idx_guilds_tempvoice_active',
            keys: { 'tempVoice.activeChannels.0': 1 },
            partial: { 'tempVoice.enabled': true },
        },
        {
            what: 'schedulerService.recalcShopPrices',
            source: 'services/schedulerService.js',
            filter: "Guild.find({ 'dynamicPricing.enabled': true }",
            index: 'idx_guilds_dynamic_pricing',
            keys: { 'dynamicPricing.enabled': 1 },
            partial: { 'dynamicPricing.enabled': true },
        },
        {
            what: 'schedulerService bank-district payout',
            source: 'services/schedulerService.js',
            filter: "$elemMatch: { districtId: 'bank', activeUntil: { $gt: now } }",
            index: 'idx_guilds_district_active',
            keys: { 'districts.districtId': 1, 'districts.activeUntil': 1 },
        },
    ];

    test.each(CASES)('$what', ({ source, filter, index, keys, partial }) => {
        // The query is still written the way the index assumes.
        expect(read(source)).toContain(filter);

        const entry = byName(index);
        expect(entry).toBeDefined();

        const [declaredKeys, opts] = entry;
        expect(declaredKeys).toEqual(keys);
        if (partial) expect(opts.partialFilterExpression).toEqual(partial);
    });

    // Both keys are paths into the one `districts` array, which Mongo indexes
    // as a single multikey index. Two *different* arrays would be the parallel
    // array case it refuses outright, and the index would fail to build at
    // runtime rather than here.
    test('the district index keys one array, not two parallel ones', () => {
        const [keys] = byName('idx_guilds_district_active');
        const roots = new Set(Object.keys(keys).map(k => k.split('.')[0]));
        expect([...roots]).toEqual(['districts']);
    });
});

describe('015 drops the giveaway index nothing queries', () => {
    const migration = read('migrations/015_drop_dead_giveaway_index.js');

    test('names the index migration 001 created', () => {
        expect(migration).toContain("dropIndex('idx_giveaways_active')");
        expect(read('migrations/001_add_indexes.js')).toContain("name: 'idx_giveaways_active'");
    });

    // The whole reason it is dead: the sweep it was built for was rewritten to
    // filter on `giveaways.0` and compare `endsAt` in JavaScript. If a query on
    // these paths ever comes back, this test is where that gets noticed.
    test('no source file filters a query on the paths it covered', () => {
        const offenders = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js') && !full.includes(path.join('src', 'migrations'))) {
                    const source = fs.readFileSync(full, 'utf8');
                    if (/['"]giveaways\.(ended|endsAt)['"]\s*:/.test(source)) {
                        offenders.push(path.relative(SRC, full));
                    }
                }
            }
        };
        walk(SRC);

        expect(offenders).toEqual([]);
    });

    test('swallows IndexNotFound so a fresh database is not a failure', () => {
        expect(migration).toContain("codeName !== 'IndexNotFound'");
    });

    test('runs after the migration that created the index', () => {
        const dir = path.join(SRC, 'migrations');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'runner.js').sort();
        expect(files.indexOf('015_drop_dead_giveaway_index.js'))
            .toBeGreaterThan(files.indexOf('001_add_indexes.js'));
    });

    // The runner records a migration by name; a file whose exported name does
    // not match its filename is recorded under something nobody can find.
    test('exports the name its filename promises', () => {
        expect(require('../src/migrations/015_drop_dead_giveaway_index').name)
            .toBe('015_drop_dead_giveaway_index');
    });
});
