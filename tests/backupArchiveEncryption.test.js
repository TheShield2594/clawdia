'use strict';

/**
 * #886 and #900. Two halves of the same exposure, and both of them are shell.
 *
 * The nightly `backup` service writes `mongodump --gzip` archives into a
 * directory beside the database and keeps thirty days of them. `--gzip` is
 * compression: every one of those archives was a readable copy of the whole
 * database, including the per-guild AI provider keys and the MCP OAuth refresh
 * tokens that `SECRET_ENCRYPTION_KEY` covers only when an operator set it. And
 * they never left the host, so the machine failing took the database and every
 * backup of it in one event (#900).
 *
 * The sealing and the off-site copy are only worth anything if the archives can
 * still be read back, which is what makes this worth driving rather than
 * grepping: `scripts/lib/archive.sh` is what `restore.sh` and
 * `verify-backup.sh` both open an archive through, so a cipher or a KDF
 * parameter that drifts from what sealed it turns a month of backups into a
 * month of noise, and it would drift silently.
 *
 * tests/deployStackParity.test.js holds the backup service's own entrypoint to
 * the same shape in both stack files; this drives the host side of it.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARCHIVE_LIB = path.join(ROOT, 'scripts', 'lib', 'archive.sh');
const OFFSITE = path.join(ROOT, 'scripts', 'offsite-sync.sh');

// The backup service runs in the stock mongo image, which carries openssl; a
// developer machine or a CI runner may not. The round-trip cases need the real
// binary — a hand-rolled Node equivalent would be testing this file's idea of
// the format rather than the one the archives are actually written in — so they
// are skipped where it is absent, and the refusal cases below still run.
const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0;
const withOpenssl = HAS_OPENSSL ? it : it.skip;

let dir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-backup-'));
    fs.mkdirSync(path.join(dir, 'work'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs a snippet with scripts/lib/archive.sh sourced. */
function sourcing(snippet, env = {}) {
    return spawnSync('bash', ['-c', `set -euo pipefail\n. "${ARCHIVE_LIB}"\n${snippet}`], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

const seal = (input, output, passphrase) => execFileSync('openssl', [
    'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
    '-pass', `env:BACKUP_ENCRYPTION_PASSPHRASE`,
    '-in', input, '-out', output,
], { env: { ...process.env, BACKUP_ENCRYPTION_PASSPHRASE: passphrase } });

describe('opening a backup archive', () => {
    it('hands back a plain archive untouched, and copies nothing', () => {
        // The unencrypted path is every install that has not set a passphrase,
        // so it has to stay exactly what it was: no temp copy of the database,
        // no decryption, the archive read where it lies.
        const archive = path.join(dir, 'clawdia-1.gz');
        fs.writeFileSync(archive, 'ARCHIVE');

        const run = sourcing(`open_archive "${archive}" "${dir}/work"`);

        expect(run.status).toBe(0);
        expect(run.stdout).toBe(archive);
        expect(fs.readdirSync(path.join(dir, 'work'))).toEqual([]);
    });

    withOpenssl('opens a sealed archive back to the bytes that went in', () => {
        const archive = path.join(dir, 'clawdia-1.gz');
        fs.writeFileSync(archive, 'THE-WHOLE-DATABASE');
        seal(archive, `${archive}.enc`, 'a passphrase with spaces');
        fs.rmSync(archive);

        const run = sourcing(`open_archive "${archive}.enc" "${dir}/work"`, {
            BACKUP_ENCRYPTION_PASSPHRASE: 'a passphrase with spaces',
        });

        expect(run.status).toBe(0);
        expect(fs.readFileSync(run.stdout, 'utf8')).toBe('THE-WHOLE-DATABASE');
    });

    withOpenssl('decrypts into the caller directory, never beside the archive', () => {
        // The backup directory being readable is the premise of the whole
        // feature; a decrypted copy landing in it would undo the archive it came
        // from, for as long as the restore took.
        const archive = path.join(dir, 'clawdia-1.gz');
        fs.writeFileSync(archive, 'THE-WHOLE-DATABASE');
        seal(archive, `${archive}.enc`, 'passphrase');
        fs.rmSync(archive);

        const run = sourcing(`open_archive "${archive}.enc" "${dir}/work"`, {
            BACKUP_ENCRYPTION_PASSPHRASE: 'passphrase',
        });

        expect(path.dirname(run.stdout)).toBe(path.join(dir, 'work'));
        expect(fs.readdirSync(dir).sort()).toEqual(['clawdia-1.gz.enc', 'work']);
    });

    withOpenssl('refuses the wrong passphrase instead of returning garbage', () => {
        // A silent half-decrypt handed to mongorestore is a restore that fails
        // somewhere else, hours later, saying something about BSON.
        const archive = path.join(dir, 'clawdia-1.gz');
        fs.writeFileSync(archive, 'THE-WHOLE-DATABASE');
        seal(archive, `${archive}.enc`, 'right');
        fs.rmSync(archive);

        const run = sourcing(`open_archive "${archive}.enc" "${dir}/work"`, {
            BACKUP_ENCRYPTION_PASSPHRASE: 'wrong',
        });

        expect(run.status).not.toBe(0);
        expect(run.stderr).toMatch(/did not decrypt/);
        // And leaves nothing half-written for a later run to pick up.
        expect(fs.readdirSync(path.join(dir, 'work'))).toEqual([]);
    });

    it('says what is missing when there is no passphrase at all', () => {
        const archive = path.join(dir, 'clawdia-1.gz.enc');
        fs.writeFileSync(archive, 'sealed');

        const run = sourcing(`open_archive "${archive}" "${dir}/work"`, {
            BACKUP_ENCRYPTION_PASSPHRASE: '',
        });

        expect(run.status).not.toBe(0);
        expect(run.stderr).toMatch(/BACKUP_ENCRYPTION_PASSPHRASE is not set/);
    });
});

describe('the archive readers both go through it', () => {
    const read = name => fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');

    it.each(['restore.sh', 'verify-backup.sh'])('%s opens the archive with open_archive', file => {
        const source = read(file);
        expect(source).toContain('lib/archive.sh');
        expect(source).toMatch(/open_archive "\$\{ARCHIVE\}"/);
        // And hands mongorestore what came back, not the path it was given —
        // which is the one-character version of this bug.
        expect(source).not.toMatch(/--archive="\$\{ARCHIVE\}"/);
    });

    it('finds a sealed archive when asked for the latest one', () => {
        // `clawdia-*.gz` does not match `clawdia-*.gz.enc`, so --latest on an
        // encrypted install would have reported no archives at all.
        expect(read('verify-backup.sh')).toContain('clawdia-*.gz.enc');
    });
});

describe('off-site replication (#900)', () => {
    /** Runs offsite-sync.sh against `dir`, with a stub rclone on PATH. */
    function sync(env = {}) {
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        const stub = path.join(bin, 'rclone');
        fs.writeFileSync(stub, '#!/bin/sh\necho "rclone $*"\n');
        fs.chmodSync(stub, 0o755);
        return spawnSync('bash', [OFFSITE, dir], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                BACKUP_REMOTE: 's3:bucket/clawdia',
                BACKUP_REMOTE_ALLOW_PLAINTEXT: '',
                ERROR_WEBHOOK_URL: '',
                ...env,
            },
        });
    }

    it('copies sealed archives off the host', () => {
        fs.writeFileSync(path.join(dir, 'clawdia-1.gz.enc'), 'sealed');

        const run = sync();

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('rclone copy');
        expect(run.stdout).toContain('s3:bucket/clawdia');
    });

    it('refuses a run that would only send readable copies of the database', () => {
        // Replicating plaintext off-site is a wider exposure than the one this
        // closes, not a narrower one: the archives stop being bounded by who can
        // reach the host at all. An install with no passphrase has nothing this
        // is willing to send, and should hear that rather than quietly succeed
        // having sent nothing.
        fs.writeFileSync(path.join(dir, 'clawdia-1.gz'), 'plaintext');

        const run = sync();

        expect(run.status).not.toBe(0);
        expect(run.stderr).toMatch(/BACKUP_ENCRYPTION_PASSPHRASE/);
        expect(run.stdout).not.toContain('rclone copy');
    });

    it('skips the plaintext ones rather than refusing a directory holding both', () => {
        // The ordinary state of an encrypted install: the bot's pre-migration
        // dump is written by the migration runner, which has no passphrase, so
        // one turns up after every irreversible migration and stays for the
        // retention window. Refusing over it takes the off-site copy away for a
        // month.
        fs.writeFileSync(path.join(dir, 'clawdia-1.gz.enc'), 'sealed');
        fs.writeFileSync(path.join(dir, 'pre-migration-1.gz'), 'plaintext');

        const run = sync();

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('Skipping 1 unencrypted archive');
        // Only the sealed pattern reaches rclone.
        expect(run.stdout).toContain('--include clawdia-*.gz.enc');
        expect(run.stdout).not.toMatch(/--include clawdia-\*\.gz(?!\.enc)/);
    });

    it('allows plaintext for a remote that encrypts, since that is not a downgrade', () => {
        fs.writeFileSync(path.join(dir, 'clawdia-1.gz'), 'plaintext');

        const run = sync({ BACKUP_REMOTE_ALLOW_PLAINTEXT: 'true' });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('rclone copy');
        expect(run.stdout).toContain('--include clawdia-*.gz ');
    });

    it('says what to set when there is no remote', () => {
        fs.writeFileSync(path.join(dir, 'clawdia-1.gz.enc'), 'sealed');
        const run = sync({ BACKUP_REMOTE: '' });

        expect(run.status).not.toBe(0);
        expect(run.stderr).toMatch(/BACKUP_REMOTE is not set/);
    });

    it('copies rather than mirrors, so a wiped host does not wipe the remote', () => {
        // `rclone sync` propagates deletions, which is the event this script
        // exists for arriving at the copy that was supposed to survive it.
        const source = fs.readFileSync(OFFSITE, 'utf8');
        const command = source.slice(source.indexOf('rclone copy'));
        expect(command).toMatch(/^rclone copy/);
        expect(source).not.toMatch(/^rclone sync/m);
        // A quarantined archive failed its own parse check; off-site storage
        // holding a known-bad archive beside good ones is a trap at 3am.
        expect(command).not.toContain('unverified');
    });
});
