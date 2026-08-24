const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const { Strategy: DiscordStrategy, DiscordScope } = require('./lib/discordStrategy');
const path = require('path');
const { getStatus, httpStatusFor } = require('../health');
const { hasManagePermission } = require('./lib/permissions');
const { jsonForScript } = require('./lib/jsonForScript');
const { asset } = require('./lib/assets');
const { createBotGateway } = require('../bot/gateway');
const { instanceStats } = require('./lib/instanceStats');

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

function resolveDashboardUrl() {
    const raw = (process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`).trim();
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`[DASHBOARD] DASHBOARD_URL is not a valid URL: "${raw}"`);
    }
    // M5: Enforce HTTPS in production unconditionally — localhost is not exempt
    // because production deployments should never be reached via localhost.
    const isProduction = process.env.NODE_ENV === 'production';
    if (parsed.protocol !== 'https:') {
        if (isProduction) {
            throw new Error(`[DASHBOARD] DASHBOARD_URL must use HTTPS in production. Got: "${raw}". Set NODE_ENV=development for local testing.`);
        }
        console.warn(`[DASHBOARD] WARNING: DASHBOARD_URL "${raw}" is not HTTPS. Discord OAuth will reject non-HTTPS redirect URIs in production.`);
    }
    if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
        throw new Error(`[DASHBOARD] DASHBOARD_URL must be just a scheme + host (e.g. https://bot.example.com), with no path. Got: "${raw}"`);
    }
    return `${parsed.protocol}//${parsed.host}`;
}

// Options for the Discord OAuth2 strategy, split out from the passport.use()
// call so the login CSRF defence below is assertable without booting the app.
//
// `state: true` is the load-bearing line. Without it passport-oauth2 falls back
// to its NullStore (lib/strategy.js), which issues no state parameter and
// verifies none on the way back — so /auth/callback accepts any `code` from
// anyone, with nothing tying it to the session that started the login. An
// attacker who begins a login, captures their own code and gets an operator to
// open /auth/callback?code=... silently signs that operator into the attacker's
// Discord identity, where anything they then configure or paste lands in the
// attacker's guild. With `state: true` the strategy uses the session-backed
// NonceStore: the callback only completes for a state value this session
// generated moments earlier.
//
// PKCE (`pkce: true`) would layer on protection for the code itself; it is left
// off deliberately, since the client secret already covers the confidential-client
// case this dashboard is and enabling it changes the token request.
function discordStrategyOptions(callbackURL) {
    return {
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        callbackURL,
        scope: [DiscordScope.Identify, DiscordScope.Guilds],
        state: true
    };
}

function setupPassport() {
    const baseUrl = resolveDashboardUrl();
    const callbackURL = `${baseUrl}/auth/callback`;
    console.log(`[DASHBOARD] OAuth callback URL: ${callbackURL}`);
    console.log('[DASHBOARD] This EXACT URL must be added under "OAuth2 → Redirects" in the Discord Developer Portal.');

    passport.use(new DiscordStrategy(discordStrategyOptions(callbackURL), (accessToken, refreshToken, profile, done) => {
        try {
            if (!profile || !profile.id || !profile.username) {
                return done(new Error('Invalid Discord profile returned from OAuth'));
            }

            // Store only what the dashboard needs — never persist raw OAuth tokens or full profile
            const safeProfile = {
                id: profile.id,
                username: profile.username,
                discriminator: profile.discriminator || '0',
                avatar: profile.avatar || null,
                guilds: Array.isArray(profile.guilds)
                    ? profile.guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon, permissions: g.permissions }))
                    : []
            };
            done(null, safeProfile);
        } catch (err) {
            done(err);
        }
    }));
}

/**
 * The dashboard's terminal error middleware.
 *
 * This is the blast-radius boundary (#616). An error that escapes Express does
 * not fail a request — it reaches the process-level `uncaughtException` /
 * `unhandledRejection` guards in src/index.js, which exit, which drops the
 * gateway connection for every guild the bot is in. The dashboard and the bot
 * share one process, so a bad route is currently a bot-wide outage.
 *
 * Splitting the dashboard out is the real fix and `createApp` above is the
 * first half of it. Until then this handler is what has to hold, so it is
 * written to have no way out of its own:
 *
 *   - `err.status` is honoured, so express.json()'s 400 on a malformed body is
 *     reported as a bad request rather than laundered into a 500.
 *   - A response already on the wire cannot be given a status, and trying is
 *     an `ERR_HTTP_HEADERS_SENT` thrown from inside the error handler. Those
 *     are delegated to Express's finalhandler, which destroys the socket —
 *     the only correct end for a half-written response.
 *   - Writing the reply is itself wrapped: a socket that died between the
 *     `headersSent` check and the write would otherwise throw here, past the
 *     last handler Express has.
 */
function errorHandler(err, req, res, next) {
    console.error('[DASHBOARD] Unhandled error:', err);

    if (res.headersSent) return next(err);

    const status = Number.isInteger(err?.status) ? err.status
        : Number.isInteger(err?.statusCode) ? err.statusCode
        : 500;

    try {
        res.status(status >= 400 && status < 600 ? status : 500)
            .json({ error: status === 500 ? 'Internal server error' : (err.expose ? err.message : 'Bad request') });
    } catch (sendErr) {
        console.error('[DASHBOARD] Failed to send the error response:', sendErr.message);
        try { res.destroy?.(); } catch { /* the socket is already gone */ }
    }
}

/**
 * Builds the dashboard's Express app and returns it, without binding a port.
 *
 * This used to be a module-level `const app = express()` configured inside
 * `start(client)`: one app per process, constructible only from a live Discord
 * client, and impossible to stand up twice. That shape is what kept the
 * middleware here untested — supertest needs an app object, not a listening
 * server — and it is the first thing in the way of running the dashboard as its
 * own process (#620, #616).
 *
 * Everything the app needs from outside arrives through `deps`:
 *
 *   bot            the gateway facade (src/bot/gateway.js). Defaults to one
 *                  built from `client`; pass a stub to construct the app with
 *                  no Discord connection at all.
 *   sessionStore   the express-session store. Defaults to the Mongo-backed one,
 *                  which is the only part of this function that reaches for a
 *                  database at construction time.
 *   configurePassport
 *                  called once before the app is assembled. Defaults to the
 *                  real Discord strategy registration, which needs
 *                  CLIENT_ID/CLIENT_SECRET and a valid DASHBOARD_URL.
 */
function createApp({ client = null, bot: injectedBot, sessionStore, configurePassport = setupPassport } = {}) {
    configurePassport();

    const app = express();

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // The version every view renders, read from package.json rather than typed
    // into the templates. Three of them carried a hardcoded "v4.2.0" while
    // package.json said 1.0.0 (#708): a footer nobody remembers to edit is a
    // footer that reports the wrong build, and the whole point of tagging
    // releases is being able to tell which one is running. `app.locals` so it
    // reaches every render without a route passing it along.
    app.locals.version = require('../../package.json').version;
    // No explicit `view cache` here on purpose: guild-settings.ejs is a few
    // hundred KB and must not be recompiled per render, but Express already
    // enables the cache whenever NODE_ENV is 'production', which both the
    // Dockerfile and portainer-stack.yml set. Forcing it on would only take
    // template reloading away from local development.

    // Gzip/deflate every compressible response. The guild settings page alone
    // renders a few hundred KB of HTML, and styles.css is another 70 KB — both
    // shrink by roughly 85% over the wire. Registered before the static handler
    // and the routers so it covers assets and rendered views alike.
    app.use(compression());

    // Assets are requested through the asset() helper, which stamps each URL
    // with a hash of the file's contents — a deploy changes the URL, so a long
    // immutable cache never serves stale JavaScript or CSS.
    app.use(express.static(path.join(__dirname, 'public'), {
        maxAge: '1y',
        immutable: true,
    }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // M1: Validate SESSION_SECRET exists and meets minimum strength requirements.
    if (!process.env.SESSION_SECRET) {
        throw new Error('[DASHBOARD] SESSION_SECRET is not set. Add a strong random value to your .env file.');
    }
    if (process.env.SESSION_SECRET.length < 32) {
        throw new Error('[DASHBOARD] SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32');
    }

    // Trust the first hop from a reverse proxy (nginx, Caddy, etc.) so that
    // req.protocol reflects the original HTTPS scheme and the secure: true
    // cookie flag works correctly when deployed behind a proxy.
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) app.set('trust proxy', 1);

    // L3: Baseline security response headers for all routes.
    // A fresh nonce is generated per request and made available to EJS templates
    // via res.locals.cspNonce so inline <script> tags can opt in safely.
    // Note: style-src retains 'unsafe-inline' because the templates contain ~400
    // inline style="" attributes which cannot accept nonces (nonces only apply to
    // <style> blocks). Removing it requires a separate CSS refactor.
    app.use((req, res, next) => {
        const nonce = crypto.randomBytes(16).toString('base64');
        res.locals.cspNonce = nonce;
        res.locals.jsonForScript = jsonForScript;
        res.locals.asset = asset;
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
            // Inline event handlers (onclick, onchange, etc.) cannot carry nonces,
            // so allow them the same way inline styles are allowed.
            "script-src-attr 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https: cdn.discordapp.com",
            "connect-src 'self'",
            "font-src 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
        ].join('; '));
        next();
    });

    // The session is what the dashboard's authorization rests on, so its
    // lifetime is part of that rule (#558). It used to be a flat 24 hours from
    // login, which was also how long a revoked admin kept their access, since
    // `req.user.guilds` is captured once at OAuth time and never refreshed.
    //
    // Two changes: four hours instead of twenty-four, and `rolling: true`, so
    // the window is an *idle* timeout rather than an absolute one — someone
    // working in the dashboard is not signed out mid-edit, and a session left
    // alone is gone in four hours instead of a day. The live permission check
    // in lib/permissions.js is what closes the window properly (a minute); this
    // bounds how long a stale snapshot can survive when Discord cannot be
    // reached to take that second opinion.
    app.use(session({
        store: sessionStore ?? MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'sessions' }),
        secret: process.env.SESSION_SECRET,
        resave: false,
        rolling: true,
        saveUninitialized: false,
        cookie: {
            maxAge: 4 * 60 * 60 * 1000,
            httpOnly: true,
            secure: isProduction,
            sameSite: 'lax'
        }
    }));

    app.use(passport.initialize());
    app.use(passport.session());

    // Routes get the facade, never the client (#608). Everything they need
    // from Discord is a method on it, so nothing downstream holds a live
    // gateway object — which is what lets this be backed by IPC or
    // broadcastEval later without touching a single route.
    const bot = injectedBot ?? createBotGateway(client);
    app.use((req, res, next) => {
        req.bot = bot;
        next();
    });

    const authRoutes = require('./routes/auth');
    const dashboardRoutes = require('./routes/dashboard');
    const apiRoutes = require('./routes/api');

    app.use('/auth', authRoutes);
    app.use('/dashboard', dashboardRoutes);
    app.use('/api', apiRoutes);

    // Everyone gets status + uptime — enough for the compose healthcheck and any
    // external uptime monitor. The detailed payload (service names, last error
    // strings, memory) goes only to users who administer a guild the bot is in.
    //
    // Merely being logged in is not enough: Discord OAuth is open to any account,
    // so authentication alone conveys no privilege here.
    app.get('/health', (req, res) => {
        const detailed = req.isAuthenticated?.() === true
            && Array.isArray(req.user?.guilds)
            && req.user.guilds.some(g => hasManagePermission(g) && bot.hasGuild(g.id));

        const status = getStatus({ detailed });
        // Non-200 for `degraded` as well as `unhealthy`, so a monitor that only
        // reads status codes still sees a half-broken bot (#640). The container
        // healthchecks read `status` out of the body instead, and restart only on
        // `unhealthy` — see httpStatusFor in src/health.js.
        res.status(httpStatusFor(status.status)).json(status);
    });

    app.get('/', (req, res) => {
        // The hero's stat row is measured, not written into the template
        // (#704). `null` when the client has not been ready yet, and the
        // template drops the row for that rather than claiming zero servers.
        res.render('index', { user: req.user, stats: instanceStats(bot) });
    });

    app.use(errorHandler);

    return app;
}

/**
 * Binds the app to a port. Split from `createApp` so the app can be built and
 * driven in-process — by supertest, or by a future dashboard process that owns
 * its own listen — without a socket ever being opened.
 */
function listen(app, port = process.env.DASHBOARD_PORT || 3000) {
    const server = app.listen(port, () => {
        console.log(`[DASHBOARD] Running on port ${port}`);
        console.log(`[DASHBOARD] URL: ${process.env.DASHBOARD_URL || `http://localhost:${port}`}`);
    });

    // A server 'error' with no listener is an unhandled 'error' event, which is
    // a process-level throw — EADDRINUSE on the dashboard port would take the
    // gateway down with it. The dashboard being unreachable is bad; the bot
    // leaving every guild because of it is worse.
    server.on('error', err => {
        console.error(`[DASHBOARD] Server error on port ${port}:`, err.message);
    });

    return server;
}

function start(client) {
    return listen(createApp({ client }));
}

module.exports = { createApp, listen, start, errorHandler, discordStrategyOptions };