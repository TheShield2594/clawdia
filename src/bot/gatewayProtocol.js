'use strict';

// The wire contract between the dashboard and the gateway (#876).
//
// src/bot/gateway.js already made every method id-in / plain-data-out, which is
// the property that lets the dashboard run somewhere the Discord client is not.
// What was missing is the wire: a list of what may cross it, and one shape for
// a call and its answer. Both live here, so the process that serves the facade
// and the process that consumes it cannot drift — a method added to one side
// and not the other fails a test rather than a request.
//
// Everything below is JSON. No discord.js object, no Buffer, no Date instance
// crosses the boundary; `listActiveTimeouts` already returns ISO strings for
// exactly this reason.

/**
 * Every method the facade exposes, in one list.
 *
 * `createBotGateway` is checked against this, so the local implementation
 * cannot gain a method the remote one does not forward, or lose one the routes
 * still call.
 */
const GATEWAY_METHODS = Object.freeze([
    'hasGuild',
    'hasGuilds',
    'canManageGuild',
    'getGuild',
    'reach',
    'listChannels',
    'listRoles',
    'hasChannel',
    'sendEmbed',
    'addReactions',
    'deleteMessage',
    'searchMembers',
    'resolveUsers',
    'listBans',
    'listActiveTimeouts',
    'unban',
    'clearTimeout',
    'sendDailyNews',
    'rescheduleBibleVerse',
]);

const GATEWAY_METHOD_SET = new Set(GATEWAY_METHODS);

/** Where the RPC server mounts. */
const RPC_PATH = '/__bot';

/** Liveness, unauthenticated, so a container healthcheck can reach it. */
const HEALTH_PATH = '/health';

/**
 * A call, encoded.
 *
 * `args` is positional because the facade's methods are, and naming them here
 * would be a second signature to keep in step with the first.
 */
function encodeCall(method, args) {
    return JSON.stringify({ method, args: args ?? [] });
}

/**
 * A refusal, encoded.
 *
 * The facade's contract distinguishes "we do not have that guild" (a null
 * return) from "Discord would not let us do that" (a throw), and routes act on
 * the difference. So a throw has to survive the wire as a throw, carrying the
 * two fields anything downstream reads: the message, and Discord's numeric
 * `code` — 10007 Unknown Member and friends.
 */
function encodeError(err) {
    return {
        message: err?.message ? String(err.message) : 'The bot process refused the call.',
        code: Number.isInteger(err?.code) ? err.code : undefined,
        name: typeof err?.name === 'string' ? err.name : 'Error',
    };
}

/** Rebuilds the thrown error on the calling side. */
function decodeError(payload) {
    const err = new Error(payload?.message || 'The bot process refused the call.');
    if (payload?.name) err.name = payload.name;
    if (Number.isInteger(payload?.code)) err.code = payload.code;
    // So a caller can tell a Discord refusal from the transport giving up.
    err.remote = true;
    return err;
}

module.exports = {
    GATEWAY_METHODS,
    GATEWAY_METHOD_SET,
    RPC_PATH,
    HEALTH_PATH,
    encodeCall,
    encodeError,
    decodeError,
};
