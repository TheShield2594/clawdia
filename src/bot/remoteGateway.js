'use strict';

// The dashboard side of the process split (#876).
//
// The same facade `createBotGateway` returns, implemented by calling the bot
// process rather than a local discord.js cache. Every route already talks to
// the facade and nothing else, so this is the only file that has to know the
// dashboard is somewhere the gateway is not.
//
// The shape is generated from src/bot/gatewayProtocol.js rather than written
// out, because a hand-written forwarder is a second copy of the method list to
// forget to update — and forgetting shows up only in the split deployment,
// which is the one nobody is running while they make the change.

const {
    GATEWAY_METHODS,
    RPC_PATH,
    encodeCall,
    decodeError,
} = require('./gatewayProtocol');
const { assertImplementsProtocol } = require('./gateway');

// A facade call sits inside an HTTP request a person is waiting on, so it gets
// a budget rather than the runtime's default of none. `canManageGuild` is the
// slow one — it forces a member fetch on the far side — and Discord's own
// timeouts are well inside this.
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Builds the remote facade.
 *
 * @param {object}   options
 * @param {string}   options.url        base URL of the bot's gateway server
 * @param {string}   options.token      the shared secret, matching the server's
 * @param {number}   [options.timeoutMs]
 * @param {Function} [options.fetchImpl] injection seam for tests; defaults to
 *   the runtime's global fetch (Node 18+).
 */
function createRemoteBotGateway({
    url = process.env.BOT_GATEWAY_URL,
    token = process.env.BOT_GATEWAY_TOKEN,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!url) {
        throw new Error('[BOT-RPC] BOT_GATEWAY_URL is not set — the dashboard has no bot process to call.');
    }
    if (!token) {
        throw new Error('[BOT-RPC] BOT_GATEWAY_TOKEN is not set — the bot process will refuse every call.');
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('[BOT-RPC] No fetch implementation available.');
    }

    const endpoint = new URL(RPC_PATH, url).toString();

    async function call(method, args) {
        // AbortController rather than Promise.race: the point is to stop
        // holding the socket, not just to stop waiting on it.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);

        let response;
        try {
            response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: encodeCall(method, args),
                signal: abort.signal,
            });
        } catch (err) {
            // The bot process being unreachable is not the same as Discord
            // refusing, and a route that catches this must be able to tell:
            // one is "try again", the other is "you may not do that".
            throw Object.assign(
                new Error(`[BOT-RPC] ${method} could not reach the bot process: ${err?.message || err}`),
                { transport: true, cause: err },
            );
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            throw Object.assign(
                new Error(`[BOT-RPC] ${method} was refused by the bot process (HTTP ${response.status}).`),
                { transport: true, status: response.status },
            );
        }

        const payload = await response.json();
        if (payload?.ok === false) throw decodeError(payload.error);
        return payload?.value ?? null;
    }

    const gateway = {};
    for (const method of GATEWAY_METHODS) {
        gateway[method] = (...args) => call(method, args);
    }

    // The same assertion the local implementation makes, for the same reason:
    // the two sides are only interchangeable while they answer to one list.
    assertImplementsProtocol(gateway, 'createRemoteBotGateway');
    return gateway;
}

module.exports = { createRemoteBotGateway, DEFAULT_TIMEOUT_MS };
