'use strict';

// The AI action executor posts model-authored text too, and one of its sends
// leaves the transport's guarded helpers entirely: the mod-log message built
// from the model's `suggest_mod_action` suggestion. It has to carry the same
// NO_MENTIONS policy as everything else the model writes (#818), or a user who
// talks the model into typing `@everyone` pings the mod-log channel.

jest.mock('../src/models/Reminder', () => ({
    countDocuments: jest.fn(async () => 0),
    create: jest.fn(async () => ({}))
}));

const mockGuildFindOne = jest.fn();
jest.mock('../src/models/Guild', () => ({
    findOne: (...args) => mockGuildFindOne(...args)
}));

const { executeAction } = require('../src/services/ai/actions');

function fakeMessage({ logChannel } = {}) {
    return {
        author: { id: 'u1' },
        guild: {
            id: 'g1',
            channels: { cache: { get: jest.fn(() => logChannel) } }
        },
        channel: { id: 'c1', send: jest.fn(async payload => payload) },
        member: { permissions: { has: jest.fn(() => true) } }
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGuildFindOne.mockResolvedValue({ moderation: { logChannelId: 'log1' } });
});

describe('suggest_mod_action', () => {
    test('the mod-log send parses no mentions out of the suggestion', async () => {
        const logChannel = { send: jest.fn(async payload => payload) };
        const message = fakeMessage({ logChannel });

        await executeAction(
            { type: 'suggest_mod_action', suggestion: '@everyone ban them all' },
            message
        );

        expect(logChannel.send).toHaveBeenCalledTimes(1);
        const [payload] = logChannel.send.mock.calls[0];
        // The text is posted as written — it is what the model said — but
        // Discord is told to parse no mentions out of it.
        expect(payload.content).toContain('@everyone ban them all');
        expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    test('a non-moderator does not reach the mod-log channel at all', async () => {
        const logChannel = { send: jest.fn(async payload => payload) };
        const message = fakeMessage({ logChannel });
        message.member.permissions.has = jest.fn(() => false);

        await executeAction({ type: 'suggest_mod_action', suggestion: 'x' }, message);

        expect(logChannel.send).not.toHaveBeenCalled();
    });
});

describe('a failed action is reported, not swallowed', () => {
    test('the channel is told, without pinging anybody', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const logChannel = { send: jest.fn(async () => { throw new Error('Missing Access'); }) };
        const message = fakeMessage({ logChannel });

        await executeAction({ type: 'suggest_mod_action', suggestion: 'x' }, message);

        expect(consoleSpy).toHaveBeenCalled();
        expect(message.channel.send).toHaveBeenCalledTimes(1);
        const [payload] = message.channel.send.mock.calls[0];
        expect(payload.content).toMatch(/couldn't deliver the mod suggestion/);
        expect(payload.allowedMentions).toEqual({ parse: [] });
        consoleSpy.mockRestore();
    });

    test('a failure report that itself fails does not throw', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockGuildFindOne.mockRejectedValue(new Error('db down'));
        const message = fakeMessage({});
        message.channel.send = jest.fn(async () => { throw new Error('Missing Access'); });

        await expect(
            executeAction({ type: 'suggest_mod_action', suggestion: 'x' }, message)
        ).resolves.toBeUndefined();
        consoleSpy.mockRestore();
    });
});
