'use strict';

// #1018. The public pages are the first session-free routes the dashboard
// serves, so the property that matters is the gate: a guild whose page is off,
// and a member who has not opted in, both answer the same 404 as a URL that
// names nothing — the page never confirms which case it is. This drives the real
// router with the data layer stubbed, so it is the routing and the gate under
// test rather than the database queries (those are tests/publicData.test.js).

const request = require('supertest');
const session = require('express-session');

// Stubbed so the routes can be driven without a database or node-canvas. The
// gate lives in the route (null from the data layer → 404), which is exactly
// what these control.
jest.mock('../src/dashboard/lib/publicData', () => ({
    resolvePublicGuild: jest.fn(),
    buildServerPage: jest.fn(),
    buildPlayerCard: jest.fn(),
    // isValidSlug is read by the settings router at require time via this module.
    isValidSlug: () => true,
}));
jest.mock('../src/dashboard/lib/publicCard', () => ({
    renderPlayerCard: jest.fn(() => Buffer.from('89504e470d0a1a0a', 'hex')),
}));

const publicData = require('../src/dashboard/lib/publicData');
const { renderPlayerCard } = require('../src/dashboard/lib/publicCard');

const SAVED_ENV = { ...process.env };
beforeEach(() => {
    process.env.SESSION_SECRET = 'x'.repeat(48);
    process.env.NODE_ENV = 'test';
    process.env.DASHBOARD_URL = 'https://bot.example.com';
    jest.clearAllMocks();
});
afterEach(() => {
    for (const key of ['SESSION_SECRET', 'NODE_ENV', 'DASHBOARD_URL']) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
});

const { createApp } = require('../src/dashboard/server');

const app = () => createApp({
    bot: { hasGuild: () => false, resolveUsers: async () => ({}), getGuild: async () => null },
    sessionStore: new session.MemoryStore(),
    configurePassport: () => {},
});

const SERVER_PAGE = {
    guild: { id: '1', name: 'Test Server', icon: null },
    slug: null,
    boards: [{ key: 'level', title: 'Top Levels', rows: [
        { rank: 1, name: 'Opted Member', value: 'Level 9', userId: '111' },
        { rank: 2, name: 'Private Member', value: 'Level 8', userId: null },
    ] }],
    champions: [],
    districts: [],
    event: null,
};

const PLAYER_CARD = {
    guild: { id: '1', name: 'Test Server', slug: null },
    userId: '111', name: 'Opted Member', avatarUrl: null,
    level: 9, rank: 1, xp: 0, requiredXp: 100, messages: 0, currency: '💰',
    netWorth: 1000, streak: 3, longestStreak: 5, prestigeTitle: null, prestigeBadge: null,
    grind: { hunt: 1, fishing: 1, mining: 1, exploration: 1 },
    achievementsCount: 2, topAchievements: [], topMaterials: [],
};

describe('the public page is off by default', () => {
    test('a guild whose page is off is a 404 for the server page', async () => {
        publicData.resolvePublicGuild.mockResolvedValue(null);
        const res = await request(app()).get('/s/123');
        expect(res.status).toBe(404);
        expect(res.headers['cache-control']).toBe('no-store');
    });

    test('a guild whose page is off is a 404 for a player card', async () => {
        publicData.resolvePublicGuild.mockResolvedValue(null);
        const res = await request(app()).get('/s/123/u/111');
        expect(res.status).toBe(404);
    });

    test('a guild whose page is off is a 404 for the card image', async () => {
        publicData.resolvePublicGuild.mockResolvedValue(null);
        const res = await request(app()).get('/s/123/u/111/card.png');
        expect(res.status).toBe(404);
        expect(renderPlayerCard).not.toHaveBeenCalled();
    });
});

describe('a member who has not opted in', () => {
    test('is the same 404 as a guild whose page is off', async () => {
        publicData.resolvePublicGuild.mockResolvedValue({ guildId: '1' });
        publicData.buildPlayerCard.mockResolvedValue(null);
        const res = await request(app()).get('/s/1/u/111');
        expect(res.status).toBe(404);
    });

    test('leaks no card image either', async () => {
        publicData.resolvePublicGuild.mockResolvedValue({ guildId: '1' });
        publicData.buildPlayerCard.mockResolvedValue(null);
        const res = await request(app()).get('/s/1/u/111/card.png');
        expect(res.status).toBe(404);
        expect(renderPlayerCard).not.toHaveBeenCalled();
    });
});

describe('an enabled guild', () => {
    test('serves the server page with a public, cacheable Cache-Control', async () => {
        publicData.resolvePublicGuild.mockResolvedValue({ guildId: '1' });
        publicData.buildServerPage.mockResolvedValue(SERVER_PAGE);

        const res = await request(app()).get('/s/1');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(res.text).toContain('Test Server');
        // The opted-in member is linkable; the private one appears by name only.
        expect(res.text).toContain('/s/1/u/111');
        expect(res.text).toContain('Private Member');
        expect(res.text).not.toMatch(/\/u\/(?!111)/);
    });

    test('is a 404 when the bot has left the guild (no live name)', async () => {
        publicData.resolvePublicGuild.mockResolvedValue({ guildId: '1' });
        publicData.buildServerPage.mockResolvedValue(null);
        const res = await request(app()).get('/s/1');
        expect(res.status).toBe(404);
    });

    test('serves an opted-in member card', async () => {
        publicData.resolvePublicGuild.mockResolvedValue({ guildId: '1' });
        publicData.buildPlayerCard.mockResolvedValue(PLAYER_CARD);

        const res = await request(app()).get('/s/1/u/111');

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        expect(res.text).toContain('Opted Member');
    });

    test('draws the card image as a PNG', async () => {
        publicData.resolvePublicGuild.mockResolvedValue({ guildId: '1' });
        publicData.buildPlayerCard.mockResolvedValue(PLAYER_CARD);

        const res = await request(app()).get('/s/1/u/111/card.png');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.headers['cache-control']).toBe('public, max-age=300');
        expect(renderPlayerCard).toHaveBeenCalledTimes(1);
    });
});
