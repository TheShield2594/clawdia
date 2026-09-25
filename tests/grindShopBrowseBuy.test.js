'use strict';

// The shop browse view's "Buy an item…" select hands `handleBuy` a select-menu
// interaction and the item id. A select-menu interaction has no `options`, and
// all three grind shops read the quantity off it anyway, so every click-to-buy
// threw before the confirmation was shown.

jest.mock('../src/utils/itemImageHelper', () => ({ attachItemThumbnail: jest.fn(async () => []) }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/grindProfile', () => ({ persistGrindIfNew: jest.fn(async () => {}) }));

const { handleBuy: mineBuy } = require('../src/commands/economy/mine/shop/buy');
const { handleBuy: fishBuy } = require('../src/commands/economy/fish/shop/buy');
const { handleBuy: huntBuy } = require('../src/commands/economy/hunt/shop/buy');
const { CONSUMABLES } = require('../src/data/mineData');

/** A select-menu interaction: no `options`, and a reply the confirm collector hangs off. */
function selectInteraction() {
    const replies = [];
    const message = {
        createMessageComponentCollector: () => {
            const handlers = {};
            const collector = { on(event, fn) { (handlers[event] ??= []).push(fn); return this; }, stop() {} };
            setTimeout(() => (handlers.end ?? []).forEach(fn => fn(new Map(), 'time')), 0);
            return collector;
        },
    };
    return {
        id: 'select-1',
        user: { id: 'user-1' },
        guild: { id: 'guild-1' },
        replies,
        reply: jest.fn(async payload => { replies.push(payload); return { resource: { message } }; }),
        editReply: jest.fn(async payload => { replies.push(payload); }),
    };
}

test('mine: a click-to-buy opens the confirmation for one of the item', async () => {
    const interaction = selectInteraction();
    const user = { balance: 100_000, mining: { consumables: {}, charges: {} } };

    await mineBuy(interaction, user, '🪙', { itemId: 'ore_magnet' });

    const confirm = interaction.replies[0].embeds[0].data;
    expect(confirm.title).toContain('Confirm Purchase');
    expect(confirm.fields.find(f => f.name === 'Total Cost').value).toBe(`🪙${CONSUMABLES.ore_magnet.cost.toLocaleString()}`);
});

test.each([['fish', fishBuy], ['hunt', huntBuy]])('%s: a click-to-buy does not read options off the select', async (_name, handleBuy) => {
    const interaction = selectInteraction();
    // An unknown id fails fast after the quantity is read, which is the line
    // that threw — no shop data or database needed to reach it.
    await expect(handleBuy(interaction, { balance: 0, fishing: {}, hunting: {} }, '🪙', { itemId: 'no_such_item' })).resolves.not.toThrow();
    expect(interaction.reply).toHaveBeenCalled();
});
