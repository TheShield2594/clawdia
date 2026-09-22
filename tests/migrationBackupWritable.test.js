'use strict';

/**
 * The pre-migration dump lands in MIGRATION_BACKUP_DIR (default ./backups),
 * which on a Docker deploy is a bind mount from the host. When that directory
 * is owned by root but the container runs as `node` (uid 1000), it exists yet
 * is read-only to the process — and `mkdirSync({ recursive: true })` is a no-op
 * that never notices. The only sign was mongodump exiting non-zero with a
 * `permission denied` buried in its stderr, so the boot aborted on an opaque
 * `mongodump exited with status 1`.
 *
 * preMigrationBackup now checks the directory is writable before spawning
 * mongodump, so an unwritable ./backups fails fast with a message that names
 * the directory and the fix instead of at the dump.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// The runner destructures spawnSync at require time, so the mock has to be in
// place before it loads — a later spyOn would not reach the captured binding.
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

// Requiring the runner pulls in the MigrationRecord model; a stand-in keeps the
// require free of any mongoose connection. preMigrationBackup itself never
// touches the model.
const { fakeMigrationRecords } = require('./helpers/fakeMigrationRecords');
const mockRecords = fakeMigrationRecords();
jest.mock('../src/models/MigrationRecord', () => mockRecords.model);

const { preMigrationBackup } = require('../src/migrations/runner');

const IRREVERSIBLE = ['026_backfill_shop_item_ids'];

describe('pre-migration backup writability', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backupdir-'));
        process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
        process.env.MIGRATION_BACKUP_DIR = dir;
        childProcess.spawnSync.mockReset();
        childProcess.spawnSync.mockReturnValue({ status: 0 });
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.MONGODB_URI;
        delete process.env.MIGRATION_BACKUP_DIR;
        delete process.env.MIGRATION_BACKUP;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Force the writability check to fail regardless of the uid the test runs
    // as, so this reproduces the container's read-only mount even when the
    // suite runs as root (where the permission bits would be bypassed).
    const denyWrite = () =>
        jest.spyOn(fs, 'accessSync').mockImplementation(() => {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        });

    describe('MIGRATION_BACKUP=require', () => {
        beforeEach(() => { process.env.MIGRATION_BACKUP = 'require'; });

        test('an unwritable backup directory aborts before mongodump runs', () => {
            denyWrite();
            expect(() => preMigrationBackup(IRREVERSIBLE)).toThrow(
                new RegExp(`backup directory ${dir} is not writable`),
            );
            expect(childProcess.spawnSync).not.toHaveBeenCalled();
        });

        test('the abort names the migration it is refusing to run', () => {
            denyWrite();
            expect(() => preMigrationBackup(IRREVERSIBLE)).toThrow(/026_backfill_shop_item_ids/);
        });
    });

    describe('MIGRATION_BACKUP unset (warn and continue)', () => {
        test('an unwritable directory warns and skips the dump without throwing', () => {
            denyWrite();
            expect(() => preMigrationBackup(IRREVERSIBLE)).not.toThrow();
            expect(childProcess.spawnSync).not.toHaveBeenCalled();
            const warned = console.warn.mock.calls.map(args => args.join(' ')).join('\n');
            expect(warned).toMatch(/is not writable/);
        });
    });

    test('a writable directory proceeds to run mongodump', () => {
        process.env.MIGRATION_BACKUP = 'require';
        // Real accessSync against the freshly created temp dir: it is writable.
        preMigrationBackup(IRREVERSIBLE);
        expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
        expect(childProcess.spawnSync.mock.calls[0][0]).toBe('mongodump');
    });
});
