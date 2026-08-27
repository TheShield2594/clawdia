const fs = require('fs');

// Secrets delivered as plain environment variables are readable by anyone who
// can reach the Docker API — `docker inspect clawdia` prints the bot token and
// every provider key in full, and the Portainer UI shows the same values in the
// container detail view to anyone with read access to the stack. Neither
// requires a shell in the container.
//
// The fix is the convention Docker's own images use: put the secret in a file
// (a docker secret is mounted at /run/secrets/<name>) and point the config at
// the *path* instead of the value. `docker inspect` then shows the path, which
// is not sensitive. This module is the loader for that: for each secret below,
// `<NAME>_FILE` names a file whose contents become `<NAME>`, so nothing
// downstream has to know where the value came from.

/**
 * The variables that carry a secret and therefore support `<NAME>_FILE`.
 *
 * Deliberately an explicit list rather than a scan for anything ending in
 * `_FILE`: `_FILE` is also the ordinary suffix for "path to a file" variables,
 * and a host that exports `SSL_CERT_FILE` or `NIX_SSL_CERT_FILE` — most Linux
 * CI images do — would otherwise have its CA bundle slurped into an
 * environment variable, and an unreadable one would abort startup over
 * something the bot never reads.
 *
 * A new provider key belongs here the moment it is added.
 */
const FILE_BACKED_SECRETS = [
    'DISCORD_TOKEN',
    'CLIENT_SECRET',
    'SESSION_SECRET',
    'MONGODB_URI',        // carries the database credentials
    'SECRET_ENCRYPTION_KEY', // opens every provider key stored in the database
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'IMGFLIP_USERNAME',
    'IMGFLIP_PASSWORD',
];

/**
 * Reads one secret file.
 *
 * Trailing whitespace is stripped: `echo "$TOKEN" > /run/secrets/token` leaves
 * a newline, and a Discord token with a newline on the end fails to
 * authenticate with an error that says nothing about whitespace. Leading
 * whitespace is left alone — it cannot come from that mistake, and a
 * passphrase is entitled to start with a space.
 */
function readSecretFile(filePath) {
    return fs.readFileSync(filePath, 'utf8').replace(/\s+$/, '');
}

/**
 * Resolves the `<NAME>_FILE` form of each supported secret into `<NAME>`.
 *
 * Precedence: an explicitly set `<NAME>` wins over `<NAME>_FILE`. That way a
 * one-off `docker run -e DISCORD_TOKEN=…` still overrides a stack that mounts
 * the secret, and the ambiguity is reported rather than resolved silently.
 *
 * An unreadable or empty secret file is fatal. The alternative — carrying on
 * with the variable unset — turns a mount typo into "the AI features stopped
 * working" hours later, instead of a startup error naming the file.
 *
 * @returns {string[]} the names resolved, for logging.
 */
function loadFileSecrets(env = process.env, { log = console, names = FILE_BACKED_SECRETS } = {}) {
    const resolved = [];

    for (const name of names) {
        const key = `${name}_FILE`;
        const filePath = env[key];
        if (!filePath) continue;

        if (env[name] !== undefined && env[name] !== '') {
            log.warn?.(`[SECRETS] Both ${name} and ${key} are set; using ${name} and ignoring the file.`);
            continue;
        }

        let value;
        try {
            value = readSecretFile(filePath);
        } catch (err) {
            throw new Error(`[SECRETS] Cannot read ${key} (${filePath}): ${err.message}`, { cause: err });
        }

        if (!value) {
            throw new Error(`[SECRETS] ${key} (${filePath}) is empty — ${name} would be blank.`);
        }

        env[name] = value;
        resolved.push(name);
    }

    if (resolved.length) {
        // The names only — never the values.
        log.log?.(`[SECRETS] Loaded from file: ${resolved.join(', ')}`);
    }
    return resolved;
}

module.exports = { loadFileSecrets, readSecretFile, FILE_BACKED_SECRETS };
