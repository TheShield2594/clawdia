const { AttachmentBuilder } = require('discord.js');

/**
 * Returns { attachment, url } for use in Discord embeds, or null if no image is stored.
 * For guild shop items pass guildId; for activity items (hunt/fish/mine) pass only itemId.
 * Checks the guild shop first, then falls back to the global ItemImage collection.
 */
async function getItemImageAttachment(itemId, guildId = null) {
    let imageData = null;
    let imageType = 'image/png';

    if (guildId) {
        const Guild = require('../models/Guild');
        const guild = await Guild.findOne({ guildId }, { shop: 1 });
        const shopItem = guild?.shop?.find(i => i.itemId === itemId);
        if (shopItem?.imageData?.length) {
            imageData = shopItem.imageData;
            imageType = shopItem.imageType || 'image/png';
        }
    }

    if (!imageData) {
        const ItemImage = require('../models/ItemImage');
        const img = await ItemImage.findOne({ itemId });
        if (img?.imageData?.length) {
            imageData = img.imageData;
            imageType = img.imageType || 'image/png';
        }
    }

    if (!imageData) return null;

    const ext = (imageType.split('/')[1] || 'png').replace('jpeg', 'jpg');
    // itemId may contain characters (e.g. the `system:slug` colon used by
    // hunt/fish/mine activity items) that Discord rejects in attachment
    // filenames, so sanitize it here without touching the lookups above.
    const safeId = itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `item-${safeId}.${ext}`;
    const attachment = new AttachmentBuilder(Buffer.from(imageData), { name: filename });
    return { attachment, url: `attachment://${filename}` };
}

module.exports = { getItemImageAttachment };
