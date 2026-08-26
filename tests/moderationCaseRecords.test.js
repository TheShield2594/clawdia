'use strict';

/**
 * #783. `caseService` was at 15% lines and **0% branches**, and it is what turns
 * an auto-moderation action into the record a human later reviews or appeals
 * against. `logModeration` is the only caller on the automod path, and the
 * case it writes is the only surviving evidence once the message is deleted.
 *
 * `getNextCaseId` is the sharp part: case ids are per-guild and user-visible
 * (`/appeal` takes one), so two concurrent actions must not be handed the same
 * number.
 */

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../src/utils/jobRunner', () => ({ runJob: jest.fn(async (_s, _j, fn) => fn()) }));
jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.fields.push(...f.flat()); return this; }
    }
    return { EmbedBuilder };
});
jest.mock('../src/models/Case',  () => ({ create: jest.fn(), find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), countDocuments: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));

const Case  = require('../src/models/Case');
const Guild = require('../src/models/Guild');
const cron = require('node-cron');
const { runJob } = require('../src/utils/jobRunner');
const { createCase, addNote, closeCase, getCase, getCasesForUser, startSlaMonitor } = require('../src/services/caseService');
const { logModeration } = require('../src/services/moderationLogService');

const HOUR = 3600_000;

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue({ guildId: 'g1' });
    Guild.findOneAndUpdate.mockResolvedValue({ caseSettings: { nextCaseId: 12 } });
    Case.create.mockImplementation(async doc => ({ ...doc }));
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('case ids', () => {
    test('are allocated in one atomic round trip, not read-then-write', async () => {
        await createCase({ guildId: 'g1', type: 'warn', targetUserId: 'u1', moderatorId: 'bot', reason: 'r' });

        const [filter, update, options] = Guild.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1' });
        // A pipeline update, so the increment happens server-side. Reading the
        // counter and writing it back would hand two concurrent actions the
        // same user-visible case number.
        expect(Array.isArray(update)).toBe(true);
        expect(update[0].$set['caseSettings.nextCaseId'].$ifNull).toEqual([{ $add: ['$caseSettings.nextCaseId', 1] }, 1]);
        expect(options).toMatchObject({ upsert: true, new: true });
    });

    test('start at 1 for a guild that has never filed one', async () => {
        // The `$ifNull` branch above: no counter yet means 1, not NaN and not 2.
        Guild.findOneAndUpdate.mockResolvedValue({ caseSettings: { nextCaseId: 1 } });

        const created = await createCase({ guildId: 'g1', type: 'warn', targetUserId: 'u1', moderatorId: 'bot', reason: 'r' });

        expect(created.caseId).toBe(1);
    });

    test('are used as returned, with no off-by-one correction', async () => {
        const created = await createCase({ guildId: 'g1', type: 'warn', targetUserId: 'u1', moderatorId: 'bot', reason: 'r' });
        expect(created.caseId).toBe(12);
    });
});

describe('createCase', () => {
    test('opens the case with the evidence it was handed', async () => {
        const evidence = { messageId: 'm1', content: 'https://example.com' };

        const created = await createCase({
            guildId: 'g1', type: 'warn', targetUserId: 'u1', moderatorId: 'bot', reason: '[AutoMod] posting a link', evidence,
        });

        expect(created).toMatchObject({
            guildId: 'g1', type: 'warn', targetUserId: 'u1', moderatorId: 'bot', status: 'open', evidence,
        });
    });

    test('an evidence-free case stores an empty object rather than null', async () => {
        const created = await createCase({ guildId: 'g1', type: 'note', targetUserId: 'u1', moderatorId: 'm1', reason: 'r' });
        expect(created.evidence).toEqual({});
    });

    test.each([['ban'], ['kick'], ['mute']])('gives a %s an SLA deadline for review', async type => {
        Guild.findOne.mockResolvedValue({ guildId: 'g1', caseSettings: { slaHours: 6 } });

        const created = await createCase({ guildId: 'g1', type, targetUserId: 'u1', moderatorId: 'bot', reason: 'r' });

        expect(created.slaDeadline.getTime() - Date.now()).toBeGreaterThan(5.9 * HOUR);
        expect(created.slaDeadline.getTime() - Date.now()).toBeLessThan(6.1 * HOUR);
    });

    test.each([['warn'], ['note'], ['unban']])('does not put a %s on the SLA clock', async type => {
        const created = await createCase({ guildId: 'g1', type, targetUserId: 'u1', moderatorId: 'bot', reason: 'r' });
        expect(created.slaDeadline).toBeNull();
    });

    test('falls back to a 48-hour SLA when the guild has not set one', async () => {
        const created = await createCase({ guildId: 'g1', type: 'ban', targetUserId: 'u1', moderatorId: 'bot', reason: 'r' });

        expect(created.slaDeadline.getTime() - Date.now()).toBeGreaterThan(47.9 * HOUR);
    });

    test('a write that fails returns null instead of throwing into the caller', async () => {
        // The caller is a moderation action that has already happened. Throwing
        // here would surface as a failed command after the user was punished.
        Case.create.mockRejectedValue(new Error('mongo down'));

        expect(await createCase({ guildId: 'g1', type: 'warn', targetUserId: 'u1', moderatorId: 'bot', reason: 'r' })).toBeNull();
        expect(errorLog).toHaveBeenCalled();
    });
});

describe('case lookup and mutation', () => {
    test('notes are appended, never overwritten', async () => {
        Case.findOneAndUpdate.mockResolvedValue({});

        await addNote('g1', 12, 'mod1', 'spoke to them');

        const [filter, update] = Case.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', caseId: 12 });
        expect(update.$push.notes).toMatchObject({ moderatorId: 'mod1', content: 'spoke to them' });
    });

    test('closing a case records who closed it and when', async () => {
        Case.findOneAndUpdate.mockResolvedValue({});

        await closeCase('g1', 12, 'mod1', 'warned, no further action');

        const [, update] = Case.findOneAndUpdate.mock.calls[0];
        expect(update).toMatchObject({ status: 'closed', resolvedBy: 'mod1', resolution: 'warned, no further action' });
        expect(update.resolvedAt).toBeInstanceOf(Date);
    });

    test('a case is looked up by guild and id together', async () => {
        Case.findOne.mockResolvedValue(null);

        await getCase('g1', 12);

        // Case ids are per-guild, so an id-only lookup reads another guild's case.
        expect(Case.findOne).toHaveBeenCalledWith({ guildId: 'g1', caseId: 12 });
    });

    test('a user’s history comes back newest first and bounded', async () => {
        const calls = {};
        Case.find.mockReturnValue({
            sort(s) { calls.sort = s; return this; },
            limit(n) { calls.limit = n; return this; },
        });

        await getCasesForUser('g1', 'u1');

        expect(Case.find).toHaveBeenCalledWith({ guildId: 'g1', targetUserId: 'u1' });
        expect(calls.sort).toEqual({ createdAt: -1 });
        expect(calls.limit).toBe(10);
    });
});

describe('logModeration — the automod path into all of it', () => {
    const botUser = (channel = null) => ({
        id: 'bot1', username: 'Clawdia',
        client: { channels: { cache: new Map(channel ? [['log1', channel]] : []) } },
    });

    test('files a case even when the guild has no log channel', async () => {
        const result = await logModeration('g1', 'warn', { id: 'u1', username: 'Ada' }, botUser(), '[AutoMod] posting a link');

        // The case is the durable record; the channel post is a courtesy.
        expect(Case.create).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ type: 'warn', targetUserId: 'u1', moderatorId: 'bot1' });
    });

    test('posts to the log channel when there is one', async () => {
        const sent = [];
        Guild.findOne.mockResolvedValue({ guildId: 'g1', moderation: { logChannelId: 'log1' } });
        const channel = { send: async p => sent.push(p) };

        await logModeration('g1', 'ban', { id: 'u1', username: 'Ada' }, botUser(channel), '[AutoMod] score 30');

        expect(sent[0].embeds[0].title).toBe('BAN | Ada');
        expect(sent[0].embeds[0].fields.map(f => f.name)).toEqual(['User', 'Moderator', 'Reason']);
    });

    test('adds the duration to the log entry for a timed action', async () => {
        const sent = [];
        Guild.findOne.mockResolvedValue({ guildId: 'g1', moderation: { logChannelId: 'log1' } });

        await logModeration('g1', 'mute', { id: 'u1', username: 'Ada' }, botUser({ send: async p => sent.push(p) }), 'r', { duration: 10 });

        expect(sent[0].embeds[0].fields.find(f => f.name === 'Duration').value).toBe('10 minutes');
    });

    test('a log channel that has been deleted does not cost the case', async () => {
        Guild.findOne.mockResolvedValue({ guildId: 'g1', moderation: { logChannelId: 'log1' } });

        await logModeration('g1', 'warn', { id: 'u1', username: 'Ada' }, botUser(), 'r');

        expect(Case.create).toHaveBeenCalledTimes(1);
    });

    test('a failure anywhere returns null rather than throwing at the moderator', async () => {
        Guild.findOne.mockRejectedValue(new Error('mongo down'));

        expect(await logModeration('g1', 'warn', { id: 'u1' }, botUser(), 'r')).toBeNull();
        expect(errorLog).toHaveBeenCalled();
    });
});

describe('the SLA monitor', () => {
    /** Runs the job body the monitor registers with cron, without a real clock. */
    async function tick(client) {
        cron.schedule.mockClear();
        startSlaMonitor(client);
        const [expression, body] = cron.schedule.mock.calls[0];
        await body();
        return expression;
    }

    function overdue(over = {}) {
        return {
            _id: 'c1', caseId: 12, guildId: 'g1', targetUserId: 'u1',
            type: 'ban', reason: 'raid', createdAt: new Date(0), ...over,
        };
    }

    function clientWith({ sent = [], channels = { sla1: { send: async p => sent.push(p) } } } = {}) {
        return {
            sent,
            client: {
                guilds: {
                    cache: new Map([['g1', {
                        channels: { cache: new Map(Object.entries(channels)) },
                    }]]),
                },
            },
        };
    }

    beforeEach(() => {
        Case.find.mockResolvedValue([overdue()]);
        Guild.find.mockResolvedValue([{ guildId: 'g1', caseSettings: { slaChannelId: 'sla1', slaHours: 48 } }]);
        Case.updateOne.mockResolvedValue({});
    });

    test('runs on a half-hourly schedule under the job runner', async () => {
        expect(await tick(clientWith().client)).toBe('*/30 * * * *');
        // Through runJob, so an overlapping tick is skipped and a failure is
        // recorded rather than vanishing into an unhandled rejection.
        expect(runJob).toHaveBeenCalledWith('caseService', 'slaMonitor', expect.any(Function));
    });

    test('reads only open cases whose deadline has passed', async () => {
        await tick(clientWith().client);

        const [filter] = Case.find.mock.calls[0];
        expect(filter.status).toBe('open');
        expect(filter.slaDeadline.$lte).toBeInstanceOf(Date);
    });

    test('batch-fetches guild settings rather than one read per case', async () => {
        Case.find.mockResolvedValue([overdue(), overdue({ _id: 'c2', caseId: 13 }), overdue({ _id: 'c3', guildId: 'g2' })]);

        await tick(clientWith().client);

        expect(Guild.find).toHaveBeenCalledTimes(1);
        // Deduplicated: three cases, two guilds.
        expect(Guild.find.mock.calls[0][0]).toEqual({ guildId: { $in: ['g1', 'g2'] } });
    });

    test('pings the SLA channel with the case it is chasing', async () => {
        const ctx = clientWith();
        await tick(ctx.client);

        const embed = ctx.sent[0].embeds[0];
        expect(embed.title).toBe('SLA Overdue — Open Case');
        expect(embed.description).toContain('Case **#12**');
        expect(Object.fromEntries(embed.fields.map(f => [f.name, f.value]))).toMatchObject({
            Type: 'BAN', Target: '<@u1>', Reason: 'raid',
        });
    });

    test('pushes the deadline forward so it does not ping every half hour', async () => {
        await tick(clientWith().client);

        const [filter, update] = Case.updateOne.mock.calls[0];
        expect(filter).toEqual({ _id: 'c1' });
        expect(update.slaDeadline.getTime() - Date.now()).toBeGreaterThan(47.9 * HOUR);
    });

    test('falls back to the moderation log channel when no SLA channel is set', async () => {
        Guild.find.mockResolvedValue([{ guildId: 'g1', moderation: { logChannelId: 'log1' } }]);
        const sent = [];

        await tick(clientWith({ sent, channels: { log1: { send: async p => sent.push(p) } } }).client);

        expect(sent).toHaveLength(1);
    });

    test.each([
        ['no channel configured', { guilds: [{ guildId: 'g1' }] }],
        ['a guild the bot has left', { guilds: [{ guildId: 'g1', caseSettings: { slaChannelId: 'sla1' } }], noGuild: true }],
        ['a channel that was deleted', { guilds: [{ guildId: 'g1', caseSettings: { slaChannelId: 'gone' } }] }],
    ])('skips %s without touching the deadline', async (_label, { guilds, noGuild }) => {
        Guild.find.mockResolvedValue(guilds);
        const client = noGuild ? { guilds: { cache: new Map() } } : clientWith().client;

        await tick(client);

        // Silently rescheduling a ping nobody received would let the case age
        // out of the report without ever being chased.
        expect(Case.updateOne).not.toHaveBeenCalled();
    });

    test('a case with no reason still reports', async () => {
        Case.find.mockResolvedValue([overdue({ reason: null })]);
        const ctx = clientWith();

        await tick(ctx.client);

        expect(ctx.sent[0].embeds[0].fields.find(f => f.name === 'Reason').value).toBe('No reason provided');
    });

    test('nothing overdue posts nothing', async () => {
        Case.find.mockResolvedValue([]);
        const ctx = clientWith();

        await tick(ctx.client);

        expect(ctx.sent).toEqual([]);
        expect(Case.updateOne).not.toHaveBeenCalled();
    });
});
