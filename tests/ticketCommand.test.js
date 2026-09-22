'use strict';

// The /ticket command (#1012) is a thin shell over ticketService; this pins the
// routing (which subcommand calls what) and the panel permission gate, with the
// service mocked so the command's own branches are what is under test.

jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/services/ticketService', () => ({
    openTicket: jest.fn(),
    closeTicket: jest.fn(),
    postTicketPanel: jest.fn(),
    isSupportMember: jest.fn(),
    findOpenTicket: jest.fn(),
}));

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const svc = require('../src/services/ticketService');
const command = require('../src/commands/moderation/ticket');

function makeInteraction({ sub, options = {}, hasManageGuild = true, channelType = ChannelType.GuildText, userId = 'u1' } = {}) {
    return {
        guild: { id: 'g1' },
        channelId: 'thread-1',
        user: { id: userId },
        member: { id: userId },
        channel: { type: channelType },
        memberPermissions: { has: flag => flag === PermissionFlagsBits.ManageGuild ? hasManageGuild : false },
        options: {
            getSubcommand: () => sub,
            getString: name => options[name] ?? null,
        },
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    getGuildSettings.mockResolvedValue({ tickets: { enabled: true } });
});

it('defers ephemerally', () => {
    expect(command.deferral).toBe('ephemeral');
});

describe('open', () => {
    it('opens a ticket and links the thread', async () => {
        svc.openTicket.mockResolvedValue({ ok: true, thread: { id: 'thread-9' } });
        const interaction = makeInteraction({ sub: 'open', options: { subject: 'help' } });
        await command.execute(interaction);
        expect(svc.openTicket).toHaveBeenCalledWith(expect.objectContaining({ subject: 'help' }));
        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('thread-9') });
    });

    it('surfaces a refusal message', async () => {
        svc.openTicket.mockResolvedValue({ ok: false, message: 'Tickets are not enabled on this server.' });
        const interaction = makeInteraction({ sub: 'open' });
        await command.execute(interaction);
        expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Tickets are not enabled on this server.' });
    });
});

describe('close', () => {
    it('refuses outside a ticket thread', async () => {
        svc.findOpenTicket.mockResolvedValue(null);
        const interaction = makeInteraction({ sub: 'close' });
        await command.execute(interaction);
        expect(svc.closeTicket).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('open ticket thread') });
    });

    it('lets the opener close their own ticket', async () => {
        svc.findOpenTicket.mockResolvedValue({ openerId: 'u1' });
        const interaction = makeInteraction({ sub: 'close', userId: 'u1' });
        await command.execute(interaction);
        expect(svc.closeTicket).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1', closedById: 'u1' }));
    });

    it('refuses a non-opener who is not support staff', async () => {
        svc.findOpenTicket.mockResolvedValue({ openerId: 'someone-else' });
        svc.isSupportMember.mockReturnValue(false);
        const interaction = makeInteraction({ sub: 'close', userId: 'u1' });
        await command.execute(interaction);
        expect(svc.closeTicket).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Only support staff') });
    });
});

describe('panel', () => {
    it('refuses without Manage Server', async () => {
        const interaction = makeInteraction({ sub: 'panel', hasManageGuild: false });
        await command.execute(interaction);
        expect(svc.postTicketPanel).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Manage Server') });
    });

    it('refuses when tickets are disabled', async () => {
        getGuildSettings.mockResolvedValue({ tickets: { enabled: false } });
        const interaction = makeInteraction({ sub: 'panel' });
        await command.execute(interaction);
        expect(svc.postTicketPanel).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Enable tickets') });
    });

    it('posts the panel in a text channel', async () => {
        const interaction = makeInteraction({ sub: 'panel' });
        await command.execute(interaction);
        expect(svc.postTicketPanel).toHaveBeenCalledWith(interaction.channel, expect.anything());
        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Posted the ticket panel') });
    });
});
