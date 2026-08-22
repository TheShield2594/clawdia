'use strict';

// Secrets handed to a container as plain environment variables are readable by
// anyone who can reach the Docker API — `docker inspect` prints them, and the
// Portainer UI shows the same values. The <NAME>_FILE convention keeps the
// value out of the environment; these tests hold its edges.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadFileSecrets, FILE_BACKED_SECRETS } = require('../src/config/fileSecrets');

let tmpDir;
let log;

function secretFile(name, contents) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, contents);
    return p;
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-secrets-'));
    log = { log: jest.fn(), warn: jest.fn() };
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadFileSecrets', () => {
    it('publishes the file contents as the plain variable', () => {
        const env = { DISCORD_TOKEN_FILE: secretFile('token', 'MTIz.abc.def') };
        expect(loadFileSecrets(env, { log })).toEqual(['DISCORD_TOKEN']);
        expect(env.DISCORD_TOKEN).toBe('MTIz.abc.def');
    });

    it('strips the trailing newline `echo > file` leaves behind', () => {
        // A Discord token with a newline on the end fails to authenticate with
        // an error that says nothing about whitespace.
        const env = { DISCORD_TOKEN_FILE: secretFile('token', 'MTIz.abc.def\n') };
        loadFileSecrets(env, { log });
        expect(env.DISCORD_TOKEN).toBe('MTIz.abc.def');
    });

    it('keeps leading whitespace, which a passphrase is entitled to', () => {
        const env = { SESSION_SECRET_FILE: secretFile('sess', '  padded  \n') };
        loadFileSecrets(env, { log });
        expect(env.SESSION_SECRET).toBe('  padded');
    });

    it('lets an explicit variable win over the file, and says so', () => {
        // A one-off `docker run -e DISCORD_TOKEN=…` has to still override a
        // stack that mounts the secret.
        const env = {
            DISCORD_TOKEN: 'from-env',
            DISCORD_TOKEN_FILE: secretFile('token', 'from-file'),
        };
        expect(loadFileSecrets(env, { log })).toEqual([]);
        expect(env.DISCORD_TOKEN).toBe('from-env');
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/DISCORD_TOKEN.*ignoring the file/));
    });

    it('treats an empty variable as unset, so a blank compose default still resolves', () => {
        // `- DISCORD_TOKEN=${DISCORD_TOKEN}` with nothing set yields "".
        const env = { DISCORD_TOKEN: '', DISCORD_TOKEN_FILE: secretFile('token', 'from-file') };
        loadFileSecrets(env, { log });
        expect(env.DISCORD_TOKEN).toBe('from-file');
    });

    it('aborts on an unreadable file rather than leaving the variable unset', () => {
        // A mount typo must fail at startup, not hours later as "the AI stopped
        // working".
        const env = { ANTHROPIC_API_KEY_FILE: path.join(tmpDir, 'missing') };
        expect(() => loadFileSecrets(env, { log })).toThrow(/Cannot read ANTHROPIC_API_KEY_FILE/);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('aborts on an empty file', () => {
        const env = { SESSION_SECRET_FILE: secretFile('sess', '\n') };
        expect(() => loadFileSecrets(env, { log })).toThrow(/is empty/);
    });

    it('ignores a *_FILE variable for anything that is not a known secret', () => {
        // The reason this is a list and not a scan: `_FILE` is the ordinary
        // suffix for "path to a file", and most Linux images export these.
        const env = {
            SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
            NIX_SSL_CERT_FILE: '/nowhere/at/all',
            MIGRATION_BACKUP_FILE: '/nowhere/either',
        };
        expect(loadFileSecrets(env, { log })).toEqual([]);
        expect(env.SSL_CERT).toBeUndefined();
        expect(env.NIX_SSL_CERT).toBeUndefined();
    });

    it('logs the names it resolved and never a value', () => {
        const env = {
            DISCORD_TOKEN_FILE: secretFile('token', 'super-secret-token'),
            SESSION_SECRET_FILE: secretFile('sess', 'super-secret-session'),
        };
        loadFileSecrets(env, { log });
        const line = log.log.mock.calls.map(c => c[0]).join('\n');
        expect(line).toContain('DISCORD_TOKEN');
        expect(line).toContain('SESSION_SECRET');
        expect(line).not.toContain('super-secret-token');
        expect(line).not.toContain('super-secret-session');
    });

    it('says nothing when no secret is file-backed', () => {
        expect(loadFileSecrets({ DISCORD_TOKEN: 'plain' }, { log })).toEqual([]);
        expect(log.log).not.toHaveBeenCalled();
    });

    it('covers every secret the bot actually reads', () => {
        // A provider key added later without a _FILE form silently loses the
        // protection, so pin the list against the source tree.
        const SRC = path.join(__dirname, '..', 'src');
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(path.join(dir, e.name))
                : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);

        const used = new Set();
        for (const file of walk(SRC)) {
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
        }

        // Everything the bot reads that carries a credential. The rest —
        // CLIENT_ID, DASHBOARD_URL, NODE_ENV, tuning knobs — is not sensitive.
        const SECRET_SHAPED = [...used].filter(name =>
            /(_TOKEN|_SECRET|_KEY|_PASSWORD|_USERNAME)$/.test(name) || name === 'MONGODB_URI');

        expect(SECRET_SHAPED.sort()).toEqual([...FILE_BACKED_SECRETS].sort());
    });
});

describe('entrypoints', () => {
    // The loader is only worth anything if it runs before the first read of
    // process.env, in every process that boots the bot.
    const ENTRYPOINTS = [
        'src/index.js',
        'src/shard.js',
        'src/deploy-commands.js',
        'scripts/rollback-migration.js',
    ];

    it.each(ENTRYPOINTS)('%s loads file secrets straight after dotenv', file => {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        const dotenv = src.indexOf("require('dotenv').config()");
        const secrets = src.indexOf('loadFileSecrets()');
        expect(dotenv).toBeGreaterThan(-1);
        expect(secrets).toBeGreaterThan(dotenv);

        // Nothing may read a secret in between. Comments there are allowed to
        // mention process.env — it is the code that must not touch it.
        const between = src.slice(dotenv, secrets).replace(/\/\/.*$/gm, '');
        expect(between).not.toMatch(/process\.env\./);
    });
});
