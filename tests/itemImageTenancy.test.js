'use strict';

// #561: activity item images (hunt/fish/mine) lived in a collection keyed on
// itemId alone, written by any admin of any guild the bot is in. One server's
// admin could replace — or delete — the icons every other server sees, and could
// keep writing rows under ids nothing reads, 512 KB at a time.
//
// The routes are driven through a real express app with the model stubbed, so
// what is asserted is the query the route actually issues, not a description of
// it: a filter missing its guildId is the whole bug.

const express = require('express');

jest.mock('../src/models/ItemImage');

const ItemImage = require('../src/models/ItemImage');

const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.alloc(16),
]);

// An id that exists in the game data, so the catalog check is not what a test
// about tenancy is passing or failing on.
const ITEM = 'hunt:wooden_rifle';

let server;
let baseUrl;
let session;

beforeAll(done => {
    const app = express();
    app.use((req, res, next) => {
        req.isAuthenticated = () => session.authenticated !== false;
        req.user = { id: session.userId, guilds: session.guilds };
        req.bot = {
            hasGuild: id => session.botGuilds.includes(id),
            canManageGuild: async () => session.live,
        };
        next();
    });
    app.use('/api', require('../src/dashboard/routes/api/itemImages'));
    server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

afterAll(done => { server.close(() => done()); });

beforeEach(() => {
    jest.clearAllMocks();
    require('../src/dashboard/lib/permissions').forgetLiveGuildAccess();
    session = {
        // Admin of g1 only. Under the old gate — "admin of any guild" — this
        // session could write every guild's images.
        userId: 'admin-1',
        guilds: [{ id: 'g1', name: 'One', permissions: '32' }],
        botGuilds: ['g1', 'g2'],
        live: true,
    };
    ItemImage.findOne.mockResolvedValue(null);
    ItemImage.findOneAndUpdate.mockResolvedValue({});
    ItemImage.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

function upload(guildId, itemId, bytes = PNG) {
    const body = new FormData();
    body.append('image', new Blob([bytes], { type: 'image/png' }), 'icon.png');
    return fetch(`${baseUrl}/api/item-image/activity/${guildId}/${encodeURIComponent(itemId)}`, {
        method: 'POST',
        body,
    });
}

const remove = (guildId, itemId) =>
    fetch(`${baseUrl}/api/item-image/activity/${guildId}/${encodeURIComponent(itemId)}`, { method: 'DELETE' });

describe('activity image writes are scoped to one guild', () => {
    test('an upload lands on the uploading guild, not on every guild', async () => {
        const res = await upload('g1', ITEM);

        expect(res.status).toBe(200);
        expect(ItemImage.findOneAndUpdate).toHaveBeenCalledWith(
            { guildId: 'g1', itemId: ITEM },
            expect.objectContaining({ imageType: 'image/png' }),
            { upsert: true },
        );
    });

    // The cross-tenant write itself: an admin of g1 reaching into g2.
    test('an admin of one guild cannot write another guild\'s image', async () => {
        const res = await upload('g2', ITEM);

        expect(res.status).toBe(403);
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('nor delete another guild\'s image', async () => {
        const res = await remove('g2', ITEM);

        expect(res.status).toBe(403);
        expect(ItemImage.deleteOne).not.toHaveBeenCalled();
    });

    test('a delete only removes this guild\'s row, never the shared one', async () => {
        const res = await remove('g1', ITEM);

        expect(res.status).toBe(200);
        expect(ItemImage.deleteOne).toHaveBeenCalledWith({ guildId: 'g1', itemId: ITEM });
    });

    test('an anonymous caller writes nothing', async () => {
        session.authenticated = false;
        expect((await upload('g1', ITEM)).status).toBe(401);
        expect((await remove('g1', ITEM)).status).toBe(401);
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
        expect(ItemImage.deleteOne).not.toHaveBeenCalled();
    });

    // #558 rides along here: the session says g1, Discord says otherwise.
    test('a revoked admin is refused even though the session still says admin', async () => {
        session.live = false;

        expect((await upload('g1', ITEM)).status).toBe(403);
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });
});

describe('what may be written', () => {
    test('an id outside the game catalog is refused, so the collection stays bounded', async () => {
        const res = await upload('g1', 'hunt:not_a_real_weapon');

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Unknown activity item');
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });

    // The catalog has to cover every id the shop views render, not just the ones
    // the dashboard panel shows cards for — the browse views draw a zone,
    // location and depth image too, and those were briefly un-uploadable.
    test.each([
        ['hunt', require('../src/data/huntData').ZONE_LIST[0].id],
        ['fish', require('../src/data/fishData').LOCATION_LIST[0].id],
        ['mine', require('../src/data/mineData').DEPTH_LIST[0].id],
    ])('accepts a %s id the browse view renders but the panel does not list', async (namespace, id) => {
        const itemId = `${namespace}:${id}`;

        const res = await upload('g1', itemId);

        expect(res.status).toBe(200);
        expect(ItemImage.findOneAndUpdate).toHaveBeenCalledWith(
            { guildId: 'g1', itemId },
            expect.objectContaining({ imageType: 'image/png' }),
            { upsert: true },
        );
    });

    test('a malformed id is refused as malformed', async () => {
        const res = await upload('g1', 'Hunt:../../etc/passwd');

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid itemId');
    });

    // The DELETE path skipped the id check the POST applied, so it could match
    // rows the upload path could never have written.
    test('DELETE validates the id too', async () => {
        const res = await remove('g1', 'hunt:not_a_real_weapon');

        expect(res.status).toBe(400);
        expect(ItemImage.deleteOne).not.toHaveBeenCalled();
    });

    test('a file that is not really an image is refused', async () => {
        const res = await upload('g1', ITEM, Buffer.from('<?php echo 1; ?>'));

        expect(res.status).toBe(400);
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });
});

describe('reads', () => {
    test("a guild's own image wins over the shared pre-#561 one", async () => {
        ItemImage.findOne.mockImplementation(async ({ guildId }) =>
            ({ imageData: Buffer.from(guildId === 'g1' ? 'own' : 'shared'), imageType: 'image/png' }));

        const res = await fetch(`${baseUrl}/api/item-image/activity/g1/${ITEM}`);

        expect(res.status).toBe(200);
        expect(ItemImage.findOne).toHaveBeenCalledWith({ guildId: 'g1', itemId: ITEM });
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('own');
    });

    test('the shared image is still served to a guild that has none of its own', async () => {
        ItemImage.findOne.mockImplementation(async ({ guildId }) =>
            (guildId === null ? { imageData: Buffer.from('shared'), imageType: 'image/gif' } : null));

        const res = await fetch(`${baseUrl}/api/item-image/activity/g9/${ITEM}`);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/gif');
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('shared');
    });

    test('404 when there is no image anywhere', async () => {
        expect((await fetch(`${baseUrl}/api/item-image/activity/g1/${ITEM}`)).status).toBe(404);
    });
});
