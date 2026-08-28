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

function timeoutMs() {
    const raw = Number(process.env.ERROR_REPORT_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Whether anything is configured. Callers use this to decide to wait at all. */
function isConfigured() {
    return Boolean(String(process.env.ERROR_WEBHOOK_URL || '').trim());
}

function describe(error) {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack || null };
    }
    // An unhandled rejection can carry anything at all, including a string or
    // undefined; `String(undefined)` is more use than an empty object.
    return { name: typeof error, message: String(error), stack: null };
}

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
    const url = String(process.env.ERROR_WEBHOOK_URL || '').trim();
    if (!url) return false;

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
            body: JSON.stringify(buildBody(url, event)),
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

module.exports = { reportError, reportAndExit, isConfigured, describe, buildBody };
