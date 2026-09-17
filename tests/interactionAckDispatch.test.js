'use strict';

// #995: the acknowledgement has to happen in the dispatcher, before the awaited
// work that can blow Discord's three-second window — the settings read, the
// cooldown claim, and then execute()'s own member fetch. These tests drive the
// real dispatcher (events/interactionCreate.execute) with those dependencies
// mocked, and pin two things the command-level tests cannot see:
//
//   1. a command that opts into `deferral` is acknowledged *before* the settings
//      read and before execute() runs, even when the settings read is slow;
//   2. a dispatcher refusal (cooldown) on a deferred command tidies the public
//      placeholder and follows up ephemerally rather than issuing a second
//      initial reply — which Discord rejects — while an un-deferred command still
//      replies directly as before.

// The dispatcher requires a spread of button/modal handlers and models at load;
// none are on the chat-input path under test, so they are stubbed to keep the
// module cheap to import and free of side effects.
jest.mock('../src/models/Guild', () => ({ exists: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/services/pollService', () => ({ handlePollVote: jest.fn() }));
jest.mock('../src/services/heistService', () => ({ handleHeistButton: jest.fn() }));
jest.mock('../src/commands/economy/syndicate', () => ({ handleSyndicateButton: jest.fn() }));
jest.mock('../src/services/dmService', () => ({ handleDmButton: jest.fn() }));
jest.mock('../src/commands/fun/8ball', () => ({
    isEightBallButton: () => false,
    isEightBallModal: () => false,
    handleEightBallButton: jest.fn(),
    handleEightBallModal: jest.fn(),
}));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn(),
    onCommandUse: jest.fn(),
    questEventCanProgress: jest.fn(() => false),
    questAssignmentNeeded: jest.fn(() => false),
    notifyQuestComplete: jest.fn(),
    notifyQuestNearComplete: jest.fn(),
}));
jest.mock('../src/utils/balanceDelta', () => ({ saveWithBalanceDelta: jest.fn() }));
jest.mock('../src/utils/commandMetricsBuffer', () => ({ recordCommandMetric: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/utils/commandCooldowns', () => ({ claimIfAvailable: jest.fn() }));

const { PermissionFlagsBits, PermissionsBitField, MessageFlags } = require('discord.js');
const interactionCreate = require('../src/events/interactionCreate');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const cooldownStore = require('../src/utils/commandCooldowns');

// A shared log the mocks and the command push into, so a test can assert the
// order the dispatcher did things in — the whole point of "before slow work".
let order;

function makeInteraction() {
    const interaction = {
        replied: false,
        deferred: false,
        commandName: 'ban',
        guild: { id: 'guild-1' },
        channelId: 'channel-1',
        channel: { id: 'channel-1' },
        user: { id: 'mod-1' },
        member: {},
        memberPermissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
        isButton: () => false,
        isModalSubmit: () => false,
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
    };
    interaction.reply = jest.fn(async () => { interaction.replied = true; order.push('reply'); });
    interaction.editReply = jest.fn(async () => { interaction.replied = true; order.push('editReply'); });
    interaction.followUp = jest.fn(async () => { order.push('followUp'); });
    interaction.deleteReply = jest.fn(async () => { order.push('deleteReply'); });
    interaction.deferReply = jest.fn(async () => { interaction.deferred = true; order.push('defer'); });
    return interaction;
}

function makeClient(command) {
    return { commands: { get: () => command } };
}

// A command shaped like the moderation ones: category 'moderation' (so the
// freeze gate does not apply), a permission requirement the Administrator holds,
// and the public `deferral` hook under test.
function moderationCommand(overrides = {}) {
    return {
        category: 'moderation',
        requiredPermissions: [PermissionFlagsBits.BanMembers],
        deferral: { ephemeral: false },
        data: { name: 'ban' },
        execute: jest.fn(async () => { order.push('execute'); }),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    order = [];
    jest.spyOn(console, 'error').mockImplementation(() => {});
    getGuildSettings.mockResolvedValue({});
    cooldownStore.claimIfAvailable.mockResolvedValue(null); // not on cooldown
});
afterEach(() => jest.restoreAllMocks());

describe('the dispatcher acknowledges before its awaited work', () => {
    test('defers before the settings read and before execute, even when settings are slow', async () => {
        // A settings read that resolves a tick late — if the defer waited on it,
        // the ordering assertion below would catch it.
        getGuildSettings.mockImplementation(() => new Promise(resolve => {
            setImmediate(() => { order.push('settings'); resolve({}); });
        }));

        const command = moderationCommand();
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.deferReply).toHaveBeenCalledWith({});
        expect(order).toEqual(['defer', 'settings', 'execute']);
    });

    test('a command with no deferral hook is not deferred', async () => {
        const command = moderationCommand({ deferral: undefined });
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(order).toEqual(['execute']); // default settings mock does not log
    });
});

describe('a dispatcher refusal on a deferred command', () => {
    test('drops the placeholder and follows up ephemerally instead of a second reply', async () => {
        cooldownStore.claimIfAvailable.mockResolvedValue(Date.now() + 60_000); // on cooldown

        const command = moderationCommand();
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.deferReply).toHaveBeenCalled();
        expect(command.execute).not.toHaveBeenCalled();
        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
        expect(interaction.followUp).toHaveBeenCalledTimes(1);
        const [payload] = interaction.followUp.mock.calls[0];
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(payload.content).toMatch(/on cooldown/i);
    });

    test('an un-deferred command still refuses with a plain ephemeral reply', async () => {
        cooldownStore.claimIfAvailable.mockResolvedValue(Date.now() + 60_000);

        const command = moderationCommand({ deferral: undefined });
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(interaction.deleteReply).not.toHaveBeenCalled();
        expect(interaction.followUp).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledTimes(1);
        const [payload] = interaction.reply.mock.calls[0];
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
    });
});

describe('the permission gate stays ahead of the acknowledgement', () => {
    // A member missing the bit is refused with a plain ephemeral reply and no
    // placeholder — they never see a "thinking" for a command they cannot run.
    test('refuses a missing permission before deferring', async () => {
        const command = moderationCommand();
        const interaction = makeInteraction();
        interaction.memberPermissions = new PermissionsBitField([PermissionFlagsBits.SendMessages]);

        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(command.execute).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledTimes(1);
        const [payload] = interaction.reply.mock.calls[0];
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(payload.content).toMatch(/permission/i);
    });
});

describe('failures around the acknowledgement itself', () => {
    // A `deferral` hook may be a function; if it throws it must not skip both the
    // ack and the error handler, leaving the interaction with no response at all.
    test('a throwing deferral hook is caught and reported, not swallowed', async () => {
        const command = moderationCommand({
            deferral: () => { throw new Error('bad hook'); },
        });
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(command.execute).not.toHaveBeenCalled();
        // Not deferred, so the refusal is a plain ephemeral reply.
        expect(interaction.reply).toHaveBeenCalledTimes(1);
        const [payload] = interaction.reply.mock.calls[0];
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
    });

    // After a public deferral, a rejected settings read would otherwise leave the
    // placeholder standing forever with nothing to fill it.
    test('a settings-read rejection clears the placeholder and reports ephemerally', async () => {
        getGuildSettings.mockRejectedValueOnce(new Error('mongo down'));

        const command = moderationCommand();
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.deferReply).toHaveBeenCalled();
        expect(command.execute).not.toHaveBeenCalled();
        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
        expect(interaction.followUp).toHaveBeenCalledTimes(1);
        const [payload] = interaction.followUp.mock.calls[0];
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(payload.content).toMatch(/server settings/i);
    });
});

describe('a command that throws after acknowledgement', () => {
    test('reports the error as an ephemeral follow-up, not a second reply', async () => {
        const command = moderationCommand({
            execute: jest.fn(async () => { order.push('execute'); throw new Error('boom'); }),
        });
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, makeClient(command));

        expect(interaction.reply).not.toHaveBeenCalled();
        // deferred + not yet replied → drop placeholder, ephemeral follow-up
        expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
        expect(interaction.followUp).toHaveBeenCalledTimes(1);
        const [payload] = interaction.followUp.mock.calls[0];
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(payload.content).toMatch(/error/i);
    });
});
