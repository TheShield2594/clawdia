'use strict';

// /shop view assembles one storefront from four shops (#1049 Phase 2): the
// server shop plus Hunt / Fish / Mine, gated on the economy being on. The grind
// page-builders and their profile loading are mocked — this proves the section
// assembly and gating, not the grind page contents (those have their own suites).

let mockWorld;

function mockQuery(value) {
    return {
        lean: async () => value,
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    };
}

jest.mock('../src/models/Guild', () => ({
    findOneAndUpdate: jest.fn(() => mockWorld.guild),
    findOne: jest.fn(() => mockQuery(mockWorld.guild)),
    updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

jest.mock('../src/models/User', () => ({
    findOneAndUpdate: jest.fn(() => mockWorld.user),
    findOne: jest.fn(() => mockQuery(mockWorld.user)),
    updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/models/Transaction', () => ({
    create: jest.fn(),
    aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/utils/itemImageHelper', () => ({
    getItemImageAttachment: jest.fn().mockResolvedValue(null),
}));

// Grind loading and page-building are out of scope here — stub them so the view
// path just collects whatever pages each builder returns.
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/huntService', () => ({ ensureHuntData: jest.fn() }));
jest.mock('../src/services/fishService', () => ({ ensureFishingData: jest.fn() }));
jest.mock('../src/services/mineService', () => ({ ensureMineData: jest.fn() }));
jest.mock('../src/commands/economy/hunt/shop/list', () => ({
    buildHuntShopPages: jest.fn(() => [{ id: 'weapons', label: 'Weapons', items: [], listText: '' }]),
}));
jest.mock('../src/commands/economy/fish/shop/list', () => ({
    buildFishShopPages: jest.fn(() => [{ id: 'rods', label: 'Rods', items: [], listText: '' }]),
}));
jest.mock('../src/commands/economy/mine/shop/list', () => ({
    buildMineShopPages: jest.fn(() => [{ id: 'pickaxes', label: 'Pickaxes', items: [], listText: '' }]),
}));

const mockRunShopBrowse = jest.fn().mockResolvedValue();
jest.mock('../src/utils/shopBrowse', () => ({ runShopBrowse: mockRunShopBrowse, getTheme: jest.fn() }));

const shopCommand = require('../src/commands/economy/shop.js');

function buildWorld({ economyEnabled = true, hasServerItems = true } = {}) {
    return {
        guild: {
            guildId: 'g1',
            name: 'Test Guild',
            shopDefaultsSeeded: true,
            economy: { currency: '💰', enabled: economyEnabled },
            dynamicPricing: { enabled: false },
            shop: hasServerItems
                ? [{ _id: 'oid_kit', name: 'Repair Kit', itemId: 'repair_kit', description: '🔧 Fixes.', price: 100, stock: -1, roleId: null, demandScore: 0 }]
                : [],
            save: jest.fn().mockResolvedValue(true),
        },
        user: { userId: 'u1', guildId: 'g1', balance: 5_000, inventory: [], accountPrestige: { rank: 0 } },
    };
}

function viewInteraction() {
    return {
        guild:   { id: 'g1', name: 'Test Guild' },
        guildId: 'g1',
        user:    { id: 'u1', username: 'tester' },
        member:  { roles: { add: jest.fn() } },
        options: { getSubcommand: () => 'view' },
        reply:      jest.fn().mockResolvedValue(),
        deferReply: jest.fn().mockResolvedValue(),
        editReply:  jest.fn().mockResolvedValue(),
    };
}

beforeEach(() => { jest.clearAllMocks(); });

test('economy on: Server, Hunt, Fishing and Mining sections in order', async () => {
    mockWorld = buildWorld({ economyEnabled: true });
    await shopCommand.execute(viewInteraction());

    expect(mockRunShopBrowse).toHaveBeenCalledTimes(1);
    const config = mockRunShopBrowse.mock.calls[0][1];
    expect(config.sections.map(s => s.id)).toEqual(['shop', 'hunt', 'fish', 'mine']);
    expect(config.sections.map(s => s.label)).toEqual(['Server Shop', 'Hunt', 'Fishing', 'Mining']);
    expect(config.sections.map(s => s.activity)).toEqual(['shop_common', 'hunt', 'fish', 'mine']);
    // No flat pages when sections are used.
    expect(config.pages).toBeUndefined();
});

test('economy off: grind sections are skipped, only the server shop remains', async () => {
    mockWorld = buildWorld({ economyEnabled: false });
    await shopCommand.execute(viewInteraction());

    const config = mockRunShopBrowse.mock.calls[0][1];
    expect(config.sections.map(s => s.id)).toEqual(['shop']);
    expect(require('../src/commands/economy/hunt/shop/list').buildHuntShopPages).not.toHaveBeenCalled();
});
