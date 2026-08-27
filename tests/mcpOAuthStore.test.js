'use strict';

/**
 * #796, the storage half. Two things here are easy to get wrong and expensive
 * when they are:
 *
 * A refresh token that rotates is single-use — the server issues a new one and
 * invalidates the old one — so two concurrent refreshes on one grant means the
 * second presents a token the first has already spent, and the whole grant is
 * revoked. Three Discord messages in a guild at once is all it takes.
 *
 * And a server that does *not* rotate simply omits the refresh token from its
 * response. Storing that null over the one already held would break the grant
 * on the very next refresh.
 */

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/config/secretBox', () => ({
    // Visible in the assertions, so a value that reached storage unencrypted
    // fails rather than looking identical to one that did not.
    encryptSecret: value => (value == null ? value : `enc:${value}`),
    decryptSecret: value => (typeof value === 'string' && value.startsWith('enc:') ? value.slice(4) : value),
}));
jest.mock('../src/services/ai/mcp/oauth', () => {
    const actual = jest.requireActual('../src/services/ai/mcp/oauth');
    return { ...actual, refreshTokens: jest.fn() };
});

const Guild = require('../src/models/Guild');
const { refreshTokens, OAuthError } = require('../src/services/ai/mcp/oauth');
const {
    accessTokenFor, saveGrant, clearGrant, readGrant, sealGrant, openGrant, _resetOAuthStore,
} = require('../src/services/ai/mcp/oauthStore');

const HOUR = 60 * 60 * 1000;

function storedGrant(over = {}) {
    return {
        guildId: 'g1',
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        resource: 'https://mcp.example.com/mcp',
        clientId: 'cid',
        clientSecret: 'enc:shh',
        accessToken: 'enc:at1',
        refreshToken: 'enc:rt1',
        expiresAt: new Date(Date.now() + HOUR),
        scope: 'read',
        // Present so the refresh below can be shown not to drop them. They are
        // the only record of who authorized the connection and when.
        connectedBy: 'admin-1',
        connectedAt: new Date('2026-08-01T00:00:00Z'),
        ...over,
    };
}

/** `Guild.findOne(...).lean()` resolving to a guild holding this grant. */
function stubRead(oauth) {
    Guild.findOne.mockReturnValue({
        lean: async () => (oauth === null ? null : { ai: { mcpServers: [{ name: 'linear', oauth }] } }),
    });
}

let warn;

beforeEach(() => {
    jest.clearAllMocks();
    _resetOAuthStore();
    Guild.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe('what reaches the database', () => {
    test('every secret is encrypted and the rest is not', () => {
        const sealed = sealGrant({
            guildId: 'g1', issuer: 'https://auth.example.com',
            authorizationEndpoint: 'https://auth.example.com/a',
            tokenEndpoint: 'https://auth.example.com/t',
            clientId: 'cid', clientSecret: 'shh', accessToken: 'at', refreshToken: 'rt',
        });

        expect(sealed.clientSecret).toBe('enc:shh');
        expect(sealed.accessToken).toBe('enc:at');
        expect(sealed.refreshToken).toBe('enc:rt');
        // The client id is a public identifier and the endpoints are URLs the
        // server publishes; encrypting them would only make the record harder
        // to read for no gain.
        expect(sealed.clientId).toBe('cid');
        expect(sealed.issuer).toBe('https://auth.example.com');
    });

    test('a grant with no secret at all does not become the string "null"', () => {
        expect(sealGrant({ clientId: 'cid', clientSecret: null, accessToken: null, refreshToken: null }))
            .toMatchObject({ clientSecret: null, accessToken: null, refreshToken: null });
    });

    test('and comes back out decrypted', () => {
        expect(openGrant(storedGrant())).toMatchObject({
            accessToken: 'at1', refreshToken: 'rt1', clientSecret: 'shh',
        });
    });

    test('nothing at all opens to nothing, not to an empty grant', () => {
        expect(openGrant(null)).toBeNull();
        expect(openGrant(undefined)).toBeNull();
    });
});

describe('saving a grant', () => {
    test('clears the static token, so the record says which credential is in use', async () => {
        await saveGrant('g1', 'linear', {
            issuer: 'https://auth.example.com',
            authorizationEndpoint: 'https://auth.example.com/a',
            tokenEndpoint: 'https://auth.example.com/t',
            clientId: 'cid', accessToken: 'at', refreshToken: 'rt',
        });

        const [, update] = Guild.updateOne.mock.calls[0];
        expect(update.$set['ai.mcpServers.$.authorizationToken']).toBeNull();
        expect(update.$set['ai.mcpServers.$.oauth'].accessToken).toBe('enc:at');
        // Stamped on the grant so the MCP client can find its way back to the
        // token store without anything in between knowing guilds exist.
        expect(update.$set['ai.mcpServers.$.oauth'].guildId).toBe('g1');
    });

    test('reports a connection that was removed while the admin was authorizing', async () => {
        Guild.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
        await expect(saveGrant('g1', 'gone', { clientId: 'cid' })).resolves.toBe(false);
    });

    test('clearing one leaves the connection behind, unauthenticated', async () => {
        await clearGrant('g1', 'linear');

        const [, update] = Guild.updateOne.mock.calls[0];
        expect(update).toEqual({ $set: { 'ai.mcpServers.$.oauth': null } });
    });

    test('reading one decrypts it', async () => {
        stubRead(storedGrant());
        await expect(readGrant('g1', 'linear')).resolves.toMatchObject({ accessToken: 'at1' });
    });
});

describe('handing out an access token', () => {
    test('uses the stored one while it is still good', async () => {
        stubRead(storedGrant());

        await expect(accessTokenFor('g1', 'linear')).resolves.toBe('at1');
        expect(refreshTokens).not.toHaveBeenCalled();
    });

    test('refreshes one that is about to expire', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() + 1000) }));
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: new Date(Date.now() + HOUR), scope: 'read' });

        await expect(accessTokenFor('g1', 'linear')).resolves.toBe('at2');
        expect(refreshTokens).toHaveBeenCalledWith('https://auth.example.com/token', expect.objectContaining({
            refreshToken: 'rt1', clientId: 'cid', clientSecret: 'shh', resource: 'https://mcp.example.com/mcp',
        }));
    });

    // The 401 path. The server rejected a token this believed was live, which
    // is what a revoked grant, a changed scope or an early expiry all look like.
    test('refreshes a token that is not due when the server has already rejected it', async () => {
        stubRead(storedGrant());
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: null, scope: null });

        await expect(accessTokenFor('g1', 'linear', { force: true })).resolves.toBe('at2');
    });

    test('says nothing at all for a connection with no grant', async () => {
        stubRead(null);
        await expect(accessTokenFor('g1', 'linear')).resolves.toBeNull();
    });

    test('offers an expired token rather than nothing when there is no way to refresh it', async () => {
        stubRead(storedGrant({ refreshToken: null, expiresAt: new Date(Date.now() - HOUR) }));

        // The server is the judge of whether it still works, and its own error
        // is more useful than one invented here.
        await expect(accessTokenFor('g1', 'linear')).resolves.toBe('at1');
        expect(refreshTokens).not.toHaveBeenCalled();
    });
});

describe('the rotation problem', () => {
    // A rotating refresh token is single-use. Two concurrent refreshes means
    // the second spends a token the first already invalidated, and the whole
    // grant is revoked.
    test('three simultaneous callers make one refresh between them', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: new Date(Date.now() + HOUR), scope: null });

        const tokens = await Promise.all([
            accessTokenFor('g1', 'linear'),
            accessTokenFor('g1', 'linear'),
            accessTokenFor('g1', 'linear'),
        ]);

        expect(tokens).toEqual(['at2', 'at2', 'at2']);
        expect(refreshTokens).toHaveBeenCalledTimes(1);
    });

    test('two different grants are not serialised against each other', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: null, scope: null });

        await Promise.all([accessTokenFor('g1', 'linear'), accessTokenFor('g1', 'notion')]);

        expect(refreshTokens).toHaveBeenCalledTimes(2);
    });

    test('a later refresh is not blocked by an earlier one having finished', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: null, scope: null });

        await accessTokenFor('g1', 'linear');
        await accessTokenFor('g1', 'linear');

        expect(refreshTokens).toHaveBeenCalledTimes(2);
    });

    // `refreshGrant` spreads the opened grant into what it seals, so a field
    // `openGrant` forgets to carry is a field every refresh silently rewrites —
    // `connectedBy` to null, `connectedAt` to the moment of the renewal.
    test('a refresh keeps who connected the grant, and when', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: null, scope: null });

        await accessTokenFor('g1', 'linear');

        const [, update] = Guild.updateOne.mock.calls[0];
        expect(update.$set['ai.mcpServers.$.oauth']).toMatchObject({
            connectedBy: 'admin-1',
            connectedAt: new Date('2026-08-01T00:00:00Z'),
        });
    });

    // A server that does not rotate omits the refresh token. Writing that null
    // over the one already held would break the grant on the next refresh.
    test('keeps the refresh token it has when the server issued no new one', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: null, expiresAt: null, scope: null });

        await accessTokenFor('g1', 'linear');

        const [, update] = Guild.updateOne.mock.calls[0];
        expect(update.$set['ai.mcpServers.$.oauth'].refreshToken).toBe('enc:rt1');
    });

    // In a sharded deployment two processes can still race. The write names the
    // refresh token it was made with, so an older result cannot land on top of
    // a newer grant.
    test('the write is conditional on the refresh token it started from', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: null, scope: null });

        await accessTokenFor('g1', 'linear');

        const [filter] = Guild.updateOne.mock.calls[0];
        expect(filter['ai.mcpServers'].$elemMatch['oauth.refreshToken']).toBe('enc:rt1');
    });

    test('a lost race uses the other process\'s grant rather than refreshing again', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        Guild.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
        refreshTokens.mockResolvedValue({ accessToken: 'mine', refreshToken: 'rt2', expiresAt: null, scope: null });

        // The re-read after the failed write finds what the winner stored.
        Guild.findOne
            .mockReturnValueOnce({ lean: async () => ({ ai: { mcpServers: [{ oauth: storedGrant({ expiresAt: new Date(Date.now() - 1000) }) }] } }) })
            .mockReturnValueOnce({ lean: async () => ({ ai: { mcpServers: [{ oauth: storedGrant({ accessToken: 'enc:theirs' }) }] } }) });

        await expect(accessTokenFor('g1', 'linear')).resolves.toBe('theirs');
        expect(refreshTokens).toHaveBeenCalledTimes(1);
    });
});

describe('a grant that has gone', () => {
    test('is reported once, in words an operator can act on', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockRejectedValue(new OAuthError('invalid_grant', { status: 400, code: 'invalid_grant' }));

        await accessTokenFor('g1', 'linear');

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('an admin must reconnect it'));
    });

    // A refresh that failed on the network is not a revoked grant, and saying
    // so would send an admin to reconnect something that is fine.
    test('is told apart from a refresh that merely could not be made', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockRejectedValue(new OAuthError('socket hang up', { code: 'ECONNRESET' }));

        await accessTokenFor('g1', 'linear');

        expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('must reconnect'));
    });

    // Deleting it would lose the issuer and client id a reconnect starts from.
    test('is left in place either way', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens.mockRejectedValue(new OAuthError('invalid_grant', { status: 400 }));

        await expect(accessTokenFor('g1', 'linear')).resolves.toBe('at1');
    });

    test('does not wedge the next attempt behind a failed in-flight refresh', async () => {
        stubRead(storedGrant({ expiresAt: new Date(Date.now() - 1000) }));
        refreshTokens
            .mockRejectedValueOnce(new OAuthError('temporary', { status: 503 }))
            .mockResolvedValueOnce({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: null, scope: null });

        await accessTokenFor('g1', 'linear');
        await expect(accessTokenFor('g1', 'linear')).resolves.toBe('at2');
    });
});
