'use strict';

jest.mock('../src/models/ItemImage', () => ({
    findOne: jest.fn(),
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(),
}));

const ItemImage = require('../src/models/ItemImage');
const Guild = require('../src/models/Guild');
const { getItemImageAttachment } = require('../src/utils/itemImageHelper');

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
