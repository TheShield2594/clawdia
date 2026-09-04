'use strict';

/**
 * #796. The dashboard had one credential field and it held a static bearer
 * token, which excluded most of the interesting hosted MCP servers — Linear,
 * Notion, Atlassian, Sentry — and was why the Gmail and Spotify presets shipped
 * with an empty URL and a note telling the admin to run their own endpoint.
 *
 * This covers the protocol half: discovery from a `WWW-Authenticate` challenge,
 * dynamic client registration, PKCE, and the two token grants. The parts worth
 * pinning are the ones that are easy to get subtly wrong and impossible to
 * notice — RFC 8414's well-known path insertion, S256 rather than plain, a
 * discovery document naming a token endpoint somewhere else entirely, and a
 * refresh response that omits the refresh token because the server does not
 * rotate.
 */

jest.mock('../src/utils/outboundGuard', () => ({
    guardedDispatcher: () => undefined,
    assertPublicHttpUrl: url => new URL(url),
}));

const { jsonResponse } = require('./helpers/fetchResponse');
const {
    resourceMetadataUrl, isOAuthChallenge, discover, registerClient,
    createPkce, createState, authorizationUrl, exchangeCode, refreshTokens,
    needsRefresh, wellKnownCandidates, checkedUrl, OAuthError, REFRESH_SKEW_MS,
} = require('../src/services/ai/mcp/oauth');

const MCP_URL = 'https://mcp.example.com/mcp';
const REDIRECT = 'https://dash.example.com/api/mcp/oauth/callback';

const AS_METADATA = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    registration_endpoint: 'https://auth.example.com/register',
    scopes_supported: ['read', 'write'],
};

// A builder rather than a value: a `Response` body reads once, and the
// discovery flow makes several calls in a row.
const ok = data => () => jsonResponse(data);
const refused = (status, data) => () => jsonResponse(data, { status });

let fetchMock;
beforeEach(() => {
    jest.resetAllMocks();
    // Every unstubbed call answers 404. Discovery walks a list of well-known
    // paths and stops at the first that answers, so "nothing here" is the right
    // default — and a real request escaping to the network is not.
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(refused(404, {}));
});
afterEach(() => fetchMock.mockRestore());

describe('reading the challenge', () => {
    test('finds the resource metadata URL a quoted challenge names', () => {
        expect(resourceMetadataUrl(
            'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
        )).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
    });

    test('and an unquoted one', () => {
        expect(resourceMetadataUrl('Bearer resource_metadata=https://x.example.com/meta, realm="x"'))
            .toBe('https://x.example.com/meta');
    });

    // Not a failure. The spec's fallback is the well-known path on the resource
    // itself, so "did the server say where" is the only question here.
    test('says nothing rather than guessing when the header carries none', () => {
        expect(resourceMetadataUrl('Bearer realm="example"')).toBeNull();
        expect(resourceMetadataUrl(undefined)).toBeNull();
    });

    test('tells a Bearer challenge from any other 401', () => {
        expect(isOAuthChallenge('Bearer realm="x"')).toBe(true);
        expect(isOAuthChallenge('Basic realm="x"')).toBe(false);
        expect(isOAuthChallenge(null)).toBe(false);
    });
});

/**
 * RFC 8414 inserts its well-known segment *before* the issuer's path rather
 * than appending to it, which is the part everyone gets wrong; OpenID Connect
 * appends instead, and plenty of real servers publish only the OIDC one.
 */
describe('well-known paths', () => {
    test('puts the RFC 8414 form first, with the path after the segment', () => {
        expect(wellKnownCandidates('https://auth.example.com/tenant/1', 'oauth-authorization-server'))
            .toEqual([
                'https://auth.example.com/.well-known/oauth-authorization-server/tenant/1',
                'https://auth.example.com/tenant/1/.well-known/oauth-authorization-server',
            ]);
    });

    test('offers one path for an issuer with no path component', () => {
        expect(wellKnownCandidates('https://auth.example.com/', 'openid-configuration'))
            .toEqual(['https://auth.example.com/.well-known/openid-configuration']);
    });
});

describe('checking a URL the far side named', () => {
    test('refuses one that is not https', () => {
        expect(() => checkedUrl('http://auth.example.com/token', 'token endpoint'))
            .toThrow('must be https');
    });

    // A discovery document naming a token endpoint on another origin is either
    // a misconfiguration or somebody collecting client secrets. Both RFC 8414
    // and the MCP spec put these on the issuer's own origin, so nothing
    // legitimate is excluded.
    test('refuses one that has wandered off the issuer', () => {
        expect(() => checkedUrl('https://evil.example.com/token', 'token endpoint', 'https://auth.example.com'))
            .toThrow('refusing to use it');
    });

    test('allows a different path on the issuer', () => {
        expect(checkedUrl('https://auth.example.com/oauth/token', 'token endpoint', 'https://auth.example.com/tenant'))
            .toBe('https://auth.example.com/oauth/token');
    });

    test('says which field is missing rather than throwing a type error', () => {
        expect(() => checkedUrl(undefined, 'token endpoint')).toThrow('token endpoint is missing');
    });
});

describe('discovery', () => {
    test('follows the challenge to the resource, then to its authorization server', async () => {
        fetchMock
            .mockImplementationOnce(ok({
                resource: 'https://mcp.example.com/mcp',
                authorization_servers: ['https://auth.example.com'],
                scopes_supported: ['mcp:read'],
            }))
            .mockImplementationOnce(ok(AS_METADATA));

        const result = await discover(MCP_URL, {
            resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        });

        expect(fetchMock.mock.calls[0][0]).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
        expect(result).toMatchObject({
            issuer: 'https://auth.example.com',
            authorizationEndpoint: 'https://auth.example.com/authorize',
            tokenEndpoint: 'https://auth.example.com/token',
            registrationEndpoint: 'https://auth.example.com/register',
            // RFC 8707's audience binding, echoed on every token request so the
            // grant stays bound to this server.
            resource: 'https://mcp.example.com/mcp',
            scopesSupported: ['mcp:read'],
        });
    });

    // A server that has simply not implemented RFC 9728. Treating it as its own
    // authorization server is the spec's fallback and what most single-tenant
    // servers actually are.
    test('treats a server with no resource metadata as its own issuer', async () => {
        fetchMock
            .mockImplementationOnce(refused(404, {}))
            .mockImplementationOnce(refused(404, {}))
            .mockImplementationOnce(ok({
                issuer: 'https://mcp.example.com',
                authorization_endpoint: 'https://mcp.example.com/authorize',
                token_endpoint: 'https://mcp.example.com/token',
            }));

        const result = await discover(MCP_URL);

        expect(result.issuer).toBe('https://mcp.example.com');
        expect(result.resource).toBe(MCP_URL);
        expect(result.registrationEndpoint).toBeNull();
    });

    test('falls back to the OpenID path when the RFC 8414 one is not there', async () => {
        // No resource metadata, so the server is its own issuer — and the
        // document it publishes has to say so, per the mismatch check below.
        const selfIssued = {
            issuer: 'https://mcp.example.com',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
        };
        fetchMock
            .mockImplementationOnce(refused(404, {}))  // resource, 8414 form
            .mockImplementationOnce(refused(404, {}))  // resource, appended form
            .mockImplementationOnce(refused(404, {}))  // AS, 8414 form
            .mockImplementationOnce(ok(selfIssued));                         // AS, openid form

        await discover(MCP_URL);

        expect(fetchMock.mock.calls.at(-1)[0]).toContain('/.well-known/openid-configuration');
    });

    /**
     * RFC 8414 §3.3: the `issuer` in the document must be identical to the one
     * the well-known URI was built from. Without the check, the origin checks on
     * the endpoints are self-referential — a document can claim any issuer and
     * put its token endpoint on that same claimed origin, passing every test
     * while sending the client secret wherever it said.
     */
    test('refuses a document that claims an issuer it was not published at', async () => {
        fetchMock
            .mockImplementationOnce(ok({ authorization_servers: ['https://auth.example.com'] }))
            .mockImplementationOnce(ok({
                issuer: 'https://evil.example.com',
                authorization_endpoint: 'https://evil.example.com/authorize',
                token_endpoint: 'https://evil.example.com/token',
                registration_endpoint: 'https://evil.example.com/register',
            }));

        await expect(discover(MCP_URL, { resourceMetadata: 'https://mcp.example.com/meta' }))
            .rejects.toThrow(/claims to be https:\/\/evil\.example\.com but was published at https:\/\/auth\.example\.com/);
    });

    // Plenty of servers that have not implemented RFC 9728 have not implemented
    // this either, and the same leniency is already extended to a resource with
    // no metadata at all.
    test('accepts a document that omits the issuer entirely', async () => {
        fetchMock
            .mockImplementationOnce(ok({ authorization_servers: ['https://auth.example.com'] }))
            .mockImplementationOnce(ok({
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: 'https://auth.example.com/token',
            }));

        const result = await discover(MCP_URL, { resourceMetadata: 'https://mcp.example.com/meta' });

        expect(result.issuer).toBe('https://auth.example.com');
    });

    // The issuer is checked against what the *document* claims, not the URL it
    // was fetched from, since a redirect could have moved that.
    test('refuses a document whose token endpoint is on another origin', async () => {
        fetchMock
            .mockImplementationOnce(ok({ authorization_servers: ['https://auth.example.com'] }))
            .mockImplementationOnce(ok({ ...AS_METADATA, token_endpoint: 'https://evil.example.com/token' }));

        await expect(discover(MCP_URL, { resourceMetadata: 'https://mcp.example.com/meta' }))
            .rejects.toThrow('refusing to use it');
    });
});

describe('client registration', () => {
    test('registers for the authorization-code and refresh grants', async () => {
        fetchMock.mockImplementation(ok({ client_id: 'cid', client_secret: 'shh' }));

        const client = await registerClient(AS_METADATA.registration_endpoint, {
            redirectUri: REDIRECT, clientName: 'Clawdia (linear)', scope: 'read write',
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toMatchObject({
            client_name: 'Clawdia (linear)',
            redirect_uris: [REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            scope: 'read write',
        });
        expect(client).toEqual({ clientId: 'cid', clientSecret: 'shh', tokenEndpointAuthMethod: 'client_secret_post' });
    });

    test('works for a server that issues no secret', async () => {
        fetchMock.mockImplementation(ok({ client_id: 'cid' }));

        const client = await registerClient(AS_METADATA.registration_endpoint, { redirectUri: REDIRECT });

        expect(client.clientSecret).toBeNull();
        expect(client.tokenEndpointAuthMethod).toBe('none');
    });

    test('reports what the server said when it refuses', async () => {
        fetchMock.mockImplementation(refused(400, {
            error: 'invalid_redirect_uri', error_description: 'redirect_uri is not allowed',
        }));

        await expect(registerClient(AS_METADATA.registration_endpoint, { redirectUri: REDIRECT }))
            .rejects.toThrow('redirect_uri is not allowed');
    });

    test('a 200 with no client_id is still a failure', async () => {
        fetchMock.mockImplementation(ok({ ok: true }));
        await expect(registerClient(AS_METADATA.registration_endpoint, { redirectUri: REDIRECT }))
            .rejects.toThrow('no client_id');
    });
});

describe('PKCE', () => {
    // `plain` is still in RFC 7636 and is not offered: it makes the challenge
    // equal to the verifier, so anything that could intercept the redirect
    // could replay it — which is the attack PKCE exists to stop.
    test('is S256, and the challenge is the hash of the verifier', () => {
        const { verifier, challenge, method } = createPkce();
        const expected = require('crypto').createHash('sha256').update(verifier).digest('base64url');

        expect(method).toBe('S256');
        expect(challenge).toBe(expected);
        expect(challenge).not.toBe(verifier);
    });

    test('produces a different verifier every time', () => {
        expect(createPkce().verifier).not.toBe(createPkce().verifier);
    });

    // The state is the flow's id and its CSRF guard, so it has to be
    // unguessable rather than merely unique.
    test('the state is long and random', () => {
        const state = createState();
        expect(state.length).toBeGreaterThanOrEqual(40);
        expect(state).not.toBe(createState());
    });
});

describe('the authorization URL', () => {
    const discovery = {
        authorizationEndpoint: AS_METADATA.authorization_endpoint,
        tokenEndpoint: AS_METADATA.token_endpoint,
        resource: MCP_URL,
    };

    test('carries the code challenge, the state and the audience', () => {
        const url = new URL(authorizationUrl(discovery, {
            clientId: 'cid', redirectUri: REDIRECT, state: 'st', challenge: 'ch', scope: 'read',
        }));

        expect(Object.fromEntries(url.searchParams)).toEqual({
            response_type: 'code',
            client_id: 'cid',
            redirect_uri: REDIRECT,
            state: 'st',
            code_challenge: 'ch',
            code_challenge_method: 'S256',
            resource: MCP_URL,
            scope: 'read',
        });
    });

    test('omits the scope when the server named none', () => {
        const url = new URL(authorizationUrl(discovery, {
            clientId: 'cid', redirectUri: REDIRECT, state: 'st', challenge: 'ch',
        }));
        expect(url.searchParams.has('scope')).toBe(false);
    });
});

describe('exchanging the code', () => {
    const discovery = { tokenEndpoint: AS_METADATA.token_endpoint, resource: MCP_URL };

    test('sends the verifier, the redirect URI and the audience', async () => {
        fetchMock.mockImplementation(ok({
            access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'read', token_type: 'Bearer',
        }));

        const tokens = await exchangeCode(discovery, {
            code: 'abc', redirectUri: REDIRECT, verifier: 'ver', clientId: 'cid', clientSecret: 'shh',
        });

        const sent = Object.fromEntries(new URLSearchParams(fetchMock.mock.calls[0][1].body));
        expect(sent).toEqual({
            grant_type: 'authorization_code',
            code: 'abc',
            redirect_uri: REDIRECT,
            code_verifier: 'ver',
            resource: MCP_URL,
            client_id: 'cid',
            client_secret: 'shh',
        });
        expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', scope: 'read' });
        expect(tokens.expiresAt).toBeInstanceOf(Date);
    });

    test('leaves the expiry unset when the server gave no lifetime', async () => {
        fetchMock.mockImplementation(ok({ access_token: 'at' }));

        const tokens = await exchangeCode(discovery, {
            code: 'abc', redirectUri: REDIRECT, verifier: 'ver', clientId: 'cid',
        });

        // Which means "until it stops working" — the 401 retry covers it.
        expect(tokens.expiresAt).toBeNull();
        expect(tokens.refreshToken).toBeNull();
    });

    test('reports the authorization server\'s own error', async () => {
        fetchMock.mockImplementation(refused(400, {
            error: 'invalid_grant', error_description: 'code already used',
        }));

        await expect(exchangeCode(discovery, {
            code: 'abc', redirectUri: REDIRECT, verifier: 'ver', clientId: 'cid',
        })).rejects.toThrow('code already used');
    });

    test('a 200 with no access token is a failure, not an empty grant', async () => {
        fetchMock.mockImplementation(ok({ token_type: 'Bearer' }));

        await expect(exchangeCode(discovery, {
            code: 'abc', redirectUri: REDIRECT, verifier: 'ver', clientId: 'cid',
        })).rejects.toThrow('no access token');
    });
});

describe('refreshing', () => {
    test('sends the refresh grant with the audience', async () => {
        fetchMock.mockImplementation(ok({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }));

        const tokens = await refreshTokens(AS_METADATA.token_endpoint, {
            refreshToken: 'rt1', clientId: 'cid', clientSecret: 'shh', resource: MCP_URL,
        });

        const sent = Object.fromEntries(new URLSearchParams(fetchMock.mock.calls[0][1].body));
        expect(sent).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt1', resource: MCP_URL });
        expect(tokens.refreshToken).toBe('rt2');
    });

    // A non-rotating server omits it. Reporting null is what lets the store
    // keep the one it already has instead of storing null over a working token.
    test('reports no refresh token when the server did not rotate one', async () => {
        fetchMock.mockImplementation(ok({ access_token: 'at2', expires_in: 3600 }));

        const tokens = await refreshTokens(AS_METADATA.token_endpoint, { refreshToken: 'rt1', clientId: 'cid' });

        expect(tokens.refreshToken).toBeNull();
    });

    test('a refusal carries its status, so a revoked grant can be told from a hiccup', async () => {
        fetchMock.mockImplementation(refused(400, { error: 'invalid_grant' }));

        await expect(refreshTokens(AS_METADATA.token_endpoint, { refreshToken: 'rt1', clientId: 'cid' }))
            .rejects.toMatchObject({ status: 400, code: 'invalid_grant' });
    });

    test('a network failure is an OAuthError rather than a raw one', async () => {
        fetchMock.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

        await expect(refreshTokens(AS_METADATA.token_endpoint, { refreshToken: 'rt1', clientId: 'cid' }))
            .rejects.toBeInstanceOf(OAuthError);
    });
});

describe('when a token is due for refresh', () => {
    test('a little before it actually expires, so a call does not race the clock', () => {
        expect(needsRefresh(new Date(Date.now() + REFRESH_SKEW_MS / 2))).toBe(true);
        expect(needsRefresh(new Date(Date.now() + REFRESH_SKEW_MS * 10))).toBe(false);
    });

    test('never, for a token with no stated expiry', () => {
        expect(needsRefresh(null)).toBe(false);
    });

    test('immediately, for one that has already expired', () => {
        expect(needsRefresh(new Date(Date.now() - 1000))).toBe(true);
    });
});
