const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const { Strategy: DiscordStrategy, DiscordScope } = require('discord-strategy');
const path = require('path');
const { getStatus } = require('../health');
const { hasManagePermission } = require('./lib/permissions');
const { jsonForScript } = require('./lib/jsonForScript');

const app = express();

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

function setupPassport() {
    const baseUrl = resolveDashboardUrl();
    const callbackURL = `${baseUrl}/auth/callback`;
    console.log(`[DASHBOARD] OAuth callback URL: ${callbackURL}`);
    console.log('[DASHBOARD] This EXACT URL must be added under "OAuth2 → Redirects" in the Discord Developer Portal.');

    passport.use(new DiscordStrategy({
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        callbackURL,
        scope: [DiscordScope.Identify, DiscordScope.Guilds]
    }, async (accessToken, refreshToken, profile, done, consumable) => {
        try {
            if (!profile || !profile.id || !profile.username) {
                return done(new Error('Invalid Discord profile returned from OAuth'));
            }
            // discord-strategy only fetches basic identity by default; guilds must
            // be pulled in explicitly, which populates profile.guilds in place.
            await consumable.guilds();

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

function start(client) {
    setupPassport();

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    app.use(express.static(path.join(__dirname, 'public')));
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

    app.use(session({
        store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'sessions' }),
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 86400000,
            httpOnly: true,
            secure: isProduction,
            sameSite: 'lax'
        }
    }));

    app.use(passport.initialize());
    app.use(passport.session());

    app.use((req, res, next) => {
        req.client = client;
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
            && req.user.guilds.some(g => hasManagePermission(g) && client.guilds.cache.has(g.id));

        const status = getStatus({ detailed });
        res.status(status.status === 'unhealthy' ? 503 : 200).json(status);
    });

    app.get('/', (req, res) => {
        res.render('index', { user: req.user });
    });

    app.use((err, req, res, next) => {
        console.error('[DASHBOARD] Unhandled error:', err);
        res.status(500).json({ error: 'Internal server error' });
    });

    const PORT = process.env.DASHBOARD_PORT || 3000;
    app.listen(PORT, () => {
        console.log(`[DASHBOARD] Running on port ${PORT}`);
        console.log(`[DASHBOARD] URL: ${process.env.DASHBOARD_URL || `http://localhost:${PORT}`}`);
    });
}

module.exports = { start };