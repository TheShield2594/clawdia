'use strict';

// ---------------------------------------------------------------------------
// Mock dependencies before requiring any event modules
// ---------------------------------------------------------------------------

jest.mock('discord.js', () => {
    // Only EmbedBuilder/AttachmentBuilder/etc. need stubbing for assertions below.
    // Everything else (SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    // MessageFlags, ...) comes from the real module so command files transitively
    // required via interactionCreate.js (e.g. heist.js, syndicate.js) still load.
    const actual = jest.requireActual('discord.js');
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
        ...actual,
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

// Minimal stubs so api.js (and its transitive requires) can be loaded without
// a real DB or external services.
jest.mock('../src/models/Case', () => ({ find: jest.fn() }));
jest.mock('../src/models/KnowledgeBase', () => ({}));
jest.mock('../src/models/SummaryJob', () => ({}));
jest.mock('../src/services/rssService', () => ({ rescheduleDailyNews: jest.fn(), sendDailyNews: jest.fn() }));
jest.mock('../src/services/dailyBibleService', () => ({ rescheduleBibleVerse: jest.fn() }));
jest.mock('rss-parser', () => jest.fn().mockImplementation(() => ({})));
jest.mock('express', () => {
    const fn = jest.fn(() => ({
        use: jest.fn(), get: jest.fn(), post: jest.fn(), delete: jest.fn(), put: jest.fn(), patch: jest.fn(),
    }));
    fn.Router = () => ({
        use: jest.fn(), get: jest.fn(), post: jest.fn(), delete: jest.fn(), put: jest.fn(), patch: jest.fn(),
    });
    return fn;
});

const { computeRetention } = require('../src/dashboard/routes/api');
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
            isModalSubmit: () => false,
            isAutocomplete: () => false,
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
        // interactionCreate reads settings through the guild settings cache,
        // which is module-level state. Without this reset a later test would
        // silently reuse the previous test's settings and never consult its
        // own findOne mock.
        require('../src/utils/guildSettingsCache').clearGuildSettingsCache();
        mockGuild.updateOne.mockResolvedValue({});
        mockGuild.findOne.mockResolvedValue(makeGuildSettings());
        mockCommand.execute.mockResolvedValue(undefined);
        // Reset cooldown state so tests don't block each other via the 3s cooldown.
        mockClient.cooldowns.clear();
    });

    it('does not crash when a globally-registered command is used in a DM', async () => {
        // Only a handful of the ~100 command files call .setDMPermission(false),
        // and all of them are registered globally, so Discord delivers most of
        // them with interaction.guild === null. Everything downstream reads
        // interaction.guild.id, so this must short-circuit rather than throw.
        const interaction = makeInteraction({ guild: null, guildId: null });

        await expect(interactionCreate.execute(interaction, mockClient)).resolves.not.toThrow();

        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('only works inside a server') })
        );
        expect(mockCommand.execute).not.toHaveBeenCalled();
        expect(mockGuild.updateOne).not.toHaveBeenCalled();
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
// Retention calculation — production computeRetention helper
// ---------------------------------------------------------------------------

// Build a date string N days before a fixed reference epoch so fixtures are
// deterministic regardless of when the tests run.
function daysAgo(n, nowMs) {
    return new Date(nowMs - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('computeRetention (production helper)', () => {
    // Pin the clock so date arithmetic is stable across runs.
    const NOW = new Date('2026-01-30T12:00:00Z').getTime();

    it('counts only events within the last 7 calendar days for retained7', () => {
        const events = [
            { date: daysAgo(35, NOW), joins: 100, leaves: 0 }, // outside both windows
            { date: daysAgo(20, NOW), joins: 100, leaves: 0 }, // inside 30-day, outside 7-day
            { date: daysAgo(5,  NOW), joins: 10,  leaves: 5  }, // inside 7-day
            { date: daysAgo(2,  NOW), joins: 10,  leaves: 5  }, // inside 7-day
        ];
        const { joins7, leaves7, retained7 } = computeRetention(events, NOW);
        expect(joins7).toBe(20);
        expect(leaves7).toBe(10);
        // retained7 = (20 - 10) / 20 = 0.5
        expect(retained7).toBeCloseTo(0.5);
    });

    it('excludes events older than 30 days from retained30', () => {
        const events = [
            { date: daysAgo(35, NOW), joins: 999, leaves: 999 }, // must be excluded
            { date: daysAgo(25, NOW), joins: 100, leaves: 20  },
            { date: daysAgo(3,  NOW), joins: 100, leaves: 20  },
        ];
        const { joins30, leaves30, retained30 } = computeRetention(events, NOW);
        expect(joins30).toBe(200);
        expect(leaves30).toBe(40);
        // retained30 = (200 - 40) / 200 = 0.8
        expect(retained30).toBeCloseTo(0.8);
    });

    it('sparse history: gaps between events do not shift the window', () => {
        // Only one event 6 days ago; no events on days 1-5.
        // slice(-7) on a 1-entry array would include it regardless of date;
        // date-filtering must also include it (6 days ago < 7-day cutoff).
        const events = [
            { date: daysAgo(60, NOW), joins: 50, leaves: 0 },
            { date: daysAgo(6,  NOW), joins: 10, leaves: 4 },
        ];
        const { joins7, retained7 } = computeRetention(events, NOW);
        expect(joins7).toBe(10);
        expect(retained7).toBeCloseTo(0.6);
    });

    it('returns 0 for retained7 when there are no 7-day joins', () => {
        const events = [{ date: daysAgo(2, NOW), joins: 0, leaves: 5 }];
        expect(computeRetention(events, NOW).retained7).toBe(0);
    });

    it('returns 0 for retained30 when there are no 30-day events', () => {
        expect(computeRetention([], NOW).retained30).toBe(0);
    });

    it('clamps retention to 0 when leaves exceed joins (no negative retention)', () => {
        const events = [{ date: daysAgo(1, NOW), joins: 10, leaves: 50 }];
        const { retained7, retained30 } = computeRetention(events, NOW);
        expect(retained7).toBeGreaterThanOrEqual(0);
        expect(retained30).toBeGreaterThanOrEqual(0);
    });
});
