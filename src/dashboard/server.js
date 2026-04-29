const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

const app = express();

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

function setupPassport() {
    passport.use(new DiscordStrategy({
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        callbackURL: `${process.env.DASHBOARD_URL}/auth/callback`,
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

    app.use(session({
        secret: process.env.SESSION_SECRET || 'your-secret-key',
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

    app.get('/', (req, res) => {
        res.render('index', { user: req.user });
    });

    const PORT = process.env.DASHBOARD_PORT || 3000;
    app.listen(PORT, () => {
        console.log(`[DASHBOARD] Running on port ${PORT}`);
        console.log(`[DASHBOARD] URL: ${process.env.DASHBOARD_URL || `http://localhost:${PORT}`}`);
    });
}

module.exports = { start };