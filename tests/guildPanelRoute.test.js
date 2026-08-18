'use strict';

// Drives the guild settings routes through a real express app with the models
// and the Discord client stubbed, so the page/fragment split is exercised
// rather than described.

const express = require('express');
const path = require('path');
const { Collection } = require('@discordjs/collection');

jest.mock('../src/models/Guild');
jest.mock('../src/models/ItemImage');

const Guild = require('../src/models/Guild');
const ItemImage = require('../src/models/ItemImage');
const { jsonForScript } = require('../src/dashboard/lib/jsonForScript');
const { asset } = require('../src/dashboard/lib/assets');
const { PANELS, DEFAULT_PANEL } = require('../src/dashboard/lib/panels');

let server;
let baseUrl;
let allowedGuildId = 'g1';

// A real settings document (schema defaults and all), just without a database
// behind it — the panels read deeply into these defaults.
const ActualGuild = jest.requireActual('../src/models/Guild');

function guildDoc() {
    const doc = new ActualGuild({ guildId: 'g1', name: 'Test Guild' });
    doc.save = jest.fn(async () => {});
    return doc;
}

function discordGuild() {
    return {
        id: 'g1',
        name: 'Test Guild',
        icon: null,
        ownerId: 'admin-1',
        channels: { cache: new Collection([['c1', { id: 'c1', name: 'general', type: 0 }]]) },
        roles: { cache: new Collection([['r1', { id: 'r1', name: 'Member' }]]) },
    };
}

beforeAll(done => {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'src', 'dashboard', 'views'));
    app.use((req, res, next) => {
        req.isAuthenticated = () => true;
        req.user = { id: 'admin-1', username: 'admin', guilds: [{ id: allowedGuildId, name: 'Test Guild', permissions: '8' }] };
        req.client = { guilds: { cache: new Collection([['g1', discordGuild()]]) } };
        res.locals.jsonForScript = jsonForScript;
        res.locals.asset = asset;
        next();
    });
    app.use('/dashboard', require('../src/dashboard/routes/dashboard'));
    server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

afterAll(done => { server.close(done); });

beforeEach(() => {
    allowedGuildId = 'g1';
    Guild.findOne.mockResolvedValue(guildDoc());
    ItemImage.find.mockReturnValue({ lean: async () => [] });
});

describe('GET /dashboard/guild/:guildId', () => {
    it('ships the default panel and a stub for each of the others', async () => {
        const res = await fetch(`${baseUrl}/dashboard/guild/g1`);
        const html = await res.text();

        expect(res.status).toBe(200);
        expect(html).toContain(`id="${DEFAULT_PANEL}"`);
        expect((html.match(/class="panel-stub"/g) || []).length).toBe(PANELS.length - 1);
        for (const panel of PANELS) {
            if (panel !== DEFAULT_PANEL) expect(html).toContain(`data-panel="${panel}"`);
        }
    });

    it('keeps the page out of shared caches, like the fragments', async () => {
        const res = await fetch(`${baseUrl}/dashboard/guild/g1`);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
    });
});

describe('GET /dashboard/guild/:guildId/panel/:panel', () => {
    it('returns one panel as a bare fragment', async () => {
        const res = await fetch(`${baseUrl}/dashboard/guild/g1/panel/starboard`);
        const html = await res.text();

        expect(res.status).toBe(200);
        expect(html.trim()).toMatch(/^<section id="starboard"/);
        expect(html).not.toContain('<!DOCTYPE');
    });

    it('renders every panel the page stubs out', async () => {
        for (const panel of PANELS) {
            const res = await fetch(`${baseUrl}/dashboard/guild/g1/panel/${panel}`);
            expect([panel, res.status]).toEqual([panel, 200]);
            expect(await res.text()).toContain(`id="${panel}"`);
        }
    });

    it('keeps fragments out of shared caches', async () => {
        const res = await fetch(`${baseUrl}/dashboard/guild/g1/panel/starboard`);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
    });

    it('refuses a name that is not a panel', async () => {
        // Including a traversal attempt: express hands the decoded value to the
        // handler, and it is not in the panel list.
        for (const name of ['nope', 'index', '../index', '../../server']) {
            const res = await fetch(`${baseUrl}/dashboard/guild/g1/panel/${encodeURIComponent(name)}`);
            expect(res.status).toBe(404);
        }
    });

    it('applies the same permission check as the page', async () => {
        allowedGuildId = 'other-guild';
        const res = await fetch(`${baseUrl}/dashboard/guild/g1/panel/starboard`);
        expect(res.status).toBe(403);
    });
});
