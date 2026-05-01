const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

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
    if (parsed.hostname !== 'localhost' && parsed.protocol !== 'https:') {
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
        scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => {
        process.nextTick(() => done(null, profile));
    }));
}

function start(client) {
    setupPassport();

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    app.use(express.static(path.join(__dirname, 'public')));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    if (!process.env.SESSION_SECRET) {
        throw new Error('[DASHBOARD] SESSION_SECRET is not set. Add a strong random value to your .env file.');
    }

    app.use(session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 86400000 }
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

    app.get('/health', (req, res) => {
        const { getStatus } = require('../health');
        const status = getStatus();
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