const express = require('express');
const router = express.Router();
const multer = require('multer');
const ItemImage = require('../../../models/ItemImage');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isActivityItemId } = require('../../../data/activityItems');
const { shopImageId } = require('../../../models/itemImageKeys');

// M4: Validate image files by magic bytes rather than trusting the client-supplied
// MIME type. Prevents disguised file uploads (e.g. PHP named as image/jpeg).
const IMAGE_SIGNATURES = [
    { mime: 'image/jpeg', offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
    { mime: 'image/png',  offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A] },
    { mime: 'image/gif',  offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: 'image/webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
];

function detectImageType(buffer) {
    for (const sig of IMAGE_SIGNATURES) {
        if (buffer.length < sig.offset + sig.bytes.length) continue;
        if (sig.bytes.every((b, i) => buffer[sig.offset + i] === b)) return sig.mime;
    }
    return null;
}

const _uploadRaw = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
        cb(null, true);
    }
});

function uploadImage(req, res, next) {
    _uploadRaw.single('image')(req, res, err => {
        if (!err) return next();
        const status = (err instanceof multer.MulterError || err.message === 'Only image files are allowed') ? 400 : 500;
        res.status(status).json({ error: err.message || 'Upload error' });
    });
}

// Serves a guild shop item's image.
//
// Authenticated and guild-scoped like every other route here (#565). It was
// public on the reasoning that a browser rendering an <img> cannot present a
// session — which is not true of these images: every consumer is a dashboard
// page on the dashboard's own origin (views/partials/game-item-card.ejs and
// public/guild-settings.js), so the session cookie rides along with the image
// request like any other same-origin subresource. Discord never fetches these
// URLs at all; a shop or activity image reaches a message as an uploaded
// attachment, built by utils/itemImageHelper.js straight from the database.
//
// So nothing needed them open, and open meant anyone who could guess a guild id
// and an item id could read that guild's uploaded artwork.
router.get('/item-image/shop/:guildId/:itemId', checkAuth, checkGuildAccess, async (req, res) => {
    try {
        // One keyed lookup on `{ guildId, itemId }` against a document holding
        // one image, rather than a read of the whole guild settings document to
        // find one element of its shop array (#888).
        const img = await ItemImage.findOne({
            guildId: req.params.guildId,
            itemId: shopImageId(req.params.itemId),
        });
        if (!img?.imageData?.length) return res.status(404).end();
        res.set('Content-Type', img.imageType || 'image/png');
        // `private`: the response is scoped to a session now, so it may sit in
        // the requesting browser's cache but not in a shared one.
        res.set('Cache-Control', 'private, max-age=86400');
        res.send(img.imageData);
    } catch { res.status(500).end(); }
});

/**
 * Whether this guild's shop carries an item with this id.
 *
 * Still checked, and for the same reason the activity routes check their id
 * against the catalog: without it the collection accepts any id at all, at
 * 512 KB and 60 writes a minute. A guild's shop is its own catalog, so it is
 * what bounds this half.
 *
 * Read under a projection naming the one field, which is the shape the whole
 * issue is about — the previous version pulled the entire settings document,
 * every shop image Buffer included, to answer this question.
 */
async function shopHasItem(guildId, itemId) {
    const guild = await require('../../../models/Guild')
        .findOne({ guildId, 'shop.itemId': itemId }, { _id: 1 })
        .lean();
    return Boolean(guild);
}

// Stores the image shown for a guild shop item, replacing any existing one.
//
// A targeted upsert on one small document (#888). It used to load the whole
// guild settings document, set a Buffer on one element of its shop array and
// `guild.save()` the lot back — which raced every concurrent settings write,
// since the document it wrote was the one it had read before that write landed.
router.post('/item-image/shop/:guildId/:itemId', checkAuth, checkGuildAccess, checkWriteRateLimit, uploadImage, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    // M4: Verify file contents match a known image signature.
    const detectedType = detectImageType(req.file.buffer);
    if (!detectedType) return res.status(400).json({ error: 'Invalid image file: unrecognized format' });
    const { guildId, itemId } = req.params;
    try {
        if (!await shopHasItem(guildId, itemId)) {
            return res.status(404).json({ error: 'Shop item not found' });
        }
        await ItemImage.findOneAndUpdate(
            { guildId, itemId: shopImageId(itemId) },
            // The detected type, not the client-supplied MIME.
            { imageData: req.file.buffer, imageType: detectedType, updatedAt: new Date() },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Shop item image upload error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Removes a guild shop item's image.
//
// A delete of the image document, not a `null` written into the guild's. An
// item whose image was never uploaded and one whose image was removed are the
// same state, and both answer 404 from the GET above.
router.delete('/item-image/shop/:guildId/:itemId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, itemId } = req.params;
    try {
        if (!await shopHasItem(guildId, itemId)) {
            return res.status(404).json({ error: 'Shop item not found' });
        }
        await ItemImage.deleteOne({ guildId, itemId: shopImageId(itemId) });
        res.json({ success: true });
    } catch (err) {
        console.error('Shop item image delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Activity item images (hunt/fish/mine) are per guild.
//
// They were not (#561). `ItemImage` had no guildId, the collection was keyed on
// itemId alone, and the write routes were gated on "admin of *any* guild the bot
// is in" — so an admin of one server could replace, or delete, the icons every
// other server sees. The routes are guild-scoped now and carry the same
// checkGuildAccess every other guild-scoped route does; the id in the path is
// the guild whose images are being changed, so administering that guild is
// exactly the permission required.
//
// Documents with `guildId: null` are the images uploaded before this change.
// They are read as a fallback so nothing disappeared on deploy, and no route
// writes them: an upload lands on the caller's own guild, a delete removes only
// that guild's row. See migration 014.
function invalidItemId(itemId) {
    // The shape check first, so a wildly malformed id is rejected as malformed,
    // then membership of the catalog the game actually renders. The catalog is
    // also what bounds this collection: without it any id at all could be
    // stored, at 512 KB and 60 writes a minute.
    if (typeof itemId !== 'string' || !/^[a-z0-9_:-]{1,64}$/.test(itemId)) return 'Invalid itemId';
    if (!isActivityItemId(itemId)) return 'Unknown activity item';
    return null;
}

// Serves a guild's activity item image, falling back to the shared pre-#561 one.
// Gated for the same reason as the shop route above (#565).
router.get('/item-image/activity/:guildId/:itemId', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId, itemId } = req.params;
    try {
        const img = await ItemImage.findOne({ guildId, itemId })
            || await ItemImage.findOne({ guildId: null, itemId });
        if (!img?.imageData?.length) return res.status(404).end();
        res.set('Content-Type', img.imageType || 'image/png');
        // Per guild, so the cache key must be too: this URL carries the guild id,
        // and the response varies by nothing else. `private` because the route
        // is authenticated (#565) — a shared cache must not hold it.
        res.set('Cache-Control', 'private, max-age=86400');
        res.send(img.imageData);
    } catch { res.status(500).end(); }
});

// Stores one guild's activity item image, replacing any existing one.
router.post('/item-image/activity/:guildId/:itemId', checkAuth, checkGuildAccess, checkWriteRateLimit, uploadImage, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const { guildId, itemId } = req.params;
    const idError = invalidItemId(itemId);
    if (idError) return res.status(400).json({ error: idError });
    // M4: Verify file contents match a known image signature.
    const detectedType = detectImageType(req.file.buffer);
    if (!detectedType) return res.status(400).json({ error: 'Invalid image file: unrecognized format' });
    try {
        await ItemImage.findOneAndUpdate(
            { guildId, itemId },
            { imageData: req.file.buffer, imageType: detectedType, updatedAt: new Date() },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Activity item image upload error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Removes one guild's activity item image. The shared fallback is not reachable
// from here: `guildId` is always the caller's own guild, never null.
router.delete('/item-image/activity/:guildId/:itemId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, itemId } = req.params;
    // The POST validated the id and the DELETE did not, which is how a delete
    // ends up matching on something the upload path could never have written.
    const idError = invalidItemId(itemId);
    if (idError) return res.status(400).json({ error: idError });
    try {
        await ItemImage.deleteOne({ guildId, itemId });
        res.json({ success: true });
    } catch (err) {
        console.error('Activity item image delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
