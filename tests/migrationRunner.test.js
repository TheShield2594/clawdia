'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// The runner reaches for the MigrationRecord model at require time, so the
// model is replaced with an in-memory stand-in before anything loads it.
const { fakeMigrationRecords } = require('./helpers/fakeMigrationRecords');

const mockRecords = fakeMigrationRecords();
jest.mock('../src/models/MigrationRecord', () => mockRecords.model);
const records = mockRecords.rows;

const { runMigrations } = require('../src/migrations/runner');

let dir;

// Writes a migration file into a scratch directory the runner is pointed at.
// `body` is spliced into the module, so a migration can record calls by
// writing to a file the test reads back.
function writeMigration(file, body) {
    fs.writeFileSync(path.join(dir, file), body);
}

const logPath = () => path.join(dir, 'calls.log');
const calls = () => (fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8').trim().split('\n') : []);
const record = expr => `require('fs').appendFileSync(${JSON.stringify(logPath())}, ${expr} + '\\n');`;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
    records.length = 0;
    // The inline fixtures declare no down(), which would otherwise trigger the
    // pre-migration backup attempt; that path has its own tests.
    process.env.MIGRATION_BACKUP = 'skip';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.MIGRATION_TIMEOUT_MS;
    delete process.env.MIGRATION_BACKUP;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('timeout budget', () => {
    test('hands each migration the default budget', async () => {
        writeMigration('001_a.js', `module.exports = { name: 'a', async up({ timeoutMs }) { ${record('timeoutMs')} } };`);
        await runMigrations({ dir });
        expect(calls()).toEqual(['30000']);
    });

    test('MIGRATION_TIMEOUT_MS replaces the default', async () => {
        process.env.MIGRATION_TIMEOUT_MS = '90000';
        writeMigration('001_a.js', `module.exports = { name: 'a', async up({ timeoutMs }) { ${record('timeoutMs')} } };`);
        await runMigrations({ dir });
        expect(calls()).toEqual(['90000']);
    });

    test('a migration that declares its own budget gets it', async () => {
        writeMigration('001_a.js', `module.exports = { name: 'a', timeoutMs: 120000, async up({ timeoutMs }) { ${record('timeoutMs')} } };`);
        await runMigrations({ dir });
        expect(calls()).toEqual(['120000']);
    });

    // Otherwise the escape hatch would be powerless against exactly the
    // migration that is timing out: a declared 120 s would cap an operator who
    // asked for 300 s because 120 s was not enough.
    test('the operator can raise a migration past its own declared budget', async () => {
        process.env.MIGRATION_TIMEOUT_MS = '300000';
        writeMigration('001_a.js', `module.exports = { name: 'a', timeoutMs: 120000, async up({ timeoutMs }) { ${record('timeoutMs')} } };`);
        await runMigrations({ dir });
        expect(calls()).toEqual(['300000']);
    });

    test.each(['nonsense', '0', '-1', ''])('ignores MIGRATION_TIMEOUT_MS=%p rather than timing out instantly', async value => {
        process.env.MIGRATION_TIMEOUT_MS = value;
        writeMigration('001_a.js', `module.exports = { name: 'a', async up({ timeoutMs }) { ${record('timeoutMs')} } };`);
        await runMigrations({ dir });
        expect(calls()).toEqual(['30000']);
    });

    test('a migration that overruns its budget fails', async () => {
        process.env.MIGRATION_TIMEOUT_MS = '60';
        writeMigration('001_slow.js', "module.exports = { name: 'slow', up: () => new Promise(() => {}) };");
        await expect(runMigrations({ dir })).rejects.toThrow(/Timed out after 60ms: slow/);
        expect(records).toEqual([]);
    });
});

describe('optional migrations', () => {
    test('a failing required migration aborts the run', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {} };");
        writeMigration('002_b.js', "module.exports = { name: 'b', async up() { throw new Error('index build failed'); } };");
        writeMigration('003_c.js', `module.exports = { name: 'c', async up() { ${record("'c'")} } };`);

        await expect(runMigrations({ dir })).rejects.toThrow('index build failed');
        expect(records.map(r => r.name)).toEqual(['a']);
        expect(calls()).toEqual([]);
    });

    test('a failing optional migration lets startup continue', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {} };");
        writeMigration('002_b.js', "module.exports = { name: 'b', optional: true, async up() { throw new Error('index build failed'); } };");
        writeMigration('003_c.js', `module.exports = { name: 'c', async up() { ${record("'c'")} } };`);

        await expect(runMigrations({ dir })).resolves.toBeUndefined();
        expect(calls()).toEqual(['c']);
    });

    test('a deferred optional migration is not recorded, so the next boot retries it', async () => {
        writeMigration('001_b.js', "module.exports = { name: 'b', optional: true, async up() { throw new Error('nope'); } };");
        await runMigrations({ dir });
        expect(records).toEqual([]);
    });

    test('an optional migration that succeeds is recorded like any other', async () => {
        writeMigration('001_b.js', "module.exports = { name: 'b', optional: true, async up() {} };");
        await runMigrations({ dir });
        expect(records.map(r => r.name)).toEqual(['b']);
    });
});

describe('bookkeeping', () => {
    test('applies in filename order and skips what is already recorded', async () => {
        records.push({ name: 'a' });
        writeMigration('002_b.js', `module.exports = { name: 'b', async up() { ${record("'b'")} } };`);
        writeMigration('001_a.js', `module.exports = { name: 'a', async up() { ${record("'a'")} } };`);
        writeMigration('003_c.js', `module.exports = { name: 'c', async up() { ${record("'c'")} } };`);

        await runMigrations({ dir });
        expect(calls()).toEqual(['b', 'c']);
    });

    test('skips a file that does not export { name, up }', async () => {
        writeMigration('001_bad.js', "module.exports = { name: 'bad' };");
        await expect(runMigrations({ dir })).resolves.toBeUndefined();
        expect(records).toEqual([]);
    });
});

// The runner only stops waiting; the query it abandoned keeps running on the
// server unless the migration bounded it. 005 is the one that rewrites the
// whole users collection, so it is the one that has to.
describe('005_grind_profiles', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '005_grind_profiles.js'), 'utf8');

    test('asks for more than the default budget', () => {
        expect(require('../src/migrations/005_grind_profiles').timeoutMs).toBeGreaterThan(30_000);
    });

    test('passes the budget to the server as maxTimeMS', () => {
        expect(source).toContain('maxTimeMS: timeoutMs');
    });

    test('bounds both the aggregation and the updateMany', () => {
        expect(source).toContain('], bounded).toArray()');
        expect(source).toMatch(/updateMany\([\s\S]*?bounded\s*\);/);
    });
});
