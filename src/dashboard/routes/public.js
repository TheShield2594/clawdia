'use strict';

// The dashboard's public face (#1018): a read-only, opt-in-per-guild server page
// and player card that need no session at all. These are the first unauthenticated
// reads the dashboard serves, so three things are true of every route here and of
// nothing under routes/api/:
//
//   - they carry no checkAuth/checkGuildAccess — reaching them is the whole point;
//   - they are gated instead by the guild's own `publicPage.enabled` toggle and,
//     for a player card, that member's `/profile public on` opt-in, and every gate
//     that fails answers the same 404 so the URL space never confirms who exists;
//   - they are rate-limited per IP and sent with a public, cacheable Cache-Control,
//     because unlike every authenticated response they may sit in a shared cache.
//
// They live in their own router mounted at /s rather than under routes/api/ so
// they are outside the api router's blanket `private, no-store` and its
// authenticated read limiter, and so the auth-enforcement sweep over routes/api/
// (tests/dashboardAuthEnforcement.js) keeps meaning exactly what it says.

const express = require('express');
const router = express.Router();
const { BoundedRateLimiter } = require('../../utils/boundedRateLimiter');
const { checkDashboardUrl } = require('../../config/validateEnv');
const { resolvePublicGuild, buildServerPage, buildPlayerCard } = require('../lib/publicData');
const { renderPlayerCard } = require('../lib/publicCard');

// Per-IP read limit. These reads each cost a database query and, for the boards,
// a Discord resolve, so an unauthenticated caller looping them costs the bot more
// than it costs them. The ceiling is well above what a person clicking around a
// page produces and well below what a scraper would want.
const RL_WINDOW_MS = 60 * 1000;
const RL_LIMIT = 60;
const readLimiter = new BoundedRateLimiter(10_000);
setInterval(() => readLimiter.cleanup(RL_WINDOW_MS), 60 * 1000).unref();

function publicReadLimit(req, res, next) {
    if (!readLimiter.check(`ip:${req.ip}`, RL_WINDOW_MS, RL_LIMIT)) {
        res.set('Cache-Control', 'no-store');
        return res.status(429).type('text/plain').send('Too many requests. Please slow down.');
    }
    next();
}

// How long each kind of response may sit in a shared cache. Short: these mirror
// live leaderboards and balances, so a stale card is a wrong card, but a minute
// of caching is what turns a burst of shares of one link into one render.
const PAGE_MAX_AGE = 60;
const CARD_MAX_AGE = 300;

/** The 404 every failed gate answers, so none of them can be told apart. */
function notFound(res) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).render('public-404');
}

/** Absolute base URL for the Open Graph tags, or null when misconfigured. */
function baseUrl() {
    try {
        return checkDashboardUrl().baseUrl;
    } catch {
        return null;
    }
}

// The public server page: the guild's header, the weekly champion race, the top
// ten on each leaderboard the admin ticked, the active seasonal event and district
// funding. A guild with its page off, or one the bot has left, is a 404.
router.get('/:id', publicReadLimit, async (req, res, next) => {
    try {
        const guild = await resolvePublicGuild(req.params.id);
        if (!guild) return notFound(res);

        const page = await buildServerPage(req.bot, guild);
        if (!page) return notFound(res);

        res.set('Cache-Control', `public, max-age=${PAGE_MAX_AGE}`);
        res.render('public-server', { page, baseUrl: baseUrl() });
    } catch (err) {
        next(err);
    }
});

// The public player card: the same figures /profile and /showcase render, as HTML.
// Served only for a member who has run `/profile public on`; a member who has not
// opted in, has no record, or is not in the guild is the same 404 as a guild whose
// page is off, so the URL cannot be used to confirm membership.
router.get('/:id/u/:userId', publicReadLimit, async (req, res, next) => {
    try {
        const guild = await resolvePublicGuild(req.params.id);
        if (!guild) return notFound(res);

        const card = await buildPlayerCard(req.bot, guild, req.params.userId);
        if (!card) return notFound(res);

        res.set('Cache-Control', `public, max-age=${PAGE_MAX_AGE}`);
        res.render('public-player', { card, baseUrl: baseUrl() });
    } catch (err) {
        next(err);
    }
});

// The player card's Open Graph image, drawn per request so a shared link unfurls
// in Discord. Gated identically to the card page above — the same opt-in, the same
// 404 — so the image never confirms a member the page would not.
router.get('/:id/u/:userId/card.png', publicReadLimit, async (req, res, next) => {
    try {
        const guild = await resolvePublicGuild(req.params.id);
        if (!guild) return notFound(res);

        const card = await buildPlayerCard(req.bot, guild, req.params.userId);
        if (!card) return notFound(res);

        const png = await renderPlayerCard(card);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', `public, max-age=${CARD_MAX_AGE}`);
        res.send(png);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
