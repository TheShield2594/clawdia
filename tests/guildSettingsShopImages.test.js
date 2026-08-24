'use strict';

// #605: the guild settings page used to read every shop item's inline image
// Buffer off the wire and deep-copy it through toObject(), only to strip both
// fields before rendering. The images are served by their own route and were
// never on the page — so they are projected out of the read instead.

const express = require('express');
const path = require('path');
const { Collection } = require('@discordjs/collection');

jest.mock('../src/models/Guild');
jest.mock('../src/models/ItemImage');

const Guild = require('../src/models/Guild');
const ItemImage = require('../src/models/ItemImage');
const { jsonForScript } = require('../src/dashboard/lib/jsonForScript');
const { asset } = require('../src/dashboard/lib/assets');
const { ensureDefaultShopItems } = require('../src/data/defaultShopItems');

let server;
let baseUrl;

const ActualGuild = jest.requireActual('../src/models/Guild');

// A real settings document, minus a database. `seeded` mirrors what a guild
// that has already been through ensureDefaultShopItems looks like.
function guildDoc({ seeded = true, shop } = {}) {
    const doc = new ActualGuild({ guildId: 'g1', name: 'Test Guild' });
    doc.shopDefaultsSeeded = seeded;
    if (shop) doc.shop = shop;
    doc.save = jest.fn(async () => {});
    return doc;
}

function discordGuild() {
    return {
        id: 'g1',
        name: 'Test Guild',
        icon: null,
        ownerId: 'admin-1',
        memberCount: 3,
        channels: { cache: new Collection([['c1', { id: 'c1', name: 'general', type: 0, parentId: null }]]) },
        roles: { cache: new Collection([['r1', { id: 'r1', name: 'Member', position: 1, managed: false }]]) },
    };
}

beforeAll(done => {
    const { createBotGateway } = require('../src/bot/gateway');
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'src', 'dashboard', 'views'));
    app.use((req, res, next) => {
        req.isAuthenticated = () => true;
        req.user = { id: 'admin-1', username: 'admin', guilds: [{ id: 'g1', name: 'Test Guild', permissions: '8' }] };
        req.bot = createBotGateway({ guilds: { cache: new Collection([['g1', discordGuild()]]) } });
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
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue(guildDoc());
    ItemImage.find.mockReturnValue({ lean: async () => [] });
});

describe('guild settings page and shop image Buffers', () => {
    it('projects the image fields out of the read', async () => {
        const res = await fetch(`${baseUrl}/dashboard/guild/g1`);
        expect(res.status).toBe(200);

        const projection = Guild.findOne.mock.calls[0][1];
        expect(projection).toContain('-shop.imageData');
        expect(projection).toContain('-shop.imageType');
    });

    it('projects them out of a panel fragment read too', async () => {
        const res = await fetch(`${baseUrl}/dashboard/guild/g1/panel/economy`);
        expect(res.status).toBe(200);

        expect(Guild.findOne.mock.calls[0][1]).toContain('-shop.imageData');
    });

    it('keeps image bytes out of the rendered page even if a read returns them', async () => {
        // Belt and braces: the projection is the fix, but a document that
        // carries the fields anyway (a freshly created one is unprojected) must
        // still not put a Buffer into the HTML.
        Guild.findOne.mockResolvedValue(guildDoc({
            shop: [{
                itemId: 'lantern', name: 'Lantern', price: 10,
                imageData: Buffer.from('SECRETIMAGEBYTES'),
                imageType: 'image/png',
            }],
        }));

        const html = await (await fetch(`${baseUrl}/dashboard/guild/g1`)).text();

        expect(html).toContain('Lantern');
        expect(html).not.toContain('imageData');
        expect(html).not.toContain('SECRETIMAGEBYTES');
        expect(html).not.toContain(Buffer.from('SECRETIMAGEBYTES').toString('base64'));
    });

    it('seeds default shop items against a fully selected document, never the projection', async () => {
        // Saving a partially selected shop array is how a guild's images get
        // replaced with nothing, so the rare backfill re-reads without the
        // projection and writes that document instead.
        const projected = guildDoc({ seeded: false });
        const full = guildDoc({ seeded: false });
        Guild.findOne.mockResolvedValueOnce(projected).mockResolvedValueOnce(full);

        const res = await fetch(`${baseUrl}/dashboard/guild/g1`);
        expect(res.status).toBe(200);

        expect(projected.save).not.toHaveBeenCalled();
        expect(full.save).toHaveBeenCalledTimes(1);
        expect(Guild.findOne.mock.calls[1][1]).toBeUndefined();
    });

    it('does not re-read or write for a guild whose shop is already complete', async () => {
        // The common case by far: nothing to seed, so the projected read is the
        // only read the page makes and no Buffer is touched at all.
        const doc = guildDoc({ seeded: false });
        while (ensureDefaultShopItems(doc)) { /* settle */ }
        doc.save.mockClear();
        Guild.findOne.mockResolvedValue(doc);

        await fetch(`${baseUrl}/dashboard/guild/g1`);

        expect(doc.save).not.toHaveBeenCalled();
        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });
});
