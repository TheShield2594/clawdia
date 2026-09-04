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
 * Three places are checked, most specific first: the guild's own shop image,
 * then that guild's activity image, then the shared image left over from when
 * the collection was global. All three are rows in `itemimages` since #888 —
 * the first used to be a scan of the guild settings document's shop array,
 * which meant loading every other item's Buffer to find one of them.
 */
async function getItemImageAttachment(itemId, guildId = null, { label } = {}) {
    const ItemImage = require('../models/ItemImage');
    const { shopImageId } = require('../models/itemImageKeys');

    // All three candidates are rows in one collection, so they are one query
    // rather than up to three round trips resolved in precedence order. The
    // shared pre-#561 row is only ever an activity id; a `shop:` key is always
    // this guild's own.
    const candidates = guildId
        ? await ItemImage.find({
            guildId: { $in: [guildId, null] },
            itemId: { $in: [shopImageId(itemId), itemId] },
        })
        : await ItemImage.find({ guildId: null, itemId });

    // Most specific first: this guild's shop image, then its activity image,
    // then the shared one.
    const rank = doc => (doc.itemId !== itemId ? 0 : doc.guildId != null ? 1 : 2);
    const best = [...candidates]
        .filter(doc => doc?.imageData?.length)
        .sort((a, b) => rank(a) - rank(b))[0];

    if (!best) return null;

    const imageData = best.imageData;
    const imageType = best.imageType || 'image/png';

    const ext = (imageType.split('/')[1] || 'png').replace('jpeg', 'jpg');
    // itemId may contain characters (e.g. the `system:slug` colon used by
    // hunt/fish/mine activity items) that Discord rejects in attachment
    // filenames, so sanitize it here without touching the lookups above.
    const safeId = itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `item-${safeId}.${ext}`;
    // Discord caps alt text at 1024 characters and rejects the upload over it,
    // and a shop item's name is whatever an admin typed into the dashboard. The
    // finished string is what gets cut, not just the label: capping the label
    // alone would still let the prefix carry the total past the limit.
    const description = `Artwork for the item ${label || itemId}.`.slice(0, 1024);
    const attachment = new AttachmentBuilder(Buffer.from(imageData), { name: filename, description });
    return { attachment, url: `attachment://${filename}` };
}

module.exports = { getItemImageAttachment };
