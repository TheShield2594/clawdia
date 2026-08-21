'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Migrations used to be forward-only: the runner read {name, up} and nothing
// ever called a down(), while destructive $unset/dropIndex steps ran with no
// backup. These tests pin the rollback contract that replaced that:
// rollbackMigration unwinds the latest applied migration through its down(),
// every shipped migration declares down() or irreversible: true, and a
// mongodump is attempted before anything irreversible runs.

const records = [];
jest.mock('../src/models/MigrationRecord', () => ({
    find: () => ({ lean: async () => records.map(r => ({ name: r.name })) }),
    create: async doc => { records.push(doc); return doc; },
    deleteOne: async ({ name }) => {
        const i = records.findIndex(r => r.name === name);
        if (i !== -1) records.splice(i, 1);
        return { deletedCount: i === -1 ? 0 : 1 };
    },
}));

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

const { spawnSync } = require('child_process');
const { runMigrations, rollbackMigration } = require('../src/migrations/runner');

let dir;

function writeMigration(file, body) {
    fs.writeFileSync(path.join(dir, file), body);
}

const logPath = () => path.join(dir, 'calls.log');
const calls = () => (fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8').trim().split('\n').filter(Boolean) : []);
const record = expr => `require('fs').appendFileSync(${JSON.stringify(logPath())}, ${expr} + '\\n');`;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-rollback-'));
    records.length = 0;
    spawnSync.mockReset().mockReturnValue({ status: 0 });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.MIGRATION_BACKUP;
    delete process.env.MIGRATION_BACKUP_DIR;
    delete process.env.MONGODB_URI;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('rollbackMigration', () => {
    test('runs down() on the latest applied migration and deletes its record', async () => {
        writeMigration('001_a.js', `module.exports = { name: 'a', async up() {}, async down() { ${record("'down-a'")} } };`);
        writeMigration('002_b.js', `module.exports = { name: 'b', async up() {}, async down() { ${record("'down-b'")} } };`);
        records.push({ name: 'a' }, { name: 'b' });

        await rollbackMigration('b', { dir });

        expect(calls()).toEqual(['down-b']);
        expect(records.map(r => r.name)).toEqual(['a']);
    });

    test('after a rollback the migration is pending again on the next run', async () => {
        writeMigration('001_a.js', `module.exports = { name: 'a', async up() { ${record("'up-a'")} }, async down() {} };`);

        await runMigrations({ dir });
        await rollbackMigration('a', { dir });
        await runMigrations({ dir });

        expect(calls()).toEqual(['up-a', 'up-a']);
        expect(records.map(r => r.name)).toEqual(['a']);
    });

    test('refuses a migration that is not the most recently applied', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {}, async down() {} };");
        writeMigration('002_b.js', "module.exports = { name: 'b', async up() {}, async down() {} };");
        records.push({ name: 'a' }, { name: 'b' });

        await expect(rollbackMigration('a', { dir })).rejects.toThrow(/roll back b first/);
        expect(records.map(r => r.name)).toEqual(['a', 'b']);
    });

    test('refuses a migration that was never applied', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {}, async down() {} };");

        await expect(rollbackMigration('a', { dir })).rejects.toThrow(/not recorded as applied/);
    });

    test('refuses an irreversible migration and points at the backup', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', irreversible: true, async up() {} };");
        records.push({ name: 'a' });

        await expect(rollbackMigration('a', { dir })).rejects.toThrow(/irreversible.*restore/is);
        expect(records.map(r => r.name)).toEqual(['a']);
    });

    test('refuses a name that matches no migration file', async () => {
        await expect(rollbackMigration('ghost', { dir })).rejects.toThrow(/No migration named "ghost"/);
    });

    test('a down() that hangs runs out of the same budget up() gets', async () => {
        process.env.MIGRATION_TIMEOUT_MS = '60';
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {}, down: () => new Promise(() => {}) };");
        records.push({ name: 'a' });

        await expect(rollbackMigration('a', { dir })).rejects.toThrow(/Timed out after 60ms: a \(down\)/);
        // The record stays: the rollback did not complete.
        expect(records.map(r => r.name)).toEqual(['a']);
        delete process.env.MIGRATION_TIMEOUT_MS;
    });
});

describe('pre-migration backup', () => {
    const backupEnv = () => {
        process.env.MONGODB_URI = 'mongodb://localhost/test';
        process.env.MIGRATION_BACKUP_DIR = path.join(dir, 'backups');
    };

    test('a pending migration without down() triggers a mongodump first', async () => {
        backupEnv();
        writeMigration('001_a.js', "module.exports = { name: 'a', irreversible: true, async up() {} };");

        await runMigrations({ dir });

        expect(spawnSync).toHaveBeenCalledTimes(1);
        const [cmd, args] = spawnSync.mock.calls[0];
        expect(cmd).toBe('mongodump');
        expect(args).toEqual(expect.arrayContaining([
            '--uri=mongodb://localhost/test',
            '--gzip',
            expect.stringContaining('pre-migration-'),
        ]));
        expect(records.map(r => r.name)).toEqual(['a']);
    });

    test('a pending migration with down() does not need one', async () => {
        backupEnv();
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {}, async down() {} };");

        await runMigrations({ dir });

        expect(spawnSync).not.toHaveBeenCalled();
        expect(records.map(r => r.name)).toEqual(['a']);
    });

    test('by default a missing mongodump warns but does not block the boot', async () => {
        backupEnv();
        spawnSync.mockReturnValue({ error: Object.assign(new Error('spawn mongodump ENOENT'), { code: 'ENOENT' }) });
        writeMigration('001_a.js', "module.exports = { name: 'a', irreversible: true, async up() {} };");

        await expect(runMigrations({ dir })).resolves.toBeUndefined();
        expect(records.map(r => r.name)).toEqual(['a']);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('WITHOUT a backup'));
    });

    test('MIGRATION_BACKUP=require turns a failed backup into an aborted boot', async () => {
        backupEnv();
        process.env.MIGRATION_BACKUP = 'require';
        spawnSync.mockReturnValue({ status: 1 });
        writeMigration('001_a.js', "module.exports = { name: 'a', irreversible: true, async up() {} };");

        await expect(runMigrations({ dir })).rejects.toThrow(/mongodump exited with status 1/);
        expect(records).toEqual([]);
    });

    test('MIGRATION_BACKUP=skip skips the dump entirely', async () => {
        backupEnv();
        process.env.MIGRATION_BACKUP = 'skip';
        writeMigration('001_a.js', "module.exports = { name: 'a', irreversible: true, async up() {} };");

        await runMigrations({ dir });

        expect(spawnSync).not.toHaveBeenCalled();
        expect(records.map(r => r.name)).toEqual(['a']);
    });
});

describe('every shipped migration declares its rollback story', () => {
    const shippedDir = path.join(__dirname, '..', 'src', 'migrations');
    const files = fs.readdirSync(shippedDir).filter(f => f.endsWith('.js') && f !== 'runner.js');

    test.each(files)('%s exports down() or irreversible: true', file => {
        const migration = require(path.join(shippedDir, file));
        const hasStory = typeof migration.down === 'function' || migration.irreversible === true;
        expect(hasStory).toBe(true);
    });
});
