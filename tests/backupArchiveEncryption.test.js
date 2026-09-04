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
const yaml = require('js-yaml');

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

// scripts/backup.sh is the same dump taken by hand, and it has to hold the same
// invariant the nightly service does: the plaintext of the database never
// appears in the archive directory, not even between the dump and the seal, and
// not after a failure.
describe('a backup taken by hand', () => {
    function backup(env = {}) {
        const out = path.join(dir, 'out');
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(out, { recursive: true });
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'mongodump'), [
            '#!/bin/sh',
            'for a in "$@"; do case "$a" in --archive=*) OUT="${a#--archive=}";; esac; done',
            'printf THE-DATABASE > "$OUT"',
        ].join('\n'));
        fs.chmodSync(path.join(bin, 'mongodump'), 0o755);

        const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'backup.sh'), out], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                MONGODB_URI: 'mongodb://db/clawdia',
                BACKUP_ENCRYPTION_PASSPHRASE: '',
                ...env,
            },
        });
        return { ...run, written: fs.readdirSync(out).sort() };
    }

    it('writes a plain archive when no passphrase is configured', () => {
        const run = backup();

        expect(run.status).toBe(0);
        expect(run.written).toEqual([expect.stringMatching(/^clawdia-.*\.gz$/)]);
    });

    withOpenssl('seals the archive, and puts only the sealed file in the directory', () => {
        const run = backup({ BACKUP_ENCRYPTION_PASSPHRASE: 'a passphrase with spaces' });

        expect(run.status).toBe(0);
        expect(run.written).toEqual([expect.stringMatching(/^clawdia-.*\.gz\.enc$/)]);

        // And it is the database, sealed — not a file that merely has the name.
        const sealed = path.join(dir, 'out', run.written[0]);
        const opened = spawnSync('bash', ['-c',
            `. "${ARCHIVE_LIB}"; open_archive "${sealed}" "${dir}/work"`], {
            encoding: 'utf8',
            env: { ...process.env, BACKUP_ENCRYPTION_PASSPHRASE: 'a passphrase with spaces' },
        });
        expect(fs.readFileSync(opened.stdout, 'utf8')).toBe('THE-DATABASE');
    });

    it('keeps nothing when the seal fails', () => {
        // The plaintext dump is staged outside the archive directory, so a
        // failure between the dump and the seal cannot strand a readable copy
        // of the database in the directory being backed up to.
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'openssl'), '#!/bin/sh\nexit 7\n');
        fs.chmodSync(path.join(bin, 'openssl'), 0o755);

        const run = backup({ BACKUP_ENCRYPTION_PASSPHRASE: 'passphrase' });

        expect(run.status).not.toBe(0);
        expect(run.stderr).toMatch(/encrypting the archive failed/);
        expect(run.written).toEqual([]);
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

// The backup service's own loop, run. tests/deployStackParity.test.js holds its
// shape and holds the two stack files to the same one; this drives it, because
// the properties that matter are about what ends up on disk after a failure —
// which no amount of reading the YAML can answer.
describe("the backup service's entrypoint", () => {
    /** The inline `sh -c` script, with its paths pointed at a scratch tree. */
    function loopScript(archives, work) {
        const service = yaml.load(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'))
            .services.backup.entrypoint;
        return String(service)
            .replace(/^\s*sh -c '/, '')
            .replace(/'\s*$/, '')
            // Compose escapes `$` for its own interpolation; the shell sees one.
            .replace(/\$\$/g, '$')
            // The staging path first: it is a /tmp path and would otherwise be
            // caught by the /backups rewrite below.
            .replace(/\/tmp\/clawdia-/g, `${work}/clawdia-`)
            .replace(/\/backups/g, archives)
            // Everything up to the scheduling loop: the boot catch-up runs one
            // backup, which is the whole of what is under test here.
            .replace(/while true[\s\S]*$/, '');
    }

    /** Stand-ins that record what they were handed rather than reaching a database. */
    function stubMongoTools(bin) {
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'mongodump'), [
            '#!/bin/sh',
            'for a in "$@"; do case "$a" in --archive=*) OUT="${a#--archive=}";; esac; done',
            // A dump killed part way leaves what it had written behind.
            '[ -n "$FAIL_DUMP" ] && { printf partial > "$OUT"; exit 3; }',
            'printf THE-DATABASE > "$OUT"',
        ].join('\n'));
        fs.writeFileSync(path.join(bin, 'mongorestore'), [
            '#!/bin/sh',
            'for a in "$@"; do case "$a" in --archive=*) IN="${a#--archive=}";; esac; done',
            '[ -n "$FAIL_VERIFY" ] && exit 4',
            'grep -q THE-DATABASE "$IN" 2>/dev/null || exit 5',
        ].join('\n'));
        for (const tool of ['mongodump', 'mongorestore']) fs.chmodSync(path.join(bin, tool), 0o755);
    }

    function runLoop(env = {}) {
        const archives = path.join(dir, 'backups');
        const work = path.join(dir, 'staging');
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(archives, { recursive: true });
        fs.mkdirSync(work, { recursive: true });
        stubMongoTools(bin);

        const run = spawnSync('sh', ['-c', loopScript(archives, work)], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MONGODB_URI: 'mongodb://db/clawdia', ...env },
        });
        // The two dotfiles the loop keeps for the healthcheck and for a human
        // are state, not archives, and are asserted by name where they matter.
        return {
            ...run,
            archives: fs.readdirSync(archives).filter(f => !f.startsWith('.')).sort(),
            staging: fs.readdirSync(work),
        };
    }

    // Not gated on openssl, unlike its neighbours: the emptiness check sits in
    // the file-reading block above the `command -v openssl` one, so this refusal
    // is reached on a machine that has no openssl at all — and it is the case
    // where a missing gate would let plaintext through, so it is worth having
    // run everywhere.
    it('refuses an empty passphrase file rather than writing plaintext', () => {
        // The failure this closes: a docker secret that exists and is readable
        // but holds nothing — a mount pointed at the wrong path, a file the
        // operator has not filled in yet. The `-n` test on the variable is
        // satisfied by a file and unsatisfied by its contents, so without this
        // the run falls through to the unencrypted branch and reports itself
        // done, which is the "asked for encryption, silently got plaintext"
        // outcome the openssl check a few lines below already refuses.
        const secret = path.join(dir, 'empty.secret');
        fs.writeFileSync(secret, '');

        const run = runLoop({ BACKUP_ENCRYPTION_PASSPHRASE_FILE: secret });

        expect(run.status).toBe(1);
        expect(run.stdout).toMatch(/is empty/);
        // Refused before anything was dumped, not after.
        expect(run.archives).toEqual([]);
    });

    withOpenssl('reads a passphrase file that has one, and seals with it', () => {
        const secret = path.join(dir, 'good.secret');
        fs.writeFileSync(secret, 'a passphrase with spaces\n');

        const run = runLoop({ BACKUP_ENCRYPTION_PASSPHRASE_FILE: secret });

        expect(run.status).toBe(0);
        expect(run.archives.filter(f => f.endsWith('.gz.enc'))).toHaveLength(1);
        // And the staging copy does not outlive the run.
        expect(run.staging).toEqual([]);
    });

    withOpenssl('never leaves the plaintext dump in the archive directory', () => {
        // Not even for the seconds between the dump and the seal: that
        // directory being readable is the premise of the whole feature.
        const run = runLoop({ BACKUP_ENCRYPTION_PASSPHRASE: 'passphrase' });

        expect(run.status).toBe(0);
        expect(run.archives).toEqual([expect.stringMatching(/^clawdia-.*\.gz\.enc$/)]);
        expect(run.archives.some(f => f.endsWith('.gz'))).toBe(false);
    });

    withOpenssl('removes the partial plaintext when the dump fails', () => {
        const run = runLoop({ BACKUP_ENCRYPTION_PASSPHRASE: 'passphrase', FAIL_DUMP: '1' });

        expect(run.archives).toEqual([]);
        expect(run.staging).toEqual([]);
        expect(fs.readFileSync(path.join(dir, 'backups', '.backup-status'), 'utf8')).toMatch(/^dump-failed/);
    });

    withOpenssl('quarantines a sealed archive that will not read back, and keeps no plaintext', () => {
        const run = runLoop({ BACKUP_ENCRYPTION_PASSPHRASE: 'passphrase', FAIL_VERIFY: '1' });

        expect(run.archives).toEqual([expect.stringMatching(/\.gz\.enc\.unverified$/)]);
        expect(run.staging).toEqual([]);
        // A quarantined archive is not the day's backup.
        expect(fs.existsSync(path.join(dir, 'backups', '.backup-ok'))).toBe(false);
    });

    it('leaves the unencrypted path exactly as it was', () => {
        // Every deployment that has not set a passphrase runs this branch, and
        // it has to be what it was before the feature existed.
        const run = runLoop();

        expect(run.status).toBe(0);
        expect(run.archives).toEqual([expect.stringMatching(/^clawdia-.*\.gz$/)]);
        expect(fs.existsSync(path.join(dir, 'backups', '.backup-ok'))).toBe(true);
    });
});
