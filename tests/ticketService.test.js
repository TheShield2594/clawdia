'use strict';

// Private-thread tickets (#1012). The service is the whole feature's logic —
// the command, the buttons and the sweep are thin shells over it — so its
// guards (enabled / channel / cap / cooldown), the atomic claim, and above all
// a close that is idempotent and survives a deleted thread are pinned here.

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn(),
}));
jest.mock('../src/services/caseService', () => ({ createCase: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/utils/sharding', () => ({ handlesGuild: jest.fn(() => true) }));

const { ChannelType } = require('discord.js');
const Guild = require('../src/models/Guild');
const { createCase } = require('../src/services/caseService');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const svc = require('../src/services/ticketService');

const GUILD_ID = 'g1';

function makeThread() {
    return {
        id: 'thread-1',
        name: 'ticket-0001-alice',
        members: { add: jest.fn().mockResolvedValue(undefined) },
        send: jest.fn().mockResolvedValue(undefined),
        setLocked: jest.fn().mockResolvedValue(undefined),
        setArchived: jest.fn().mockResolvedValue(undefined),
    };
}

function makeGuild({ thread, parentType = ChannelType.GuildText, logChannel } = {}) {
    const parent = {
        id: 'parent-1',
        type: parentType,
        threads: { create: jest.fn().mockResolvedValue(thread || makeThread()) },
    };
    const channels = new Map([['parent-1', parent]]);
    if (logChannel) channels.set('log-1', logChannel);
    if (thread) channels.set(thread.id, thread);
    return {
        id: GUILD_ID,
        channels: { cache: channels, fetch: jest.fn(async id => channels.get(id) || null) },
        roles: { cache: new Map() },
    };
}

function makeMember(id = 'alice') {
    return { id, user: { id, username: id, tag: `${id}#0001` }, roles: { cache: new Map() }, permissions: { has: () => false } };
}

const baseSettings = () => ({
    tickets: { enabled: true, channelId: 'parent-1', supportRoleIds: [], perUserCap: 1, cooldownSeconds: 0, open: [], autoCloseHours: 0 },
});

beforeEach(() => {
    jest.clearAllMocks();
    svc._resetCooldowns();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Guild.findOneAndUpdate.mockResolvedValue({ tickets: { nextTicketId: 1 } });
    Guild.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    createCase.mockResolvedValue({ caseId: 7 });
});

afterEach(() => jest.restoreAllMocks());

describe('openTicket', () => {
    it('refuses when tickets are disabled', async () => {
        const res = await svc.openTicket({ guild: makeGuild(), member: makeMember(), settings: { tickets: { enabled: false } } });
        expect(res).toMatchObject({ ok: false, code: 'disabled' });
    });

    it('refuses when no channel is configured', async () => {
        const res = await svc.openTicket({ guild: makeGuild(), member: makeMember(), settings: { tickets: { enabled: true, channelId: null } } });
        expect(res).toMatchObject({ ok: false, code: 'no-channel' });
    });

    it('refuses when the member is at their cap', async () => {
        const settings = baseSettings();
        settings.tickets.open = [{ openerId: 'alice', threadId: 't' }];
        const res = await svc.openTicket({ guild: makeGuild(), member: makeMember('alice'), settings });
        expect(res).toMatchObject({ ok: false, code: 'capped' });
    });

    it('enforces the open cooldown', async () => {
        const settings = baseSettings();
        settings.tickets.cooldownSeconds = 60;
        const guild = makeGuild({ thread: makeThread() });
        const first = await svc.openTicket({ guild, member: makeMember('bob'), settings });
        expect(first.ok).toBe(true);
        const second = await svc.openTicket({ guild, member: makeMember('bob'), settings });
        expect(second).toMatchObject({ ok: false, code: 'cooldown' });
    });

    it('creates a private thread, records it and posts the opening message', async () => {
        const thread = makeThread();
        const guild = makeGuild({ thread });
        const res = await svc.openTicket({ guild, member: makeMember('alice'), subject: 'help me', settings: baseSettings() });

        expect(res).toMatchObject({ ok: true, ticketId: 1 });
        const createArgs = guild.channels.cache.get('parent-1').threads.create.mock.calls[0][0];
        expect(createArgs.type).toBe(ChannelType.PrivateThread);
        // Recorded before wiring the thread up, so a partial failure still leaves a row.
        expect(Guild.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: GUILD_ID, $expr: expect.anything() }),
            expect.objectContaining({ $push: expect.objectContaining({ 'tickets.open': expect.objectContaining({ ticketId: 1, openerId: 'alice', subject: 'help me' }) }) }),
        );
        expect(thread.members.add).toHaveBeenCalledWith('alice');
        expect(thread.send).toHaveBeenCalled();
    });

    // #1159: the cap is enforced by the write, not just the pre-check.
    it('makes the record conditional on the stored count being under the cap', async () => {
        const settings = baseSettings();
        settings.tickets.perUserCap = 2;
        await svc.openTicket({ guild: makeGuild({ thread: makeThread() }), member: makeMember('alice'), settings });
        const [filter] = Guild.updateOne.mock.calls[0];
        const [count, cap] = filter.$expr.$lt;
        expect(cap).toBe(2);
        expect(count.$size.$filter.cond).toEqual({ $eq: ['$$this.openerId', { $literal: 'alice' }] });
    });

    it('deletes the thread and refuses when the conditional record does not land', async () => {
        Guild.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
        const thread = makeThread();
        thread.delete = jest.fn().mockResolvedValue(undefined);
        const res = await svc.openTicket({ guild: makeGuild({ thread }), member: makeMember('alice'), settings: baseSettings() });
        expect(res).toMatchObject({ ok: false, code: 'capped' });
        expect(thread.delete).toHaveBeenCalled();
        // Nobody was added or pinged on the surplus thread.
        expect(thread.members.add).not.toHaveBeenCalled();
        expect(thread.send).not.toHaveBeenCalled();
    });

    it('refuses a second open from the same member while the first is in flight', async () => {
        let release;
        const guild = makeGuild({ thread: makeThread() });
        guild.channels.cache.get('parent-1').threads.create
            .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(makeThread()); }));

        const first = svc.openTicket({ guild, member: makeMember('alice'), settings: baseSettings() });
        await new Promise(setImmediate);
        const second = await svc.openTicket({ guild, member: makeMember('alice'), settings: baseSettings() });
        expect(second).toMatchObject({ ok: false, code: 'cooldown' });

        release();
        expect((await first).ok).toBe(true);
        // A different member is not held up by alice's open.
        const other = await svc.openTicket({ guild, member: makeMember('bob'), settings: baseSettings() });
        expect(other.ok).toBe(true);
    });

    it('does not start the cooldown when the open fails', async () => {
        const settings = baseSettings();
        settings.tickets.cooldownSeconds = 60;
        const guild = makeGuild({ thread: makeThread() });
        guild.channels.cache.get('parent-1').threads.create.mockRejectedValueOnce(new Error('Missing Permissions'));
        const failed = await svc.openTicket({ guild, member: makeMember('carol'), settings });
        expect(failed).toMatchObject({ ok: false, code: 'create-failed' });
        const retry = await svc.openTicket({ guild, member: makeMember('carol'), settings });
        expect(retry.ok).toBe(true);
    });

    it('reports a create failure without throwing', async () => {
        const guild = makeGuild();
        guild.channels.cache.get('parent-1').threads.create.mockRejectedValue(new Error('Missing Permissions'));
        const res = await svc.openTicket({ guild, member: makeMember(), settings: baseSettings() });
        expect(res).toMatchObject({ ok: false, code: 'create-failed' });
    });
});

describe('claimTicket', () => {
    it('claims an unclaimed ticket', async () => {
        Guild.findOne.mockResolvedValue({ tickets: { open: [{ ticketId: 3, threadId: 'thread-1', claimedBy: null }] } });
        Guild.updateOne.mockResolvedValue({ modifiedCount: 1 });
        const res = await svc.claimTicket({ guild: { id: GUILD_ID }, threadId: 'thread-1', member: makeMember('mod') });
        expect(res).toMatchObject({ ok: true, ticketId: 3 });
    });

    it('reports an already-claimed ticket without reassigning', async () => {
        Guild.findOne.mockResolvedValue({ tickets: { open: [{ ticketId: 3, threadId: 'thread-1', claimedBy: 'someone' }] } });
        const res = await svc.claimTicket({ guild: { id: GUILD_ID }, threadId: 'thread-1', member: makeMember('mod') });
        expect(res).toMatchObject({ ok: false, code: 'claimed' });
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    it('reports a thread that is not a ticket', async () => {
        Guild.findOne.mockResolvedValue(null);
        const res = await svc.claimTicket({ guild: { id: GUILD_ID }, threadId: 'x', member: makeMember('mod') });
        expect(res).toMatchObject({ ok: false, code: 'not-ticket' });
    });
});

describe('closeTicket', () => {
    const openRecord = { ticketId: 5, threadId: 'thread-1', channelId: 'parent-1', openerId: 'alice', subject: 'billing', claimedBy: 'mod' };

    it('files a ticket case, posts to the log channel and locks the thread', async () => {
        const thread = makeThread();
        const logChannel = { isTextBased: () => true, send: jest.fn().mockResolvedValue(undefined) };
        const guild = makeGuild({ thread, logChannel });
        Guild.findOneAndUpdate.mockResolvedValue({
            tickets: { open: [openRecord], logChannelId: 'log-1' }, moderation: { logChannelId: null },
        });

        const res = await svc.closeTicket({ guild, guildId: GUILD_ID, threadId: 'thread-1', closedById: 'mod' });

        expect(res).toMatchObject({ ok: true, ticketId: 5, caseId: 7 });
        expect(createCase).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket', targetUserId: 'alice', moderatorId: 'mod' }));
        expect(logChannel.send).toHaveBeenCalled();
        expect(thread.setLocked).toHaveBeenCalledWith(true, expect.any(String));
        expect(thread.setArchived).toHaveBeenCalledWith(true, expect.any(String));
    });

    it('is idempotent: a second close finds nothing and no-ops', async () => {
        Guild.findOneAndUpdate.mockResolvedValueOnce({ tickets: { open: [openRecord] }, moderation: {} }).mockResolvedValueOnce(null);
        const guild = makeGuild({ thread: makeThread() });

        const first = await svc.closeTicket({ guild, guildId: GUILD_ID, threadId: 'thread-1', closedById: 'mod' });
        const second = await svc.closeTicket({ guild, guildId: GUILD_ID, threadId: 'thread-1', closedById: 'mod' });

        expect(first.ok).toBe(true);
        expect(second).toMatchObject({ ok: false, code: 'already-closed' });
        expect(createCase).toHaveBeenCalledTimes(1);
    });

    it('survives the thread having been deleted by hand', async () => {
        Guild.findOneAndUpdate.mockResolvedValue({ tickets: { open: [openRecord] }, moderation: {} });
        const guild = makeGuild(); // no thread in the cache, fetch returns null
        guild.channels.fetch.mockResolvedValue(null);

        const res = await svc.closeTicket({ guild, guildId: GUILD_ID, threadId: 'thread-1', closedById: 'mod' });

        expect(res).toMatchObject({ ok: true, ticketId: 5 });
        expect(createCase).toHaveBeenCalledTimes(1); // record still filed
    });
});

describe('helpers', () => {
    it('maps idle hours to the nearest Discord auto-archive bucket', () => {
        expect(svc.autoArchiveMinutesFor(0)).toBe(10080);
        expect(svc.autoArchiveMinutesFor(1)).toBe(60);
        expect(svc.autoArchiveMinutesFor(2)).toBe(1440);
        expect(svc.autoArchiveMinutesFor(24)).toBe(1440);
        expect(svc.autoArchiveMinutesFor(100)).toBe(10080);
    });

    it('resolves the log channel, preferring the ticket log over the mod log', () => {
        expect(svc.resolveLogChannelId({ tickets: { logChannelId: 'a' }, moderation: { logChannelId: 'b' } })).toBe('a');
        expect(svc.resolveLogChannelId({ tickets: { logChannelId: null }, moderation: { logChannelId: 'b' } })).toBe('b');
        expect(svc.resolveLogChannelId({ tickets: {}, moderation: {} })).toBe(null);
    });

    it('recognises support staff by role or Manage Threads', () => {
        const settings = { tickets: { supportRoleIds: ['role-1'] } };
        const byRole = { permissions: { has: () => false }, roles: { cache: new Map([['role-1', {}]]) } };
        const byPerm = { permissions: { has: () => true }, roles: { cache: new Map() } };
        const neither = { permissions: { has: () => false }, roles: { cache: new Map() } };
        expect(svc.isSupportMember(byRole, settings)).toBe(true);
        expect(svc.isSupportMember(byPerm, settings)).toBe(true);
        expect(svc.isSupportMember(neither, settings)).toBe(false);
    });

    it('classifies its own button and modal custom ids', () => {
        expect(svc.isTicketButton('ticket_close')).toBe(true);
        expect(svc.isTicketButton('poll_x')).toBe(false);
        expect(svc.isTicketModal('ticket_modal_open')).toBe(true);
        expect(svc.isTicketModal('ticket_close')).toBe(false);
    });
});

describe('interaction handlers', () => {
    function makeInteraction(customId, { member, channelId = 'thread-1', fields } = {}) {
        return {
            customId,
            channelId,
            guild: { id: GUILD_ID },
            user: { id: member?.id || 'u1' },
            member: member || makeMember('u1'),
            channel: { id: channelId, messages: { fetch: jest.fn().mockResolvedValue(new Map()) } },
            fields: fields || { getTextInputValue: () => '' },
            reply: jest.fn().mockResolvedValue(undefined),
            followUp: jest.fn().mockResolvedValue(undefined),
            deferReply: jest.fn().mockResolvedValue(undefined),
            editReply: jest.fn().mockResolvedValue(undefined),
            showModal: jest.fn().mockResolvedValue(undefined),
        };
    }

    beforeEach(() => getGuildSettings.mockResolvedValue({ tickets: { supportRoleIds: ['role-1'] } }));

    it('shows a subject modal for the panel open button', async () => {
        const interaction = makeInteraction(svc.BUTTON_OPEN);
        await svc.handleTicketButton(interaction);
        expect(interaction.showModal).toHaveBeenCalled();
    });

    it('opens a ticket from the modal submit', async () => {
        const thread = makeThread();
        // openTicket needs a real guild on the interaction for this path; give it one.
        const guild = makeGuild({ thread });
        const interaction = { ...makeInteraction(svc.MODAL_OPEN, { fields: { getTextInputValue: () => 'hi' } }), guild };
        Guild.findOne.mockResolvedValue(baseSettings());
        await svc.handleTicketModal(interaction);
        expect(interaction.deferReply).toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining(thread.id) });
    });

    it('refuses a claim from a non-support member', async () => {
        const interaction = makeInteraction(svc.BUTTON_CLAIM, { member: makeMember('rando') });
        await svc.handleTicketButton(interaction);
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('support staff') }));
    });

    it('claims a ticket for a support member', async () => {
        const staff = { id: 'mod', user: { id: 'mod' }, roles: { cache: new Map([['role-1', {}]]) }, permissions: { has: () => false } };
        Guild.findOne.mockResolvedValue({ tickets: { open: [{ ticketId: 1, threadId: 'thread-1', claimedBy: null }] } });
        Guild.updateOne.mockResolvedValue({ modifiedCount: 1 });
        const interaction = makeInteraction(svc.BUTTON_CLAIM, { member: staff });
        await svc.handleTicketButton(interaction);
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('claimed') }));
    });

    it('lets the opener close via the close button', async () => {
        Guild.findOne.mockResolvedValue({ tickets: { open: [{ ticketId: 1, threadId: 'thread-1', openerId: 'u1' }] } });
        Guild.findOneAndUpdate.mockResolvedValue({ tickets: { open: [{ ticketId: 1, threadId: 'thread-1', openerId: 'u1' }] }, moderation: {} });
        const interaction = makeInteraction(svc.BUTTON_CLOSE, { member: makeMember('u1') });
        await svc.handleTicketButton(interaction);
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Closing') }));
        expect(createCase).toHaveBeenCalled();
    });

    it('builds a transcript for a support member', async () => {
        const staff = { id: 'mod', user: { id: 'mod' }, roles: { cache: new Map([['role-1', {}]]) }, permissions: { has: () => false } };
        Guild.findOne.mockResolvedValue({ tickets: { open: [{ ticketId: 1, threadId: 'thread-1' }] } });
        const interaction = makeInteraction(svc.BUTTON_TRANSCRIPT, { member: staff });
        await svc.handleTicketButton(interaction);
        expect(interaction.deferReply).toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalled();
    });
});

describe('sweepIdleTickets', () => {
    it('closes tickets idle past the window and clears records for deleted threads', async () => {
        const oldThread = { id: 'old', lastMessage: { createdTimestamp: Date.now() - 5 * 3600000 }, name: 't', messages: { fetch: jest.fn().mockResolvedValue(new Map()) }, send: jest.fn().mockResolvedValue(), setLocked: jest.fn().mockResolvedValue(), setArchived: jest.fn().mockResolvedValue() };
        const freshThread = { id: 'fresh', lastMessage: { createdTimestamp: Date.now() }, name: 't', messages: { fetch: jest.fn().mockResolvedValue(new Map()) }, send: jest.fn().mockResolvedValue(), setLocked: jest.fn().mockResolvedValue(), setArchived: jest.fn().mockResolvedValue() };
        const channels = new Map([['old', oldThread], ['fresh', freshThread]]);
        const guild = { id: GUILD_ID, channels: { cache: channels, fetch: jest.fn(async id => channels.get(id) || null) } };
        const client = { guilds: { cache: new Map([[GUILD_ID, guild]]) } };

        Guild.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([{
            guildId: GUILD_ID,
            tickets: { autoCloseHours: 1, open: [
                { ticketId: 1, threadId: 'old', openerId: 'a', openedAt: new Date() },
                { ticketId: 2, threadId: 'fresh', openerId: 'b', openedAt: new Date() },
                { ticketId: 3, threadId: 'gone', openerId: 'c', openedAt: new Date() },
            ] },
        }]) });
        // findOneAndUpdate is the close claim; return a matching record for the two it closes.
        Guild.findOneAndUpdate.mockImplementation(async ({ 'tickets.open.threadId': threadId }) => ({
            tickets: { open: [{ ticketId: 0, threadId, openerId: 'x' }] }, moderation: {},
        }));

        await svc.sweepIdleTickets(client);

        const closedThreadIds = Guild.findOneAndUpdate.mock.calls.map(c => c[0]['tickets.open.threadId']);
        expect(closedThreadIds).toContain('old');   // idle past 1h
        expect(closedThreadIds).toContain('gone');  // thread deleted
        expect(closedThreadIds).not.toContain('fresh'); // still active
    });
});
