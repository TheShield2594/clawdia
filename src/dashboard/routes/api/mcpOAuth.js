'use strict';

/**
 * The dashboard half of MCP OAuth (#796).
 *
 * Three routes, and the middle one is the awkward one:
 *
 *   POST  /guild/:guildId/mcp-servers/:name/oauth/start   discovery + the URL
 *                                                         to send the admin to
 *   GET   /mcp/oauth/callback                             the redirect back
 *   DELETE /guild/:guildId/mcp-servers/:name/oauth        forget the grant
 *
 * ── Why the callback is not under /guild/:guildId ─────────────────────────
 * The redirect URI is registered with the authorization server, sometimes at
 * registration time and sometimes by an admin pasting it into a form, and it
 * has to be one fixed string. A path carrying the guild id would be a different
 * URI per guild, which several servers will not accept and which would make an
 * operator register one per guild by hand. So it is one path, and the guild it
 * belongs to comes from the `state` — which is looked up in a collection this
 * dashboard wrote, so it cannot be chosen by whoever opens the URL.
 *
 * ── What guards the callback ──────────────────────────────────────────────
 * It is a GET a browser is redirected to from somebody else's site, so it can
 * carry neither an Origin the CSRF check would accept nor a body. What stands
 * in for that:
 *
 *   - The `state` is 32 random bytes this process generated and stored. A
 *     callback with a state nobody issued finds no document and stops there,
 *     which is exactly what the parameter is for.
 *   - The flow document is deleted before the code is exchanged, so a replayed
 *     callback — the admin refreshing the tab, a link someone kept — finds
 *     nothing rather than spending the code a second time.
 *   - The flow records who started it and which guild it is for, so the grant
 *     lands on the connection the admin was actually looking at and nowhere
 *     else. The session is not consulted at all: a login can expire while the
 *     admin is on the consent screen, and the flow's own record is a better
 *     statement of intent than whoever happens to hold the cookie on return.
 *   - It is still behind `checkAuth`, so an anonymous request cannot even reach
 *     the lookup. That is the same `checkAuth` every other route in the API
 *     mounts first, which `tests/dashboardAuthEnforcement.test.js` enforces
 *     across the whole directory — so a session that expires while the admin is
 *     on the consent screen gets the API's ordinary JSON 401 rather than a page,
 *     and the admin logs in and clicks Connect again. A local variant that
 *     rendered something friendlier would be the one route in the API whose
 *     first handler is not the shared one, and a uniform guard is worth more
 *     than a better error on a ten-minute window.
 */

const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const McpOAuthState = require('../../../models/McpOAuthState');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { logAuditEvent } = require('../../lib/apiHelpers');
const { resolveMcpServers, guildServersAllowed } = require('../../../config/mcpServers');
const { inspectServer } = require('../../../services/ai/mcp/inspect');
const { resetMcpCache } = require('../../../services/ai/mcp/connections');
const {
    discover, registerClient, createPkce, createState, authorizationUrl,
    exchangeCode, resourceMetadataUrl, FLOW_TTL_MS, OAuthError,
} = require('../../../services/ai/mcp/oauth');
const { saveGrant, clearGrant, readGrant } = require('../../../services/ai/mcp/oauthStore');

const CALLBACK_PATH = '/mcp/oauth/callback';

/** The one redirect URI every flow uses. See the note above on why it is fixed. */
function redirectUriFor() {
    const base = process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`;
    return `${base.replace(/\/+$/, '')}/api${CALLBACK_PATH}`;
}

/**
 * A page for the browser that came back from the consent screen.
 *
 * Plain HTML rather than JSON because a redirect lands in a tab a person is
 * looking at, and it is served with no scripting and nothing interpolated
 * except the one message — every value that reaches it is escaped, since some
 * of it (an `error_description`) is written by the authorization server.
 */
function closingPage(res, { ok, title, detail }) {
    const escape = text => String(text).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    res.status(ok ? 200 : 400).type('html').send(
        '<!doctype html><meta charset="utf-8">'
        + '<title>MCP authorization</title>'
        + '<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem}'
        + 'h1{font-size:1.3rem}p{color:#444}</style>'
        + `<h1>${ok ? '✅ ' : '⚠️ '}${escape(title)}</h1>`
        + `<p>${escape(detail)}</p>`
        + '<p>You can close this tab and go back to the dashboard.</p>',
    );
}

/** The stored server subdocument, or null. */
async function storedServer(guildId, name) {
    const doc = await Guild.findOne(
        { guildId, 'ai.mcpServers.name': name },
        { 'ai.mcpServers.$': 1 },
    ).lean();
    return doc?.ai?.mcpServers?.[0] ?? null;
}

/**
 * Start a flow: find out where the server's authorization lives, register as a
 * client, and hand back the URL to open.
 *
 * Discovery starts from a real request to the server, because that is where the
 * `WWW-Authenticate` challenge comes from and the challenge is the only thing
 * that reliably names the resource metadata. A server that answers the request
 * happily needs no login at all, and saying so is more useful than sending an
 * admin through a flow for a connection that already works.
 */
async function startFlow(req, res) {
    const { guildId } = req.params;
    const name = String(req.params.name || '').trim();

    if (!guildServersAllowed()) {
        return res.status(403).json({ error: 'Dashboard-managed MCP servers are disabled by the bot operator' });
    }

    try {
        const stored = await storedServer(guildId, name);
        if (!stored) return res.status(404).json({ error: 'No MCP server with that name' });

        const resolved = resolveMcpServers([{ ...stored, enabled: true }]).find(s => s.name === name);
        if (!resolved) return res.status(400).json({ error: 'Stored server is not valid — re-save it' });

        // What the server says when asked. A 401 carrying a Bearer challenge
        // is the flow's starting gun; anything else means OAuth is not what
        // this connection is missing.
        const probe = await inspectServer(resolved, { confirmMode: 'off' });
        if (probe.success) {
            return res.status(400).json({
                error: 'This server already answers without a login — there is nothing to authorize.',
            });
        }
        if (!probe.needsOAuth) {
            return res.status(400).json({
                error: `This server did not ask for an OAuth login: ${probe.message}`,
            });
        }

        const discovery = await discover(resolved.connection.url, {
            resourceMetadata: resourceMetadataUrl(probe.wwwAuthenticate),
        });

        const redirectUri = redirectUriFor();
        const scope = discovery.scopesSupported.length ? discovery.scopesSupported.join(' ') : null;

        if (!discovery.registrationEndpoint) {
            return res.status(400).json({
                error: 'This server does not support dynamic client registration, so it needs a client id '
                    + 'issued by hand. Register a client with it using this redirect URI and paste the '
                    + 'credentials into the server\'s token field instead.',
                redirectUri,
            });
        }

        const client = await registerClient(discovery.registrationEndpoint, {
            redirectUri,
            clientName: `Clawdia (${name})`,
            scope,
        });

        const pkce = createPkce();
        const state = createState();

        await McpOAuthState.create({
            _id: state,
            guildId,
            server: name,
            verifier: pkce.verifier,
            redirectUri,
            discovery,
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            startedBy: req.user?.id || null,
            expiresAt: new Date(Date.now() + FLOW_TTL_MS),
        });

        await logAuditEvent(req, guildId, 'mcp_oauth_start', { name, issuer: discovery.issuer });

        res.json({
            success: true,
            // Opened by the panel rather than redirected to here: this is an
            // XHR, and a 302 in an XHR is followed by fetch rather than by
            // the tab the admin is looking at.
            authorizationUrl: authorizationUrl(discovery, {
                clientId: client.clientId,
                redirectUri,
                state,
                challenge: pkce.challenge,
                scope,
            }),
            issuer: discovery.issuer,
            scope,
            expiresInMs: FLOW_TTL_MS,
        });
} catch (error) {
    const known = error instanceof OAuthError;
    if (!known) console.error('MCP OAuth start error:', error?.message || error);
    res.status(known ? 400 : 500).json({
        error: known ? error.message : 'Internal server error',
    });
}
}

async function handleCallback(req, res) {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';

    // The authorization server refusing, which is a normal outcome — the admin
    // clicked Deny, or the consent expired. Reported before the state lookup so
    // the message says what happened rather than "unknown flow".
    if (typeof req.query.error === 'string' && req.query.error) {
        const detail = typeof req.query.error_description === 'string'
            ? req.query.error_description
            : req.query.error;
        return closingPage(res, {
            ok: false,
            title: 'The server did not authorize the connection',
            detail,
        });
    }

    if (!state || !code) {
        return closingPage(res, {
            ok: false,
            title: 'Incomplete callback',
            detail: 'The authorization server sent no code or no state, so nothing was connected.',
        });
    }

    // Read and delete in one operation, so a callback that arrives twice — a
    // refreshed tab, a kept link — finds nothing the second time and cannot
    // spend the code again.
    let flow;
    try {
        flow = await McpOAuthState.findByIdAndDelete(state).lean();
    } catch (error) {
        console.error('MCP OAuth callback lookup error:', error?.message || error);
        return closingPage(res, { ok: false, title: 'Something went wrong', detail: 'Try connecting again.' });
    }

    if (!flow) {
        return closingPage(res, {
            ok: false,
            title: 'This authorization has already been used, or has expired',
            detail: 'Start the connection again from the dashboard.',
        });
    }

    try {
        const tokens = await exchangeCode(flow.discovery, {
            code,
            redirectUri: flow.redirectUri,
            verifier: flow.verifier,
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
        });

        const saved = await saveGrant(flow.guildId, flow.server, {
            issuer:                flow.discovery.issuer,
            authorizationEndpoint: flow.discovery.authorizationEndpoint,
            tokenEndpoint:         flow.discovery.tokenEndpoint,
            resource:              flow.discovery.resource,
            clientId:              flow.clientId,
            clientSecret:          flow.clientSecret,
            accessToken:           tokens.accessToken,
            refreshToken:          tokens.refreshToken,
            expiresAt:             tokens.expiresAt,
            scope:                 tokens.scope,
            connectedBy:           flow.startedBy,
            connectedAt:           new Date(),
        });

        if (!saved) {
            return closingPage(res, {
                ok: false,
                title: 'That connection is gone',
                detail: 'It was removed while you were authorizing, so the login was not stored.',
            });
        }

        // The pooled client for this connection was built when there was no
        // grant, so it is holding no token and its cached tool list is whatever
        // an unauthenticated server answered. Dropping the cache is what makes
        // the connection work on the next message rather than the next hour.
        resetMcpCache();

        // The admin who *started* the flow, not whoever holds the session on
        // return — those are the same person in every ordinary case, and the
        // flow's own record is the better statement of intent when they are not.
        // `ip` and `get` come from the real request because `logAuditEvent`
        // reads both off it, and a plain `{ user }` would throw inside the
        // helper's own try/catch and lose the record silently.
        await logAuditEvent(
            { user: { id: flow.startedBy }, ip: req.ip, get: name => req.get(name) },
            flow.guildId,
            'mcp_oauth_connect',
            { name: flow.server, issuer: flow.discovery.issuer, scope: tokens.scope || null },
        );

        return closingPage(res, {
            ok: true,
            title: `Connected "${flow.server}"`,
            detail: 'The bot can now reach this server. Run Test from the dashboard to see its tools.',
        });
    } catch (error) {
        const known = error instanceof OAuthError;
        if (!known) console.error('MCP OAuth callback error:', error?.message || error);
        return closingPage(res, {
            ok: false,
            title: 'The login could not be completed',
            detail: known ? error.message : 'Something went wrong. Try connecting again.',
        });
    }
}

/**
 * Forget a grant. The connection stays, unauthenticated, which is what an admin
 * about to reconnect with a different account wants.
 */
async function disconnect(req, res) {
    const { guildId } = req.params;
    const name = String(req.params.name || '').trim();

    try {
        const grant = await readGrant(guildId, name);
        if (!grant) return res.status(404).json({ error: 'That server has no OAuth login stored' });

        await clearGrant(guildId, name);
        await McpOAuthState.deleteMany({ guildId, server: name });
        resetMcpCache();

        await logAuditEvent(req, guildId, 'mcp_oauth_disconnect', { name, issuer: grant.issuer });
        res.json({ success: true });
    } catch (error) {
        console.error('MCP OAuth disconnect error:', error?.message || error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Starts an OAuth login for one MCP server and returns the URL to send the admin to.
router.post('/guild/:guildId/mcp-servers/:name/oauth/start', checkAuth, checkGuildAccess, checkWriteRateLimit, startFlow);

// The redirect back from the authorization server, exchanging the code for a stored grant.
router.get('/mcp/oauth/callback', checkAuth, handleCallback);

// Forgets one MCP server's OAuth login, leaving the connection unauthenticated.
router.delete('/guild/:guildId/mcp-servers/:name/oauth', checkAuth, checkGuildAccess, checkWriteRateLimit, disconnect);

module.exports = router;
module.exports.redirectUriFor = redirectUriFor;
module.exports.CALLBACK_PATH = CALLBACK_PATH;
