'use strict';

/**
 * The one place that decides whether this process is configured well enough to
 * run (#639).
 *
 * There used to be two places. `src/index.js` checked that five variables were
 * present; `src/dashboard/server.js` enforced the rest — that `DASHBOARD_URL`
 * parses, carries no path, and is HTTPS in production, and that
 * `SESSION_SECRET` is at least 32 characters. The dashboard starts *after*
 * `connectDatabase()` and `runMigrations()`, so a deploy with a http://
 * DASHBOARD_URL and NODE_ENV=production would connect, migrate the database,
 * and only then throw. The crash-loop that follows is not the problem — the
 * problem is that it had already written to the database on the way there, and
 * migrations have no rollback path.
 *
 * So every rule lives here, and both entry points call `assertEnv()` before
 * they touch anything: src/index.js as its first statement after the secrets
 * are loaded, src/shard.js likewise, so a bad config is caught by the manager
 * rather than N times over by its children.
 *
 * The dashboard still applies the same rules at the point it needs their
 * answers — `resolveDashboardUrl()` below is the function it calls — but it is
 * no longer where they are *defined*, and by the time it runs they have already
 * passed. That matters for the second entry point into the dashboard,
 * `createApp()` under test: it can still be handed a bad environment directly,
 * and it still refuses.
 *
 * Everything is reported at once. A validator that stops at the first problem
 * turns a misconfigured deploy into one round trip per missing variable.
 */

// Without these there is no bot: the gateway will not connect, OAuth cannot
// complete, and there is nowhere to write. All five are also `*_FILE`-capable —
// see config/fileSecrets.js, which must run first so the values are in place.
const REQUIRED_ENV = ['DISCORD_TOKEN', 'CLIENT_ID', 'MONGODB_URI', 'SESSION_SECRET', 'CLIENT_SECRET'];

// What the split-out dashboard process needs (#876). DISCORD_TOKEN is absent on
// purpose: that process never connects to the gateway, and a container that
// cannot use the bot token should not be handed one — it is the credential with
// the widest blast radius in the deployment. CLIENT_ID and CLIENT_SECRET stay,
// because OAuth is exactly what this process does.
const DASHBOARD_REQUIRED_ENV = REQUIRED_ENV.filter(name => name !== 'DISCORD_TOKEN');

// express-session will happily sign cookies with "hunter2". The floor is the
// one openssl invocation in .env.example: `openssl rand -hex 32`.
const SESSION_SECRET_MIN_LENGTH = 32;

/** What DASHBOARD_URL falls back to when it is not set — local development. */
function defaultDashboardUrl(env) {
    return `http://localhost:${env.DASHBOARD_PORT || 3000}`;
}

/**
 * Checks DASHBOARD_URL and works out the base URL the OAuth callback hangs off.
 *
 * Returns the problems rather than throwing them, so the same code can serve
 * the startup validator (which wants all of them at once) and the dashboard
 * (which wants the value, and throws on the first).
 *
 * @returns {{ baseUrl: ?string, errors: string[], warnings: string[] }}
 */
function checkDashboardUrl(env = process.env) {
    const errors = [];
    const warnings = [];
    const raw = (env.DASHBOARD_URL || defaultDashboardUrl(env)).trim();

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        errors.push(`DASHBOARD_URL is not a valid URL: "${raw}"`);
        return { baseUrl: null, errors, warnings };
    }

    // M5: HTTPS is required in production unconditionally — localhost is not
    // exempt, because a production deployment should never be reached that way.
    if (parsed.protocol !== 'https:') {
        if (env.NODE_ENV === 'production') {
            errors.push(
                `DASHBOARD_URL must use HTTPS in production. Got: "${raw}". ` +
                'Set NODE_ENV=development for local testing.'
            );
        } else {
            warnings.push(
                `DASHBOARD_URL "${raw}" is not HTTPS. ` +
                'Discord OAuth will reject non-HTTPS redirect URIs in production.'
            );
        }
    }

    // The callback URL is built by appending "/auth/callback", and it has to
    // match what is registered in the Discord Developer Portal character for
    // character. A path here silently produces a URL that never matches.
    if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
        errors.push(
            'DASHBOARD_URL must be just a scheme + host (e.g. https://bot.example.com), ' +
            `with no path. Got: "${raw}"`
        );
    }

    return { baseUrl: `${parsed.protocol}//${parsed.host}`, errors, warnings };
}

/**
 * The dashboard's base URL, or a throw. This is the call site that wants an
 * answer rather than a report — it runs while passport is being configured, at
 * which point there is nothing useful to do with a URL that does not parse.
 */
function resolveDashboardUrl(env = process.env) {
    const { baseUrl, errors, warnings } = checkDashboardUrl(env);
    if (errors.length) throw new Error(`[DASHBOARD] ${errors[0]}`);
    for (const warning of warnings) console.warn(`[DASHBOARD] WARNING: ${warning}`);
    return baseUrl;
}

/** M1: SESSION_SECRET has to exist and be long enough to be worth having. */
function checkSessionSecret(env = process.env) {
    if (!env.SESSION_SECRET) {
        return ['SESSION_SECRET is not set. Add a strong random value to your .env file.'];
    }
    if (env.SESSION_SECRET.length < SESSION_SECRET_MIN_LENGTH) {
        return [
            `SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters. ` +
            'Generate one with: openssl rand -hex 32',
        ];
    }
    return [];
}

/**
 * Every configuration problem this process can be told about before it starts.
 *
 * @param {object} env
 * @returns {{ errors: string[], warnings: string[] }}
 */
function collectEnvProblems(env = process.env, { required = REQUIRED_ENV } = {}) {
    const errors = [];
    const warnings = [];

    const missing = required.filter(key => !env[key]);
    if (missing.length) {
        errors.push(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Only worth saying when the variable is there at all; "not set" is already
    // covered by the line above, and saying it twice reads like two faults.
    if (env.SESSION_SECRET) errors.push(...checkSessionSecret(env));

    if (env.MONGODB_URI && !/^mongodb(\+srv)?:\/\//.test(env.MONGODB_URI)) {
        errors.push(
            'MONGODB_URI must start with mongodb:// or mongodb+srv:// ' +
            `(got "${env.MONGODB_URI.split(':')[0]}:...")`
        );
    } else if (env.NODE_ENV === 'production' && env.MONGODB_URI && !env.MONGODB_URI.includes('@')) {
        // #648: MongoDB auth is opt-in so that existing deployments keep
        // booting, but a production deploy running credential-less should hear
        // about it — the internal Docker network is then the only thing
        // between any co-located container and the full database. A warning,
        // not an error: failing the boot would take down every deployment that
        // has not migrated yet.
        warnings.push(
            'MONGODB_URI has no credentials. Enable MongoDB authentication — ' +
            'see "Enabling MongoDB authentication" in docs/SETUP_GUIDE.md.'
        );
    }

    if (env.DASHBOARD_PORT !== undefined && env.DASHBOARD_PORT !== '') {
        const port = Number(env.DASHBOARD_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            errors.push(`DASHBOARD_PORT must be a port number between 1 and 65535. Got: "${env.DASHBOARD_PORT}"`);
        }
    }

    const dashboardUrl = checkDashboardUrl(env);
    errors.push(...dashboardUrl.errors);
    warnings.push(...dashboardUrl.warnings);

    errors.push(...checkGatewaySplit(env));

    return { errors, warnings };
}

/**
 * The three variables that move the dashboard into its own process (#876).
 *
 * Checked together because they are only meaningful together: a port with no
 * token is an endpoint that can act in every guild the bot is in and will not
 * start; a URL with no token is a dashboard whose every call is refused; and a
 * token alone does nothing, which is the one combination worth only a silence
 * — an operator midway through setting this up should not be blocked by having
 * written the secret first.
 */
function checkGatewaySplit(env) {
    const errors = [];
    const port = env.BOT_GATEWAY_PORT;
    const url = env.BOT_GATEWAY_URL;

    if (port !== undefined && port !== '') {
        const parsed = Number(port);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
            errors.push(`BOT_GATEWAY_PORT must be a port number between 1 and 65535. Got: "${port}"`);
        }
        if (String(parsed) === String(Number(env.DASHBOARD_PORT || 3000))) {
            errors.push(
                `BOT_GATEWAY_PORT (${port}) must differ from DASHBOARD_PORT — ` +
                'the two are served by different processes and cannot share a port.'
            );
        }
    }

    if (url) {
        try {
            new URL(url);
        } catch {
            errors.push(`BOT_GATEWAY_URL is not a valid URL: "${url}"`);
        }
    }

    if ((port || url) && !env.BOT_GATEWAY_TOKEN) {
        errors.push(
            'BOT_GATEWAY_TOKEN is not set. The gateway endpoint can ban, unban and post in ' +
            'every guild the bot is in, so it does not run without a shared secret. ' +
            'Generate one with: openssl rand -hex 32'
        );
    }

    if (env.BOT_GATEWAY_TOKEN && env.BOT_GATEWAY_TOKEN.length < SESSION_SECRET_MIN_LENGTH) {
        errors.push(
            `BOT_GATEWAY_TOKEN must be at least ${SESSION_SECRET_MIN_LENGTH} characters. ` +
            'Generate one with: openssl rand -hex 32'
        );
    }

    return errors;
}

/**
 * Validates, or exits.
 *
 * Called before `connectDatabase()`, which is the whole point: a process that
 * is going to refuse to serve should refuse before it has written anything.
 * Warnings are printed and do not stop the boot.
 *
 * @param {object}   [options]
 * @param {object}   [options.env]    environment to read, for tests
 * @param {string}   [options.label]  log prefix — 'STARTUP', 'SHARD' or 'DASHBOARD'
 * @param {string[]} [options.required] which variables must be present.
 *   Defaults to REQUIRED_ENV. The split-out dashboard passes a narrower list:
 *   it holds no gateway connection, so demanding DISCORD_TOKEN of it would put
 *   the bot's token in a container that has no use for one (#876).
 * @param {Function} [options.onFail] what to do when it fails; exits by default
 */
function assertEnv({ env = process.env, label = 'STARTUP', onFail, required } = {}) {
    const { errors, warnings } = collectEnvProblems(env, required ? { required } : undefined);

    for (const warning of warnings) console.warn(`[${label}] WARNING: ${warning}`);
    if (!errors.length) return true;

    for (const error of errors) console.error(`[${label}] ${error}`);
    console.error(`[${label}] Copy .env.example to .env and fill in all required values.`);

    if (onFail) return onFail(errors);
    process.exit(1);
    return false;
}

module.exports = {
    assertEnv,
    collectEnvProblems,
    checkDashboardUrl,
    checkSessionSecret,
    checkGatewaySplit,
    DASHBOARD_REQUIRED_ENV,
    resolveDashboardUrl,
    REQUIRED_ENV,
    SESSION_SECRET_MIN_LENGTH,
};
