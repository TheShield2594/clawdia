const express = require('express');
const router = express.Router();
const multer = require('multer');
const ItemImage = require('../../../models/ItemImage');
const { checkAuth, checkGuildAccess, checkWriteRateLimit, checkAnyGuildAdmin } = require('../../lib/middleware');

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

// Serve a guild shop item's image
router.get('/item-image/shop/:guildId/:itemId', async (req, res) => {
    try {
        const guild = await require('../../../models/Guild').findOne({ guildId: req.params.guildId }, { shop: 1 });
        const item = guild?.shop?.find(i => i.itemId === req.params.itemId);
        if (!item?.imageData?.length) return res.status(404).end();
        res.set('Content-Type', item.imageType || 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(item.imageData);
    } catch { res.status(500).end(); }
});

// Upload image for a guild shop item
router.post('/item-image/shop/:guildId/:itemId', checkAuth, checkGuildAccess, checkWriteRateLimit, uploadImage, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    // M4: Verify file contents match a known image signature.
    const detectedType = detectImageType(req.file.buffer);
    if (!detectedType) return res.status(400).json({ error: 'Invalid image file: unrecognized format' });
    try {
        const guild = await require('../../../models/Guild').findOne({ guildId: req.params.guildId });
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        const item = guild.shop.find(i => i.itemId === req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Shop item not found' });
        item.imageData = req.file.buffer;
        item.imageType = detectedType; // use detected type, not client-supplied MIME
        await guild.save();
        res.json({ success: true });
    } catch (err) {
        console.error('Shop item image upload error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Remove image from a guild shop item
router.delete('/item-image/shop/:guildId/:itemId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    try {
        const guild = await require('../../../models/Guild').findOne({ guildId: req.params.guildId });
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        const item = guild.shop.find(i => i.itemId === req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Shop item not found' });
        item.imageData = null;
        await guild.save();
        res.json({ success: true });
    } catch (err) {
        console.error('Shop item image delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve a global activity item image (hunt/fish/mine)
router.get('/item-image/activity/:itemId', async (req, res) => {
    try {
        const img = await ItemImage.findOne({ itemId: req.params.itemId });
        if (!img?.imageData?.length) return res.status(404).end();
        res.set('Content-Type', img.imageType || 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(img.imageData);
    } catch { res.status(500).end(); }
});

// Upload/replace a global activity item image (any guild admin)
router.post('/item-image/activity/:itemId', checkAuth, checkAnyGuildAdmin, checkWriteRateLimit, uploadImage, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const { itemId } = req.params;
    if (!/^[a-z0-9_:\-]{1,64}$/.test(itemId)) return res.status(400).json({ error: 'Invalid itemId' });
    // M4: Verify file contents match a known image signature.
    const detectedType = detectImageType(req.file.buffer);
    if (!detectedType) return res.status(400).json({ error: 'Invalid image file: unrecognized format' });
    try {
        await ItemImage.findOneAndUpdate(
            { itemId },
            { imageData: req.file.buffer, imageType: detectedType, updatedAt: new Date() },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Activity item image upload error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Remove a global activity item image
router.delete('/item-image/activity/:itemId', checkAuth, checkAnyGuildAdmin, checkWriteRateLimit, async (req, res) => {
    try {
        await ItemImage.deleteOne({ itemId: req.params.itemId });
        res.json({ success: true });
    } catch (err) {
        console.error('Activity item image delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
