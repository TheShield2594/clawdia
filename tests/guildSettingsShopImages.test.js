'use strict';

// #605: the guild settings page used to read every shop item's inline image
// Buffer off the wire and deep-copy it through toObject(), only to strip both
// fields before rendering. The images are served by their own route and were
// never on the page — so they were projected out of the read instead.
//
// #888 removed the fields themselves: shop artwork lives in the ItemImage
// collection now, so there is nothing on this document to project out and no
// projection for a future read to forget. What is left to hold is the property
// the projection existed for — no image bytes reach the rendered page — plus
// the seeding behaviour that grew up around it.

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
    it('carries no image fields on the shop schema to read at all', () => {
        // The projection this suite was written for is gone because the fields
        // are: a document written through the schema cannot hold a Buffer on a
        // shop item any more, whatever a caller sets.
        const doc = new ActualGuild({ guildId: 'g1', name: 'Test Guild' });
        doc.shop = [{
            itemId: 'lantern', name: 'Lantern', price: 10,
            imageData: Buffer.from('SECRETIMAGEBYTES'),
            imageType: 'image/png',
        }];

        expect(doc.shop[0].imageData).toBeUndefined();
        expect(doc.shop[0].imageType).toBeUndefined();
        expect(doc.shop[0].name).toBe('Lantern');
    });

    it('keeps image bytes out of the rendered page even if a read returns them', async () => {
        // Belt and braces, and it still earns its place after #888: a document
        // read straight off a database that predates migration 022 carries the
        // fields whatever the schema says, and none of them may reach the HTML.
        const doc = guildDoc();
        doc.shop = [{ itemId: 'lantern', name: 'Lantern', price: 10 }];
        // Past the schema, the way an unmigrated document arrives.
        doc.shop[0].$__parent = undefined;
        const asObject = doc.toObject.bind(doc);
        doc.toObject = () => {
            const plain = asObject();
            plain.shop[0].imageData = Buffer.from('SECRETIMAGEBYTES');
            plain.shop[0].imageType = 'image/png';
            return plain;
        };
        Guild.findOne.mockResolvedValue(doc);

        const html = await (await fetch(`${baseUrl}/dashboard/guild/g1`)).text();

        expect(html).toContain('Lantern');
        expect(html).not.toContain('SECRETIMAGEBYTES');
        expect(html).not.toContain(Buffer.from('SECRETIMAGEBYTES').toString('base64'));
    });

    it('seeds default shop items off one fully selected read, not two', async () => {
        // The backfill used to re-read the document without the projection
        // before writing, because saving a partially selected shop array was how
        // a guild's images got replaced with nothing. There is no projection to
        // work around any more, so there is no second read either.
        const doc = guildDoc({ seeded: false });
        Guild.findOne.mockResolvedValue(doc);

        const res = await fetch(`${baseUrl}/dashboard/guild/g1`);
        expect(res.status).toBe(200);

        expect(doc.save).toHaveBeenCalledTimes(1);
        expect(Guild.findOne).toHaveBeenCalledTimes(1);
        expect(Guild.findOne.mock.calls[0][1]).toBeUndefined();
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
