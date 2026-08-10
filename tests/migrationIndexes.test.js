'use strict';

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
