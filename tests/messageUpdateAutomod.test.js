'use strict';

/**
 * Auto-moderation on edited messages.
 *
 * The filters only ever ran on `messageCreate`, which left an opening that
 * needed no skill at all: post "hello", edit it into the invite link or the
 * slur, and nothing ever inspected the text that ended up on screen. Every
 * filter in the list was bypassable this way.
 */

jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/services/autoModService', () => ({ handleAutoModeration: jest.fn() }));

const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { handleAutoModeration } = require('../src/services/autoModService');
const messageUpdate = require('../src/events/messageUpdate');

function makeEdit({ before = 'hello', after = 'discord.gg/raid', logging = false } = {}) {
    const logChannel = { send: jest.fn(async () => {}), permissionsFor: () => ({ has: () => true }) };
    const guild = {
        id: 'guild1',
        channels: { cache: new Map([['log1', logChannel]]) },
        members: { me: {} },
    };
    return {
        logChannel,
        logging,
        oldMessage: { content: before },
        newMessage: {
            content: after,
            author: { bot: false, username: 'someone', globalName: null, displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png' },
            guild,
            channel: { id: 'chan1' },
            url: 'https://discord.com/channels/guild1/chan1/msg1',
        },
    };
}

function settings({ moderation = {}, eventLog = {} } = {}) {
    return {
        moderation: { enabled: true, autoModEnabled: true, ...moderation },
        eventLog: { enabled: false, logMessageEdit: false, channelId: 'log1', ...eventLog },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    handleAutoModeration.mockResolvedValue(false);
});

it('re-runs the filters on the edited text', async () => {
    const { oldMessage, newMessage } = makeEdit();
    getGuildSettings.mockResolvedValue(settings());

    await messageUpdate.execute(oldMessage, newMessage);

    expect(handleAutoModeration).toHaveBeenCalledTimes(1);
    expect(handleAutoModeration.mock.calls[0][0]).toBe(newMessage);
});

it('skips the filters when the guild turns edit scanning off', async () => {
    const { oldMessage, newMessage } = makeEdit();
    getGuildSettings.mockResolvedValue(settings({ moderation: { scanEdits: false } }));

    await messageUpdate.execute(oldMessage, newMessage);

    expect(handleAutoModeration).not.toHaveBeenCalled();
});

it('skips the filters when moderation is off entirely', async () => {
    const { oldMessage, newMessage } = makeEdit();
    getGuildSettings.mockResolvedValue(settings({ moderation: { enabled: false } }));

    await messageUpdate.execute(oldMessage, newMessage);

    expect(handleAutoModeration).not.toHaveBeenCalled();
});

it('runs the filters even when event logging is off', async () => {
    // A guild that never switched edit logging on is exactly the guild that
    // would never have noticed the hole, so the two are independent.
    const { oldMessage, newMessage, logChannel } = makeEdit();
    getGuildSettings.mockResolvedValue(settings({ eventLog: { enabled: false } }));

    await messageUpdate.execute(oldMessage, newMessage);

    expect(handleAutoModeration).toHaveBeenCalledTimes(1);
    expect(logChannel.send).not.toHaveBeenCalled();
});

it('does not log an edit for a message the filters deleted', async () => {
    const { oldMessage, newMessage, logChannel } = makeEdit();
    getGuildSettings.mockResolvedValue(settings({ eventLog: { enabled: true, logMessageEdit: true } }));
    handleAutoModeration.mockResolvedValue(true);

    await messageUpdate.execute(oldMessage, newMessage);

    expect(logChannel.send).not.toHaveBeenCalled();
});

it('still logs the edit when the filters let it stand', async () => {
    const { oldMessage, newMessage, logChannel } = makeEdit({ after: 'hello again' });
    getGuildSettings.mockResolvedValue(settings({ eventLog: { enabled: true, logMessageEdit: true } }));

    await messageUpdate.execute(oldMessage, newMessage);

    expect(logChannel.send).toHaveBeenCalledTimes(1);
});

it('logs the edit anyway when the filters throw', async () => {
    // A filter failure must not swallow the audit trail for the edit.
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { oldMessage, newMessage, logChannel } = makeEdit();
    getGuildSettings.mockResolvedValue(settings({ eventLog: { enabled: true, logMessageEdit: true } }));
    handleAutoModeration.mockRejectedValue(new Error('boom'));

    await messageUpdate.execute(oldMessage, newMessage);

    expect(logChannel.send).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
});

it('ignores an edit that did not change the content', async () => {
    const { oldMessage, newMessage } = makeEdit({ before: 'same', after: 'same' });
    getGuildSettings.mockResolvedValue(settings());

    await messageUpdate.execute(oldMessage, newMessage);

    expect(handleAutoModeration).not.toHaveBeenCalled();
});

it('ignores a bot editing its own message', async () => {
    const { oldMessage, newMessage } = makeEdit();
    newMessage.author.bot = true;
    getGuildSettings.mockResolvedValue(settings());

    await messageUpdate.execute(oldMessage, newMessage);

    expect(handleAutoModeration).not.toHaveBeenCalled();
});
