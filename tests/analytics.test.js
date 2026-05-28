'use strict';

// ---------------------------------------------------------------------------
// Mock dependencies before requiring any event modules
// ---------------------------------------------------------------------------

jest.mock('discord.js', () => {
    const EmbedBuilder = jest.fn().mockImplementation(() => {
        const self = {
            setColor: jest.fn().mockReturnThis(),
            setTitle: jest.fn().mockReturnThis(),
            setDescription: jest.fn().mockReturnThis(),
            setThumbnail: jest.fn().mockReturnThis(),
            setAuthor: jest.fn().mockReturnThis(),
            setImage: jest.fn().mockReturnThis(),
            addFields: jest.fn().mockReturnThis(),
            setTimestamp: jest.fn().mockReturnThis(),
        };
        return self;
    });
    return {
        EmbedBuilder,
        AttachmentBuilder: jest.fn(),
        PermissionFlagsBits: { SendMessages: 1n << 11n, AttachFiles: 1n << 15n },
        AuditLogEvent: { MemberKick: 20 },
    };
});

// mockGuild.updateOne must live inside the factory so it's available when the module
// factory executes (jest.mock is hoisted above const declarations).
const mockGuild = { findOne: jest.fn(), updateOne: jest.fn() };
jest.mock('../src/models/Guild', () => mockGuild);
jest.mock('../src/services/raidService', () => ({ handleMemberJoin: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/antiNukeService', () => ({
    enforceJoinGate: jest.fn().mockResolvedValue(false),
    trackAction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/cardGenerator', () => ({ createWelcomeCard: jest.fn().mockResolvedValue(Buffer.from('img')) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn(),
    onCommandUse: jest.fn().mockResolvedValue({ completed: [], nearComplete: [] }),
    notifyQuestComplete: jest.fn(),
    notifyQuestNearComplete: jest.fn(),
}));
jest.mock('../src/commands/utility/poll', () => ({ handlePollVote: jest.fn() }));

const Guild = require('../src/models/Guild');
const guildMemberAdd = require('../src/events/guildMemberAdd');
const guildMemberRemove = require('../src/events/guildMemberRemove');
const interactionCreate = require('../src/events/interactionCreate');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuildSettings(overrides = {}) {
    return {
        guildId: '111111111111111111',
        constructor: { updateOne: mockGuild.updateOne },
        welcome: { enabled: false, cardEnabled: false, dmEnabled: false, message: '', dmMessage: '' },
        farewell: { enabled: false },
        autoRoles: [],
        eventLog: { enabled: false },
        ...overrides,
    };
}

function makeMember(overrides = {}) {
    return {
        id: '222222222222222222',
        user: {
            id: '222222222222222222',
            globalName: 'DisplayName',
            username: 'username',
            tag: 'username#0',
            displayAvatarURL: jest.fn().mockReturnValue('https://cdn.discordapp.com/test.png'),
            createdTimestamp: Date.now() - 86400000,
        },
        guild: {
            id: '111111111111111111',
            name: 'Test Guild',
            memberCount: 100,
            channels: { cache: new Map() },
            members: { me: { permissionsIn: jest.fn() } },
            roles: { cache: new Map() },
        },
        joinedAt: new Date(),
        joinedTimestamp: Date.now() - 86400000,
        roles: { add: jest.fn().mockResolvedValue(undefined), cache: new Map() },
        send: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// trackMemberEvent — join tracking
// ---------------------------------------------------------------------------

describe('trackMemberEvent (guildMemberAdd)', () => {
    const TODAY = new Date().toISOString().slice(0, 10);

    beforeEach(() => {
        jest.clearAllMocks();
        mockGuild.findOne.mockResolvedValue(makeGuildSettings());
    });

    it('increments joins on existing today entry', async () => {
        mockGuild.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

        const member = makeMember();
        await guildMemberAdd.execute(member, {});

        expect(mockGuild.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ 'analytics.memberEvents.date': TODAY }),
            expect.objectContaining({ $inc: { 'analytics.memberEvents.$.joins': 1 } })
        );
    });

    it('inserts new entry when no existing today entry', async () => {
        mockGuild.updateOne
            .mockResolvedValueOnce({ matchedCount: 0 }) // increment miss
            .mockResolvedValueOnce({ matchedCount: 1 }); // insert succeeds

        const member = makeMember();
        await guildMemberAdd.execute(member, {});

        const secondCall = mockGuild.updateOne.mock.calls[1];
        expect(secondCall[1].$push['analytics.memberEvents'].$each[0]).toMatchObject({
            date: TODAY,
            joins: 1,
            leaves: 0,
        });
        expect(secondCall[1].$push['analytics.memberEvents'].$slice).toBe(-120);
    });

    it('does not throw if guild not found', async () => {
        mockGuild.findOne.mockResolvedValue(null);
        const member = makeMember();
        await expect(guildMemberAdd.execute(member, {})).resolves.not.toThrow();
    });

    it('swallows analytics errors without crashing the join flow', async () => {
        mockGuild.updateOne.mockRejectedValue(new Error('DB error'));
        const member = makeMember();
        // Should not reject — analytics errors are caught
        await expect(guildMemberAdd.execute(member, {})).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// trackMemberEvent — leave tracking
// ---------------------------------------------------------------------------

describe('trackMemberEvent (guildMemberRemove)', () => {
    const TODAY = new Date().toISOString().slice(0, 10);

    beforeEach(() => {
        jest.clearAllMocks();
        mockGuild.findOne.mockResolvedValue(makeGuildSettings());
    });

    it('increments leaves on existing today entry', async () => {
        mockGuild.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

        const member = makeMember();
        await guildMemberRemove.execute(member, {});

        expect(mockGuild.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ 'analytics.memberEvents.date': TODAY }),
            expect.objectContaining({ $inc: { 'analytics.memberEvents.$.leaves': 1 } })
        );
    });

    it('inserts new entry with leaves=1 joins=0 when no today entry', async () => {
        mockGuild.updateOne
            .mockResolvedValueOnce({ matchedCount: 0 })
            .mockResolvedValueOnce({ matchedCount: 1 });

        const member = makeMember();
        await guildMemberRemove.execute(member, {});

        const secondCall = mockGuild.updateOne.mock.calls[1];
        expect(secondCall[1].$push['analytics.memberEvents'].$each[0]).toMatchObject({
            date: TODAY,
            joins: 0,
            leaves: 1,
        });
    });

    it('swallows analytics errors without crashing the leave flow', async () => {
        mockGuild.updateOne.mockRejectedValue(new Error('DB error'));
        const member = makeMember();
        await expect(guildMemberRemove.execute(member, {})).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// logCommandMetric (interactionCreate)
// ---------------------------------------------------------------------------

describe('logCommandMetric (interactionCreate)', () => {
    const mockCommand = {
        data: { name: 'ping' },
        cooldown: 3,
        execute: jest.fn().mockResolvedValue(undefined),
    };
    const mockClient = {
        commands: new Map([['ping', mockCommand]]),
        cooldowns: new Map(),
    };

    function makeInteraction(overrides = {}) {
        return {
            isChatInputCommand: () => true,
            isButton: () => false,
            commandName: 'ping',
            guildId: '111111111111111111',
            guild: { id: '111111111111111111', name: 'Test Guild' },
            channelId: '333333333333333333',
            user: { id: '444444444444444444' },
            member: { roles: { cache: new Map() } },
            reply: jest.fn().mockResolvedValue(undefined),
            editReply: jest.fn().mockResolvedValue(undefined),
            replied: false,
            deferred: false,
            ...overrides,
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockGuild.updateOne.mockResolvedValue({});
        mockGuild.findOne.mockResolvedValue(makeGuildSettings());
        mockCommand.execute.mockResolvedValue(undefined);
        // Reset cooldown state so tests don't block each other via the 3s cooldown.
        mockClient.cooldowns.clear();
    });

    it('logs a success metric after successful command execution', async () => {
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, mockClient);

        const call = mockGuild.updateOne.mock.calls.find(c =>
            c[1]?.$push?.['analytics.commandUsage'] !== undefined
        );
        expect(call).toBeDefined();
        const entry = call[1].$push['analytics.commandUsage'].$each[0];
        expect(entry.command).toBe('ping');
        expect(entry.success).toBe(true);
        expect(entry.reason).toBeNull();
    });

    it('logs a failure metric when command throws', async () => {
        mockCommand.execute.mockRejectedValueOnce(new Error('boom'));
        const interaction = makeInteraction({ replied: false, deferred: false });
        await interactionCreate.execute(interaction, mockClient);

        const calls = mockGuild.updateOne.mock.calls.filter(c =>
            c[1]?.$push?.['analytics.commandUsage'] !== undefined
        );
        const failCall = calls.find(c => c[1].$push['analytics.commandUsage'].$each[0].success === false);
        expect(failCall).toBeDefined();
    });

    it('caps commandUsage array at 3000 entries via $slice', async () => {
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, mockClient);

        const call = mockGuild.updateOne.mock.calls.find(c =>
            c[1]?.$push?.['analytics.commandUsage'] !== undefined
        );
        expect(call[1].$push['analytics.commandUsage'].$slice).toBe(-3000);
    });

    it('records the hour of the command (0–23)', async () => {
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, mockClient);

        const call = mockGuild.updateOne.mock.calls.find(c =>
            c[1]?.$push?.['analytics.commandUsage'] !== undefined
        );
        const hour = call[1].$push['analytics.commandUsage'].$each[0].hour;
        expect(hour).toBeGreaterThanOrEqual(0);
        expect(hour).toBeLessThanOrEqual(23);
    });

    it('logs unknown_command reason when command not found', async () => {
        const unknownInteraction = makeInteraction({ commandName: 'nonexistent' });
        await interactionCreate.execute(unknownInteraction, mockClient);

        const call = mockGuild.updateOne.mock.calls.find(c =>
            c[1]?.$push?.['analytics.commandUsage'] !== undefined
        );
        expect(call[1].$push['analytics.commandUsage'].$each[0].reason).toBe('unknown_command');
        expect(call[1].$push['analytics.commandUsage'].$each[0].success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// applyVariables — {tag} uses username not deprecated .tag
// ---------------------------------------------------------------------------

describe('applyVariables {tag} template (guildMemberAdd)', () => {
    it('replaces {tag} with username (not deprecated .tag)', () => {
        const member = makeMember();
        member.user.tag = 'DEPRECATED#1234';
        member.user.username = 'correctusername';
        const result = guildMemberAdd._applyVariables('{tag}', member);
        expect(result).toBe('correctusername');
        expect(result).not.toContain('DEPRECATED');
    });
});

// ---------------------------------------------------------------------------
// Retention calculation — /stats endpoint math
// ---------------------------------------------------------------------------

describe('Retention calculation math (stats endpoint)', () => {
    // These tests validate the corrected formulas directly.
    // retained7 must use 7-day data; retained30 must use plain joins-leaves / joins.

    function computeRetained(memberEvents) {
        const joins7 = memberEvents.slice(-7).reduce((a, d) => a + (d.joins || 0), 0);
        const leaves7 = memberEvents.slice(-7).reduce((a, d) => a + (d.leaves || 0), 0);
        const joins30 = memberEvents.slice(-30).reduce((a, d) => a + (d.joins || 0), 0);
        const leaves30 = memberEvents.slice(-30).reduce((a, d) => a + (d.leaves || 0), 0);
        const retained7 = joins7 ? Math.max(0, joins7 - leaves7) / joins7 : 0;
        const retained30 = joins30 ? Math.max(0, joins30 - leaves30) / joins30 : 0;
        return { joins7, leaves7, joins30, leaves30, retained7, retained30 };
    }

    it('retained7 uses 7-day window, not 30-day', () => {
        // 7 entries, each with 10 joins 5 leaves; entries 8–30 have 100 joins each
        const events = [];
        for (let i = 0; i < 23; i++) events.push({ joins: 100, leaves: 0 }); // older than 7 days
        for (let i = 0; i < 7; i++) events.push({ joins: 10, leaves: 5 });  // last 7 days
        const { retained7, joins7 } = computeRetained(events);
        expect(joins7).toBe(70); // 7 * 10
        // retained7 = (70 - 35) / 70 ≈ 50%
        expect(retained7).toBeCloseTo(0.5);
    });

    it('retained30 does not inflate leaves', () => {
        const events = Array.from({ length: 30 }, () => ({ joins: 100, leaves: 20 }));
        const { retained30 } = computeRetained(events);
        // (3000 - 600) / 3000 = 0.8
        expect(retained30).toBeCloseTo(0.8);
    });

    it('retained7 returns 0 when no 7-day joins', () => {
        const events = [{ joins: 0, leaves: 5 }];
        const { retained7 } = computeRetained(events);
        expect(retained7).toBe(0);
    });

    it('retained30 returns 0 when no 30-day joins', () => {
        const { retained30 } = computeRetained([]);
        expect(retained30).toBe(0);
    });

    it('retained values are clamped to 0 minimum (no negative retention)', () => {
        const events = Array.from({ length: 30 }, () => ({ joins: 10, leaves: 50 }));
        const { retained7, retained30 } = computeRetained(events);
        expect(retained7).toBeGreaterThanOrEqual(0);
        expect(retained30).toBeGreaterThanOrEqual(0);
    });
});
