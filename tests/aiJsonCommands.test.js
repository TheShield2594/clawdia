'use strict';

// What /forge and /questgen do with what the model sends back (#830).
//
// Both commands take the user's coins *before* the AI call, because the call
// takes seconds and two concurrent invocations would otherwise both pass the
// balance check. That makes everything after the call a compensation problem:
// a model that returns prose instead of JSON, a provider that is rate-limited,
// a refund write that fails — each one decides whether the user is left short.
// None of it was covered by a test.
//
// The other half is the sanitising: a quest's mechanic and target come straight
// out of model output, and a `mechanic` the quest engine has never heard of is a
// quest that can never be completed.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/AiItem', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/AiQuest', () => ({ findOne: jest.fn(), create: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../src/utils/inventoryGrant', () => ({ grantInventoryItem: jest.fn(async () => true) }));

const mockGetCompletion = jest.fn();
jest.mock('../src/services/aiService', () => ({
    resolveProviderConfig: () => ({ provider: 'mock', model: 'mock-1', apiKey: 'k' }),
    getCompletion: (...args) => mockGetCompletion(...args),
}));

const User = require('../src/models/User');
const Guild = require('../src/models/Guild');
const AiItem = require('../src/models/AiItem');
const AiQuest = require('../src/models/AiQuest');

const forge = require('../src/commands/economy/forge');
const questgen = require('../src/commands/community/questgen');

const GUILD_ID = 'g1';
const USER_ID = 'u1';

function makeInteraction(options = {}) {
    return {
        user: { id: USER_ID },
        guild: { id: GUILD_ID },
        channelId: 'c1',
        options: { getString: name => options[name] ?? null },
        deferReply: jest.fn(async () => {}),
        editReply: jest.fn(async payload => payload),
    };
}

// What the user was told, whichever shape the command replied in.
const replyText = interaction => {
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    return typeof payload === 'string' ? payload : payload?.content ?? '';
};

const lastEmbed = interaction => {
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    return payload?.embeds?.[0]?.data ?? null;
};

/** Every write that hands coins back, with the amount it returned. */
const refunds = () => [...User.updateOne.mock.calls, ...User.findOneAndUpdate.mock.calls]
    .map(call => call[1]?.$inc?.balance)
    .filter(amount => typeof amount === 'number' && amount > 0);

let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    Guild.findOne.mockResolvedValue({
        guildId: GUILD_ID,
        ai: { enabled: true, provider: 'mock' },
        quests: { enabled: true },
        economy: { currency: '💰' },
    });
});

afterEach(() => errorSpy.mockRestore());

describe('/forge', () => {
    const COMMON_COST = 500;

    beforeEach(() => {
        User.findOne.mockResolvedValue({ userId: USER_ID, guildId: GUILD_ID, balance: 10_000, level: 4 });
        // The guarded debit that takes the cost up front.
        User.findOneAndUpdate.mockResolvedValue({ userId: USER_ID, guildId: GUILD_ID, balance: 9_500, level: 4 });
        User.updateOne.mockResolvedValue({ modifiedCount: 1 });
        AiItem.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
        AiItem.create.mockResolvedValue({});
    });

    const run = () => {
        const interaction = makeInteraction({ rarity: 'common' });
        return forge.execute(interaction).then(() => interaction);
    };

    test('forges the item the model described', async () => {
        mockGetCompletion.mockResolvedValue(
            '```json\n{"name":"Ember Fang","emoji":"🔥","description":"It bites.","lore":"Forged in ash."}\n```'
        );

        const interaction = await run();

        expect(AiItem.create).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Ember Fang', emoji: '🔥', rarity: 'Common',
        }));
        expect(lastEmbed(interaction).title).toMatch(/Common Item Forged/);
        expect(refunds()).toEqual([]);
    });

    // The retry the token budgets exist for, end to end: the first answer is
    // cut off mid-string, the second is whole, and the user pays once.
    test('a truncated first answer costs a retry, not the user\'s coins', async () => {
        mockGetCompletion
            .mockResolvedValueOnce('{"name":"Ember')
            .mockResolvedValueOnce('{"name":"Ember Fang","emoji":"🔥"}');

        await run();

        expect(mockGetCompletion).toHaveBeenCalledTimes(2);
        expect(AiItem.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ember Fang' }));
        expect(refunds()).toEqual([]);
    });

    test('refunds exactly what it charged when the model never returns JSON', async () => {
        mockGetCompletion.mockResolvedValue('I would rather not.');

        const interaction = await run();

        expect(AiItem.create).not.toHaveBeenCalled();
        expect(refunds()).toEqual([COMMON_COST]);
        expect(replyText(interaction)).toMatch(/refunded/);
    });

    // The refund is what the message promises, so the message follows the write
    // rather than the intent: a swallowed failure used to tell the user their
    // coins were back when they were not.
    test('says the coins are gone when the refund did not land', async () => {
        mockGetCompletion.mockRejectedValue(new Error('provider down'));
        User.updateOne.mockResolvedValue({ modifiedCount: 0 });

        const interaction = await run();

        expect(replyText(interaction)).toMatch(/refund failed to process/);
        expect(replyText(interaction)).not.toMatch(/have been refunded/);
    });

    test('and when the refund write itself throws', async () => {
        mockGetCompletion.mockRejectedValue(new Error('provider down'));
        User.updateOne.mockRejectedValue(new Error('mongo is down'));

        const interaction = await run();

        expect(replyText(interaction)).toMatch(/contact a server admin/);
    });

    // A limit refusal is the server's own setting talking. Told "the forge
    // misfired", the user retries straight into the same wall.
    test('names the server\'s AI limit rather than blaming the forge', async () => {
        mockGetCompletion.mockRejectedValue(
            Object.assign(new Error('limit'), { rateLimited: true, limit: 5, windowMin: 10 })
        );

        const interaction = await run();

        expect(replyText(interaction)).toMatch(/AI limit has been reached \(5 per 10m\)/);
        expect(refunds()).toEqual([COMMON_COST]);
    });

    test('refunds when the item cannot be saved either', async () => {
        mockGetCompletion.mockResolvedValue('{"name":"Ember Fang"}');
        AiItem.create.mockRejectedValue(new Error('write failed'));

        const interaction = await run();

        expect(refunds()).toEqual([COMMON_COST]);
        expect(replyText(interaction)).toMatch(/failed to save/);
    });
});

describe('/questgen', () => {
    const COST = 200;

    beforeEach(() => {
        User.findOne.mockResolvedValue({
            userId: USER_ID, guildId: GUILD_ID, balance: 5_000, level: 7, quests: [],
        });
        User.findOneAndUpdate.mockResolvedValue({ userId: USER_ID, guildId: GUILD_ID, balance: 4_800 });
        AiQuest.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
        AiQuest.create.mockResolvedValue({});
        AiQuest.deleteOne.mockResolvedValue({});
    });

    const run = () => {
        const interaction = makeInteraction();
        return questgen.execute(interaction).then(() => interaction);
    };

    const savedQuest = () => AiQuest.create.mock.calls.at(-1)?.[0];

    test('keeps a mechanic and target the engine understands', async () => {
        mockGetCompletion.mockResolvedValue(
            '{"name":"The Deep Vein","lore":"Something stirs below.","description":"Mine 14 times","mechanic":"mining","target":14,"emoji":"⛏️"}'
        );

        await run();

        expect(savedQuest()).toMatchObject({ mechanic: 'mining', target: 14, name: 'The Deep Vein' });
    });

    // A mechanic nothing tracks is a quest that can never be completed, and the
    // user has already paid for it.
    test('falls back to a real mechanic when the model invents one', async () => {
        mockGetCompletion.mockResolvedValue('{"name":"Astral Drift","mechanic":"teleport","target":12}');

        await run();

        expect(savedQuest().mechanic).toBe('hunt');
    });

    test.each([
        ['mining', 400, 20],    // above the mechanic's ceiling
        ['mining', 1, 5],       // below its floor
        ['economy', 999_999, 1000],
        ['social', 20, 20],     // exactly on the floor, left alone
        ['hunt', 12.6, 13],     // a fractional target is rounded, not floored into nonsense
    ])('clamps a %s target of %s to %s', async (mechanic, target, expected) => {
        mockGetCompletion.mockResolvedValue(JSON.stringify({ name: 'Q', mechanic, target }));

        await run();

        expect(savedQuest()).toMatchObject({ mechanic, target: expected });
    });

    test('gives a non-numeric target a sane default inside the range', async () => {
        mockGetCompletion.mockResolvedValue('{"name":"Q","mechanic":"social","target":"lots"}');

        await run();

        expect(savedQuest()).toMatchObject({ mechanic: 'social', target: 20 });
    });

    test('refunds the cost when the model never returns JSON', async () => {
        mockGetCompletion.mockResolvedValue('Here is a quest idea: go fishing!');

        const interaction = await run();

        expect(AiQuest.create).not.toHaveBeenCalled();
        expect(refunds()).toEqual([COST]);
        expect(replyText(interaction)).toMatch(/refunded/);
    });

    test('says so when the refund fails', async () => {
        mockGetCompletion.mockRejectedValue(new Error('provider down'));
        User.findOneAndUpdate.mockImplementation(async (_filter, update) => (
            update?.$inc?.balance > 0 ? Promise.reject(new Error('mongo is down')) : { balance: 4_800 }
        ));

        const interaction = await run();

        expect(replyText(interaction)).toMatch(/contact a server admin/);
    });

    test('names the server\'s AI limit rather than blaming the forge', async () => {
        mockGetCompletion.mockRejectedValue(
            Object.assign(new Error('limit'), { rateLimited: true, limit: 3, windowMin: 15 })
        );

        const interaction = await run();

        expect(replyText(interaction)).toMatch(/AI limit has been reached \(3 per 15m\)/);
    });

    // The cap is re-checked atomically with the push, because the earlier read
    // could be stale. Losing that race must not cost the user 200 coins.
    test('refunds when a concurrent quest won the cap race', async () => {
        mockGetCompletion.mockResolvedValue('{"name":"Q","mechanic":"hunt","target":10}');
        User.findOneAndUpdate.mockImplementation(async (_filter, update) => (
            update?.$push ? null : { balance: 4_800 }
        ));

        const interaction = await run();

        expect(AiQuest.deleteOne).toHaveBeenCalledWith({ questId: expect.any(String) });
        expect(refunds()).toEqual([COST]);
        expect(replyText(interaction)).toMatch(/already have an active Legendary Quest/);
    });
});
