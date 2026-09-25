'use strict';

/**
 * #1150. With BACKUP_ENCRYPTION_PASSPHRASE set, ./backups is meant to hold only
 * ciphertext — but the dump the runner takes before an irreversible migration
 * landed there in plaintext, a full readable copy of the database beside the
 * sealed nightly archives. It is now staged outside the directory, sealed in
 * the same `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt` format the
 * backup service writes, and created 0600.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

const { fakeMigrationRecords } = require('./helpers/fakeMigrationRecords');
const mockRecords = fakeMigrationRecords();
jest.mock('../src/models/MigrationRecord', () => mockRecords.model);

const { preMigrationBackup, sealArchive, archiveTag } = require('../src/migrations/runner');

const IRREVERSIBLE = ['026_backfill_shop_item_ids'];
const DUMP = Buffer.from('pretend this is a gzipped mongodump archive '.repeat(5000));

// What `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000` does, so the format
// is checked against the reader restore.sh uses rather than against itself.
function opensslDecrypt(sealed, passphrase) {
    expect(sealed.subarray(0, 8).toString()).toBe('Salted__');
    const salt = sealed.subarray(8, 16);
    const derived = crypto.pbkdf2Sync(passphrase, salt, 200000, 48, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
    return Buffer.concat([decipher.update(sealed.subarray(16)), decipher.final()]);
}

// Stands in for mongodump: writes DUMP to wherever --archive= points.
function fakeMongodump({ status = 0 } = {}) {
    childProcess.spawnSync.mockImplementation((cmd, args) => {
        const target = args.find(a => a.startsWith('--archive=')).slice('--archive='.length);
        fs.writeFileSync(target, DUMP);
        return { status };
    });
}

describe('pre-migration backup encryption', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backupenc-'));
        process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
        process.env.MIGRATION_BACKUP_DIR = dir;
        process.env.MIGRATION_BACKUP = 'require';
        childProcess.spawnSync.mockReset();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.MONGODB_URI;
        delete process.env.MIGRATION_BACKUP_DIR;
        delete process.env.MIGRATION_BACKUP;
        delete process.env.BACKUP_ENCRYPTION_PASSPHRASE;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('with a passphrase, only a sealed .gz.enc lands in the backup directory', () => {
        process.env.BACKUP_ENCRYPTION_PASSPHRASE = 'correct horse battery staple';
        fakeMongodump();

        preMigrationBackup(IRREVERSIBLE);

        const files = fs.readdirSync(dir).sort();
        // The sealed dump and its tag (#1161), nothing else.
        expect(files).toHaveLength(2);
        expect(files[0]).toMatch(/^pre-migration-.*\.gz\.enc$/);
        expect(files[1]).toBe(`${files[0]}.tag`);
        expect(fs.readFileSync(path.join(dir, files[1]), 'utf8').trim())
            .toBe(archiveTag(path.join(dir, files[0]), 'correct horse battery staple'));

        // mongodump never wrote into the backup directory at all.
        const archiveArg = childProcess.spawnSync.mock.calls[0][1].find(a => a.startsWith('--archive='));
        expect(archiveArg.startsWith(`--archive=${dir}`)).toBe(false);

        const sealed = fs.readFileSync(path.join(dir, files[0]));
        expect(sealed.includes(DUMP.subarray(0, 40))).toBe(false);
        expect(opensslDecrypt(sealed, 'correct horse battery staple').equals(DUMP)).toBe(true);
    });

    test('the staging directory is removed afterwards', () => {
        process.env.BACKUP_ENCRYPTION_PASSPHRASE = 'pw';
        fakeMongodump();
        preMigrationBackup(IRREVERSIBLE);

        const target = childProcess.spawnSync.mock.calls[0][1]
            .find(a => a.startsWith('--archive=')).slice('--archive='.length);
        expect(fs.existsSync(path.dirname(target))).toBe(false);
    });

    test('a failed dump leaves nothing behind, sealed or not', () => {
        process.env.BACKUP_ENCRYPTION_PASSPHRASE = 'pw';
        fakeMongodump({ status: 1 });
        expect(() => preMigrationBackup(IRREVERSIBLE)).toThrow(/mongodump exited with status 1/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('without a passphrase the archive is plaintext as before, but not a partial one', () => {
        fakeMongodump({ status: 1 });
        expect(() => preMigrationBackup(IRREVERSIBLE)).toThrow(/mongodump exited with status 1/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    if (process.platform !== 'win32') {
        test.each([['sealed', 'pw'], ['plaintext', undefined]])('the %s archive is created 0600', (_, pw) => {
            if (pw) process.env.BACKUP_ENCRYPTION_PASSPHRASE = pw;
            fakeMongodump();
            preMigrationBackup(IRREVERSIBLE);
            for (const file of fs.readdirSync(dir)) {
                expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
            }
        });
    }

    test('sealArchive round-trips an empty file', () => {
        const src = path.join(dir, 'empty');
        const dest = path.join(dir, 'empty.enc');
        fs.writeFileSync(src, '');
        sealArchive(src, dest, 'pw');
        expect(opensslDecrypt(fs.readFileSync(dest), 'pw').length).toBe(0);
    });

    // restore.sh checks the tag with scripts/lib/archive.sh, so the Node tag
    // must be that one byte for byte, or every sealed pre-migration dump is
    // refused as tampered with on the day it is needed.
    // child_process is mocked for mongodump above; these need the real one.
    const { spawnSync: realSpawnSync } = jest.requireActual('child_process');
    const HAS_TOOLS = realSpawnSync('openssl', ['version']).status === 0
        && realSpawnSync('bash', ['--version']).status === 0;
    (HAS_TOOLS ? test : test.skip)('archiveTag matches archive.sh archive_tag', () => {
        const file = path.join(dir, 'x.gz.enc');
        fs.writeFileSync(file, crypto.randomBytes(3000));
        const run = realSpawnSync('bash', ['-c', '. "$ARCHIVE_LIB"; archive_tag "$ARCHIVE_PATH"'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                ARCHIVE_LIB: path.join(__dirname, '..', 'scripts', 'lib', 'archive.sh'),
                ARCHIVE_PATH: file,
                BACKUP_ENCRYPTION_PASSPHRASE: 'a passphrase with spaces',
            },
        });
        expect(run.status).toBe(0);
        expect(run.stdout.trim()).toBe(archiveTag(file, 'a passphrase with spaces'));
    });
});
