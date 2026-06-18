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
        expect(ItemImage.findOne).toHaveBeenCalledWith({ itemId: 'hunt:wooden_rifle' });
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
});
