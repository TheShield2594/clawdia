'use strict';

/**
 * #888. Shop item images are rows in `itemimages` now, not `Buffer`s on the
 * guild settings document.
 *
 * Inline, they were an unbounded array of up to ~512 KB blobs inside the one
 * document every cached read pulls: a guild with an illustrated shop walks
 * toward MongoDB's 16 MB ceiling and then stops saving anything at all, and
 * every reader owed a `-shop.imageData` projection it could forget. The write
 * path was worse than the read: the upload route loaded the whole document,
 * set a Buffer on one element of its shop array, and `guild.save()`d the lot
 * back — so an upload and a concurrent settings save each wrote a document read
 * before the other landed, and the later one won entirely.
 *
 * Driven through a real express app with the models stubbed, like
 * tests/itemImageTenancy.test.js: what is asserted is the query the route
 * issues, because "it writes one small document" is the whole change.
 */

const express = require('express');

jest.mock('../src/models/ItemImage');
jest.mock('../src/models/Guild');

const ItemImage = require('../src/models/ItemImage');
const Guild = require('../src/models/Guild');
const stubBotGateway = require('./helpers/stubBotGateway');
const { shopImageId } = require('../src/models/itemImageKeys');

const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.alloc(16),
]);

const ITEM = 'padlock';

let server;
let baseUrl;
let session;

beforeAll(done => {
    const app = express();
    app.use((req, res, next) => {
        req.isAuthenticated = () => session.authenticated !== false;
        req.user = { id: session.userId, guilds: session.guilds };
        req.bot = stubBotGateway({
            hasGuild: async id => session.botGuilds.includes(id),
            canManageGuild: async () => session.live,
        });
        next();
    });
    app.use('/api', require('../src/dashboard/routes/api/itemImages'));
    server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

afterAll(done => { server.close(() => done()); });

/** The guild lookup the write routes make to check the item exists. */
function shopHas(...itemIds) {
    Guild.findOne.mockImplementation(filter => ({
        lean: async () => (itemIds.includes(filter['shop.itemId']) ? { _id: 'guild-doc' } : null),
    }));
}

beforeEach(() => {
    jest.clearAllMocks();
    require('../src/dashboard/lib/permissions').forgetLiveGuildAccess();
    session = {
        userId: 'admin-1',
        guilds: [{ id: 'g1', name: 'One', permissions: '32' }],
        botGuilds: ['g1', 'g2'],
        live: true,
    };
    shopHas(ITEM);
    ItemImage.findOne.mockResolvedValue(null);
    ItemImage.findOneAndUpdate.mockResolvedValue({});
    ItemImage.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

function upload(guildId, itemId, bytes = PNG) {
    const body = new FormData();
    body.append('image', new Blob([bytes], { type: 'image/png' }), 'icon.png');
    return fetch(`${baseUrl}/api/item-image/shop/${guildId}/${encodeURIComponent(itemId)}`, {
        method: 'POST',
        body,
    });
}

const remove = (guildId, itemId) =>
    fetch(`${baseUrl}/api/item-image/shop/${guildId}/${encodeURIComponent(itemId)}`, { method: 'DELETE' });

const read = (guildId, itemId) =>
    fetch(`${baseUrl}/api/item-image/shop/${guildId}/${encodeURIComponent(itemId)}`);

describe('an upload', () => {
    test('writes one keyed document instead of rewriting the guild', async () => {
        const res = await upload('g1', ITEM);

        expect(res.status).toBe(200);
        expect(ItemImage.findOneAndUpdate).toHaveBeenCalledWith(
            { guildId: 'g1', itemId: 'shop:padlock' },
            expect.objectContaining({ imageType: 'image/png' }),
            { upsert: true },
        );
        // The race this closes: a full-document read followed by `guild.save()`
        // overwrites whatever a concurrent settings save wrote in between.
        expect(Guild.findOne).not.toHaveBeenCalledWith(expect.objectContaining({ guildId: 'g1' }), undefined);
    });

    test('namespaces the key so a shop item cannot claim an activity image', async () => {
        // Shop item ids are whatever an admin typed into the dashboard, and
        // nothing stops one being `hunt:wooden_rifle`.
        shopHas('hunt:wooden_rifle');

        const res = await upload('g1', 'hunt:wooden_rifle');

        expect(res.status).toBe(200);
        const [filter] = ItemImage.findOneAndUpdate.mock.calls[0];
        expect(filter.itemId).toBe('shop:hunt:wooden_rifle');
        expect(filter.itemId).not.toBe('hunt:wooden_rifle');
    });

    test('reads the guild under a projection, not the document it used to load', async () => {
        // Asking "does this item exist" by pulling every other item's Buffer is
        // the shape the issue is about, and it outlived the write it belonged to.
        await upload('g1', ITEM);

        const [filter, projection] = Guild.findOne.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', 'shop.itemId': ITEM });
        expect(projection).toEqual({ _id: 1 });
    });

    test('refuses an item the guild does not sell, so the collection stays bounded', async () => {
        shopHas('some_other_item');

        const res = await upload('g1', 'not_in_this_shop');

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Shop item not found' });
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a file that is not really an image is refused', async () => {
        const res = await upload('g1', ITEM, Buffer.from('<?php echo 1; ?>'));

        expect(res.status).toBe(400);
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('an admin of one guild cannot write another guild\'s image', async () => {
        const res = await upload('g2', ITEM);

        expect(res.status).toBe(403);
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('an anonymous caller writes nothing', async () => {
        session.authenticated = false;

        expect((await upload('g1', ITEM)).status).toBe(401);
        expect(ItemImage.findOneAndUpdate).not.toHaveBeenCalled();
    });
});

describe('a delete', () => {
    test('removes the row rather than nulling a field on the guild', async () => {
        const res = await remove('g1', ITEM);

        expect(res.status).toBe(200);
        expect(ItemImage.deleteOne).toHaveBeenCalledWith({ guildId: 'g1', itemId: 'shop:padlock' });
    });

    test('touches only this guild\'s row', async () => {
        const res = await remove('g2', ITEM);

        expect(res.status).toBe(403);
        expect(ItemImage.deleteOne).not.toHaveBeenCalled();
    });

    test('refuses an item the guild does not sell', async () => {
        shopHas('some_other_item');

        expect((await remove('g1', 'not_in_this_shop')).status).toBe(404);
        expect(ItemImage.deleteOne).not.toHaveBeenCalled();
    });
});

describe('a read', () => {
    test('is one keyed lookup, not a scan of the guild document', async () => {
        ItemImage.findOne.mockResolvedValue({ imageData: Buffer.from('art'), imageType: 'image/gif' });

        const res = await read('g1', ITEM);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/gif');
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('art');
        expect(ItemImage.findOne).toHaveBeenCalledWith({ guildId: 'g1', itemId: shopImageId(ITEM) });
        expect(Guild.findOne).not.toHaveBeenCalled();
    });

    test('404 when the item has no image, which is what the panel expects', async () => {
        // The dashboard renders an <img> per item and hides it on error, so a
        // missing image is a 404 and not an error page.
        expect((await read('g1', ITEM)).status).toBe(404);
    });

    // #565. These reads carry the same gates the writes do.
    test('an admin of one guild cannot read another guild\'s image', async () => {
        ItemImage.findOne.mockResolvedValue({ imageData: Buffer.from('art'), imageType: 'image/png' });

        expect((await read('g2', ITEM)).status).toBe(403);
        expect(ItemImage.findOne).not.toHaveBeenCalled();
    });

    test('the response is marked private, not publicly cacheable', async () => {
        ItemImage.findOne.mockResolvedValue({ imageData: Buffer.from('art'), imageType: 'image/png' });

        const res = await read('g1', ITEM);

        expect(res.headers.get('cache-control')).toContain('private');
        expect(res.headers.get('cache-control')).not.toContain('public');
    });
});
