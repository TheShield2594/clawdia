const mongoose = require('mongoose');

/**
 * Images for hunt/fish/mine items, one document per guild per item.
 *
 * This collection used to be global: `itemId` alone was the unique key, and the
 * dashboard route that wrote it accepted any admin of any guild the bot is in
 * (#561). One server's admin replacing their pickaxe icon replaced it for every
 * server, and deleting it deleted it everywhere.
 *
 * `guildId: null` is the pre-#561 document — the images that were uploaded while
 * the collection was shared. They are kept as a read-only fallback so nobody's
 * icons vanish on deploy, and nothing writes them any more: an upload always
 * lands on the uploading guild's own document, and a delete only ever removes
 * that one. See migration 014.
 */
const itemImageSchema = new mongoose.Schema({
    guildId:   { type: String, default: null },
    itemId:    { type: String, required: true },
    imageData: { type: Buffer, required: true },
    imageType: { type: String, default: 'image/png' },
    updatedAt: { type: Date,   default: Date.now }
});

// One image per item per guild. Declared here so a fresh database gets it, and
// created explicitly in migration 014 — which also drops the old single-field
// unique index on itemId, since that index makes per-guild rows impossible.
itemImageSchema.index({ guildId: 1, itemId: 1 }, { unique: true, name: 'idx_itemimage_guild_item' });

module.exports = mongoose.model('ItemImage', itemImageSchema);
