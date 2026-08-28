'use strict';

/**
 * Somewhere for a fatal error to go other than the log (#647).
 *
 * `unhandledRejection` and `uncaughtException` in src/index.js wrote a line and
 * exited. That line lands in a 250 MB rolling text stream with nothing watching
 * it, so the practical failure mode was a bot that restarted at 04:00 and an
 * operator who found out days later, from a user.
 *
 * ERROR_WEBHOOK_URL is the opt-out-by-default sink: unset — the shipped
 * default — nothing changes at all, including the timing of the exit. Set, the
 * process posts the error once, waits at most ERROR_REPORT_TIMEOUT_MS for it,
 * and exits regardless.
 *
 * A Discord webhook URL is recognised and sent Discord's payload shape, because
 * that is the sink the operator of a Discord bot already has. Anything else
 * gets a flat JSON body, which is what Sentry's or Better Stack's ingest
 * endpoints (and any 20-line receiver) want.
 */

const DEFAULT_TIMEOUT_MS = 2000;
const DISCORD_WEBHOOK = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\//;
// Discord rejects a message over 2000 characters outright, so the stack has to
// be cut somewhere; short enough to leave room for the frame around it.
const DISCORD_LIMIT = 1800;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Parse and vet the configured sink.
 *
 * The report carries a stack trace and whatever failure context the caller
 * attached, so where it goes and how it gets there both matter: over cleartext
 * it is readable on the wire, and a sink that answers 3xx could otherwise walk
 * the report to a host the operator never configured.
 *
 * https is always allowed. Plain http is allowed only to loopback, which is the
 * legitimate case — a collector sidecar on the same host — and is the one place
 * cleartext costs nothing. Anything else is refused rather than downgraded.
 *
 * @param {string} raw the ERROR_WEBHOOK_URL value.
 * @returns {URL|null} the parsed URL, or null if it must not be used.
 */
function parseSink(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
    return null;
}

// Refusing a misconfigured sink silently would leave an operator believing
// crashes were being reported. Said once per process, not once per crash.
let warnedAboutSink = false;
/**
 * @param {string} raw the rejected value, used only for its scheme.
 */
function warnOnce(raw) {
    if (warnedAboutSink) return;
    warnedAboutSink = true;
    // Deliberately does not echo the URL — it is a credential.
    console.warn(
        `[ERRORS] Ignoring ERROR_WEBHOOK_URL: expected an https:// URL (or http:// to loopback), got ${
            raw.split(':')[0] || 'an unparseable value'
        }://… — crash reports are NOT being sent.`
    );
}

/**
 * @returns {number} the wait budget for one report, in milliseconds — the
 *   ERROR_REPORT_TIMEOUT_MS override when it is a positive number, else 2000.
 */
function timeoutMs() {
    const raw = Number(process.env.ERROR_REPORT_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Whether a usable sink is configured. Callers use this to decide whether to
 * wait before exiting at all — a URL that will be refused must not buy the
 * crash path an extra two seconds.
 */
function isConfigured() {
    const raw = String(process.env.ERROR_WEBHOOK_URL || '').trim();
    return raw !== '' && parseSink(raw) !== null;
}

/**
 * Reduce a thrown value to something JSON-serializable.
 *
 * @param {unknown} error anything at all — an unhandled rejection can carry a
 *   string, or nothing.
 * @returns {{name: string, message: string, stack: string|null}}
 */
function describe(error) {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack || null };
    }
    // An unhandled rejection can carry anything at all, including a string or
    // undefined; `String(undefined)` is more use than an empty object.
    return { name: typeof error, message: String(error), stack: null };
}

/**
 * Shape the event for the sink it is going to.
 *
 * @param {string} url the destination, which is what decides the shape.
 * @param {object} event the flat crash event.
 * @returns {object} a Discord message for a Discord webhook, else `event` itself.
 */
function buildBody(url, event) {
    if (!DISCORD_WEBHOOK.test(url)) return event;
    const stack = event.error.stack || event.error.message;
    return {
        content:
            `**${event.kind}** on \`${event.service}\`${event.shard === undefined ? '' : ` (shard ${event.shard})`}\n` +
            '```\n' + String(stack).slice(0, DISCORD_LIMIT) + '\n```',
    };
}

/**
 * Report one fatal error. Never rejects and never throws: this runs on the path
 * to `process.exit`, where a failure to report must not replace the error being
 * reported.
 *
 * @returns {Promise<boolean>} whether the sink accepted it.
 */
async function reportError(kind, error, extra = {}) {
    const raw = String(process.env.ERROR_WEBHOOK_URL || '').trim();
    if (!raw) return false;

    const url = parseSink(raw);
    if (!url) {
        warnOnce(raw);
        return false;
    }

    const event = {
        kind,
        service: process.env.SERVICE_NAME || 'clawdia',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        pid: process.pid,
        error: describe(error),
        ...extra,
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildBody(url.href, event)),
            // A 3xx would otherwise carry the stack trace to whatever host the
            // Location header names. The report is not worth following one for.
            redirect: 'error',
            // Bounds the wait rather than the delivery: the exit below happens
            // either way, and a sink that is itself down is the likeliest thing
            // to be down at the same moment as the bot.
            signal: AbortSignal.timeout(timeoutMs()),
        });
        return response.ok;
    } catch {
        // Deliberately silent about the URL — it is a credential.
        return false;
    }
}

/**
 * Report, then exit, without the reporting being able to hold the process open.
 *
 * `uncaughtException` leaves the process in an undefined state, so the exit is
 * the important half and the report is best-effort around it. With no sink
 * configured the exit is synchronous, exactly as it was before this existed.
 */
function reportAndExit(kind, error, { code = 1, exit = c => process.exit(c), extra = {} } = {}) {
    if (!isConfigured()) {
        exit(code);
        return Promise.resolve(false);
    }

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        exit(code);
    };

    // The belt to the AbortSignal's braces: an exit that depends on a network
    // call completing is an exit that can fail to happen.
    const guard = setTimeout(finish, timeoutMs() + 250);
    if (typeof guard.unref === 'function') guard.unref();

    return reportError(kind, error, extra).then(
        delivered => { clearTimeout(guard); finish(); return delivered; },
        () => { clearTimeout(guard); finish(); return false; }
    );
}

module.exports = { reportError, reportAndExit, isConfigured, describe, buildBody, parseSink };
