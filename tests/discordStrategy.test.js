'use strict';

// The dashboard's Discord OAuth2 strategy, which sits directly on the login
// path. It used to be `discord-strategy`, a single-maintainer package that
// carried its own copy of passport-oauth2's `authenticate()`. What replaced it
// is a subclass that overrides one method, so these tests pin the two things
// that method is responsible for — fetching the profile, and fetching the guild
// list the dashboard authorizes against — plus the fact that everything else
// still comes from passport-oauth2.

const OAuth2Strategy = require('passport-oauth2');
const {
    Strategy: DiscordStrategy,
    DiscordScope,
    API_BASE,
} = require('../src/dashboard/lib/discordStrategy');

const OPTIONS = {
    clientID: 'client-id',
    clientSecret: 'client-secret',
    callbackURL: 'https://dash.example.com/auth/callback',
    scope: [DiscordScope.Identify, DiscordScope.Guilds],
    state: true,
};

const PROFILE = { id: '1', username: 'tester', discriminator: '0', avatar: null };
const GUILDS = [{ id: '10', name: 'Test Guild', icon: null, permissions: '8' }];

/** Stubs the OAuth2 client's GET so no request leaves the process. */
function stubApi(strategy, routes) {
    const seen = [];
    strategy._oauth2.get = (url, accessToken, cb) => {
        seen.push({ url, accessToken });
        const route = routes[url];
        if (!route) return cb(new Error(`unexpected GET ${url}`));
        if (route.err) return cb(route.err);
        process.nextTick(() => cb(null, route.body));
    };
    return seen;
}

const build = (options = OPTIONS) => new DiscordStrategy(options, () => {});

const profileOf = strategy => new Promise((resolve, reject) => {
    strategy.userProfile('access-token', (err, profile) => (err ? reject(err) : resolve(profile)));
});

describe('DiscordStrategy', () => {
    it('is a passport-oauth2 strategy, not a reimplementation of one', () => {
        const strategy = build();
        expect(strategy).toBeInstanceOf(OAuth2Strategy);
        expect(strategy.name).toBe('discord');
        // authenticate() — token exchange, PKCE, and the state check that
        // defends the callback against login CSRF — must be the inherited one.
        expect(Object.prototype.hasOwnProperty.call(DiscordStrategy.prototype, 'authenticate')).toBe(false);
        expect(strategy.authenticate).toBe(OAuth2Strategy.prototype.authenticate);
    });

    it('points at Discord\'s own endpoints', () => {
        const strategy = build();
        expect(strategy._oauth2._authorizeUrl).toBe('https://discord.com/api/oauth2/authorize');
        expect(strategy._oauth2._accessTokenUrl).toBe('https://discord.com/api/oauth2/token');
    });

    it('lets a caller override an endpoint', () => {
        const strategy = build({ ...OPTIONS, tokenURL: 'https://proxy.example.com/token' });
        expect(strategy._oauth2._accessTokenUrl).toBe('https://proxy.example.com/token');
    });

    it('sends the access token as a Bearer header, which Discord requires', () => {
        expect(build()._oauth2._useAuthorizationHeaderForGET).toBe(true);
    });

    it('separates scopes with a space, as Discord expects', () => {
        expect(build()._scopeSeparator).toBe(' ');
    });

    it('fetches the profile and the guild list the dashboard authorizes against', async () => {
        const strategy = build();
        const seen = stubApi(strategy, {
            [`${API_BASE}/users/@me`]: { body: JSON.stringify(PROFILE) },
            [`${API_BASE}/users/@me/guilds`]: { body: JSON.stringify(GUILDS) },
        });

        const profile = await profileOf(strategy);
        expect(profile.id).toBe('1');
        expect(profile.guilds).toEqual(GUILDS);
        expect(seen.map(s => s.url)).toEqual([
            `${API_BASE}/users/@me`,
            `${API_BASE}/users/@me/guilds`,
        ]);
        expect(seen.every(s => s.accessToken === 'access-token')).toBe(true);
    });

    it('fails the login when the guild list cannot be fetched', async () => {
        // Not an empty list: the dashboard reads guilds to decide which servers
        // this user may configure, so silently dropping them turns a broken
        // fetch into a successful login with no permissions — indistinguishable,
        // from the callback, from a user who administers nothing.
        const strategy = build();
        stubApi(strategy, {
            [`${API_BASE}/users/@me`]: { body: JSON.stringify(PROFILE) },
            [`${API_BASE}/users/@me/guilds`]: { err: new Error('502 from Discord') },
        });

        await expect(profileOf(strategy)).rejects.toThrow(/users\/@me\/guilds/);
    });

    it('fails the login when the profile itself cannot be fetched', async () => {
        const strategy = build();
        stubApi(strategy, { [`${API_BASE}/users/@me`]: { err: new Error('401') } });
        await expect(profileOf(strategy)).rejects.toThrow(/users\/@me/);
    });

    it('fails rather than guessing when Discord returns something unparseable', async () => {
        const strategy = build();
        stubApi(strategy, { [`${API_BASE}/users/@me`]: { body: '<html>gateway timeout</html>' } });
        await expect(profileOf(strategy)).rejects.toThrow(/unparseable/);
    });

    it('does not request guilds when the scope was not asked for', async () => {
        const strategy = build({ ...OPTIONS, scope: [DiscordScope.Identify] });
        const seen = stubApi(strategy, {
            [`${API_BASE}/users/@me`]: { body: JSON.stringify(PROFILE) },
        });

        const profile = await profileOf(strategy);
        expect(profile.guilds).toEqual([]);
        expect(seen.map(s => s.url)).toEqual([`${API_BASE}/users/@me`]);
    });

    it('handles a scope given as a single string', async () => {
        const strategy = build({ ...OPTIONS, scope: DiscordScope.Guilds });
        stubApi(strategy, {
            [`${API_BASE}/users/@me`]: { body: JSON.stringify(PROFILE) },
            [`${API_BASE}/users/@me/guilds`]: { body: JSON.stringify(GUILDS) },
        });
        expect((await profileOf(strategy)).guilds).toEqual(GUILDS);
    });

    it('handles a scope given as one pre-joined string, which passport also accepts', async () => {
        // 'identify guilds' compared whole against 'guilds' is never equal, so
        // this configuration used to skip the guild fetch and hand the
        // dashboard a user who appears to administer nothing.
        const strategy = build({ ...OPTIONS, scope: 'identify guilds' });
        const seen = stubApi(strategy, {
            [`${API_BASE}/users/@me`]: { body: JSON.stringify(PROFILE) },
            [`${API_BASE}/users/@me/guilds`]: { body: JSON.stringify(GUILDS) },
        });

        expect((await profileOf(strategy)).guilds).toEqual(GUILDS);
        expect(seen.map(s => s.url)).toContain(`${API_BASE}/users/@me/guilds`);
    });

    it('still skips the fetch when a joined scope string omits guilds', async () => {
        const strategy = build({ ...OPTIONS, scope: 'identify email' });
        const seen = stubApi(strategy, {
            [`${API_BASE}/users/@me`]: { body: JSON.stringify(PROFILE) },
        });

        expect((await profileOf(strategy)).guilds).toEqual([]);
        expect(seen.map(s => s.url)).toEqual([`${API_BASE}/users/@me`]);
    });
});

describe('the dashboard wiring', () => {
    const savedEnv = {};
    beforeAll(() => {
        for (const key of ['CLIENT_ID', 'CLIENT_SECRET']) {
            savedEnv[key] = process.env[key];
            process.env[key] = `test-${key.toLowerCase()}`;
        }
    });
    afterAll(() => {
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('takes a four-argument verify callback, the passport-oauth2 shape', () => {
        // discord-strategy passed a sixth "consumable" argument that only its
        // own forked authenticate() knew how to supply. Nothing may depend on
        // that again.
        const server = require('../src/dashboard/server');
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'dashboard', 'server.js'), 'utf8');
        expect(src).not.toMatch(/consumable/);
        expect(src).not.toMatch(/require\('discord-strategy'\)/);
        expect(typeof server.discordStrategyOptions).toBe('function');
    });

    it('is not shipping discord-strategy any more', () => {
        const pkg = require('../package.json');
        expect(pkg.dependencies['discord-strategy']).toBeUndefined();
        expect(pkg.dependencies['passport-oauth2']).toBeDefined();
    });
});
