'use strict';

/**
 * A drift check over the migration sources, not a substitute for running them.
 *
 * `indexNamesIn` below is a regex over the file text, which #629 rightly called
 * out as a "migration test" that executes no migration. It stays because the
 * question it answers is a textual one — do 009's drop list and 002/003's
 * create lists still name the same indexes — and a mismatch there is a silent
 * no-op rather than a failure any execution would surface.
 *
 * What it is no longer standing in for lives in tests/integration/migrations.test.js:
 * every shipped migration applied in order against a real mongod, over real
 * documents, twice.
 */

const fs   = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'src', 'migrations');
const read = file => fs.readFileSync(path.join(migrationsDir, file), 'utf8');
const indexNamesIn = source => new Set((source.match(/'idx_[a-z0-9_]+'/g) ?? []).map(s => s.slice(1, -1)));

// 009 drops the hunt/fishing indexes that 002 and 003 built on the users
// collection, which migration 005 left covering paths no document has. A drop
// naming an index that is never created is a silent no-op, so the two lists
// have to stay in step.
describe('009_drop_stale_grind_indexes', () => {
    const dropped = indexNamesIn(read('009_drop_stale_grind_indexes.js'));
    const created = new Set([
        ...indexNamesIn(read('002_hunt_indexes.js')),
        ...indexNamesIn(read('003_fishing_indexes.js')),
    ]);

    test('drops every index 002 and 003 create on users', () => {
        expect([...created].sort()).toEqual([...dropped].sort());
    });

    test('names only indexes that are actually created', () => {
        const orphans = [...dropped].filter(name => !created.has(name));
        expect(orphans).toEqual([]);
    });

    test('swallows IndexNotFound so a fresh database is not a failure', () => {
        expect(read('009_drop_stale_grind_indexes.js')).toContain("codeName !== 'IndexNotFound'");
    });

    test('runs after the migration that moved grind state off User', () => {
        const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js') && f !== 'runner.js').sort();
        expect(files.indexOf('009_drop_stale_grind_indexes.js'))
            .toBeGreaterThan(files.indexOf('005_grind_profiles.js'));
    });
});

// 014 re-keys itemimages from { itemId } to { guildId, itemId } so one guild's
// admin can no longer overwrite every guild's images (#561). Two things have to
// agree for that to hold, and neither is visible from the other file: the model
// declares the compound index, and the migration drops the single-field unique
// index Mongoose built from the old `unique: true` — which Mongoose will never
// drop on its own, and which makes a second guild's row a duplicate-key error.
describe('014_scope_item_images_per_guild', () => {
    const source = read('014_scope_item_images_per_guild.js');
    const model = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'ItemImage.js'), 'utf8');

    test('creates the index the model declares, under the same name', () => {
        expect(indexNamesIn(source)).toContain('idx_itemimage_guild_item');
        expect(model).toContain("name: 'idx_itemimage_guild_item'");
        expect(model).toContain('unique: true');
    });

    test('drops the legacy unique index, and the model no longer declares it', () => {
        expect(source).toContain("dropIndex('itemId_1')");
        expect(model).not.toMatch(/itemId:\s*\{[^}]*unique/);
    });

    test('swallows IndexNotFound so a fresh database is not a failure', () => {
        expect(source).toContain("codeName !== 'IndexNotFound'");
    });
});

// 021 gives the marketlistings TTL a grace period so `returnExpiredMarketListings`
// can claim an expired listing and return its items before MongoDB destroys the
// document (#867). Two numbers have to agree and neither file can see the other:
// the migration's collMod sets the grace on the index that exists, and the
// model's declaration is what a fresh database — and any later createIndex —
// builds. A migration that set a different figure would be quietly undone.
describe('021_market_listing_ttl_grace', () => {
    const source = read('021_market_listing_ttl_grace.js');
    const model = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'MarketListing.js'), 'utf8');
    const { EXPIRED_LISTING_GRACE_SECONDS } = require('../src/models/MarketListing');

    // Read off the migration rather than required from it: requiring it pulls in
    // mongoose, and the value is the thing under test.
    const migrationGrace = Number(
        source.match(/const GRACE_SECONDS = ([\d\s*]+);/)[1].split('*').reduce((a, b) => a * Number(b), 1),
    );

    test('sets the same grace the model declares', () => {
        expect(migrationGrace).toBe(EXPIRED_LISTING_GRACE_SECONDS);
    });

    test('the model no longer declares the zero-grace TTL that lost the items', () => {
        expect(model).not.toContain('expireAfterSeconds: 0');
        expect(model).toContain('expireAfterSeconds: EXPIRED_LISTING_GRACE_SECONDS');
    });

    test('the grace far outlasts the sweep that has to win the race', () => {
        // The sweep runs every ten minutes and takes 50 listings a tick, so the
        // margin has to cover a backlog rather than a single tick. Asserted
        // against the schedule itself so a change to either is caught here.
        const { JOBS } = require('../src/services/scheduler');
        const sweep = JOBS.find(j => j.name === 'returnExpiredMarketListings');
        expect(sweep.schedule).toBe('*/10 * * * *');
        expect(EXPIRED_LISTING_GRACE_SECONDS).toBeGreaterThan(100 * 10 * 60);
    });
});
