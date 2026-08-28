'use strict';

/**
 * Structured logging (#647).
 *
 * The bot reported for itself through 660-odd raw `console.*` calls: one flat
 * text stream, no levels, nothing to filter on, and 250 MB of retention per
 * service holding lines no tool can query. `LOG_LEVEL=warn` had nowhere to be
 * read, and an error that mattered looked exactly like a startup notice.
 *
 * This is a pino logger and, crucially, a bridge that routes the existing
 * `console.*` calls through it. Rewriting 660 call sites would have been 660
 * chances to change a message while nothing tested it; routing them instead
 * means every one of them gains a level, a timestamp, a component and JSON
 * output on the day the bridge is installed, and new code can use the logger
 * directly. `[TAG] message` — the convention every one of those lines already
 * follows — becomes the `component` field, so the tags that were only ever
 * greppable text become something a log backend can facet on.
 *
 * The bridge is installed explicitly by the entry points (src/index.js,
 * src/shard.js) and by nothing else: a test that asserts on `console.error`,
 * and `npm run deploy`, both want the real console.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { formatWithOptions } = require('util');
const pino = require('pino');

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const DEFAULT_LEVEL = 'info';

// Fields that must never reach a log backend, wherever in the object they turn
// up. The bot handles a gateway token, an OAuth client secret, a session secret
// and up to five provider keys; one `logger.error({ err }, ...)` on a failed
// axios call is otherwise enough to print an Authorization header into a stream
// with 250 MB of retention.
const REDACT_PATHS = [
    'token', '*.token', '*.*.token',
    'password', '*.password',
    'authorization', '*.authorization',
    'headers.authorization', '*.headers.authorization',
    'headers.cookie', '*.headers.cookie',
    'apiKey', '*.apiKey',
    'DISCORD_TOKEN', 'CLIENT_SECRET', 'SESSION_SECRET', 'SECRET_ENCRYPTION_KEY',
];

/**
 * Per-request / per-interaction fields that every log line inside the same
 * async chain should carry — the correlation id above all. AsyncLocalStorage
 * is what lets that happen without threading a logger argument through every
 * service signature.
 */
const store = new AsyncLocalStorage();

function currentContext() {
    return store.getStore() || null;
}

/**
 * Run `fn` with `fields` attached to every log line it produces, directly or
 * through anything it awaits. Nested calls merge rather than replace, so a
 * guild id added inside a request keeps the request id.
 */
function withContext(fields, fn) {
    const merged = { ...(currentContext() || {}), ...fields };
    return store.run(merged, fn);
}

/** Add fields to the context already in force. A no-op outside one. */
function addContext(fields) {
    const current = currentContext();
    if (!current) return false;
    Object.assign(current, fields);
    return true;
}

/**
 * @param {unknown} raw the LOG_LEVEL value, as the environment gave it.
 * @param {(msg: string) => void} [warn] where to report a value that was ignored.
 * @returns {string} a level pino accepts.
 */
function resolveLevel(raw, warn = () => {}) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value === '') return DEFAULT_LEVEL;
    if (LEVELS.includes(value)) return value;
    // Ignored rather than fatal: a typo in LOG_LEVEL should not be the reason
    // a bot will not boot, and defaulting to silent would hide that it was.
    warn(`[LOGGER] Ignoring LOG_LEVEL="${raw}": expected one of ${LEVELS.join(', ')}. Using ${DEFAULT_LEVEL}.`);
    return DEFAULT_LEVEL;
}

/**
 * @param {unknown} raw the LOG_FORMAT value.
 * @returns {'json'|'pretty'} explicit setting if it names one, else the default
 *   for this NODE_ENV.
 */
function resolveFormat(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value === 'json' || value === 'pretty') return value;
    // Production ships to a log driver, where JSON is the whole point. A
    // developer reading a terminal wants the line, not the envelope.
    return process.env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

const LEVEL_COLOURS = {
    trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m',
    warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[35m',
};
const RESET = '\x1b[0m';

/**
 * The human-readable renderer.
 *
 * Deliberately written here rather than pulled in as a pino transport: a
 * transport runs on a worker thread, which means log lines can be lost when the
 * process exits — and this process exits on `uncaughtException`, which is
 * exactly the moment its last line matters most. A plain destination object is
 * synchronous and has no such window.
 */
function prettyLine(record, colour = false) {
    const { level, time, msg, component, err, pid: _pid, hostname: _hostname, ...rest } = record;
    const stamp = new Date(time).toISOString().slice(11, 23);
    const tint = colour ? (LEVEL_COLOURS[level] || '') : '';
    const off = tint ? RESET : '';
    const tag = component ? ` [${component}]` : '';

    let line = `${stamp} ${tint}${String(level).toUpperCase().padEnd(5)}${off}${tag} ${msg ?? ''}`;

    const extras = Object.keys(rest);
    if (extras.length) line += ` ${JSON.stringify(rest)}`;
    if (err) line += `\n${err.stack || `${err.type || 'Error'}: ${err.message}`}`;
    return `${line}\n`;
}

/**
 * @param {'json'|'pretty'} format
 * @param {NodeJS.WritableStream} out
 * @returns {object} what pino writes to: the stream itself for JSON, or a
 *   renderer wrapping it for pretty.
 */
function createDestination(format, out) {
    if (format === 'json') return out;
    const colour = Boolean(out.isTTY) && !process.env.NO_COLOR;
    return {
        write(chunk) {
            try {
                out.write(prettyLine(JSON.parse(chunk), colour));
            } catch {
                // Not one of ours (or truncated) — pass it through rather than
                // dropping it. A logger that eats output is worse than an ugly
                // line.
                out.write(chunk);
            }
        },
    };
}

/**
 * Build a logger. The module's own `logger` is one of these over stdout; tests
 * make their own over a collector so they can assert on the records.
 *
 * @param {object} [options]
 * @param {string} [options.level] overrides LOG_LEVEL.
 * @param {string} [options.format] overrides LOG_FORMAT.
 * @param {NodeJS.WritableStream} [options.out] where lines go.
 * @param {(msg: string) => void} [options.warn] where a rejected LOG_LEVEL is reported.
 * @returns {import('pino').Logger}
 */
function createLogger({
    level = process.env.LOG_LEVEL,
    format = process.env.LOG_FORMAT,
    out = process.stdout,
    warn = msg => process.stderr.write(`${msg}\n`),
} = {}) {
    return pino({
        level: resolveLevel(level, warn),
        // ISO rather than pino's default epoch millis: these lines are read by
        // people at least as often as by machines.
        timestamp: pino.stdTimeFunctions.isoTime,
        // `level: "info"` beats `level: 30` for anyone querying the stream.
        formatters: { level: label => ({ level: label }) },
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        // Whatever the current request/interaction put in scope, on every line.
        mixin: () => currentContext() || {},
    }, createDestination(resolveFormat(format), out));
}

const logger = createLogger();

// `[TAG] the rest of the message` — the convention every existing log line in
// this codebase follows. Anchored, and bounded to the shapes actually in use
// (`[READY]`, `[AI/MCP]`), so a message that merely opens with a bracket is
// left alone.
const TAG = /^\[([A-Za-z0-9 _/:.-]{1,32})\]\s*/;
// `shardTag()` in utils/sharding.js prefixes lines with this when the process
// is one of several.
const SHARD_TAG = /^\[shard (\d+)\/(\d+)\]\s*/;

/**
 * @param {unknown[]} args
 * @returns {{err: Error|null, rest: unknown[]}} the first Error, and everything
 *   else in the order it was passed.
 */
function splitArgs(args) {
    // The first Error becomes `err`, so pino serializes its stack into a field
    // instead of `util.format` flattening it into the message text. The rest is
    // formatted exactly as console would have.
    let err = null;
    const rest = [];
    for (const arg of args) {
        if (!err && arg instanceof Error) err = arg;
        else rest.push(arg);
    }
    return { err, rest };
}

// Keys whose value is a credential, whatever the object around them is called.
// Matched as a substring so `discordToken`, `X-Api-Key` and `sessionSecret` are
// all caught alongside the bare names.
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|apikey|authorization|cookie|credential/i;

// Deep enough for the shapes that actually turn up (an axios error's
// `config.headers`, a Mongo command document); past that the value is
// truncated by `formatWithOptions` anyway.
const SCRUB_DEPTH = 4;

/**
 * Replace credential-valued keys in a console argument with `[redacted]`,
 * returning a copy — the original object belongs to the caller and is very
 * often the live config or request that is about to be retried.
 *
 * pino's own `redact` covers `logger.x({ ... })` calls, but it only sees
 * structured fields, and a bridged `console.error('[X] failed', err.config)`
 * has been through `util.format` into a message string long before pino is
 * handed it. Scrubbing the argument first is what makes the two paths agree,
 * and it works at any nesting depth rather than needing a redact path
 * enumerated per shape.
 *
 * @param {unknown} value
 * @param {number} [depth] recursion budget remaining.
 * @param {WeakSet} [seen] guards the cycles that `util.format` prints as
 *   `[Circular]` and a naive walk would follow forever.
 * @returns {unknown} the value, or a scrubbed copy of it.
 */
function scrubSecrets(value, depth = SCRUB_DEPTH, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object' || depth <= 0) return value;
    // An Error's own enumerable properties can carry a request config; the
    // stack is handled separately, so leave the instance itself alone rather
    // than copying it into a plain object and losing that.
    if (value instanceof Error) return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) return value.map(v => scrubSecrets(v, depth - 1, seen));

    const out = {};
    for (const [key, v] of Object.entries(value)) {
        out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrubSecrets(v, depth - 1, seen);
    }
    return out;
}

/**
 * Turn a `console.*` argument list into the `(fields, message)` pair pino
 * takes. Exported so tests can pin the parsing without capturing output.
 *
 * @param {unknown[]} args exactly what was passed to `console.*`.
 * @returns {{fields: object, msg: string}}
 */
function toRecord(args) {
    const { err, rest } = splitArgs(args);
    // The format string itself is never an object, so scrubbing the whole list
    // cannot disturb the specifiers in it.
    const safe = rest.map(arg => scrubSecrets(arg));
    let msg = safe.length ? formatWithOptions({ colors: false, depth: 4 }, ...safe) : '';

    let shard;
    const shardMatch = SHARD_TAG.exec(msg);
    if (shardMatch) {
        shard = Number(shardMatch[1]);
        msg = msg.slice(shardMatch[0].length);
    }

    let component;
    const match = TAG.exec(msg);
    if (match) {
        component = match[1];
        msg = msg.slice(match[0].length);
    }

    if (!msg && err) msg = err.message;

    const fields = {};
    if (component) fields.component = component;
    if (shard !== undefined) fields.shard = shard;
    if (err) fields.err = err;
    return { fields, msg };
}

/**
 * Point `console.log/info/warn/error/debug` at the logger.
 *
 * Returns a function that puts the originals back, which is what tests use.
 * Idempotent: installing twice does not stack two bridges, and the restore
 * still returns the real console.
 */
/**
 * @param {object} [options]
 * @param {object} [options.target] the console to replace; defaults to the real one.
 * @param {import('pino').Logger} [options.log] where the calls are routed.
 * @returns {() => void} restores the original methods.
 */
function installConsoleBridge({ target = console, log = logger } = {}) {
    if (target.__clawdiaConsoleBridge) return target.__clawdiaConsoleBridge;

    const original = {};
    const map = { log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error' };

    for (const [method, level] of Object.entries(map)) {
        original[method] = target[method];
        target[method] = (...args) => {
            const { fields, msg } = toRecord(args);
            log[level](fields, msg);
        };
    }

    const restore = () => {
        for (const [method, fn] of Object.entries(original)) target[method] = fn;
        delete target.__clawdiaConsoleBridge;
    };
    Object.defineProperty(target, '__clawdiaConsoleBridge', {
        value: restore, configurable: true, enumerable: false, writable: false,
    });
    return restore;
}

module.exports = {
    logger,
    createLogger,
    installConsoleBridge,
    withContext,
    addContext,
    currentContext,
    // Exported for the tests that pin the parsing, the rendering and the
    // environment handling.
    toRecord,
    scrubSecrets,
    prettyLine,
    resolveLevel,
    resolveFormat,
    LEVELS,
    REDACT_PATHS,
};
