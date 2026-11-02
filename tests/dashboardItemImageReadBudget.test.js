'use strict';

// The economy panel renders every hunt, fish and mine item as a card whose icon
// is an <img> pointing at /item-image/activity/…, plus one per guild shop item.
// Each of those is a GET, and every GET under the API router used to spend the
// shared 120-a-minute read budget. One page load spent all of it, so the
// cards drawn last — the mining Upgrades, Blasts and Consumables tabs — got a
// 429 and fell back to their emoji while every other tab showed its art.
//
// Item-image reads now skip the shared budget; routes/api/itemImages.js meters
// them with its own limiter. These tests drive the real router.

const express = require('express');
const request = require('supertest');

const apiRouter = require('../src/dashboard/routes/api');
const { ACTIVITY_ITEMS } = require('../src/data/activityItems');

const SHARED_READ_LIMIT = 120;
const ITEM_IMAGE_READ_LIMIT = 300;

// A user id per app so each test starts with a fresh budget (both limiters key
// on the session's user id). Unauthenticated past the limiters: checkAuth
// answers 401 before any handler touches the database, which is enough to tell
// a request that got through the limiters from one they turned away.
let seq = 0;
function makeApp() {
    const user = { id: `budget-${++seq}` };
    const app = express();
    app.use((req, res, next) => { req.user = user; req.isAuthenticated = () => false; next(); });
    app.use('/api', apiRouter);
    return app;
}

const everyActivityItemId = Object.values(ACTIVITY_ITEMS)
    .flatMap(groups => Object.values(groups))
    .flat()
    .map(item => item.id);

describe('item-image reads do not spend the shared read budget', () => {
    test('a full economy panel of icons, plus headroom, is never turned away', async () => {
        const app = makeApp();
        // Every activity card, with room for the guild shop's own items.
        const urls = [
            ...everyActivityItemId.map(id => `/api/item-image/activity/123/${encodeURIComponent(id)}`),
            ...Array.from({ length: 60 }, (_, i) => `/api/item-image/shop/123/shop_item_${i}`),
        ];
        expect(urls.length).toBeGreaterThan(SHARED_READ_LIMIT);

        const statuses = [];
        for (const url of urls) statuses.push((await request(app).get(url)).status);

        expect(statuses.filter(s => s === 429)).toHaveLength(0);
    });

    test('and the page\'s own API calls keep their full budget alongside them', async () => {
        const app = makeApp();
        for (let i = 0; i < 100; i++) await request(app).get('/api/item-image/activity/123/mine:gem_lens');

        // The images spent none of it, so all 120 API reads still go through.
        for (let i = 0; i < SHARED_READ_LIMIT; i++) {
            const res = await request(app).get('/api/guild/123/cases');
            expect(res.status).toBe(401);
        }
        const over = await request(app).get('/api/guild/123/cases');
        expect(over.status).toBe(429);
    });
});

describe('item-image reads are still rate limited', () => {
    test('by the item-image router\'s own limiter', async () => {
        const app = makeApp();
        for (let i = 0; i < ITEM_IMAGE_READ_LIMIT; i++) {
            const res = await request(app).get('/api/item-image/activity/123/mine:gem_lens');
            expect(res.status).toBe(401);
        }
        const over = await request(app).get('/api/item-image/activity/123/mine:gem_lens');
        expect(over.status).toBe(429);
    });

    // The per-router limiters (stats at 60, the session probe at 120) used to be
    // bare, pathless use() mounts, so they metered every request passing through
    // their router — the icons included. Scoped to their own paths now, they
    // still guard those paths.
    test('while the stats limiter still guards /stats', async () => {
        const app = makeApp();
        for (let i = 0; i < 60; i++) {
            const res = await request(app).get('/api/guild/123/stats');
            expect(res.status).toBe(401);
        }
        const over = await request(app).get('/api/guild/123/stats');
        expect(over.status).toBe(429);
    });

    test('and /insights, the other aggregation it covers', async () => {
        const app = makeApp();
        for (let i = 0; i < 60; i++) {
            const res = await request(app).get('/api/guild/123/insights');
            expect(res.status).toBe(401);
        }
        const over = await request(app).get('/api/guild/123/insights');
        expect(over.status).toBe(429);
    });

    test('a write to an item image still goes through origin validation', async () => {
        const res = await request(makeApp())
            .post('/api/item-image/shop/123/lucky_charm')
            .set('Origin', 'https://not-the-dashboard.example');
        expect(res.status).toBe(403);
    });
});
