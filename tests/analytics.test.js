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
const mockGuildAnalytics = { findOne: jest.fn(), updateOne: jest.fn(), bulkWrite: jest.fn() };
jest.mock('../src/models/GuildAnalytics', () => mockGuildAnalytics);
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
jest.mock('../src/services/pollService', () => ({ handlePollVote: jest.fn() }));

// Minimal stubs so api.js (and its transitive requires) can be loaded without
// a real DB or external services.
jest.mock('../src/models/Case', () => ({ find: jest.fn() }));
jest.mock('../src/models/KnowledgeBase', () => ({}));
jest.mock('../src/models/SummaryJob', () => ({}));
jest.mock('../src/services/rssService', () => ({ sendDailyNews: jest.fn() }));
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
const guildMemberAdd = require('../src/events/guildMemberAdd');
const guildMemberRemove = require('../src/events/guildMemberRemove');
const interactionCreate = require('../src/events/interactionCreate');
const { useFixedClock, advanceClock, HOUR } = require('./helpers/fixedClock');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuildSettings(overrides = {}) {
    return {
        guildId: '111111111111111111',
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
    // `TODAY` is read once when this describe body runs; the handler reads its
    // own `new Date().toISOString().slice(0, 10)` when the event arrives
    // (guildMemberAdd.js:65). Unpinned those are two clock reads with the whole
    // suite between them, and a run that crosses midnight UTC compares one day
    // against the next (#632).
    useFixedClock();
    const TODAY = '2026-03-29';

    beforeEach(() => {
        jest.clearAllMocks();
        mockGuild.findOne.mockResolvedValue(makeGuildSettings());
    });

    it('increments joins on existing today entry', async () => {
        mockGuildAnalytics.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

        const member = makeMember();
        await guildMemberAdd.execute(member, {});

        expect(mockGuildAnalytics.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ 'memberEvents.date': TODAY }),
            expect.objectContaining({ $inc: { 'memberEvents.$.joins': 1 } })
        );
    });

    it('inserts new entry when no existing today entry', async () => {
        mockGuildAnalytics.updateOne
            .mockResolvedValueOnce({ matchedCount: 0 }) // increment miss
            .mockResolvedValueOnce({ matchedCount: 1 }); // insert succeeds

        const member = makeMember();
        await guildMemberAdd.execute(member, {});

        const secondCall = mockGuildAnalytics.updateOne.mock.calls[1];
        expect(secondCall[1].$push.memberEvents.$each[0]).toMatchObject({
            date: TODAY,
            joins: 1,
            leaves: 0,
        });
        expect(secondCall[1].$push.memberEvents.$slice).toBe(-120);
    });

    it('a join either side of midnight UTC is counted against its own day', async () => {
        // The pinned clock sits half an hour before midnight, so one hour of
        // elapsed time is a date change, a month rollover and — in the EU — a
        // DST change. The day key must follow the clock rather than whatever
        // the suite captured when it started.
        mockGuildAnalytics.updateOne.mockResolvedValue({ matchedCount: 1 });

        await guildMemberAdd.execute(makeMember(), {});
        advanceClock(HOUR);
        await guildMemberAdd.execute(makeMember(), {});

        const [before, after] = mockGuildAnalytics.updateOne.mock.calls;
        expect(before[0]).toMatchObject({ 'memberEvents.date': '2026-03-29' });
        expect(after[0]).toMatchObject({ 'memberEvents.date': '2026-03-30' });
    });

    it('does not throw if guild not found', async () => {
        mockGuild.findOne.mockResolvedValue(null);
        const member = makeMember();
        await expect(guildMemberAdd.execute(member, {})).resolves.not.toThrow();
    });

    it('swallows analytics errors without crashing the join flow', async () => {
        mockGuildAnalytics.updateOne.mockRejectedValue(new Error('DB error'));
        const member = makeMember();
        // Should not reject — analytics errors are caught
        await expect(guildMemberAdd.execute(member, {})).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// trackMemberEvent — leave tracking
// ---------------------------------------------------------------------------

describe('trackMemberEvent (guildMemberRemove)', () => {
    // Same clock race as the join side above (#632).
    useFixedClock();
    const TODAY = '2026-03-29';

    beforeEach(() => {
        jest.clearAllMocks();
        mockGuild.findOne.mockResolvedValue(makeGuildSettings());
    });

    it('increments leaves on existing today entry', async () => {
        mockGuildAnalytics.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

        const member = makeMember();
        await guildMemberRemove.execute(member, {});

        expect(mockGuildAnalytics.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ 'memberEvents.date': TODAY }),
            expect.objectContaining({ $inc: { 'memberEvents.$.leaves': 1 } })
        );
    });

    it('inserts new entry with leaves=1 joins=0 when no today entry', async () => {
        mockGuildAnalytics.updateOne
            .mockResolvedValueOnce({ matchedCount: 0 })
            .mockResolvedValueOnce({ matchedCount: 1 });

        const member = makeMember();
        await guildMemberRemove.execute(member, {});

        const secondCall = mockGuildAnalytics.updateOne.mock.calls[1];
        expect(secondCall[1].$push.memberEvents.$each[0]).toMatchObject({
            date: TODAY,
            joins: 0,
            leaves: 1,
        });
    });

    it('swallows analytics errors without crashing the leave flow', async () => {
        mockGuildAnalytics.updateOne.mockRejectedValue(new Error('DB error'));
        const member = makeMember();
        await expect(guildMemberRemove.execute(member, {})).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// logCommandMetric (interactionCreate)
// ---------------------------------------------------------------------------

// Command metrics are buffered and flushed in batches now (#895), so these
// assert on the batch write rather than on a per-command updateOne — and each
// one has to flush first, because the point of the change is that nothing on
// the interaction path waits for the write.
describe('logCommandMetric (interactionCreate)', () => {
    const metrics = require('../src/utils/commandMetricsBuffer');

    /** Flush the buffer and return the ops the batch write was given. */
    async function flushedOps() {
        await metrics.flushCommandMetrics();
        const call = mockGuildAnalytics.bulkWrite.mock.calls.at(-1);
        return call ? call[0] : [];
    }

    /** The commandUsage entries a flush pushed for the one test guild. */
    async function flushedEntries() {
        const ops = await flushedOps();
        return ops.flatMap(op => op.updateOne.update.$push.commandUsage.$each);
    }

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
        mockGuildAnalytics.updateOne.mockResolvedValue({});
        mockGuildAnalytics.bulkWrite.mockResolvedValue({});
        mockGuild.findOne.mockResolvedValue(makeGuildSettings());
        mockCommand.execute.mockResolvedValue(undefined);
        // Reset cooldown state so tests don't block each other via the 3s cooldown.
        mockClient.cooldowns.clear();
        // Module-level state, like the settings cache above: entries left by a
        // previous test would otherwise ride along in the next one's flush.
        metrics.resetCommandMetrics();
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
        await metrics.flushCommandMetrics();
        expect(mockGuildAnalytics.bulkWrite).not.toHaveBeenCalled();
    });

    it('logs a success metric after successful command execution', async () => {
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, mockClient);

        const [entry] = await flushedEntries();
        expect(entry).toBeDefined();
        expect(entry.command).toBe('ping');
        expect(entry.success).toBe(true);
        expect(entry.reason).toBeNull();
    });

    it('does not make the reply wait for the metric write', async () => {
        // The whole point of #895: the handler returns having touched no
        // database at all for analytics. A regression here is silent — the
        // metric still lands, just back in front of the user's reply.
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, mockClient);

        expect(mockGuildAnalytics.bulkWrite).not.toHaveBeenCalled();
        expect(mockGuildAnalytics.updateOne).not.toHaveBeenCalled();
        expect(metrics.getCommandMetricsStats().pendingEntries).toBe(1);
    });

    it('logs a failure metric when command throws', async () => {
        mockCommand.execute.mockRejectedValueOnce(new Error('boom'));
        const interaction = makeInteraction({ replied: false, deferred: false });
        await interactionCreate.execute(interaction, mockClient);

        const entries = await flushedEntries();
        expect(entries.some(e => e.success === false)).toBe(true);
    });

    it('caps commandUsage array at 3000 entries via $slice', async () => {
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, mockClient);

        const [op] = await flushedOps();
        expect(op.updateOne.update.$push.commandUsage.$slice).toBe(-3000);
    });

    it('records the hour of the command (0–23)', async () => {
        const interaction = makeInteraction();
        await interactionCreate.execute(interaction, mockClient);

        const [entry] = await flushedEntries();
        expect(entry.hour).toBeGreaterThanOrEqual(0);
        expect(entry.hour).toBeLessThanOrEqual(23);
    });

    it('logs unknown_command reason when command not found', async () => {
        const unknownInteraction = makeInteraction({ commandName: 'nonexistent' });
        await interactionCreate.execute(unknownInteraction, mockClient);

        const [entry] = await flushedEntries();
        expect(entry.reason).toBe('unknown_command');
        expect(entry.success).toBe(false);
    });

    it('collapses a burst of commands into one write per guild', async () => {
        // The reason for the buffer. Five commands used to be five capped
        // pushes, each one rewriting a 3000-element array region.
        // A different user each time: the command carries a 3s cooldown, and
        // the cooldown store is real here, so one user would be turned away
        // four times over and record four policy-shaped metrics instead.
        for (let i = 0; i < 5; i++) {
            await interactionCreate.execute(
                makeInteraction({ user: { id: `44444444444444440${i}` } }), mockClient);
        }

        const ops = await flushedOps();
        expect(mockGuildAnalytics.bulkWrite).toHaveBeenCalledTimes(1);
        expect(ops).toHaveLength(1);
        expect(ops[0].updateOne.update.$push.commandUsage.$each.length).toBeGreaterThan(1);
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
