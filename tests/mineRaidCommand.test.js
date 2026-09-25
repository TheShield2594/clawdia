'use strict';

// /mine raid, driven through the handler: the gates ahead of the transfer, the
// Mine Lock, and the result card.

const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/grindProfile', () => ({
    attachGrind: jest.fn(async () => {}),
    persistGrindIfNew: jest.fn(async () => {}),
}));
jest.mock('../src/utils/activeGameLock', () => ({
    tryAcquire: jest.fn(async () => 'lease-1'),
    release: jest.fn(async () => {}),
}));

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const GrindProfile = require('../src/models/GrindProfile');
const { handleRaid } = require('../src/commands/economy/mine/raid');
const { RAID_COOLDOWN_MS } = require('../src/data/mineData');

function player(userId, mining = {}) {
    return {
        userId,
        guildId: 'guild-1',
        balance: 0,
        mining: {
            pickaxes: [{ name: 'Iron Pickaxe', tier: 2, status: 'good', currentDurability: 50, maxDurability: 50, baseDurability: 50 }],
            equippedPickaxeIndex: 0,
            ...mining,
        },
        markModified: jest.fn(),
        save: jest.fn().mockResolvedValue(undefined),
    };
}

const target = { id: 'user-2', username: 'digger', send: jest.fn().mockResolvedValue(undefined) };

function seed(raider, defender) {
    User.findOneAndUpdate.mockResolvedValue(raider);
    User.findOne.mockResolvedValue(defender);
}

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue({ economy: { enabled: true, currency: '🪙' } });
});

describe('the Mine Lock', () => {
    test('is not spent on a mine with nothing exposed', async () => {
        seed(player('user-1'), player('user-2', { mineLockActive: true, materials: { coal_dust: 1 } }));
        const interaction = makeInteraction({ options: { target } });

        await handleRaid(interaction);

        expect(repliedText(interaction)).toContain('nothing worth raiding');
        expect(GrindProfile.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('absorbs a raid on a mine that has something to take', async () => {
        seed(player('user-1'), player('user-2', { mineLockActive: true, materials: { coal_dust: 5 } }));
        GrindProfile.findOneAndUpdate.mockResolvedValueOnce({ data: { mineLockActive: false } });
        const interaction = makeInteraction({ options: { target } });

        await handleRaid(interaction);

        expect(repliedText(interaction)).toContain('Mine Lock Triggered');
        expect(GrindProfile.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ 'data.mineLockActive': true });
    });
});

describe('waits', () => {
    test('the raider cooldown is a live countdown', async () => {
        const lastRaidSent = new Date(Date.now() - 60_000);
        seed(player('user-1', { lastRaidSent }), player('user-2', { materials: { coal_dust: 5 } }));
        const interaction = makeInteraction({ options: { target } });

        await handleRaid(interaction);

        const at = Math.ceil((lastRaidSent.getTime() + RAID_COOLDOWN_MS) / 1000);
        expect(repliedText(interaction)).toContain(`<t:${at}:R>`);
    });
});

describe('a raid that lands', () => {
    test('reports the haul and both countdowns as fields', async () => {
        seed(player('user-1'), player('user-2', { materials: { coal_dust: 5 } }));
        GrindProfile.findOneAndUpdate
            .mockResolvedValueOnce({ data: { lastRaidReceived: null } })   // defender debit
            .mockResolvedValueOnce({ data: {} });                          // raider credit
        const interaction = makeInteraction({ options: { target } });

        await handleRaid(interaction);

        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.title).toContain('Mine Raided');
        expect(embed.fields.map(f => f.name)).toEqual(['Stolen', 'Next raid', 'Their shield']);
        expect(embed.fields[1].value).toMatch(/^<t:\d+:R>$/);
        expect(embed.fields[2].value).toMatch(/<t:\d+:R>/);
    });
});
