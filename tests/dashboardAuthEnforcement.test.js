'use strict';

// The authorization *rule* — `hasManagePermission` — was already at 100% coverage.
// The middleware that enforces it was at 17.9%, and not one test asserted that a
// non-admin request gets turned away. A rule nothing proves is applied is a rule
// that can quietly stop being applied.
//
// So this suite is about the deny paths, and only the deny paths: no session,
// wrong guild, a guild the bot is not in, a cross-origin write, an admin of
// nothing. Plus a structural pass over every API sub-router, because the second
// way this protection disappears is not a broken check — it is a new route added
// next month that forgets to list the guard at all.

const fs   = require('fs');
const path = require('path');

const {
    checkAuth,
    checkGuildAccess,
    checkCsrfOrigin,
    checkAnyGuildAdmin,
} = require('../src/dashboard/lib/middleware');

const MANAGE_GUILD = (0x20n).toString();
const NO_PERMS     = '0';

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

// `guilds` is what Discord's /users/@me/guilds returned for this session;
// `botGuilds` is what the bot is actually in. Both matter: dashboard access needs
// the user to administer the guild *and* the bot to be present in it.
function makeReq({ authenticated = true, guilds = [], botGuilds = [], params = {}, headers = {} } = {}) {
    return {
        isAuthenticated: () => authenticated,
        user: authenticated ? { id: 'user-1', guilds } : undefined,
        bot: { hasGuild: id => botGuilds.includes(id) },
        params,
        headers,
    };
}

const adminOf   = id => ({ id, name: `guild ${id}`, permissions: MANAGE_GUILD });
const memberOf  = id => ({ id, name: `guild ${id}`, permissions: NO_PERMS });

describe('checkAuth', () => {
    test('rejects an unauthenticated request with 401 and does not call next', () => {
        const res = makeRes();
        const next = jest.fn();

        checkAuth(makeReq({ authenticated: false }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    test('lets an authenticated request through', () => {
        const res = makeRes();
        const next = jest.fn();

        checkAuth(makeReq(), res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });
});

describe('checkGuildAccess', () => {
    test('rejects a guild the user only belongs to, with no manage permission', () => {
        const res = makeRes();
        const next = jest.fn();
        const req = makeReq({
            guilds: [memberOf('g1')],
            botGuilds: ['g1'],
            params: { guildId: 'g1' },
        });

        checkGuildAccess(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
    });

    // The IDOR shape: authenticated, genuinely an admin — just not of this guild.
    test('rejects an admin of one guild reaching for another', () => {
        const res = makeRes();
        const next = jest.fn();
        const req = makeReq({
            guilds: [adminOf('g1'), memberOf('g2')],
            botGuilds: ['g1', 'g2'],
            params: { guildId: 'g2' },
        });

        checkGuildAccess(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('rejects a guild the user administers but the bot is not in', () => {
        const res = makeRes();
        const next = jest.fn();
        const req = makeReq({
            guilds: [adminOf('g1')],
            botGuilds: [],
            params: { guildId: 'g1' },
        });

        checkGuildAccess(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('rejects a guild id the session has never heard of', () => {
        const res = makeRes();
        const next = jest.fn();
        const req = makeReq({
            guilds: [adminOf('g1')],
            botGuilds: ['g1', 'g9'],
            params: { guildId: 'g9' },
        });

        checkGuildAccess(req, res, next);

        expect(res.statusCode).toBe(403);
    });

    test('admits an admin of a guild the bot shares', () => {
        const res = makeRes();
        const next = jest.fn();
        const req = makeReq({
            guilds: [adminOf('g1')],
            botGuilds: ['g1'],
            params: { guildId: 'g1' },
        });

        checkGuildAccess(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });
});

describe('checkAnyGuildAdmin', () => {
    test('rejects an unauthenticated caller with 401', () => {
        const res = makeRes();
        const next = jest.fn();

        checkAnyGuildAdmin(makeReq({ authenticated: false }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    test('rejects a signed-in user who administers nothing', () => {
        const res = makeRes();
        const next = jest.fn();

        checkAnyGuildAdmin(makeReq({ guilds: [memberOf('g1')], botGuilds: ['g1'] }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
    });

    test('rejects an admin whose only guilds are ones the bot is absent from', () => {
        const res = makeRes();
        const next = jest.fn();

        checkAnyGuildAdmin(makeReq({ guilds: [adminOf('g1')], botGuilds: [] }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('admits an admin of at least one shared guild', () => {
        const res = makeRes();
        const next = jest.fn();

        checkAnyGuildAdmin(makeReq({ guilds: [adminOf('g1')], botGuilds: ['g1'] }), res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('checkCsrfOrigin', () => {
    const DASHBOARD = 'https://dash.example.com';
    let saved;

    beforeAll(() => { saved = process.env.DASHBOARD_URL; process.env.DASHBOARD_URL = DASHBOARD; });
    afterAll(() => {
        if (saved === undefined) delete process.env.DASHBOARD_URL;
        else process.env.DASHBOARD_URL = saved;
    });

    test('rejects a write carrying a foreign Origin', () => {
        const res = makeRes();
        const next = jest.fn();

        checkCsrfOrigin(makeReq({ headers: { origin: 'https://evil.example.com' } }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden: cross-origin request rejected' });
    });

    // Prefix matching is the classic way this check is written wrong:
    // dash.example.com.evil.test starts with the dashboard host.
    test('rejects a host that merely starts with the dashboard host', () => {
        const res = makeRes();
        const next = jest.fn();

        checkCsrfOrigin(makeReq({ headers: { origin: 'https://dash.example.com.evil.test' } }), res, next);

        expect(res.statusCode).toBe(403);
    });

    test('rejects the same host on another scheme or port', () => {
        for (const origin of ['http://dash.example.com', 'https://dash.example.com:8443']) {
            const res = makeRes();
            checkCsrfOrigin(makeReq({ headers: { origin } }), res, jest.fn());
            expect(res.statusCode).toBe(403);
        }
    });

    test('rejects an unparseable Origin rather than falling through', () => {
        const res = makeRes();
        const next = jest.fn();

        checkCsrfOrigin(makeReq({ headers: { origin: 'not a url' } }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('admits a matching Origin, and a request that sends none', () => {
        for (const headers of [{ origin: DASHBOARD }, {}]) {
            const res = makeRes();
            const next = jest.fn();
            checkCsrfOrigin(makeReq({ headers }), res, next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(res.statusCode).toBeNull();
        }
    });
});

// The middleware above can be perfect and still protect nothing if a route never
// lists it. Rather than trusting 33 route declarations to stay right, this walks
// the routers Express actually built and reads the guard off each layer.
describe('every API route mounts its guards', () => {
    const apiDir = path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api');
    const files = fs.readdirSync(apiDir).filter(f => f.endsWith('.js'));

    // Each entry: { file, method, routePath, handlers: [middleware names] }
    const routes = files.flatMap(file => {
        const router = require(path.join(apiDir, file));
        return router.stack
            .filter(layer => layer.route)
            .flatMap(layer => Object.keys(layer.route.methods).map(method => ({
                file,
                method: method.toUpperCase(),
                routePath: layer.route.path,
                handlers: layer.route.stack.map(s => s.handle.name),
            })));
    });

    const label = r => `${r.file} ${r.method} ${r.routePath}`;

    // The two routes that serve image bytes to <img> tags. A shop or activity
    // image is decoration, not guild data, and a browser rendering one cannot be
    // asked to present a session — so these are public by design, GET-only, and
    // still counted by the router-wide read limiter. Listed here rather than
    // skipped by pattern: adding a public route should mean editing this line and
    // saying why, not slipping past a wildcard.
    const PUBLIC_ROUTES = new Set([
        'itemImages.js GET /item-image/shop/:guildId/:itemId',
        'itemImages.js GET /item-image/activity/:itemId',
    ]);

    const guarded = routes.filter(r => !PUBLIC_ROUTES.has(label(r)));

    test('the public-route allowlist still describes routes that exist', () => {
        const all = new Set(routes.map(label));
        for (const entry of PUBLIC_ROUTES) expect(all).toContain(entry);
    });

    test('nothing on the allowlist is a write', () => {
        for (const route of routes.filter(r => PUBLIC_ROUTES.has(label(r)))) {
            expect(`${label(route)} is ${route.method}`).toBe(`${label(route)} is GET`);
        }
    });

    test('there are routes to check, so an empty sweep cannot pass silently', () => {
        expect(files.length).toBeGreaterThan(10);
        expect(routes.length).toBeGreaterThan(25);
    });

    test.each(files)('%s guards every route with checkAuth', file => {
        const own = guarded.filter(r => r.file === file);
        expect(own.length).toBeGreaterThan(0);
        for (const route of own) {
            expect(`${label(route)}: ${route.handlers.join(' | ')}`)
                .toContain('checkAuth');
        }
    });

    test('every guild-scoped route also checks access to that guild', () => {
        const scoped = guarded.filter(r => r.routePath.includes(':guildId'));
        expect(scoped.length).toBeGreaterThan(20);
        for (const route of scoped) {
            expect(`${label(route)}: ${route.handlers.join(' | ')}`)
                .toContain('checkGuildAccess');
        }
    });

    // checkGuildAccess dereferences req.user.guilds with no null check of its
    // own, so ordering here is not style — reversed, an anonymous request would
    // throw a 500 out of the guard instead of returning 401.
    test('checkAuth runs before checkGuildAccess, which reads req.user unguarded', () => {
        for (const route of routes.filter(r => r.handlers.includes('checkGuildAccess'))) {
            const auth   = route.handlers.indexOf('checkAuth');
            const access = route.handlers.indexOf('checkGuildAccess');
            expect(`${label(route)}: auth=${auth} access=${access}`)
                .toBe(`${label(route)}: auth=${auth} access=${access}`);
            expect(auth).toBeGreaterThanOrEqual(0);
            expect(access).toBeGreaterThan(auth);
        }
    });

    test('every state-changing route is rate limited', () => {
        const writes = guarded.filter(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
        expect(writes.length).toBeGreaterThan(15);
        for (const route of writes) {
            expect(`${label(route)}: ${route.handlers.join(' | ')}`)
                .toContain('checkWriteRateLimit');
        }
    });

    test('no guarded route reaches its own handler before checkAuth', () => {
        for (const route of guarded) {
            expect(`${label(route)} runs ${route.handlers[0] || '(its handler)'} first`)
                .toBe(`${label(route)} runs checkAuth first`);
        }
    });
});
