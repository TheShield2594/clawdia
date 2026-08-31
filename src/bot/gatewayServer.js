'use strict';

// The bot side of the process split (#876).
//
// One HTTP listener whose only job is to answer gateway-facade calls for a
// dashboard running somewhere else. It is deliberately not the dashboard's
// Express app: this is the process that holds the Discord connection, and the
// whole point of the split is that nothing expensive or user-facing runs here.
// So it is `http.createServer` with no framework, no views, no sessions, two
// routes, and a body cap — the smallest thing that can serve the facade.
//
// ── Why HTTP and not IPC ────────────────────────────────────────────────────
//
// discord.js's `ShardingManager` IPC only reaches processes it spawned, which
// makes it a way to talk to another shard, not to another container. #876 asks
// for the dashboard to be its own container, so the transport has to survive a
// network. HTTP over the compose-internal network is that, it needs no new
// dependency, and it is the one protocol every deployment already runs.
//
// ── Trust ───────────────────────────────────────────────────────────────────
//
// This endpoint can ban, unban, delete messages and post embeds in every guild
// the bot is in. It is therefore never published to the host: it binds the
// internal network only, and every call carries a shared secret compared in
// constant time. The secret is required — there is no unauthenticated mode to
// leave switched on by accident.

const http = require('http');
const crypto = require('crypto');

const {
    GATEWAY_METHOD_SET,
    RPC_PATH,
    HEALTH_PATH,
    encodeError,
} = require('./gatewayProtocol');

// A call is a method name and a few ids. Anything larger is a mistake or an
// attack, and reading it into memory first is how a small endpoint becomes a
// denial of service.
const MAX_BODY_BYTES = 256 * 1024;

// Long enough that guessing is not a strategy. Checked at construction so a
// misconfiguration is a refusal to start rather than a weak door.
const MIN_TOKEN_LENGTH = 32;

/** Compares without leaking how much of the token matched. */
function tokenMatches(presented, expected) {
    const a = Buffer.from(String(presented ?? ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual throws on a length mismatch, which would itself be the
    // leak. Compare digests instead: same length always, same comparison.
    return crypto.timingSafeEqual(
        crypto.createHash('sha256').update(a).digest(),
        crypto.createHash('sha256').update(b).digest(),
    );
}

function bearerOf(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                // Destroying rather than just rejecting: the sender is still
                // uploading, and answering while it does leaves the socket held
                // open by a body nobody will read.
                req.destroy();
                reject(Object.assign(new Error('Request body too large'), { status: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        // Nothing here is ever a browser document, and saying so costs one line.
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

/**
 * Builds the request handler. Exported separately from `startGatewayServer` so
 * it can be driven by a test without binding a port.
 *
 * @param {object} gateway  a facade from createBotGateway
 * @param {string} token    the shared secret every call must present
 * @param {() => object} health  the payload GET /health answers with
 */
function createGatewayHandler(gateway, token, health = () => ({ status: 'ok' })) {
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
        throw new Error(
            `[BOT-RPC] BOT_GATEWAY_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. ` +
            'This endpoint can act in every guild the bot is in; it does not run without one.'
        );
    }

    return async function handle(req, res) {
        try {
            // Unauthenticated on purpose, and it says nothing an attacker wants:
            // a container healthcheck runs before any secret is in scope, and in
            // the split deployment this listener is the only thing left in the
            // bot container that speaks HTTP.
            if (req.method === 'GET' && req.url === HEALTH_PATH) {
                return send(res, 200, health());
            }

            if (req.url !== RPC_PATH) return send(res, 404, { error: 'Not found' });
            if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

            if (!tokenMatches(bearerOf(req), token)) {
                // No detail: a caller that got the token wrong learns only that.
                return send(res, 401, { error: 'Unauthorized' });
            }

            let call;
            try {
                call = JSON.parse(await readBody(req));
            } catch (err) {
                if (err?.status === 413) return send(res, 413, { error: 'Request body too large' });
                return send(res, 400, { error: 'Malformed request body' });
            }

            const { method, args } = call ?? {};
            // Checked against the protocol's own set rather than against the
            // gateway object, so a caller cannot reach `constructor`, `toString`
            // or anything else that happens to be a function on it.
            if (!GATEWAY_METHOD_SET.has(method)) {
                return send(res, 400, { error: `Unknown gateway method: ${String(method)}` });
            }
            if (args !== undefined && !Array.isArray(args)) {
                return send(res, 400, { error: 'args must be an array' });
            }

            try {
                const value = await gateway[method](...(args ?? []));
                // `undefined` is not JSON, and a method that returns nothing
                // (addReactions on a missing channel, say) must not become a
                // parse failure on the other side.
                return send(res, 200, { ok: true, value: value === undefined ? null : value });
            } catch (err) {
                // A refusal from Discord is an answer, not a server fault: the
                // facade's contract is that these throw so a route can tell them
                // from "no such guild", and that has to survive the wire.
                return send(res, 200, { ok: false, error: encodeError(err) });
            }
        } catch (err) {
            // Anything that escapes the arms above is this listener's own bug.
            // It must not take the gateway process down — that is the whole
            // reason the dashboard was split out in the first place.
            console.error('[BOT-RPC] Unhandled error while serving a call:', err);
            if (!res.headersSent) return send(res, 500, { error: 'Internal error' });
            res.destroy();
        }
    };
}

/**
 * The port the bot serves the facade on, or null when the split is off.
 *
 * Setting BOT_GATEWAY_PORT is the whole switch: it is what tells the bot to
 * serve the facade instead of a dashboard, so the decision is written down once
 * here rather than as a condition at the bootstrap site. An unusable value is
 * null rather than a throw — validateEnv has already refused to start on it,
 * and this must not be a second, different opinion.
 */
function resolveGatewayPort(env = process.env) {
    const port = Number(env.BOT_GATEWAY_PORT);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Binds the listener.
 *
 * @returns {import('http').Server}
 */
function startGatewayServer(gateway, {
    port = Number(process.env.BOT_GATEWAY_PORT) || 3001,
    host = process.env.BOT_GATEWAY_HOST || '0.0.0.0',
    token = process.env.BOT_GATEWAY_TOKEN,
    health,
} = {}) {
    const server = http.createServer(createGatewayHandler(gateway, token, health));

    // Same reasoning as the dashboard's listener: an 'error' with no listener is
    // a process-level throw, and EADDRINUSE here would drop the gateway
    // connection for every guild the bot is in.
    server.on('error', err => {
        console.error(`[BOT-RPC] Server error on port ${port}:`, err.message);
    });

    server.listen(port, host, () => {
        console.log(`[BOT-RPC] Serving the gateway facade on ${host}:${port}`);
    });

    return server;
}

/**
 * Starts the listener if the deployment asked for it, and reports whether the
 * dashboard has been split out.
 *
 * The whole policy lives here rather than at the bootstrap site because both
 * halves of it are about this server: whether it should run, and what happens
 * when it cannot. A listener that fails to bind must not stop the bot logging
 * in — the containment src/index.js already applies to the in-process
 * dashboard, for the same reason.
 *
 * @returns {boolean} true when BOT_GATEWAY_PORT is set, whether or not the
 *   listener came up. The caller uses this to decide *not* to start an
 *   in-process dashboard, and that decision must not flip on a bind failure:
 *   the operator asked for the split, a dashboard is expected elsewhere, and
 *   falling back here would bind a port they did not ask for and run the very
 *   aggregations they moved out.
 */
function serveGatewayIfConfigured(buildGateway, options = {}) {
    const port = resolveGatewayPort();
    if (port === null) return false;

    try {
        startGatewayServer(buildGateway(), { ...options, port });
    } catch (err) {
        console.error('[BOT-RPC] Failed to start. The dashboard will not be able to reach this process:', err);
    }
    return true;
}

module.exports = {
    createGatewayHandler,
    startGatewayServer,
    serveGatewayIfConfigured,
    resolveGatewayPort,
    MAX_BODY_BYTES,
    MIN_TOKEN_LENGTH,
};
