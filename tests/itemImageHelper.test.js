'use strict';

jest.mock('../src/models/ItemImage', () => ({
    findOne: jest.fn(),
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(),
}));

const ItemImage = require('../src/models/ItemImage');
const Guild = require('../src/models/Guild');
const { getItemImageAttachment, attachItemThumbnail } = require('../src/utils/itemImageHelper');

describe('getItemImageAttachment', () => {
    beforeEach(() => {
        ItemImage.findOne.mockReset();
        Guild.findOne.mockReset();
    });

    test('sanitizes colon-containing itemIds (hunt/fish/mine activity items) so the attachment filename stays valid', async () => {
        ItemImage.findOne.mockResolvedValue({ imageData: Buffer.from('fake-png-bytes'), imageType: 'image/png' });

        const result = await getItemImageAttachment('hunt:wooden_rifle');

        expect(result).not.toBeNull();
        expect(result.url).toBe('attachment://item-hunt_wooden_rifle.png');
        expect(result.attachment.name).toBe('item-hunt_wooden_rifle.png');
        expect(ItemImage.findOne).toHaveBeenCalledWith({ guildId: null, itemId: 'hunt:wooden_rifle' });
    });

    test('leaves plain itemIds untouched', async () => {
        ItemImage.findOne.mockResolvedValue({ imageData: Buffer.from('fake-png-bytes'), imageType: 'image/jpeg' });

        const result = await getItemImageAttachment('plain_item');

        expect(result.url).toBe('attachment://item-plain_item.jpg');
    });

    test('returns null when no image is stored anywhere', async () => {
        ItemImage.findOne.mockResolvedValue(null);

        const result = await getItemImageAttachment('hunt:nonexistent');

        expect(result).toBeNull();
    });

    test('checks guild shop image first using the unmodified itemId, falling back to ItemImage', async () => {
        Guild.findOne.mockResolvedValue({
            shop: [{ itemId: 'fish:bamboo_rod', imageData: Buffer.from('guild-bytes'), imageType: 'image/png' }],
        });

        const result = await getItemImageAttachment('fish:bamboo_rod', 'g1');

        expect(result.url).toBe('attachment://item-fish_bamboo_rod.png');
        expect(ItemImage.findOne).not.toHaveBeenCalled();
    });

    // #561: activity images belong to a guild now. The guild's own row is what
    // it must render — the shared pre-#561 row is a fallback, not a peer.
    test('prefers the guild\'s own activity image over the shared one', async () => {
        Guild.findOne.mockResolvedValue({ shop: [] });
        ItemImage.findOne.mockImplementation(async ({ guildId }) => ({
            imageData: Buffer.from(guildId === 'g1' ? 'guild-bytes' : 'shared-bytes'),
            imageType: guildId === 'g1' ? 'image/png' : 'image/gif',
        }));

        const result = await getItemImageAttachment('mine:stone_pickaxe', 'g1');

        expect(ItemImage.findOne).toHaveBeenCalledWith({ guildId: 'g1', itemId: 'mine:stone_pickaxe' });
        expect(result.attachment.name).toBe('item-mine_stone_pickaxe.png');
    });

    test('falls back to the shared image when this guild has none of its own', async () => {
        Guild.findOne.mockResolvedValue({ shop: [] });
        ItemImage.findOne.mockImplementation(async ({ guildId }) =>
            guildId === null ? { imageData: Buffer.from('shared-bytes'), imageType: 'image/gif' } : null);

        const result = await getItemImageAttachment('mine:stone_pickaxe', 'g1');

        expect(ItemImage.findOne).toHaveBeenNthCalledWith(1, { guildId: 'g1', itemId: 'mine:stone_pickaxe' });
        expect(ItemImage.findOne).toHaveBeenNthCalledWith(2, { guildId: null, itemId: 'mine:stone_pickaxe' });
        expect(result.attachment.name).toBe('item-mine_stone_pickaxe.gif');
    });
});

// The catch and material thumbnails (an animal on a hunt result, a fish on a
// cast, the rarest material on an /inventory tab) all go through this, and all
// of them are optional: a server that has uploaded nothing must get the embed
// it got before, not a thumbnail pointing at a file the reply does not carry.
describe('attachItemThumbnail', () => {
    const fakeEmbed = () => {
        const embed = { thumbnail: null };
        embed.setThumbnail = url => { embed.thumbnail = url; return embed; };
        return embed;
    };

    beforeEach(() => {
        ItemImage.findOne.mockReset();
        Guild.findOne.mockReset();
    });

    test('sets the thumbnail and hands back the file to send with it', async () => {
        Guild.findOne.mockResolvedValue({ shop: [] });
        ItemImage.findOne.mockResolvedValue({ imageData: Buffer.from('bytes'), imageType: 'image/png' });
        const embed = fakeEmbed();

        const files = await attachItemThumbnail(embed, 'fish:minnow', 'g1');

        expect(embed.thumbnail).toBe('attachment://item-fish_minnow.png');
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('item-fish_minnow.png');
    });

    test('leaves the embed alone and sends nothing when the item has no image', async () => {
        Guild.findOne.mockResolvedValue({ shop: [] });
        ItemImage.findOne.mockResolvedValue(null);
        const embed = fakeEmbed();

        const files = await attachItemThumbnail(embed, 'material:fish_scale', 'g1');

        expect(embed.thumbnail).toBeNull();
        expect(files).toEqual([]);
    });

    // A dead database must cost the player a thumbnail, not their catch.
    test('swallows a lookup failure rather than taking the result embed down', async () => {
        Guild.findOne.mockRejectedValue(new Error('mongo is having a day'));
        const embed = fakeEmbed();

        await expect(attachItemThumbnail(embed, 'hunt:rabbit', 'g1')).resolves.toEqual([]);
        expect(embed.thumbnail).toBeNull();
    });
});
