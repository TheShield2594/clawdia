const { AttachmentBuilder } = require('discord.js');

/**
 * Returns { attachment, url } for use in Discord embeds, or null if no image is stored.
 *
 * `label` is the item's display name, used for the attachment's alt text. Only
 * the id is needed to find the image, but "Image of hunt:wooden_rifle" is not
 * something to read out, so every caller that has the name should pass it.
 *
 * `guildId` is the server the image is being rendered for, and every caller
 * should pass it: activity images (hunt/fish/mine) are per guild since #561,
 * and a lookup without one can only find the shared pre-#561 image.
 *
 * Three places are checked, most specific first: the guild's own shop item,
 * then that guild's activity image, then the shared image left over from when
 * the collection was global.
 */
async function getItemImageAttachment(itemId, guildId = null, { label } = {}) {
    const ItemImage = require('../models/ItemImage');
    let imageData = null;
    let imageType = 'image/png';

    const take = source => {
        if (!source?.imageData?.length) return false;
        imageData = source.imageData;
        imageType = source.imageType || 'image/png';
        return true;
    };

    if (guildId) {
        const Guild = require('../models/Guild');
        const guild = await Guild.findOne({ guildId }, { shop: 1 });
        const shopItem = guild?.shop?.find(i => i.itemId === itemId);
        take(shopItem);

        if (!imageData) take(await ItemImage.findOne({ guildId, itemId }));
    }

    if (!imageData) take(await ItemImage.findOne({ guildId: null, itemId }));

    if (!imageData) return null;

    const ext = (imageType.split('/')[1] || 'png').replace('jpeg', 'jpg');
    // itemId may contain characters (e.g. the `system:slug` colon used by
    // hunt/fish/mine activity items) that Discord rejects in attachment
    // filenames, so sanitize it here without touching the lookups above.
    const safeId = itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `item-${safeId}.${ext}`;
    const attachment = new AttachmentBuilder(Buffer.from(imageData), {
        name: filename,
        description: `Artwork for the item ${label || itemId}.`,
    });
    return { attachment, url: `attachment://${filename}` };
}

module.exports = { getItemImageAttachment };
