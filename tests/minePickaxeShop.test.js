'use strict';

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

    const existingMiningProfile = new MockGrindProfile({
        guildId: 'g1', userId: 'u1', system: 'mining',
        data: {
            stamina: 10, xp: 500, level: 4, pickaxes: [
                { name: 'Wooden Pickaxe', tier: 1, slug: 'wooden_pickaxe', currentDurability: 80, maxDurability: 80, baseDurability: 80, repairCount: 0, upgrade: null, status: 'good', acquiredAt: new Date() }
            ], equippedPickaxeIndex: 0, charges: {}, consumables: {}, unlockedDepths: [],
        },
    });
    existingMiningProfile.isNew = false;

    MockGrindProfile.find = jest.fn().mockResolvedValue([existingMiningProfile]);
    MockGrindProfile.findOneAndUpdate = jest.fn().mockImplementation(async (query, update) => {
        if (update.$push) {
            existingMiningProfile.data.pickaxes.push(update.$push['data.pickaxes']);
        }
        return existingMiningProfile;
    });
    MockGrindProfile.updateOne = jest.fn().mockResolvedValue({});
    MockGrindProfile.__existingMiningProfile = existingMiningProfile;
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
            if (query.balance) fakeUser.balance -= 500;
            return fakeUser;
        }),
        findOne: jest.fn().mockResolvedValue(fakeUser),
        updateOne: jest.fn().mockResolvedValue({}),
        __fakeUser: fakeUser,
    };
});

jest.mock('../src/models/ItemImage', () => ({
    findOne: jest.fn().mockResolvedValue({ imageData: Buffer.from('fake-png'), imageType: 'image/png' }),
}));

const mineCommand = require('../src/commands/economy/mine.js');

test('mine shop pickaxe -> confirm purchase does not throw, even with a colon-keyed item image', async () => {
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
            getSubcommand: () => 'pickaxe',
            getString: (name) => name === 'type' ? 'iron_pickaxe' : null,
            getBoolean: () => true,
        },
        reply: jest.fn(async () => fakeReply),
        editReply: jest.fn(async (payload) => { editReplyCalls.push(payload); }),
    };

    await mineCommand.execute(interaction);
    expect(collectHandler).toBeDefined();

    const btn = {
        user: { id: 'u1' },
        customId: 'minepickaxe_confirm',
        deferUpdate: jest.fn().mockResolvedValue(),
        editReply: jest.fn(async (payload) => { editReplyCalls.push(payload); }),
        update: jest.fn(async (payload) => { editReplyCalls.push(payload); }),
    };

    await collectHandler(btn);

    const failureMsg = editReplyCalls.find(c => c.content === 'Something went wrong. Please try again.');
    expect(failureMsg).toBeUndefined();

    const successEmbed = editReplyCalls.find(c => c.embeds?.[0]?.data?.title?.includes('Purchased'));
    expect(successEmbed).toBeDefined();
});
