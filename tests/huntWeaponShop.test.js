'use strict';

const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn().mockResolvedValue({ economy: { enabled: true, currency: '💰' } }),
}));

jest.mock('../src/models/GrindProfile', () => {
    function MockGrindProfile(fields) {
        Object.assign(this, fields);
        this.isNew = true;
        this.saved = 0;
        this.modifiedPaths = [];
    }
    MockGrindProfile.prototype.markModified = function (p) { this.modifiedPaths.push(p); };
    MockGrindProfile.prototype.save = async function () { this.saved += 1; this.isNew = false; return this; };

    const existingHuntProfile = new MockGrindProfile({
        guildId: 'g1', userId: 'u1', system: 'hunt',
        data: {
            stamina: 10, xp: 500, level: 4, weapons: [
                { name: 'Wooden Rifle', tier: 1, slug: 'wooden_rifle', currentDurability: 80, maxDurability: 80, baseDurability: 80, repairCount: 0, upgrade: null, status: 'good', acquiredAt: new Date() }
            ], equippedWeaponIndex: 0, ammo: {}, consumables: {}, unlockedZones: [], activeZone: 'forest',
        },
    });
    existingHuntProfile.isNew = false;

    MockGrindProfile.find = jest.fn().mockResolvedValue([existingHuntProfile]);
    MockGrindProfile.findOneAndUpdate = jest.fn().mockImplementation(async (query, update) => {
        if (update.$push) {
            existingHuntProfile.data.weapons.push(update.$push['data.weapons']);
        }
        if (update.$set) {
            Object.assign(existingHuntProfile.data, Object.fromEntries(
                Object.entries(update.$set).map(([k, v]) => [k.replace('data.', ''), v])
            ));
        }
        return existingHuntProfile;
    });
    MockGrindProfile.updateOne = jest.fn().mockResolvedValue({});
    MockGrindProfile.__existingHuntProfile = existingHuntProfile;
    return MockGrindProfile;
});

jest.mock('../src/models/User', () => {
    const fakeUser = {
        userId: 'u1', guildId: 'g1', balance: 1000000,
        save: jest.fn().mockResolvedValue('ok'),
        markModified: jest.fn(),
        isModified: jest.fn().mockReturnValue(false),
    };
    return {
        findOneAndUpdate: jest.fn().mockImplementation(async (query) => {
            if (query.balance) fakeUser.balance -= 2500;
            return fakeUser;
        }),
        findOne: jest.fn().mockResolvedValue(fakeUser),
        updateOne: jest.fn().mockResolvedValue({}),
        __fakeUser: fakeUser,
    };
});

jest.mock('../src/models/ItemImage', () => ({
    findOne: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/utils/shopBrowse.js', () => ({}));
jest.mock('canvas', () => ({
    createCanvas: () => ({ getContext: () => ({}), toBuffer: () => Buffer.from('') }),
    loadImage: jest.fn(),
    registerFont: jest.fn(),
}));

const huntCommand = require('../src/commands/economy/hunt.js');
const User = require('../src/models/User');
const GrindProfile = require('../src/models/GrindProfile');

beforeEach(() => {
    jest.clearAllMocks();
    GrindProfile.__existingHuntProfile.data.weapons = [
        { name: 'Wooden Rifle', tier: 1, slug: 'wooden_rifle', currentDurability: 80, maxDurability: 80, baseDurability: 80, repairCount: 0, upgrade: null, status: 'good', acquiredAt: new Date() }
    ];
    User.__fakeUser.balance = 1000000;
});

test('hunt shop weapon -> confirm purchase does not throw, even with a colon-keyed item image', async () => {
    let collectHandler;
    const editReplyCalls = [];
    const fakeReply = {
        createMessageComponentCollector: () => ({
            on: (event, cb) => { if (event === 'collect') collectHandler = cb; },
            stop: () => {},
        }),
    };

    const interaction = {
        guild: { id: 'g1' },
        user: { id: 'u1', username: 'tester' },
        options: {
            getSubcommandGroup: () => 'shop',
            getSubcommand: () => 'weapon',
            getString: (name) => name === 'type' ? 'iron_rifle' : null,
            getBoolean: () => true,
        },
        reply: jest.fn(async () => fakeReply),
        editReply: jest.fn(async (payload) => { editReplyCalls.push(payload); }),
    };

    await huntCommand.execute(interaction);
    expect(collectHandler).toBeDefined();

    // execute() already upserts the user once before the button exists; only
    // count calls made during the confirm click itself.
    const userCallsBeforeConfirm = User.findOneAndUpdate.mock.calls.length;
    const grindCallsBeforeConfirm = GrindProfile.findOneAndUpdate.mock.calls.length;

    const btn = {
        user: { id: 'u1' },
        customId: 'buygun_confirm',
        deferUpdate: jest.fn().mockResolvedValue(),
        editReply: jest.fn(async (payload) => { editReplyCalls.push(payload); }),
        update: jest.fn(async (payload) => { editReplyCalls.push(payload); }),
    };

    await collectHandler(btn);

    const failureMsg = editReplyCalls.find(c => c.content === 'Something went wrong. Please try again.');
    expect(failureMsg).toBeUndefined();

    const successEmbed = editReplyCalls.find(c => c.embeds?.[0]?.data?.title?.includes('Purchased'));
    expect(successEmbed).toBeDefined();

    expect(User.findOneAndUpdate.mock.calls.length).toBe(userCallsBeforeConfirm + 1);
    expect(GrindProfile.findOneAndUpdate.mock.calls.length).toBe(grindCallsBeforeConfirm + 1);
    expect(User.findOneAndUpdate.mock.invocationCallOrder[userCallsBeforeConfirm])
        .toBeLessThan(GrindProfile.findOneAndUpdate.mock.invocationCallOrder[grindCallsBeforeConfirm]);
});

// Weapon purchases are guarded by a `balance: { $gte: cost }` filter — the buyer
// never ends a purchase path in the red.
afterEach(() => {
    expectNonNegativeBalance(require('../src/models/User').__fakeUser, 'hunt weapon shop');
});
