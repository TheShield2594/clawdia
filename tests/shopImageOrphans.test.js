'use strict';

/**
 * #888, the other side of moving shop images out of the guild document.
 *
 * Inline, an item's image was part of the item: deleting the item from the shop
 * deleted its artwork with it, because the settings save rewrote the array the
 * Buffer lived in. As a row in `itemimages` the image outlives the item unless
 * something removes it — and nothing else would. The retention prune only
 * covers archive files, the image route only reads, and no read reaches a row
 * whose item is gone. That is a 512 KB document per removed item, accumulating
 * for as long as an admin keeps editing their shop.
 *
 * So the settings endpoint removes the rows for the ids that actually went, and
 * only those: an id that survives the rewrite, or is re-added in the same
 * request under the same name, keeps its artwork.
 */

const express = require('express');

jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (_req, _res, next) => next(),
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
    logAuditEvent: jest.fn(async () => {}),
}));
jest.mock('../src/models/Guild');
jest.mock('../src/models/ItemImage');

const Guild = require('../src/models/Guild');
const ItemImage = require('../src/models/ItemImage');

let server;
let baseUrl;
let doc;

/** A settings document whose `set('shop', …)` behaves the way Mongoose's does. */
function guildDoc(shop) {
    return {
        guildId: 'g1',
        shop,
        set: jest.fn(function set(key, value) { this[key] = value; }),
        save: jest.fn(async () => {}),
    };
}

const item = itemId => ({ itemId, name: itemId, price: 10 });

beforeAll(done => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'admin-1' }; next(); });
    app.use('/api', require('../src/dashboard/routes/api/settings'));
    server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

afterAll(done => { server.close(done); });

beforeEach(() => {
    jest.clearAllMocks();
    doc = guildDoc([item('padlock'), item('shield')]);
    Guild.findOne.mockResolvedValue(doc);
    ItemImage.deleteMany.mockResolvedValue({ deletedCount: 1 });
});

const saveShop = shop =>
    fetch(`${baseUrl}/api/guild/g1/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shop }),
    });

describe('removing an item from the shop', () => {
    it('takes its image with it, the way the inline Buffer used to', async () => {
        const res = await saveShop([item('padlock')]);

        expect(res.status).toBe(200);
        expect(ItemImage.deleteMany).toHaveBeenCalledWith({
            guildId: 'g1',
            itemId: { $in: ['shop:shield'] },
        });
    });

    it('leaves the images of the items that stayed', async () => {
        await saveShop([item('padlock')]);

        const [{ itemId }] = ItemImage.deleteMany.mock.calls[0];
        expect(itemId.$in).not.toContain('shop:padlock');
    });

    it('deletes nothing when the shop is only reordered or edited', async () => {
        await saveShop([item('shield'), { ...item('padlock'), price: 99 }]);

        expect(ItemImage.deleteMany).not.toHaveBeenCalled();
    });

    it('keeps the artwork of an item re-added under the same id in one request', async () => {
        // An admin who deletes a row and adds it back before pressing save has
        // not asked for the artwork to go.
        await saveShop([item('padlock'), item('shield')]);

        expect(ItemImage.deleteMany).not.toHaveBeenCalled();
    });

    it('touches nothing when the request is not about the shop at all', async () => {
        const res = await fetch(`${baseUrl}/api/guild/g1/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ 'economy.currencySymbol': '🪙' }),
        });

        expect(res.status).toBe(200);
        expect(ItemImage.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes only after the save, so a rejected write keeps every image', async () => {
        doc.save.mockRejectedValue(new Error('write concern failed'));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await saveShop([item('padlock')]);

        expect(res.status).toBe(500);
        expect(ItemImage.deleteMany).not.toHaveBeenCalled();
    });

    it('reports the save as saved even when the cleanup fails', async () => {
        // The settings the admin asked for are written. A row left behind is
        // something to collect later, not a reason to tell them it did not save.
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        ItemImage.deleteMany.mockRejectedValue(new Error('connection reset'));

        const res = await saveShop([item('padlock')]);

        expect(res.status).toBe(200);
        expect(errors).toHaveBeenCalledWith('[SETTINGS] shop image cleanup failed:', 'connection reset');
    });

    it('never reaches outside the guild being edited', async () => {
        await saveShop([]);

        expect(ItemImage.deleteMany).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: 'g1' }),
        );
    });
});
