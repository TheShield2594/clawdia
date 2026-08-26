'use strict';

/**
 * #783. `escalationService` was at 11.9% lines and **0% branches**. It is the
 * warning ladder behind `/warn`: cross a configured threshold and it mutes,
 * kicks, bans or temp-bans without anyone confirming it.
 *
 * The branches that were unexecuted are the ones that decide whether the action
 * can happen at all — a member who has already left, a member the bot is not
 * permitted to act on, a tempban step with no duration — and each of them has to
 * skip rather than half-apply, because a half-applied step files a case for a
 * punishment nobody received.
 */

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
jest.mock('../src/models/Guild',   () => ({ findOne: jest.fn() }));
jest.mock('../src/models/Case',    () => ({ countDocuments: jest.fn() }));
jest.mock('../src/models/TempBan', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/services/caseService', () => ({ createCase: jest.fn() }));

const Guild   = require('../src/models/Guild');
const Case    = require('../src/models/Case');
const TempBan = require('../src/models/TempBan');
const { createCase } = require('../src/services/caseService');
const {
    applyEscalation, simulate, findStepForCount, countWarnings, formatReason,
} = require('../src/services/escalationService');

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

const LADDER = [
    { threshold: 3, action: 'mute',    durationMinutes: 10, reason: '{count} warnings', dmUser: true },
    { threshold: 5, action: 'kick',    reason: 'kicked at {count}' },
    { threshold: 7, action: 'tempban', durationMinutes: 1440 },
    { threshold: 9, action: 'ban' },
];

function member(over = {}) {
    return {
        id: 'u1',
        moderatable: true, kickable: true, bannable: true,
        timeout: jest.fn(async () => {}),
        kick:    jest.fn(async () => {}),
        ...over,
    };
}

function fakeGuild({ theMember = member(), channel = null } = {}) {
    return {
        id: 'g1',
        name: 'Guild One',
        members: { fetch: jest.fn(async () => theMember), ban: jest.fn(async () => {}) },
        channels: { cache: new Map(channel ? [['log1', channel]] : []) },
    };
}

const targetUser = () => ({ id: 'u1', username: 'Ada', send: jest.fn(async () => {}) });
const client = { user: { id: 'bot1', username: 'Clawdia' } };

const apply = (over = {}) => applyEscalation({
    guild: fakeGuild(), targetUser: targetUser(), warningCount: 3, client, ...over,
});

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue({ moderation: { escalation: { enabled: true, ladder: LADDER } } });
    createCase.mockResolvedValue({ caseId: 42 });
    TempBan.findOneAndUpdate.mockResolvedValue({});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('picking a rung', () => {
    test('matches a threshold exactly, not "at least"', () => {
        expect(findStepForCount(LADDER, 3).action).toBe('mute');
        // 4 is past the mute rung but short of the kick one. Treating the ladder
        // as ">=" would re-mute on every warning between rungs.
        expect(findStepForCount(LADDER, 4)).toBeNull();
        expect(findStepForCount(LADDER, 5).action).toBe('kick');
    });

    test('an empty or missing ladder matches nothing', () => {
        expect(findStepForCount([], 3)).toBeNull();
        expect(findStepForCount(undefined, 3)).toBeNull();
        expect(findStepForCount(null, 3)).toBeNull();
    });

    test('simulate is the same lookup, for previewing a ladder before saving it', () => {
        expect(simulate(LADDER, 5)).toEqual(LADDER[1]);
        expect(simulate(LADDER, 6)).toBeNull();
    });

    test('the reason template gets the count substituted in, everywhere it appears', () => {
        expect(formatReason('{count} warnings ({count})', 4)).toBe('4 warnings (4)');
        expect(formatReason(null, 4)).toBe('Automatic escalation: 4 warnings reached');
        expect(formatReason('', 4)).toBe('Automatic escalation: 4 warnings reached');
    });

    test('warnings are counted per guild, per user, and only warnings', async () => {
        Case.countDocuments.mockResolvedValue(3);

        expect(await countWarnings('g1', 'u1')).toBe(3);
        expect(Case.countDocuments).toHaveBeenCalledWith({ guildId: 'g1', targetUserId: 'u1', type: 'warn' });
    });
});

describe('the gate in front of the ladder', () => {
    test('does nothing when escalation is off', async () => {
        Guild.findOne.mockResolvedValue({ moderation: { escalation: { enabled: false, ladder: LADDER } } });
        expect(await apply()).toBeNull();
        expect(createCase).not.toHaveBeenCalled();
    });

    test('does nothing for a guild with no escalation settings at all', async () => {
        Guild.findOne.mockResolvedValue(null);
        expect(await apply()).toBeNull();
    });

    test('does nothing on a count that matches no rung', async () => {
        expect(await apply({ warningCount: 4 })).toBeNull();
        expect(createCase).not.toHaveBeenCalled();
    });
});

describe('applying a rung', () => {
    test('mutes for the configured duration and files the case', async () => {
        const m = member();
        const result = await apply({ guild: fakeGuild({ theMember: m }) });

        expect(m.timeout).toHaveBeenCalledWith(10 * 60 * 1000, '3 warnings');
        expect(result).toMatchObject({ applied: true, actionTaken: 'mute', autoCase: { caseId: 42 } });
        expect(createCase).toHaveBeenCalledWith(expect.objectContaining({
            guildId: 'g1', type: 'mute', targetUserId: 'u1', moderatorId: 'bot1', duration: 10,
        }));
    });

    test('clamps a mute to Discord’s 28-day ceiling instead of failing the call', async () => {
        Guild.findOne.mockResolvedValue({ moderation: { escalation: { enabled: true, ladder: [
            { threshold: 3, action: 'mute', durationMinutes: 60 * 24 * 365 },
        ] } } });
        const m = member();

        await apply({ guild: fakeGuild({ theMember: m }) });

        expect(m.timeout.mock.calls[0][0]).toBe(MAX_TIMEOUT_MS);
    });

    test('a mute step with no duration uses the ceiling rather than muting for zero', async () => {
        Guild.findOne.mockResolvedValue({ moderation: { escalation: { enabled: true, ladder: [
            { threshold: 3, action: 'mute' },
        ] } } });
        const m = member();

        await apply({ guild: fakeGuild({ theMember: m }) });

        expect(m.timeout.mock.calls[0][0]).toBe(MAX_TIMEOUT_MS);
        expect(createCase.mock.calls[0][0].duration).toBeNull();
    });

    test('kicks with the substituted reason', async () => {
        const m = member();
        await apply({ guild: fakeGuild({ theMember: m }), warningCount: 5 });

        expect(m.kick).toHaveBeenCalledWith('kicked at 5');
        expect(createCase.mock.calls[0][0].type).toBe('kick');
    });

    test('bans through the guild, so it works on a user who has already left', async () => {
        const guild = fakeGuild();
        guild.members.fetch.mockResolvedValue(null);

        const result = await apply({ guild, warningCount: 9 });

        // Discord allows ban-by-id; refusing here would let leaving the server
        // dodge the ban rung.
        expect(guild.members.ban).toHaveBeenCalledWith('u1', { reason: expect.stringContaining('9 warnings reached') });
        expect(result.applied).toBe(true);
    });

    test('a tempban records the expiry so the sweep can lift it', async () => {
        const guild = fakeGuild();
        await apply({ guild, warningCount: 7 });

        const [filter, update, options] = TempBan.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', userId: 'u1' });
        expect(update.expiresAt.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
        // Upsert, so re-banning someone who already has a record moves the
        // expiry rather than failing on the unique index.
        expect(options).toEqual({ upsert: true });
        expect(guild.members.ban).toHaveBeenCalled();
        // Filed as a ban: 'tempban' is not a case type.
        expect(createCase.mock.calls[0][0].type).toBe('ban');
    });

    test('records the tempban before it issues the ban', async () => {
        const order = [];
        TempBan.findOneAndUpdate.mockImplementation(async () => { order.push('record'); return {}; });
        const guild = fakeGuild();
        guild.members.ban.mockImplementation(async () => { order.push('ban'); });

        await apply({ guild, warningCount: 7 });

        // Banning first and crashing before the record is a permanent ban that
        // nothing will ever lift.
        expect(order).toEqual(['record', 'ban']);
    });
});

describe('rungs that cannot be applied', () => {
    test.each([
        ['a member who has left',      'mute', 3, { theMember: null }],
        ['a member it cannot mute',    'mute', 3, { theMember: member({ moderatable: false }) }],
        ['a member who has left',      'kick', 5, { theMember: null }],
        ['a member it cannot kick',    'kick', 5, { theMember: member({ kickable: false }) }],
        ['a member it cannot ban',     'ban',  9, { theMember: member({ bannable: false }) }],
        ['a member it cannot tempban', 'ban',  7, { theMember: member({ bannable: false }) }],
    ])('skips %s on a %s rung', async (_who, _action, warningCount, guildOpts) => {
        const result = await apply({ guild: fakeGuild(guildOpts), warningCount });

        expect(result.skipped).toBe(true);
        expect(result.reason).toBeTruthy();
        // No case, because nothing happened. A case here is a record of a
        // punishment the user never received.
        expect(createCase).not.toHaveBeenCalled();
    });

    test('skips a tempban rung configured with no duration', async () => {
        Guild.findOne.mockResolvedValue({ moderation: { escalation: { enabled: true, ladder: [
            { threshold: 3, action: 'tempban' },
        ] } } });

        const result = await apply();

        // Without a duration there is nothing to expire, so this would be a
        // permanent ban dressed as a temporary one.
        expect(result).toMatchObject({ skipped: true, reason: 'tempban step missing duration.' });
        expect(TempBan.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('an action that throws is reported, not swallowed and not re-thrown', async () => {
        const m = member();
        m.timeout.mockRejectedValue(new Error('Missing Permissions'));

        const result = await apply({ guild: fakeGuild({ theMember: m }) });

        expect(result).toMatchObject({ error: true, step: expect.objectContaining({ action: 'mute' }) });
        expect(createCase).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalled();
    });
});

describe('what the guild is told', () => {
    test('DMs the target when the rung says to, naming the action and duration', async () => {
        const user = targetUser();
        await apply({ targetUser: user });

        expect(user.send.mock.calls[0][0]).toBe('You have been auto-muted for 10 minute(s) in **Guild One**: 3 warnings');
    });

    test('stays silent when the rung does not ask for a DM', async () => {
        const user = targetUser();
        await apply({ targetUser: user, warningCount: 5 });

        expect(user.send).not.toHaveBeenCalled();
    });

    test('a DM the user has closed does not stop the mute', async () => {
        const user = targetUser();
        user.send.mockRejectedValue(new Error('Cannot send messages to this user'));
        const m = member();

        const result = await apply({ targetUser: user, guild: fakeGuild({ theMember: m }) });

        expect(m.timeout).toHaveBeenCalled();
        expect(result.applied).toBe(true);
    });

    test('posts to the moderation log with both case references', async () => {
        const sent = [];
        Guild.findOne.mockResolvedValue({ moderation: { logChannelId: 'log1', escalation: { enabled: true, ladder: LADDER } } });

        await apply({
            guild: fakeGuild({ channel: { send: async p => sent.push(p) } }),
            triggeringCase: { caseId: 41, guildId: 'g1' },
        });

        const embed = sent[0].embeds[0];
        expect(embed.title).toBe('AutoMod | MUTE | Ada');
        expect(embed.description).toContain('threshold **3**');
        const byName = Object.fromEntries(embed.fields.map(f => [f.name, f.value]));
        expect(byName['Triggering Warning']).toBe('Case #41');
        expect(byName['Auto Case']).toBe('Case #42');
        expect(byName.Duration).toBe('10 minute(s)');
    });

    test('a guild with no log channel still applies the rung', async () => {
        const m = member();
        const result = await apply({ guild: fakeGuild({ theMember: m }) });

        expect(m.timeout).toHaveBeenCalled();
        expect(result.applied).toBe(true);
    });

    test('a case that failed to file does not block the log post', async () => {
        const sent = [];
        Guild.findOne.mockResolvedValue({ moderation: { logChannelId: 'log1', escalation: { enabled: true, ladder: LADDER } } });
        createCase.mockResolvedValue(null);

        const result = await apply({ guild: fakeGuild({ channel: { send: async p => sent.push(p) } }) });

        expect(sent[0].embeds[0].fields.some(f => f.name === 'Auto Case')).toBe(false);
        expect(result.applied).toBe(true);
    });
});
