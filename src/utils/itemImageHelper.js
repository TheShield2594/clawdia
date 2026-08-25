const { AttachmentBuilder } = require('discord.js');

/**
 * Returns { attachment, url } for use in Discord embeds, or null if no image is stored.
 *
 * `guildId` is the server the image is being rendered for, and every caller
 * should pass it: activity images (hunt/fish/mine) are per guild since #561,
 * and a lookup without one can only find the shared pre-#561 image.
 *
 * Three places are checked, most specific first: the guild's own shop item,
 * then that guild's activity image, then the shared image left over from when
 * the collection was global.
 */
async function getItemImageAttachment(itemId, guildId = null) {
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
    const attachment = new AttachmentBuilder(Buffer.from(imageData), { name: filename });
    return { attachment, url: `attachment://${filename}` };
}

/**
 * Sets `embed`'s thumbnail to the image stored for `itemId`, and returns the
 * files to send with it — `[]` when the guild has uploaded nothing for that id.
 *
 * Every caller was writing the same four lines: fetch, swallow the error, set
 * the thumbnail, remember the attachment for the reply payload. Forgetting the
 * last of those is the interesting mistake — the embed points at
 * `attachment://item-fish_minnow.png`, the payload carries no such file, and
 * Discord renders the embed with an empty thumbnail box rather than failing.
 * Returning the files and the thumbnail together makes that pair hard to split.
 *
 * @returns {Promise<Array>} files for the reply payload, empty when there is no image
 */
async function attachItemThumbnail(embed, itemId, guildId) {
    const image = await getItemImageAttachment(itemId, guildId).catch(() => null);
    if (!image) return [];
    embed.setThumbnail(image.url);
    return [image.attachment];
}

module.exports = { getItemImageAttachment, attachItemThumbnail };
