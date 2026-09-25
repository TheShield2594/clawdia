'use strict';

/**
 * #1156. mongodump and mongorestore were handed `--uri=mongodb://user:pass@…`,
 * and argv is readable by every user of the host through `ps` or
 * /proc/<pid>/cmdline — a process inside a container included. The URI now
 * goes to them in a 0600 YAML file passed as `--config`.
 *
 * Three things write that file: scripts/lib/mongotools.sh for the scripts run
 * by hand, src/migrations/runner.js for the pre-migration dump, and the backup
 * service's entrypoint in both stack files. They are held to one output here,
 * with a URI carrying the two characters the YAML scalar has to escape.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { mongoToolsConfig } = require('../src/migrations/runner');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'mongotools.sh');
const STACKS = ['docker-compose.yml', 'portainer-stack.yml'];

const URI = 'mongodb://clawdia:pa"ss\\word@db:27017/clawdia?authSource=admin';
const EXPECTED = 'uri: "mongodb://clawdia:pa\\"ss\\\\word@db:27017/clawdia?authSource=admin"\n';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongotools-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the --config file', () => {
    it('is the URI as a YAML double-quoted scalar, from Node', () => {
        expect(mongoToolsConfig(URI)).toBe(EXPECTED);
        // And it is YAML that reads back to the URI it was given.
        expect(yaml.load(mongoToolsConfig(URI))).toEqual({ uri: URI });
    });

    it('is the same file from scripts/lib/mongotools.sh, readable by its owner only', () => {
        const file = path.join(dir, 'tools.yaml');
        const run = spawnSync('bash', ['-c', `. "${LIB}" && write_mongo_tools_config "$URI" "$1"`, 'bash', file], {
            encoding: 'utf8',
            env: { ...process.env, URI },
        });

        expect(run.status).toBe(0);
        expect(fs.readFileSync(file, 'utf8')).toBe(EXPECTED);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it.each(STACKS)('is the same file from the backup entrypoint in %s', (stack) => {
        const entrypoint = String(yaml.load(fs.readFileSync(path.join(ROOT, stack), 'utf8'))
            .services.backup.entrypoint)
            // Compose escapes `$` for its own interpolation; the shell sees one.
            .replace(/\$\$/g, '$');
        const start = entrypoint.indexOf('if ! TOOLS_CONFIG=');
        const writer = entrypoint.slice(start, entrypoint.indexOf('fi;', start) + 'fi;'.length);
        expect(start).toBeGreaterThan(-1);

        const run = spawnSync('sh', ['-c', `umask 077; ${writer} cat "$TOOLS_CONFIG"; rm -f "$TOOLS_CONFIG"`], {
            encoding: 'utf8',
            env: { ...process.env, MONGODB_URI: URI, TMPDIR: dir },
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toBe(EXPECTED);
    });
});

describe('no URI on a command line', () => {
    it.each([
        'scripts/backup.sh',
        'scripts/restore.sh',
        'scripts/verify-backup.sh',
        'src/migrations/runner.js',
        ...STACKS,
    ])('%s passes the mongo tools no --uri', (file) => {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        expect(text).not.toMatch(/mongo(dump|restore)\b[^\n]*--uri/);
        // mongosh has no config file; verify-backup.sh hands it the URI in the
        // environment instead of as its first argument.
        expect(text).not.toMatch(/mongosh "\$1"/);
    });

    it('backup.sh hands mongodump a 0600 config file and keeps the URI off argv', () => {
        const bin = path.join(dir, 'bin');
        const out = path.join(dir, 'out');
        const seen = path.join(dir, 'seen');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'mongodump'), [
            '#!/bin/sh',
            `printf '%s\\n' "$@" > "${seen}.argv"`,
            'for a in "$@"; do case "$a" in',
            '  --archive=*) OUT="${a#--archive=}";;',
            `  --config=*) CFG="\${a#--config=}"; cat "$CFG" > "${seen}.config"; stat -c %a "$CFG" > "${seen}.mode";;`,
            'esac; done',
            'printf THE-DATABASE > "$OUT"',
        ].join('\n'));
        fs.chmodSync(path.join(bin, 'mongodump'), 0o755);

        const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'backup.sh'), out], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                MONGODB_URI: URI,
                BACKUP_ENCRYPTION_PASSPHRASE: '',
            },
        });

        expect(run.status).toBe(0);
        expect(fs.readFileSync(`${seen}.argv`, 'utf8')).not.toContain('mongodb://');
        expect(fs.readFileSync(`${seen}.config`, 'utf8')).toBe(EXPECTED);
        expect(fs.readFileSync(`${seen}.mode`, 'utf8').trim()).toBe('600');
        // And the file holding the password does not outlive the run.
        const argv = fs.readFileSync(`${seen}.argv`, 'utf8');
        const config = argv.split('\n').find(a => a.startsWith('--config=')).slice('--config='.length);
        expect(fs.existsSync(config)).toBe(false);
    });
});
