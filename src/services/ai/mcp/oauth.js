'use strict';

/**
 * OAuth 2.1 for MCP servers (#796).
 *
 * The dashboard has one credential field and it holds a static bearer token,
 * which excludes most of the interesting hosted servers — Linear, Notion,
 * Atlassian, Sentry — and is why the Gmail and Spotify presets ship with an
 * empty URL and a note telling the admin to run their own endpoint.
 *
 * What the MCP authorization spec asks a client to do, in order:
 *
 *   1. Make a request. Get a 401 carrying `WWW-Authenticate: Bearer
 *      resource_metadata="https://…"`.
 *   2. Fetch that protected-resource metadata. It names the authorization
 *      server(s) and the canonical resource identifier.
 *   3. Fetch the authorization server's own metadata (RFC 8414) for its
 *      authorize, token and registration endpoints.
 *   4. Register as a client, dynamically (RFC 7591), because nobody is going to
 *      go and create an app registration by hand for every guild.
 *   5. Send the admin through the authorization-code flow with PKCE, and
 *      exchange the code that comes back for an access and a refresh token.
 *   6. Refresh on expiry.
 *
 * This module is steps 1–6 as plain functions over HTTP, with no storage and no
 * Express in it: the dashboard route owns where the tokens go and who is
 * allowed to start a flow, and `client.js` owns when a token is used. Keeping
 * them apart is what makes the flow testable without either.
 *
 * ── Where the bot is dialling ──────────────────────────────────────────────
 * Every URL here comes from a server the guild admin chose, including the ones
 * discovered rather than typed: an authorization-server metadata document is
 * that server telling the bot where to send a browser and a token request. So
 * each one goes through the same `assertPublicHttpUrl` and guarded agents as
 * the MCP endpoint itself, and each discovered URL is additionally required to
 * be https and to live on the issuer the metadata claims — a discovery document
 * that points its token endpoint at somewhere else entirely is not a service
 * this bot is going to post a client secret to.
 */

const axios = require('axios');
const crypto = require('crypto');
const { guardedAgents, assertPublicHttpUrl } = require('../../../utils/outboundGuard');
const { version: CLAWDIA_VERSION } = require('../../../../package.json');

const DISCOVERY_TIMEOUT_MS = 10000;
const TOKEN_TIMEOUT_MS = 15000;

// Metadata and token responses are small JSON documents. Anything larger is a
// server misbehaving, and it is parsed into memory either way.
const MAX_METADATA_BYTES = 256 * 1024;

// An access token is refreshed this long before it actually expires, so a call
// does not race the clock and come back 401 for the sake of two seconds.
const REFRESH_SKEW_MS = 60 * 1000;

// How long an admin has between clicking Connect and finishing the consent
// screen. Long enough to log in and read a scope list, short enough that an
// abandoned flow's PKCE verifier is not sitting in the database for a day.
const FLOW_TTL_MS = 10 * 60 * 1000;

const USER_AGENT = `Clawdia/${CLAWDIA_VERSION} (+https://github.com/TheShield2594/clawdia)`;

class OAuthError extends Error {
    constructor(message, { status = null, code = null } = {}) {
        super(message);
        this.name = 'OAuthError';
        this.status = status;
        this.code = code;
    }
}

/**
 * The `resource_metadata` URL out of a `WWW-Authenticate` header, or null.
 *
 * RFC 9728's parameter, on the challenge the MCP spec requires a protected
 * server to send. Parsed rather than regexed off the whole header because a
 * server may send several challenges and only the Bearer one carries this.
 *
 * A header with no `resource_metadata` is not a failure — the spec's fallback
 * is the well-known path on the resource itself — so this answers "did the
 * server say where" and the caller decides what to do about "no".
 */
function resourceMetadataUrl(wwwAuthenticate) {
    if (typeof wwwAuthenticate !== 'string' || !wwwAuthenticate) return null;
    const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate)
        || /resource_metadata\s*=\s*([^\s,]+)/i.exec(wwwAuthenticate);
    return match ? match[1].trim() : null;
}

/** True for the challenge that says "authenticate with OAuth", not "your token is wrong". */
function isOAuthChallenge(wwwAuthenticate) {
    return typeof wwwAuthenticate === 'string' && /^\s*bearer\b/i.test(wwwAuthenticate);
}

/**
 * A discovered URL, checked before anything is sent to it.
 *
 * `sameOriginAs` is the issuer the document claims to be. A metadata document
 * naming a token endpoint on another origin is either a misconfiguration or
 * somebody redirecting a client secret somewhere; either way it is not
 * followed. The MCP spec and RFC 8414 both have these endpoints on the
 * authorization server's own origin, so nothing legitimate is excluded.
 */
function checkedUrl(value, label, sameOriginAs = null) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new OAuthError(`${label} is missing from the server's metadata`);
    }
    const url = assertPublicHttpUrl(value.trim(), label);
    if (url.protocol !== 'https:') {
        throw new OAuthError(`${label} must be https`);
    }
    if (sameOriginAs) {
        const issuer = new URL(sameOriginAs);
        if (url.origin !== issuer.origin) {
            throw new OAuthError(`${label} is on ${url.origin}, not on the issuer ${issuer.origin} — refusing to use it`);
        }
    }
    // `URL` normalises a bare origin to a trailing slash, and an issuer is
    // compared as a string by anything that checks an `iss` claim — so the one
    // form everybody publishes is the one that gets stored.
    const normalized = url.toString();
    return url.pathname === '/' && !url.search && !url.hash
        ? normalized.replace(/\/$/, '')
        : normalized;
}

/** GET a JSON document from a URL the far side named. */
async function fetchJson(url, label) {
    let response;
    try {
        response = await axios.get(url, {
            timeout: DISCOVERY_TIMEOUT_MS,
            maxRedirects: 3,
            maxContentLength: MAX_METADATA_BYTES,
            headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
            validateStatus: () => true,
            ...guardedAgents(),
        });
    } catch (err) {
        throw new OAuthError(`could not fetch ${label}: ${err.message}`, { code: err.code || null });
    }

    if (response.status >= 400) {
        throw new OAuthError(`could not fetch ${label}: HTTP ${response.status}`, { status: response.status });
    }
    if (!response.data || typeof response.data !== 'object') {
        throw new OAuthError(`${label} did not return a JSON object`);
    }
    return response.data;
}

/**
 * The well-known paths to try for one document type, most specific first.
 *
 * RFC 8414 inserts its path *before* the issuer's own path component rather
 * than appending to it, which is the part everyone gets wrong; OpenID Connect
 * appends instead, and plenty of real servers only publish the OIDC one. So
 * both are tried, in the spec's order, and the first that answers wins.
 */
function wellKnownCandidates(issuer, suffix) {
    const url = new URL(issuer);
    const path = url.pathname.replace(/\/+$/, '');
    const candidates = [`${url.origin}/.well-known/${suffix}${path}`];
    if (path) candidates.push(`${url.origin}${path}/.well-known/${suffix}`);
    return candidates;
}

/** The first candidate that answers with a JSON object, or a thrown error. */
async function fetchFirst(candidates, label) {
    let last = null;
    for (const candidate of candidates) {
        try {
            return await fetchJson(candidate, label);
        } catch (err) {
            last = err;
        }
    }
    throw last ?? new OAuthError(`could not fetch ${label}`);
}

/**
 * Steps 2 and 3: what the resource says about itself, and what its
 * authorization server says about itself.
 *
 * `resourceMetadata` is where the challenge pointed, or the resource's own
 * well-known path when it did not point anywhere. A resource that publishes no
 * metadata at all is treated as its own authorization server, which is what a
 * server that has simply not implemented RFC 9728 usually is.
 *
 * Returns everything a flow needs and nothing it does not: the two endpoints,
 * the optional registration endpoint, the scopes on offer, and the canonical
 * `resource` identifier the token request has to echo.
 */
async function discover(mcpUrl, { resourceMetadata = null } = {}) {
    const endpoint = assertPublicHttpUrl(mcpUrl, 'MCP server URL');

    let resource;
    const metadataUrl = resourceMetadata
        ? checkedUrl(resourceMetadata, 'resource metadata URL')
        : null;

    try {
        resource = metadataUrl
            ? await fetchJson(metadataUrl, 'protected resource metadata')
            : await fetchFirst(
                wellKnownCandidates(endpoint.toString(), 'oauth-protected-resource'),
                'protected resource metadata',
            );
    } catch {
        // No RFC 9728 document. The server is its own authorization server,
        // which is both the spec's fallback and what most single-tenant servers
        // actually are.
        resource = null;
    }

    const issuer = resource?.authorization_servers?.[0] ?? resource?.authorization_server ?? endpoint.origin;
    const issuerUrl = checkedUrl(issuer, 'authorization server');

    const metadata = await fetchFirst(
        [
            ...wellKnownCandidates(issuerUrl, 'oauth-authorization-server'),
            ...wellKnownCandidates(issuerUrl, 'openid-configuration'),
        ],
        'authorization server metadata',
    );

    // RFC 8414 §3.3: the `issuer` in the document must be identical to the
    // issuer the well-known URI was built from. Without that check the origin
    // checks below are self-referential — a document is free to claim any
    // issuer it likes and then put its token endpoint on that same claimed
    // origin, which passes every test and sends the client secret wherever the
    // document said. Comparing it to where the document was actually looked for
    // is what makes those checks mean something.
    //
    // An omitted `issuer` is not a mismatch. Plenty of servers that have not
    // implemented RFC 9728 have not implemented that either, and the same
    // leniency is already extended to a resource with no metadata at all.
    const claimed = checkedUrl(metadata.issuer || issuerUrl, 'authorization server issuer');
    if (claimed !== issuerUrl) {
        throw new OAuthError(
            `the authorization server metadata claims to be ${claimed} but was published at ${issuerUrl} — refusing to use it`,
        );
    }

    return {
        issuer: claimed,
        authorizationEndpoint: checkedUrl(metadata.authorization_endpoint, 'authorization endpoint', claimed),
        tokenEndpoint: checkedUrl(metadata.token_endpoint, 'token endpoint', claimed),
        registrationEndpoint: metadata.registration_endpoint
            ? checkedUrl(metadata.registration_endpoint, 'registration endpoint', claimed)
            : null,
        // The canonical identifier the resource wants echoed in token requests
        // (RFC 8707). Without one the token is not audience-bound, which some
        // servers reject outright.
        resource: typeof resource?.resource === 'string' ? resource.resource : endpoint.toString(),
        scopesSupported: Array.isArray(resource?.scopes_supported)
            ? resource.scopes_supported.filter(s => typeof s === 'string')
            : (Array.isArray(metadata.scopes_supported)
                ? metadata.scopes_supported.filter(s => typeof s === 'string')
                : []),
    };
}

/**
 * Step 4: register as a client with the authorization server (RFC 7591).
 *
 * Dynamic because the alternative is an admin creating an app registration by
 * hand, per service, per guild — which is the bar this whole issue exists to
 * lower. A server with no registration endpoint has to be given a client id
 * that was issued out of band, and the caller says so rather than this
 * inventing one.
 */
async function registerClient(registrationEndpoint, { redirectUri, clientName = 'Clawdia', scope = null }) {
    const body = {
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // Public clients cannot keep a secret in a browser; this one is a
        // server-side bot, so a secret is kept if the server issues one and the
        // flow works either way (`none` is what a server that issues no secret
        // will answer with).
        token_endpoint_auth_method: 'client_secret_post',
        ...(scope ? { scope } : {}),
    };

    let response;
    try {
        response = await axios.post(registrationEndpoint, body, {
            timeout: TOKEN_TIMEOUT_MS,
            maxRedirects: 0,
            maxContentLength: MAX_METADATA_BYTES,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
            validateStatus: () => true,
            ...guardedAgents(),
        });
    } catch (err) {
        throw new OAuthError(`client registration failed: ${err.message}`, { code: err.code || null });
    }

    if (response.status >= 400) {
        // `typeof null === 'object'`, so the null check is load-bearing: a
        // refusal with an empty body would otherwise throw a TypeError here and
        // lose the status the admin needs. Same shape as `postToken` below.
        const detail = response.data && typeof response.data === 'object'
            ? (response.data.error_description || response.data.error || '')
            : String(response.data || '').slice(0, 200);
        throw new OAuthError(
            `client registration was refused (HTTP ${response.status}${detail ? `: ${detail}` : ''})`,
            { status: response.status },
        );
    }

    const clientId = response.data?.client_id;
    if (typeof clientId !== 'string' || !clientId) {
        throw new OAuthError('client registration returned no client_id');
    }

    return {
        clientId,
        clientSecret: typeof response.data.client_secret === 'string' ? response.data.client_secret : null,
        tokenEndpointAuthMethod: typeof response.data.token_endpoint_auth_method === 'string'
            ? response.data.token_endpoint_auth_method
            : (response.data.client_secret ? 'client_secret_post' : 'none'),
    };
}

/**
 * PKCE (RFC 7636), S256 only.
 *
 * `plain` is still in the RFC and is not offered here: it makes the challenge
 * equal to the verifier, so anything that could intercept the redirect could
 * replay it, which is the attack PKCE exists to stop. Every authorization
 * server that supports PKCE at all supports S256.
 */
function createPkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    return {
        verifier,
        challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        method: 'S256',
    };
}

/** An unguessable value for the `state` parameter, which is also the flow's id. */
function createState() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * Step 5a: where to send the admin's browser.
 *
 * `resource` is RFC 8707's audience binding, sent on the authorization request
 * as well as the token request because the MCP spec asks for both — a server
 * that ignores it is unaffected, and one that enforces it refuses a token that
 * did not ask for the right audience.
 */
function authorizationUrl(discovery, { clientId, redirectUri, state, challenge, scope = null }) {
    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (discovery.resource) url.searchParams.set('resource', discovery.resource);
    if (scope) url.searchParams.set('scope', scope);
    return url.toString();
}

/** POST to the token endpoint, shared by the exchange and the refresh. */
async function postToken(tokenEndpoint, params, { clientId, clientSecret }) {
    const body = new URLSearchParams({ ...params, client_id: clientId });
    if (clientSecret) body.set('client_secret', clientSecret);

    let response;
    try {
        response = await axios.post(tokenEndpoint, body.toString(), {
            timeout: TOKEN_TIMEOUT_MS,
            maxRedirects: 0,
            maxContentLength: MAX_METADATA_BYTES,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
                'User-Agent': USER_AGENT,
            },
            validateStatus: () => true,
            ...guardedAgents(),
        });
    } catch (err) {
        throw new OAuthError(`token request failed: ${err.message}`, { code: err.code || null });
    }

    const data = response.data && typeof response.data === 'object' ? response.data : {};
    if (response.status >= 400) {
        const detail = data.error_description || data.error || `HTTP ${response.status}`;
        throw new OAuthError(`the authorization server refused the token request: ${detail}`, {
            status: response.status,
            code: typeof data.error === 'string' ? data.error : null,
        });
    }
    if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new OAuthError('the authorization server returned no access token');
    }

    const expiresIn = Number(data.expires_in);
    return {
        accessToken: data.access_token,
        // A rotating server issues a new refresh token with every use and
        // invalidates the old one; a server that does not rotate simply omits
        // it, and the caller must keep the one it already has rather than
        // storing null over it.
        refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0
            ? new Date(Date.now() + expiresIn * 1000)
            : null,
        scope: typeof data.scope === 'string' ? data.scope : null,
        tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    };
}

/** Step 5b: the authorization code, for tokens. */
function exchangeCode(discovery, { code, redirectUri, verifier, clientId, clientSecret = null }) {
    return postToken(discovery.tokenEndpoint, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        ...(discovery.resource ? { resource: discovery.resource } : {}),
    }, { clientId, clientSecret });
}

/** Step 6: a refresh token, for a new access token. */
function refreshTokens(tokenEndpoint, { refreshToken, clientId, clientSecret = null, resource = null }) {
    return postToken(tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(resource ? { resource } : {}),
    }, { clientId, clientSecret });
}

/** Whether a stored access token is close enough to expiry to be worth refreshing. */
function needsRefresh(expiresAt, now = Date.now()) {
    if (!expiresAt) return false;
    const at = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
    return Number.isFinite(at) && at - REFRESH_SKEW_MS <= now;
}

module.exports = {
    OAuthError,
    resourceMetadataUrl,
    isOAuthChallenge,
    discover,
    registerClient,
    createPkce,
    createState,
    authorizationUrl,
    exchangeCode,
    refreshTokens,
    needsRefresh,
    wellKnownCandidates,
    checkedUrl,
    FLOW_TTL_MS,
    REFRESH_SKEW_MS,
};
