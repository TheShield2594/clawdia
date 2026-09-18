'use strict';

// Covers the click-to-buy select runShopBrowse renders when a page opts in with
// an onBuy handler (#1049 Phase 1). The banner renderer and image store are
// mocked so this exercises the component wiring and the collector dispatch
// alone, not the canvas or the database.

jest.mock('../src/models/ItemImage', () => ({
    find: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/utils/shopBanner', () => ({
    renderCategoryBanner: jest.fn().mockResolvedValue(Buffer.from('banner')),
    getTheme: jest.fn(),
}));

const { runShopBrowse } = require('../src/utils/shopBrowse');

// Builds a fake interaction whose editReply captures each payload and whose
// reply message hands back the collector's collect/end callbacks.
function buildInteraction() {
    const state = { editReplies: [], collect: null, end: null };
    const message = {
        createMessageComponentCollector: () => ({
            on: (event, cb) => {
                if (event === 'collect') state.collect = cb;
                if (event === 'end') state.end = cb;
            },
            stop: () => {},
        }),
    };
    const interaction = {
        guild:   { id: 'g1', name: 'Test Guild' },
        guildId: 'g1',
        user:    { id: 'u1' },
        deferred: false,
        replied:  false,
        deferReply: jest.fn().mockResolvedValue(),
        editReply:  jest.fn(async (payload) => { state.editReplies.push(payload); return message; }),
    };
    return { interaction, state };
}

// Flattens a components payload into the JSON discord.js would send.
function componentsJson(payload) {
    return (payload.components || []).map(row => row.toJSON());
}

function buyPage(overrides = {}) {
    return {
        id:       'ammo',
        label:    'Ammunition',
        emoji:    '🔶',
        subtitle: 'Keep your rifle fed.',
        items: [
            { name: 'Standard Rounds', buyId: 'ammo_std', price: 100, imageId: 'hunt:ammo_std' },
            { name: 'Hollow Points',   buyId: 'ammo_hp',  price: 250, imageId: 'hunt:ammo_hp'  },
        ],
        listText: 'buy them',
        ...overrides,
    };
}

const baseConfig = (pages) => ({
    activity: 'hunt',
    title:    'Hunt Shop',
    currency: '💰',
    guildId:  'g1',
    pages,
});

describe('runShopBrowse buy select', () => {
    test('renders a shop_buy select listing the page\'s buyable items', async () => {
        const onBuy = jest.fn();
        const { interaction, state } = buildInteraction();

        await runShopBrowse(interaction, baseConfig([buyPage({ onBuy })]));

        const rows = componentsJson(state.editReplies[0]);
        const buyRow = rows.find(r => r.components?.[0]?.custom_id === 'shop_buy');
        expect(buyRow).toBeTruthy();

        const select = buyRow.components[0];
        expect(select.options.map(o => o.value)).toEqual(['ammo_std', 'ammo_hp']);
        expect(select.options[0].label).toBe('Standard Rounds');
        expect(select.options[0].description).toBe('💰100');
    });

    test('omits the buy select when the page has no onBuy', async () => {
        const { interaction, state } = buildInteraction();

        await runShopBrowse(interaction, baseConfig([buyPage({ onBuy: undefined })]));

        const rows = componentsJson(state.editReplies[0]);
        expect(rows.some(r => r.components?.[0]?.custom_id === 'shop_buy')).toBe(false);
    });

    test('selecting an item calls onBuy with the interaction and resets the buy select', async () => {
        const onBuy = jest.fn().mockResolvedValue();
        const { interaction, state } = buildInteraction();

        await runShopBrowse(interaction, baseConfig([buyPage({ onBuy })]));
        expect(interaction.editReply).toHaveBeenCalledTimes(1); // initial render only

        const btn = {
            user: { id: 'u1' },
            customId: 'shop_buy',
            values: ['ammo_hp'],
            reply: jest.fn().mockResolvedValue(),
            deferUpdate: jest.fn().mockResolvedValue(),
        };
        await state.collect(btn);

        expect(onBuy).toHaveBeenCalledWith(btn, 'ammo_hp');
        // The purchase owns its own reply on the component interaction — the
        // browse view is never deferred or updated through btn.
        expect(btn.deferUpdate).not.toHaveBeenCalled();

        // A follow-up components-only edit (through the original interaction)
        // resets the select so the same item can be bought again, without
        // re-rendering the banner (no embeds/files in the payload).
        expect(interaction.editReply).toHaveBeenCalledTimes(2);
        const refresh = state.editReplies[1];
        expect(Object.keys(refresh)).toEqual(['components']);
        expect(refresh.components.some(r => r.toJSON().components?.[0]?.custom_id === 'shop_buy')).toBe(true);
    });

    test('a non-owner cannot use the buy select', async () => {
        const onBuy = jest.fn();
        const { interaction, state } = buildInteraction();

        await runShopBrowse(interaction, baseConfig([buyPage({ onBuy })]));

        const btn = {
            user: { id: 'intruder' },
            customId: 'shop_buy',
            values: ['ammo_std'],
            reply: jest.fn().mockResolvedValue(),
            deferUpdate: jest.fn().mockResolvedValue(),
        };
        await state.collect(btn);

        expect(onBuy).not.toHaveBeenCalled();
        expect(btn.reply).toHaveBeenCalledTimes(1);
    });
});

const sectionsConfig = () => ({
    title:    'My Server Shop',
    currency: '💰',
    guildId:  'g1',
    sections: [
        {
            id: 'shop', label: 'Server Shop', emoji: '🛒', activity: 'shop_common', title: 'My Server Shop',
            pages: [{ id: 'common', label: 'Common', emoji: '⚪', items: [{ name: 'Pet Food', imageId: 'pet_food' }], listText: 'server' }],
        },
        {
            id: 'hunt', label: 'Hunt', emoji: '🏹', activity: 'hunt', title: 'Hunt Shop',
            pages: [
                { id: 'weapons', label: 'Weapons', emoji: '🔫', items: [{ name: 'Rifle', imageId: 'hunt:rifle' }], listText: 'weapons' },
                { id: 'ammo', label: 'Ammo', emoji: '🔶', items: [{ name: 'Rounds', buyId: 'ammo_std', price: 100, imageId: 'hunt:ammo' }], listText: 'ammo', onBuy: jest.fn() },
            ],
        },
    ],
});

describe('runShopBrowse sections', () => {
    test('renders a section select listing every section', async () => {
        const { interaction, state } = buildInteraction();

        await runShopBrowse(interaction, sectionsConfig());

        const rows = componentsJson(state.editReplies[0]);
        const sectionRow = rows.find(r => r.components?.[0]?.custom_id === 'shop_section');
        expect(sectionRow).toBeTruthy();
        expect(sectionRow.components[0].options.map(o => o.label)).toEqual(['Server Shop', 'Hunt']);
        // Category select shows the active section's pages (server → one 'Common').
        const catRow = rows.find(r => r.components?.[0]?.custom_id === 'shop_cat');
        expect(catRow.components[0].options.map(o => o.label)).toEqual(['Common']);
    });

    test('switching section resets to its first page and shows its categories', async () => {
        const { interaction, state } = buildInteraction();

        await runShopBrowse(interaction, sectionsConfig());

        const btn = {
            user: { id: 'u1' },
            customId: 'shop_section',
            values: ['1'], // Hunt
            deferUpdate: jest.fn().mockResolvedValue(),
        };
        await state.collect(btn);

        expect(btn.deferUpdate).toHaveBeenCalledTimes(1);
        const rows = componentsJson(state.editReplies.at(-1));
        const catRow = rows.find(r => r.components?.[0]?.custom_id === 'shop_cat');
        // Hunt's categories, first page (Weapons) selected by default.
        expect(catRow.components[0].options.map(o => o.label)).toEqual(['Weapons', 'Ammo']);
        expect(catRow.components[0].options.find(o => o.default).label).toBe('Weapons');
    });

    test('single-section (flat pages) shows no section select', async () => {
        const { interaction, state } = buildInteraction();

        await runShopBrowse(interaction, baseConfig([buyPage({ onBuy: jest.fn() })]));

        const rows = componentsJson(state.editReplies[0]);
        expect(rows.some(r => r.components?.[0]?.custom_id === 'shop_section')).toBe(false);
    });
});
