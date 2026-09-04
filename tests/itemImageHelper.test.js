'use strict';

jest.mock('../src/models/ItemImage', () => ({
    find: jest.fn(),
}));

const ItemImage = require('../src/models/ItemImage');
const { getItemImageAttachment } = require('../src/utils/itemImageHelper');

/** The rows the one query answers with. */
const rows = (...docs) => ItemImage.find.mockResolvedValue(docs);

const png = bytes => ({ imageData: Buffer.from(bytes), imageType: 'image/png' });

describe('getItemImageAttachment', () => {
    beforeEach(() => {
        ItemImage.find.mockReset();
        rows();
    });

    test('sanitizes colon-containing itemIds (hunt/fish/mine activity items) so the attachment filename stays valid', async () => {
        rows({ guildId: null, itemId: 'hunt:wooden_rifle', ...png('fake-png-bytes') });

        const result = await getItemImageAttachment('hunt:wooden_rifle');

        expect(result).not.toBeNull();
        expect(result.url).toBe('attachment://item-hunt_wooden_rifle.png');
        expect(result.attachment.name).toBe('item-hunt_wooden_rifle.png');
        expect(ItemImage.find).toHaveBeenCalledWith({ guildId: null, itemId: 'hunt:wooden_rifle' });
    });

    test('leaves plain itemIds untouched', async () => {
        rows({ guildId: null, itemId: 'plain_item', imageData: Buffer.from('x'), imageType: 'image/jpeg' });

        const result = await getItemImageAttachment('plain_item');

        expect(result.url).toBe('attachment://item-plain_item.jpg');
    });

    test('returns null when no image is stored anywhere', async () => {
        const result = await getItemImageAttachment('hunt:nonexistent');

        expect(result).toBeNull();
    });

    // #888. The shop image is a row in the same collection now, under a
    // `shop:` key, so all three candidates are one query rather than a read of
    // the whole guild settings document followed by up to two more.
    test('asks for every candidate at once, not one round trip at a time', async () => {
        await getItemImageAttachment('fish:bamboo_rod', 'g1');

        expect(ItemImage.find).toHaveBeenCalledTimes(1);
        expect(ItemImage.find).toHaveBeenCalledWith({
            guildId: { $in: ['g1', null] },
            itemId: { $in: ['shop:fish:bamboo_rod', 'fish:bamboo_rod'] },
        });
    });

    test('prefers the guild shop image over both activity images', async () => {
        // An admin who uploaded artwork for their own shop item gets that,
        // whatever the activity catalog carries for the same id.
        rows(
            { guildId: null, itemId: 'fish:bamboo_rod', ...png('shared') },
            { guildId: 'g1', itemId: 'fish:bamboo_rod', ...png('guild-activity') },
            { guildId: 'g1', itemId: 'shop:fish:bamboo_rod', imageData: Buffer.from('shop'), imageType: 'image/gif' },
        );

        const result = await getItemImageAttachment('fish:bamboo_rod', 'g1');

        expect(result.attachment.name).toBe('item-fish_bamboo_rod.gif');
    });

    // #561: activity images belong to a guild now. The guild's own row is what
    // it must render — the shared pre-#561 row is a fallback, not a peer.
    test("prefers the guild's own activity image over the shared one", async () => {
        rows(
            { guildId: null, itemId: 'mine:stone_pickaxe', imageData: Buffer.from('shared'), imageType: 'image/gif' },
            { guildId: 'g1', itemId: 'mine:stone_pickaxe', ...png('guild') },
        );

        const result = await getItemImageAttachment('mine:stone_pickaxe', 'g1');

        expect(result.attachment.name).toBe('item-mine_stone_pickaxe.png');
    });

    test('falls back to the shared image when this guild has none of its own', async () => {
        rows({ guildId: null, itemId: 'mine:stone_pickaxe', imageData: Buffer.from('shared'), imageType: 'image/gif' });

        const result = await getItemImageAttachment('mine:stone_pickaxe', 'g1');

        expect(result.attachment.name).toBe('item-mine_stone_pickaxe.gif');
    });

    test('skips a row whose image is empty rather than rendering nothing', async () => {
        // A zero-length Buffer is not artwork, and taking it because it ranked
        // highest would hide the image that is actually there.
        rows(
            { guildId: 'g1', itemId: 'shop:sword', imageData: Buffer.alloc(0), imageType: 'image/png' },
            { guildId: null, itemId: 'sword', imageData: Buffer.from('shared'), imageType: 'image/gif' },
        );

        const result = await getItemImageAttachment('sword', 'g1');

        expect(result.attachment.name).toBe('item-sword.gif');
    });

    // #672's alt text. A shop item's name is whatever an admin typed into the
    // dashboard, and Discord rejects an upload whose description runs past 1024
    // characters — so the whole message fails over the caption on the thumbnail.
    describe('alt text', () => {
        beforeEach(() => {
            ItemImage.find.mockImplementation(async () => [{ guildId: null, itemId: 'x', ...png('fake-png-bytes') }]);
        });

        test('names the item when the caller passes one', async () => {
            const result = await getItemImageAttachment('sword', null, { label: 'Iron Sword' });
            expect(result.attachment.description).toBe('Artwork for the item Iron Sword.');
        });

        test('falls back to the id, which is all some callers have', async () => {
            const result = await getItemImageAttachment('hunt:wooden_rifle');
            expect(result.attachment.description).toBe('Artwork for the item hunt:wooden_rifle.');
        });

        test('caps an overlong label at what Discord will accept', async () => {
            const result = await getItemImageAttachment('sword', null, { label: 'A'.repeat(5_000) });
            expect(result.attachment.description).toHaveLength(1024);
        });

        // The prefix counts too, so capping the label alone would leave the
        // finished string 25 characters over the limit.
        test('counts the prefix against the cap, not just the label', async () => {
            const result = await getItemImageAttachment('sword', null, { label: 'A'.repeat(1024) });
            expect(result.attachment.description).toHaveLength(1024);
        });

        test('caps a fallback id that is overlong too', async () => {
            const result = await getItemImageAttachment('x'.repeat(5_000));
            expect(result.attachment.description).toHaveLength(1024);
        });
    });
});
