'use strict';

// #639: config validation was split across two files that run at very different
// points in the boot. src/index.js checked that five variables were present;
// dashboard/server.js enforced the DASHBOARD_URL and SESSION_SECRET rules — and
// it starts after connectDatabase() and runMigrations(). So a deploy that was
// always going to be rejected got as far as migrating the database first, and
// migrations have no rollback path.
//
// These tests hold both halves of the fix: every rule is in one module, and the
// entry points run it before they connect to anything.

const fs = require('fs');
const path = require('path');

const {
    assertEnv,
    collectEnvProblems,
    checkDashboardUrl,
    checkSessionSecret,
    checkSecretEncryption,
    resolveDashboardUrl,
    REQUIRED_ENV,
    SESSION_SECRET_MIN_LENGTH,
} = require('../src/config/validateEnv');

/** A configuration with nothing wrong with it. */
function goodEnv(overrides = {}) {
    return {
        DISCORD_TOKEN: 'token',
        CLIENT_ID: '123',
        CLIENT_SECRET: 'secret',
        // Credentialed: a production URI without credentials is a warning (#648).
        MONGODB_URI: 'mongodb://clawdia:pass@mongodb:27017/ultrabot?authSource=ultrabot',
        SESSION_SECRET: 'x'.repeat(SESSION_SECRET_MIN_LENGTH),
        // Set: a production deploy that stores other people's provider keys in
        // the clear is a warning (#886).
        SECRET_ENCRYPTION_KEY: 'Zm9vYmFyYmF6cXV1eGZvb2JhcmJhenF1dXhmb28=',
        DASHBOARD_URL: 'https://bot.example.com',
        NODE_ENV: 'production',
        ...overrides,
    };
}

const errorsFor = env => collectEnvProblems(env).errors;

afterEach(() => jest.restoreAllMocks());

describe('a configuration with nothing wrong with it', () => {
    test('produces no errors and no warnings', () => {
        expect(collectEnvProblems(goodEnv())).toEqual({ errors: [], warnings: [] });
    });

    test('development over http is a warning, not a refusal', () => {
        const { errors, warnings } = collectEnvProblems(goodEnv({
            NODE_ENV: 'development',
            DASHBOARD_URL: 'http://localhost:3000',
        }));
        expect(errors).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/not HTTPS/);
    });

    test('an unset DASHBOARD_URL falls back to localhost on the configured port', () => {
        const { baseUrl } = checkDashboardUrl({ DASHBOARD_PORT: '8080' });
        expect(baseUrl).toBe('http://localhost:8080');
    });
});

describe('required variables', () => {
    test.each(REQUIRED_ENV)('a missing %s is an error', key => {
        const env = goodEnv();
        delete env[key];
        expect(errorsFor(env).join('\n')).toContain(key);
    });

    // A validator that stops at the first problem turns a misconfigured deploy
    // into one round trip per missing variable.
    test('every missing variable is named at once, in one message', () => {
        const env = goodEnv();
        delete env.DISCORD_TOKEN;
        delete env.CLIENT_SECRET;

        const missing = errorsFor(env).filter(e => e.startsWith('Missing required'));
        expect(missing).toHaveLength(1);
        expect(missing[0]).toContain('DISCORD_TOKEN');
        expect(missing[0]).toContain('CLIENT_SECRET');
    });

    // "SESSION_SECRET is not set" and "SESSION_SECRET must be 32 characters"
    // are the same fault; reporting both reads like two.
    test('an unset SESSION_SECRET is reported once, not also as too short', () => {
        const env = goodEnv();
        delete env.SESSION_SECRET;
        const errors = errorsFor(env);
        expect(errors.filter(e => e.includes('SESSION_SECRET'))).toEqual([
            'Missing required environment variables: SESSION_SECRET',
        ]);
    });
});

describe('SESSION_SECRET strength', () => {
    test('a secret one character short is rejected', () => {
        const short = 'x'.repeat(SESSION_SECRET_MIN_LENGTH - 1);
        expect(checkSessionSecret({ SESSION_SECRET: short })).toHaveLength(1);
        expect(checkSessionSecret({ SESSION_SECRET: short })[0]).toMatch(/at least 32 characters/);
    });

    test('a secret at exactly the floor is accepted', () => {
        expect(checkSessionSecret({ SESSION_SECRET: 'x'.repeat(SESSION_SECRET_MIN_LENGTH) })).toEqual([]);
    });

    test('the rule reaches collectEnvProblems too', () => {
        expect(errorsFor(goodEnv({ SESSION_SECRET: 'too-short' })).join('\n'))
            .toMatch(/SESSION_SECRET must be at least/);
    });
});

// #886. Without SECRET_ENCRYPTION_KEY the per-guild AI provider keys and the
// MCP OAuth refresh tokens are plaintext in the database, and the nightly backup
// keeps a month of unencrypted dumps of it — so the credentials someone else's
// server entered are readable by anyone who can list ./backups.
describe('SECRET_ENCRYPTION_KEY', () => {
    test('an unset key warns in production, naming what is exposed', () => {
        const [warning] = checkSecretEncryption({ NODE_ENV: 'production' });
        expect(warning).toMatch(/SECRET_ENCRYPTION_KEY is not set/);
        expect(warning).toMatch(/in the database and in every nightly backup archive/);
        // And says how to fix it, both halves: the variable and the sweep that
        // seals what is already stored.
        expect(warning).toMatch(/openssl rand -base64 32/);
        expect(warning).toMatch(/secrets:encrypt/);
    });

    test('it is a warning and not a refusal', () => {
        // Encryption shipped opt-in, so failing the boot would take down every
        // deployment that has not set it — the same call the MONGODB_URI
        // credentials check makes.
        const { errors, warnings } = collectEnvProblems(goodEnv({ SECRET_ENCRYPTION_KEY: '' }));
        expect(errors).toEqual([]);
        expect(warnings.join('\n')).toMatch(/SECRET_ENCRYPTION_KEY/);
    });

    test('a key that is only whitespace counts as unset', () => {
        // config/secretBox.js trims before deriving, so " " configures nothing;
        // reading it as configured here would silence the one warning about it.
        expect(checkSecretEncryption({ NODE_ENV: 'production', SECRET_ENCRYPTION_KEY: '   ' }))
            .toHaveLength(1);
    });

    test('it stops claiming the backups when those are sealed too', () => {
        // BACKUP_ENCRYPTION_PASSPHRASE closes the archive half on its own, and
        // telling an operator who set it that their credentials are readable in
        // every backup sends them looking for an exposure they have covered.
        // The database half is what this variable is for, so it stays.
        const [warning] = checkSecretEncryption({
            NODE_ENV: 'production',
            BACKUP_ENCRYPTION_PASSPHRASE: 'a passphrase',
        });

        expect(warning).toMatch(/SECRET_ENCRYPTION_KEY is not set/);
        expect(warning).toMatch(/in the database\./);
        expect(warning).not.toMatch(/backup archive/);
    });

    test('a short passphrase is called out on its own terms', () => {
        const [warning] = checkSecretEncryption({ NODE_ENV: 'production', SECRET_ENCRYPTION_KEY: 'hunter2' });
        // It still works — scrypt stretches anything — so the message must not
        // read as "this is not encrypting", which would send an operator looking
        // for a fault that is not there.
        expect(warning).toMatch(/still works/);
        expect(warning).toMatch(/7 characters/);
    });

    test('development says nothing at all', () => {
        // A dev database holds test guilds; the warning would be noise on every
        // `npm run dev`.
        expect(checkSecretEncryption({ NODE_ENV: 'development' })).toEqual([]);
        expect(checkSecretEncryption({})).toEqual([]);
    });
});

describe('DASHBOARD_URL', () => {
    // The rule this issue was named for: it was enforced only from
    // dashboard/server.js, four steps into the boot.
    test('http in production is an error', () => {
        const errors = errorsFor(goodEnv({ DASHBOARD_URL: 'http://bot.example.com' }));
        expect(errors.join('\n')).toMatch(/must use HTTPS in production/);
    });

    test('a URL that does not parse is an error', () => {
        expect(errorsFor(goodEnv({ DASHBOARD_URL: 'not a url' })).join('\n'))
            .toMatch(/not a valid URL/);
    });

    // The callback URL is this value plus "/auth/callback", and it has to match
    // the Discord Developer Portal entry character for character.
    test('a path is an error', () => {
        expect(errorsFor(goodEnv({ DASHBOARD_URL: 'https://bot.example.com/dashboard' })).join('\n'))
            .toMatch(/no path/);
    });

    test('a bare trailing slash is not a path', () => {
        expect(errorsFor(goodEnv({ DASHBOARD_URL: 'https://bot.example.com/' }))).toEqual([]);
    });

    test('surrounding whitespace is trimmed rather than failing the parse', () => {
        expect(checkDashboardUrl({ DASHBOARD_URL: '  https://bot.example.com  ' }))
            .toMatchObject({ baseUrl: 'https://bot.example.com', errors: [] });
    });

    test('resolveDashboardUrl throws the first error with the dashboard prefix', () => {
        expect(() => resolveDashboardUrl({ DASHBOARD_URL: 'not a url' }))
            .toThrow(/^\[DASHBOARD\] DASHBOARD_URL is not a valid URL/);
    });

    test('resolveDashboardUrl returns scheme and host only', () => {
        expect(resolveDashboardUrl({ DASHBOARD_URL: 'https://bot.example.com:8443' }))
            .toBe('https://bot.example.com:8443');
    });
});

describe('the values that are read as numbers', () => {
    test('a DASHBOARD_PORT that is not a port is an error', () => {
        expect(errorsFor(goodEnv({ DASHBOARD_PORT: 'three thousand' })).join('\n'))
            .toMatch(/DASHBOARD_PORT must be a port number/);
        expect(errorsFor(goodEnv({ DASHBOARD_PORT: '70000' })).join('\n'))
            .toMatch(/DASHBOARD_PORT must be a port number/);
    });

    test('an unset or empty DASHBOARD_PORT is fine — it has a default', () => {
        expect(errorsFor(goodEnv({ DASHBOARD_PORT: '' }))).toEqual([]);
    });

    test('a MONGODB_URI with the wrong scheme is an error', () => {
        expect(errorsFor(goodEnv({ MONGODB_URI: 'postgres://localhost/db' })).join('\n'))
            .toMatch(/must start with mongodb/);
    });

    test('mongodb+srv is accepted', () => {
        expect(errorsFor(goodEnv({ MONGODB_URI: 'mongodb+srv://cluster/db' }))).toEqual([]);
    });

    // #648: auth is opt-in so existing deployments keep booting, which is why
    // this must stay a warning — an error here takes down every deploy that
    // has not migrated yet.
    test('a credential-less MONGODB_URI in production is a warning, not an error', () => {
        const { errors, warnings } = collectEnvProblems(goodEnv({
            MONGODB_URI: 'mongodb://mongodb:27017/ultrabot',
        }));
        expect(errors).toEqual([]);
        expect(warnings.join('\n')).toMatch(/no credentials/);
    });

    test('a credential-less MONGODB_URI in development warns about nothing', () => {
        const { warnings } = collectEnvProblems(goodEnv({
            MONGODB_URI: 'mongodb://localhost:27017/ultrabot',
            NODE_ENV: 'development',
            DASHBOARD_URL: 'http://localhost:3000',
        }));
        expect(warnings.join('\n')).not.toMatch(/no credentials/);
    });
});

describe('assertEnv', () => {
    test('returns true and prints nothing when the config is good', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(assertEnv({ env: goodEnv(), onFail: () => 'failed' })).toBe(true);
        expect(error).not.toHaveBeenCalled();
    });

    test('prints every error under the given label, then fails', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const env = goodEnv({ SESSION_SECRET: 'short', DASHBOARD_URL: 'http://bot.example.com' });

        const failed = jest.fn(() => 'failed');
        expect(assertEnv({ env, label: 'SHARD', onFail: failed })).toBe('failed');
        expect(failed).toHaveBeenCalledTimes(1);
        expect(failed.mock.calls[0][0]).toHaveLength(2);

        const printed = error.mock.calls.map(c => c.join(' ')).join('\n');
        expect(printed).toMatch(/\[SHARD\] SESSION_SECRET must be at least/);
        expect(printed).toMatch(/\[SHARD\] DASHBOARD_URL must use HTTPS/);
        expect(printed).toMatch(/Copy \.env\.example/);
    });

    test('warnings are printed but do not stop the boot', () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const failed = jest.fn();

        expect(assertEnv({
            env: goodEnv({ NODE_ENV: 'development', DASHBOARD_URL: 'http://localhost:3000' }),
            onFail: failed,
        })).toBe(true);
        expect(failed).not.toHaveBeenCalled();
        expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/not HTTPS/);
    });
});

// The half of #639 that is about ordering rather than rules. Asserted against
// the source, because the alternative is booting a real bot: both entry points
// exit the process, and index.js opens a gateway connection on the way.
describe('the entry points validate before they connect', () => {
    const sourceOf = file => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

    test.each(['index.js', 'shard.js'])('%s validates the environment', file => {
        expect(sourceOf(file)).toMatch(/require\('\.\/config\/validateEnv'\)\.assertEnv\(/);
    });

    // The point of the issue: this ordering is what stops a misconfigured deploy
    // migrating the database on its way to the crash it was always going to hit.
    test('index.js validates before it connects or migrates', () => {
        const source = sourceOf('index.js');
        const validate = source.indexOf("require('./config/validateEnv')");
        const connect = source.indexOf('async function connectDatabase');
        const startBot = source.indexOf('async function startBot');

        expect(validate).toBeGreaterThan(-1);
        expect(validate).toBeLessThan(connect);
        expect(validate).toBeLessThan(startBot);
    });

    // A second copy of the required-variable list is a second copy that drifts.
    test.each(['index.js', 'shard.js'])('%s no longer keeps its own copy of the rules', file => {
        expect(sourceOf(file)).not.toMatch(/REQUIRED_ENV\s*=\s*\[/);
    });

    test('the dashboard applies the shared rules rather than redefining them', () => {
        const source = sourceOf('dashboard/server.js');
        expect(source).toMatch(/require\('\.\.\/config\/validateEnv'\)/);
        expect(source).not.toMatch(/must use HTTPS in production/);
        expect(source).not.toMatch(/SESSION_SECRET\.length < 32/);
    });
});
