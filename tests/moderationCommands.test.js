'use strict';

// #628: `src/commands/moderation/*` is 16 files and the whole destructive
// surface — ban, kick, mute, massban, lockdown, clear — and not one of their
// `execute()` functions had ever been invoked by a test. The directory's
// reported line coverage was module-level `SlashCommandBuilder` constants
// evaluating at import; branches were at zero, and 49 `PermissionFlagsBits` /
// `memberPermissions` references sat unexecuted.
//
// The gap that matters most is the role-hierarchy guard. `src/utils/
// moderationHierarchy.js` is at 100% and tests/moderationHierarchy.test.js
// proves the rule — but it ties the rule to its *call sites* with a grep over
// file source, so renaming the helper, or moving the call below the action it
// guards, keeps that suite green. These tests drive the commands instead: a
// trial moderator aims at the head moderator and the ban has to not happen.

const { PermissionFlagsBits } = require('discord.js');

jest.mock('../src/services/moderationLogService', () => ({
    logModeration: jest.fn().mockResolvedValue({ caseId: 1 }),
}));
jest.mock('../src/services/antiNukeService', () => ({
    startLockdown: jest.fn().mockResolvedValue({ ok: true, locked: 4 }),
    endLockdown:   jest.fn().mockResolvedValue({ ok: true, restored: 4 }),
}));
jest.mock('../src/models/TempBan', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/models/Case', () => ({
    countDocuments: jest.fn().mockResolvedValue(0),
    find:           jest.fn(),
    findOne:        jest.fn().mockResolvedValue(null),
    deleteOne:      jest.fn().mockResolvedValue({ deletedCount: 1 }),
}));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue({}) }));
// findStepForCount is a pure function over the configured ladder and is worth
// running for real; only the half that touches Discord is stubbed.
jest.mock('../src/services/escalationService', () => ({
    ...jest.requireActual('../src/services/escalationService'),
    applyEscalation: jest.fn().mockResolvedValue({ applied: false }),
}));

const { logModeration } = require('../src/services/moderationLogService');
const Case = require('../src/models/Case');
const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { applyEscalation } = require('../src/services/escalationService');
const { startLockdown, endLockdown } = require('../src/services/antiNukeService');
const TempBan = require('../src/models/TempBan');

const {
    makeUser, makeMember, makeGuild, makeInteraction, lastReply, command,
    GUILD_ID, OWNER_ID, BOT_ID, MOD_ID,
} = require('./helpers/moderationInteraction');

// The moderator is deliberately mid-table: high enough to act on an ordinary
// member, low enough that the head moderator and the owner are out of reach.
const MOD_POSITION = 10;
const modMember = () => makeMember(MOD_ID, { position: MOD_POSITION });

const target = (id = 'target-1', position = 1) => makeMember(id, { position });
const headMod = (id = 'head-mod') => makeMember(id, { position: MOD_POSITION + 5 });

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ── The guard, at every call site that has one ──────────────────────────────
//
// One table rather than one test per command, because the point is that the
// answer is the same everywhere: the rule is not a thing each handler
// re-implements slightly differently.
describe('a moderator cannot act on someone who outranks them', () => {
    const CASES = [
        {
            name: 'ban',
            run: async member => {
                const guild = makeGuild({ cached: [member] });
                const interaction = makeInteraction({
                    guild, options: { user: makeUser(member.id) }, invoker: modMember(),
                });
                await command('ban').execute(interaction);
                return { interaction, done: guild.actions.banned.length > 0 };
            },
        },
        {
            name: 'softban',
            run: async member => {
                const guild = makeGuild({ cached: [member] });
                const interaction = makeInteraction({
                    guild, options: { user: makeUser(member.id) }, invoker: modMember(),
                });
                await command('softban').execute(interaction);
                return { interaction, done: guild.actions.banned.length > 0 };
            },
        },
        {
            name: 'kick',
            run: async member => {
                const guild = makeGuild({ cached: [member] });
                const interaction = makeInteraction({
                    guild, options: { user: makeUser(member.id) }, invoker: modMember(),
                });
                await command('kick').execute(interaction);
                return { interaction, done: member.kick.mock.calls.length > 0 };
            },
        },
        {
            name: 'mute',
            run: async member => {
                const guild = makeGuild({ cached: [member] });
                const interaction = makeInteraction({
                    guild, options: { user: makeUser(member.id), duration: 10 }, invoker: modMember(),
                });
                await command('mute').execute(interaction);
                return { interaction, done: member.timeout.mock.calls.length > 0 };
            },
        },
    ];

    test.each(CASES)('$name refuses a target with a higher role', async ({ run }) => {
        const { interaction, done } = await run(headMod());
        expect(done).toBe(false);
        expect(lastReply(interaction)).toMatch(/above or equal to yours/i);
    });

    // The realistic case: two moderators handed the same role. Discord treats
    // equal as "no".
    test.each(CASES)('$name refuses an equal', async ({ run }) => {
        const { interaction, done } = await run(makeMember('peer', { position: MOD_POSITION }));
        expect(done).toBe(false);
        expect(lastReply(interaction)).toMatch(/above or equal to yours/i);
    });

    test.each(CASES)('$name refuses the server owner', async ({ run }) => {
        const { interaction, done } = await run(makeMember(OWNER_ID, { position: 1 }));
        expect(done).toBe(false);
        expect(lastReply(interaction)).toMatch(/server owner/i);
    });

    test.each(CASES)('$name allows an ordinary member below them', async ({ run }) => {
        const { done } = await run(target());
        expect(done).toBe(true);
    });
});

// ── ban ─────────────────────────────────────────────────────────────────────
describe('/ban', () => {
    const banInteraction = (overrides = {}) => {
        const member = overrides.member ?? target();
        const guild = overrides.guild ?? makeGuild({ cached: [member] });
        return {
            member,
            guild,
            interaction: makeInteraction({
                guild,
                invoker: modMember(),
                options: { user: makeUser(member.id), ...overrides.options },
            }),
        };
    };

    test('bans a member below the moderator and logs the case', async () => {
        const { guild, interaction } = banInteraction({ options: { reason: 'spam' } });
        await command('ban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(1);
        expect(guild.actions.banned[0].options.reason).toBe('spam');
        expect(logModeration).toHaveBeenCalledWith(
            GUILD_ID, 'ban', expect.anything(), expect.anything(), 'spam', {},
        );
        expect(lastReply(interaction)).toMatch(/User Banned/);
    });

    test('refuses to ban the moderator themselves', async () => {
        const guild = makeGuild();
        const interaction = makeInteraction({ guild, options: { user: makeUser(MOD_ID) } });
        await command('ban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/cannot ban yourself/i);
    });

    test('refuses to ban the bot', async () => {
        const guild = makeGuild();
        const interaction = makeInteraction({ guild, options: { user: makeUser(BOT_ID) } });
        await command('ban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/cannot ban myself/i);
    });

    test('refuses a target the bot itself cannot ban', async () => {
        const { guild, interaction } = banInteraction({
            member: makeMember('immune', { position: 1, bannable: false }),
        });
        await command('ban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/higher permissions/i);
    });

    // The member cache holds at most 200 per guild, so a target who has been
    // quiet is a cache miss rather than a non-member. A miss must be fetched.
    test('fetches a target the cache does not hold, and still checks their rank', async () => {
        const boss = headMod();
        const guild = makeGuild({ cached: [], fetchable: [boss] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(boss.id) },
        });
        await command('ban').execute(interaction);

        expect(guild.members.fetch).toHaveBeenCalledWith(boss.id);
        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/above or equal to yours/i);
    });

    // A ban by ID of someone who was never here is the whole point of the
    // command's "no member" path — it must still work.
    test('bans a user who is confirmed not in the guild', async () => {
        const guild = makeGuild({ cached: [], fetchable: [] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser('outsider') },
        });
        await command('ban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(1);
    });

    // The failure a caller can provoke: a 429 on the fetch is not "not a
    // member", and treating it as one would skip both the bot's bannable check
    // and the moderator's rank check.
    test('refuses when the lookup could not be settled', async () => {
        const rateLimited = Object.assign(new Error('rate limited'), { code: 0, status: 429 });
        const guild = makeGuild({ cached: [], fetchError: rateLimited });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser('unknown') },
        });
        await command('ban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/could not look this user up/i);
    });

    test('a temporary ban records an expiry and says when it lifts', async () => {
        const { interaction } = banInteraction({ options: { duration: '2h', reason: 'cooling off' } });
        await command('ban').execute(interaction);

        expect(TempBan.findOneAndUpdate).toHaveBeenCalledTimes(1);
        const [filter, update, opts] = TempBan.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: GUILD_ID, userId: 'target-1' });
        expect(update.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(opts).toEqual({ upsert: true });
        expect(lastReply(interaction)).toMatch(/User Temporarily Banned/);
        expect(lastReply(interaction)).toMatch(/2h/);
    });

    test.each(['2 hours', '2', 'h', '-1h', '2w'])('rejects the duration %p without banning', async duration => {
        const { guild, interaction } = banInteraction({ options: { duration } });
        await command('ban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(TempBan.findOneAndUpdate).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/Invalid duration/i);
    });

    test('a permanent ban writes no TempBan record', async () => {
        const { interaction } = banInteraction();
        await command('ban').execute(interaction);
        expect(TempBan.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('delete_days is sent to Discord as seconds', async () => {
        const { guild, interaction } = banInteraction({ options: { delete_days: 7 } });
        await command('ban').execute(interaction);
        expect(guild.actions.banned[0].options.deleteMessageSeconds).toBe(7 * 86400);
    });

    // The reply is the only place a moderator finds out; swallowing the error
    // and saying nothing is what this branch exists to prevent.
    test('reports a ban that Discord rejects', async () => {
        const member = target();
        const guild = makeGuild({ cached: [member], banError: new Error('Missing Permissions') });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id) },
        });
        await command('ban').execute(interaction);

        expect(lastReply(interaction)).toMatch(/Failed to ban/i);
    });
});

// ── softban ─────────────────────────────────────────────────────────────────
describe('/softban', () => {
    test('bans and then unbans, so the messages go but the member may return', async () => {
        const member = target();
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id), reason: 'raid' },
        });
        await command('softban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(1);
        expect(guild.actions.unbanned).toHaveLength(1);
        expect(guild.actions.banned[0].options.reason).toBe('[Softban] raid');
        expect(lastReply(interaction)).toMatch(/User Softbanned/);
    });

    test('deletes one day of messages by default', async () => {
        const member = target();
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id) },
        });
        await command('softban').execute(interaction);
        expect(guild.actions.banned[0].options.deleteMessageSeconds).toBe(86400);
    });

    // The unban is the half that makes it a softban rather than a ban, but it
    // is also the half that has already achieved its purpose if it fails.
    test('does not unban when the ban step failed', async () => {
        const member = target();
        const guild = makeGuild({ cached: [member], banError: new Error('Missing Permissions') });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id) },
        });
        await command('softban').execute(interaction);

        expect(guild.actions.unbanned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/Failed to ban/i);
    });

    test('refuses when the lookup could not be settled', async () => {
        const guild = makeGuild({ fetchError: new Error('rate limited') });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser('unknown') },
        });
        await command('softban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/could not look this user up/i);
    });

    test.each([[MOD_ID, /cannot softban yourself/i], [BOT_ID, /cannot softban myself/i]])(
        'refuses %s', async (id, expected) => {
            const guild = makeGuild();
            const interaction = makeInteraction({ guild, options: { user: makeUser(id) } });
            await command('softban').execute(interaction);

            expect(guild.actions.banned).toHaveLength(0);
            expect(lastReply(interaction)).toMatch(expected);
        });
});

// ── kick / mute / unmute ────────────────────────────────────────────────────
describe('/kick', () => {
    test('kicks a member below the moderator', async () => {
        const member = target();
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id), reason: 'rules' },
        });
        await command('kick').execute(interaction);

        expect(member.kick).toHaveBeenCalledWith('rules');
        expect(logModeration).toHaveBeenCalledWith(GUILD_ID, 'kick', expect.anything(), expect.anything(), 'rules');
    });

    test('refuses a target the bot cannot kick', async () => {
        const member = makeMember('immune', { position: 1, kickable: false });
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id) },
        });
        await command('kick').execute(interaction);

        expect(member.kick).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/higher permissions/i);
    });

    test('refuses a user who is not in the guild', async () => {
        const interaction = makeInteraction({
            guild: makeGuild(), invoker: modMember(), options: { user: makeUser('outsider') },
        });
        await command('kick').execute(interaction);
        expect(lastReply(interaction)).toMatch(/not found in this server/i);
    });

    test('refuses to kick the moderator themselves', async () => {
        const self = modMember();
        const guild = makeGuild({ cached: [self] });
        const interaction = makeInteraction({ guild, invoker: self, options: { user: makeUser(MOD_ID) } });
        await command('kick').execute(interaction);

        expect(self.kick).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/cannot kick yourself/i);
    });

    test('reports a kick that Discord rejects', async () => {
        const member = target();
        member.kick.mockRejectedValue(new Error('Missing Permissions'));
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id) },
        });
        await command('kick').execute(interaction);
        expect(lastReply(interaction)).toMatch(/Failed to kick/i);
    });
});

describe('/mute and /unmute', () => {
    test('mute times the member out for the requested minutes', async () => {
        const member = target();
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id), duration: 45, reason: 'cooldown' },
        });
        await command('mute').execute(interaction);

        expect(member.timeout).toHaveBeenCalledWith(45 * 60 * 1000, 'cooldown');
        expect(lastReply(interaction)).toMatch(/45 minutes/);
    });

    test('mute refuses a target the bot cannot moderate', async () => {
        const member = makeMember('immune', { position: 1, moderatable: false });
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id), duration: 5 },
        });
        await command('mute').execute(interaction);

        expect(member.timeout).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/cannot mute/i);
    });

    test('unmute clears the timeout', async () => {
        const member = target();
        const guild = makeGuild({ cached: [member] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user: makeUser(member.id) },
        });
        await command('unmute').execute(interaction);

        expect(member.timeout).toHaveBeenCalledWith(null);
        expect(lastReply(interaction)).toMatch(/User Unmuted/);
    });

    test('unmute refuses a user who is not in the guild', async () => {
        const interaction = makeInteraction({
            guild: makeGuild(), invoker: modMember(), options: { user: makeUser('outsider') },
        });
        await command('unmute').execute(interaction);
        expect(lastReply(interaction)).toMatch(/not found/i);
    });
});

// ── unban ───────────────────────────────────────────────────────────────────
describe('/unban', () => {
    const BANNED_ID = '123456789012345678';
    const banRecord = { user: makeUser(BANNED_ID, { username: 'returner' }) };

    test('unbans an id that is actually banned', async () => {
        const guild = makeGuild({ bans: new Map([[BANNED_ID, banRecord]]) });
        const interaction = makeInteraction({ guild, options: { user_id: BANNED_ID, reason: 'appeal upheld' } });
        await command('unban').execute(interaction);

        expect(guild.actions.unbanned).toEqual([{ id: BANNED_ID, reason: 'appeal upheld' }]);
        expect(logModeration).toHaveBeenCalledWith(
            GUILD_ID, 'unban', banRecord.user, expect.anything(), 'appeal upheld',
        );
    });

    test('says so when the id is not banned, without calling unban', async () => {
        const guild = makeGuild();
        const interaction = makeInteraction({ guild, options: { user_id: BANNED_ID } });
        await command('unban').execute(interaction);

        expect(guild.actions.unbanned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/not banned/i);
    });

    test.each(['not-an-id', '123', '1'.repeat(21), ''])('rejects %p as a user id', async userId => {
        const guild = makeGuild();
        const interaction = makeInteraction({ guild, options: { user_id: userId } });
        await command('unban').execute(interaction);

        expect(guild.bans.fetch).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/Invalid user ID/i);
    });

    // The unban itself succeeded; the moderator is told the log did not, rather
    // than being told the unban failed.
    test('an audit-log failure does not read as a failed unban', async () => {
        logModeration.mockRejectedValueOnce(new Error('mongo down'));
        const guild = makeGuild({ bans: new Map([[BANNED_ID, banRecord]]) });
        const interaction = makeInteraction({ guild, options: { user_id: BANNED_ID } });
        await command('unban').execute(interaction);

        expect(guild.actions.unbanned).toHaveLength(1);
        expect(interaction.followUp).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringMatching(/failed to log/i) }),
        );
    });
});

// ── massban ─────────────────────────────────────────────────────────────────
//
// The command that used to be the way around the hierarchy rule: it looped
// guild.members.ban() over raw IDs with neither the bannable check nor the rank
// check the single-target commands run.
describe('/massban', () => {
    const id = n => `10000000000000000${n}`;

    const run = async ({ ids, cached = [], fetchable = [], fetchError = null, invoker = modMember() }) => {
        const guild = makeGuild({ cached, fetchable, fetchError });
        const interaction = makeInteraction({
            guild, invoker, options: { user_ids: ids.join(' '), reason: 'raid' },
        });
        await command('massban').execute(interaction);
        return { guild, interaction };
    };

    test('bans the ids nobody in the guild answers to — the raid case', async () => {
        const { guild, interaction } = await run({ ids: [id(1), id(2), id(3)] });
        expect(guild.actions.banned.map(b => b.id)).toEqual([id(1), id(2), id(3)]);
        expect(lastReply(interaction)).toMatch(/Banned: 3 user\(s\)/);
    });

    test('skips a member who outranks the moderator, and says why', async () => {
        const boss = makeMember(id(2), { position: MOD_POSITION + 5 });
        const { guild, interaction } = await run({ ids: [id(1), id(2)], cached: [boss] });

        expect(guild.actions.banned.map(b => b.id)).toEqual([id(1)]);
        expect(lastReply(interaction)).toMatch(/outranks you or the bot/i);
    });

    test('skips a member the bot cannot ban', async () => {
        const immune = makeMember(id(2), { position: 1, bannable: false });
        const { guild } = await run({ ids: [id(1), id(2)], cached: [immune] });
        expect(guild.actions.banned.map(b => b.id)).toEqual([id(1)]);
    });

    // The distinction a moderator needs in order to know what to retry.
    test('reports ids it could not look up apart from ids it refused', async () => {
        const { guild, interaction } = await run({
            ids: [id(1), id(2)], fetchError: new Error('rate limited'),
        });
        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/could not be looked up, try again/i);
    });

    test('never bans the moderator or the bot, whatever the list says', async () => {
        const guild = makeGuild();
        const interaction = makeInteraction({
            guild, invoker: modMember(),
            options: { user_ids: [MOD_ID, BOT_ID, id(1)].join(','), reason: 'raid' },
        });
        await command('massban').execute(interaction);
        // MOD_ID and BOT_ID are not 17–20 digits, so they are filtered as
        // malformed first; the assertion that matters is that neither is banned.
        expect(guild.actions.banned.map(b => b.id)).toEqual([id(1)]);
    });

    test('deduplicates a repeated id', async () => {
        const { guild } = await run({ ids: [id(1), id(1), id(1)] });
        expect(guild.actions.banned).toHaveLength(1);
    });

    test('refuses a list with no valid ids', async () => {
        const guild = makeGuild();
        const interaction = makeInteraction({ guild, options: { user_ids: 'nobody, at, all' } });
        await command('massban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/No valid user IDs/i);
    });

    test('refuses more than fifty at once', async () => {
        const many = Array.from({ length: 51 }, (_, i) => `1000000000000000${String(i).padStart(3, '0')}`);
        const guild = makeGuild();
        const interaction = makeInteraction({ guild, options: { user_ids: many.join(' ') } });
        await command('massban').execute(interaction);

        expect(guild.actions.banned).toHaveLength(0);
        expect(lastReply(interaction)).toMatch(/Maximum 50/i);
    });

    // One batch fetch for the whole list, not one per id: the member cache holds
    // 200 per guild, so reading it alone would make most of a raid list look
    // like non-members and skip both checks.
    test('resolves the whole batch in one round trip', async () => {
        const guild = makeGuild({ fetchable: [] });
        const interaction = makeInteraction({
            guild, invoker: modMember(), options: { user_ids: [id(1), id(2), id(3)].join(' ') },
        });
        await command('massban').execute(interaction);

        expect(guild.members.fetch).toHaveBeenCalledTimes(1);
        expect(guild.members.fetch).toHaveBeenCalledWith({ user: [id(1), id(2), id(3)] });
    });
});

// ── clear / slowmode / lockdown ─────────────────────────────────────────────
describe('/clear', () => {
    test('bulk-deletes the requested number of messages', async () => {
        const interaction = makeInteraction({ options: { amount: 42 } });
        await command('clear').execute(interaction);

        expect(interaction.channel.bulkDelete).toHaveBeenCalledWith(42, true);
        expect(lastReply(interaction)).toMatch(/deleted 42 messages/i);
    });

    // Discord refuses to bulk-delete anything older than 14 days, and the reply
    // is the only place a moderator learns that is what happened.
    test('explains a failure rather than reporting a deletion that did not happen', async () => {
        const interaction = makeInteraction({ options: { amount: 10 } });
        interaction.channel.bulkDelete.mockRejectedValue(new Error('too old'));
        await command('clear').execute(interaction);

        expect(lastReply(interaction)).toMatch(/14\+ days/);
    });
});

describe('/slowmode', () => {
    test('applies the cooldown to the current channel by default', async () => {
        const interaction = makeInteraction({ options: { seconds: 30 } });
        await command('slowmode').execute(interaction);

        expect(interaction.channel.setRateLimitPerUser).toHaveBeenCalledWith(30, expect.any(String));
        expect(lastReply(interaction)).toMatch(/Slowmode Enabled/);
    });

    test('zero seconds reads as disabling it', async () => {
        const interaction = makeInteraction({ options: { seconds: 0 } });
        await command('slowmode').execute(interaction);

        expect(interaction.channel.setRateLimitPerUser).toHaveBeenCalledWith(0, expect.any(String));
        expect(lastReply(interaction)).toMatch(/Slowmode Disabled/);
    });

    test('applies to the named channel when one is given', async () => {
        const other = {
            id: 'channel-2',
            isTextBased: () => true,
            setRateLimitPerUser: jest.fn().mockResolvedValue(undefined),
            toString: () => '<#channel-2>',
        };
        const interaction = makeInteraction({ options: { seconds: 5, channel: other } });
        await command('slowmode').execute(interaction);

        expect(other.setRateLimitPerUser).toHaveBeenCalledWith(5, expect.any(String));
        expect(interaction.channel.setRateLimitPerUser).not.toHaveBeenCalled();
    });

    test('refuses a channel that is not text-based', async () => {
        const voice = { id: 'voice-1', isTextBased: () => false, setRateLimitPerUser: jest.fn() };
        const interaction = makeInteraction({ options: { seconds: 5, channel: voice } });
        await command('slowmode').execute(interaction);

        expect(voice.setRateLimitPerUser).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/only be set on text channels/i);
    });
});

describe('/lockdown', () => {
    test('start locks the server and reports the count', async () => {
        const interaction = makeInteraction({ subcommand: 'start', options: { reason: 'raid' } });
        await command('lockdown').execute(interaction);

        expect(startLockdown).toHaveBeenCalledWith(
            interaction.guild, interaction.client,
            { startedBy: MOD_ID, reason: 'raid' },
        );
        expect(lastReply(interaction)).toMatch(/Locked \*\*4\*\* channels/);
    });

    test('start defaults the reason rather than recording an empty one', async () => {
        const interaction = makeInteraction({ subcommand: 'start' });
        await command('lockdown').execute(interaction);
        expect(startLockdown.mock.calls[0][2].reason).toBe('Manual lockdown');
    });

    test('end lifts it and reports what was restored', async () => {
        const interaction = makeInteraction({ subcommand: 'end' });
        await command('lockdown').execute(interaction);

        expect(endLockdown).toHaveBeenCalledWith(interaction.guild, { endedBy: MOD_ID });
        expect(lastReply(interaction)).toMatch(/Restored \*\*4\*\* channels/);
    });

    test.each(['start', 'end'])('%s surfaces a refusal from the service', async sub => {
        startLockdown.mockResolvedValueOnce({ ok: false, error: 'already active' });
        endLockdown.mockResolvedValueOnce({ ok: false, error: 'nothing to lift' });
        const interaction = makeInteraction({ subcommand: sub });
        await command('lockdown').execute(interaction);

        expect(lastReply(interaction)).toMatch(/Could not (start|end) lockdown:/);
    });

    // Server-wide channel edits are slow enough to blow the three-second
    // interaction window; without the defer the reply lands on a dead token.
    test.each(['start', 'end'])('%s defers before doing the work', async sub => {
        const interaction = makeInteraction({ subcommand: sub });
        await command('lockdown').execute(interaction);
        expect(interaction.deferReply).toHaveBeenCalled();
    });
});

// ── warn ────────────────────────────────────────────────────────────────────
//
// The largest file in the directory, and the one whose `memberPermissions`
// reference decides something: `bypass_escalation` is offered to anyone who can
// run /warn, and honoured only for someone who also holds Manage Messages.
describe('/warn', () => {
    const TARGET = makeUser('target-1', { username: 'offender' });

    const ladder = (...steps) => ({ moderation: { escalation: { enabled: true, ladder: steps } } });

    beforeEach(() => {
        Case.countDocuments.mockResolvedValue(3);
        Case.findOne.mockResolvedValue(null);
        Guild.findOne.mockResolvedValue(null);
    });

    const warnAdd = (options = {}, permissions) => makeInteraction({
        subcommand: 'add',
        options: { user: TARGET, reason: 'being unpleasant', ...options },
        ...(permissions ? { permissions } : {}),
    });

    test('records the warning, counts it, and tells the member', async () => {
        const interaction = warnAdd();
        await command('warn').execute(interaction);

        expect(logModeration).toHaveBeenCalledWith(
            GUILD_ID, 'warn', TARGET, expect.anything(), 'being unpleasant',
        );
        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: TARGET.id, guildId: GUILD_ID },
            { $set: { lastWarnedAt: expect.any(Date) } },
            { upsert: true },
        );
        expect(TARGET.send).toHaveBeenCalledWith(expect.stringContaining('being unpleasant'));
        expect(lastReply(interaction)).toMatch(/Total Warnings: 3/);
    });

    test('refuses to warn a bot', async () => {
        const bot = makeUser('bot-9', { bot: true });
        const interaction = makeInteraction({ subcommand: 'add', options: { user: bot, reason: 'x' } });
        await command('warn').execute(interaction);

        expect(logModeration).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/cannot warn bots/i);
    });

    // A member who cannot bypass asking to bypass must not silently bypass.
    test('ignores a bypass from a moderator without Manage Messages, and says so', async () => {
        Guild.findOne.mockResolvedValue(ladder({ threshold: 3, action: 'mute', durationMinutes: 10 }));
        const interaction = warnAdd({ bypass_escalation: true }, [PermissionFlagsBits.ModerateMembers]);
        await command('warn').execute(interaction);

        expect(lastReply(interaction)).toMatch(/Requested but ignored/);
        expect(applyEscalation).toHaveBeenCalledTimes(1);
    });

    test('honours a bypass from a moderator who holds Manage Messages', async () => {
        Guild.findOne.mockResolvedValue(ladder({ threshold: 3, action: 'mute', durationMinutes: 10 }));
        const interaction = warnAdd({ bypass_escalation: true },
            [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages]);
        await command('warn').execute(interaction);

        expect(applyEscalation).not.toHaveBeenCalled();
        expect(lastReply(interaction)).toMatch(/Bypassed — would have triggered MUTE at 3 warnings/);
    });

    test('a bypass at a count with no step says there was nothing to bypass', async () => {
        Guild.findOne.mockResolvedValue(ladder({ threshold: 10, action: 'ban' }));
        const interaction = warnAdd({ bypass_escalation: true });
        await command('warn').execute(interaction);

        expect(lastReply(interaction)).toMatch(/no matching step at this count/i);
    });

    test('announces an escalation that fired', async () => {
        Guild.findOne.mockResolvedValue(ladder({ threshold: 3, action: 'mute', durationMinutes: 30 }));
        applyEscalation.mockResolvedValueOnce({
            applied: true, step: { threshold: 3, action: 'mute', durationMinutes: 30 },
        });
        const interaction = warnAdd();
        await command('warn').execute(interaction);

        expect(interaction.followUp).toHaveBeenCalledTimes(1);
        expect(lastReply(interaction)).toMatch(/Auto-Escalation Triggered/);
    });

    test.each([
        ['skipped', { skipped: true, reason: 'target outranks the bot', step: { threshold: 3, action: 'ban' } }, /skipped: target outranks the bot/],
        ['failed',  { error: new Error('boom'), step: { threshold: 3, action: 'ban' } },                          /failed — see logs/],
    ])('reports an escalation that %s', async (_label, result, expected) => {
        Guild.findOne.mockResolvedValue(ladder({ threshold: 3, action: 'ban' }));
        applyEscalation.mockResolvedValueOnce(result);
        const interaction = warnAdd();
        await command('warn').execute(interaction);

        expect(interaction.followUp).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringMatching(expected) }),
        );
    });

    test('does not escalate when the guild has the ladder switched off', async () => {
        Guild.findOne.mockResolvedValue({ moderation: { escalation: { enabled: false, ladder: [{ threshold: 3, action: 'ban' }] } } });
        await command('warn').execute(warnAdd());
        expect(applyEscalation).not.toHaveBeenCalled();
    });

    // The warning itself succeeded; losing the achievement timestamp must not
    // turn into a failed warning.
    test('a failed lastWarnedAt write does not fail the warning', async () => {
        User.findOneAndUpdate.mockRejectedValueOnce(new Error('mongo down'));
        const interaction = warnAdd();
        await command('warn').execute(interaction);

        expect(lastReply(interaction)).toMatch(/User Warned/);
    });

    test('reports a warning that could not be recorded at all', async () => {
        logModeration.mockRejectedValueOnce(new Error('mongo down'));
        const interaction = warnAdd();
        await command('warn').execute(interaction);

        expect(lastReply(interaction)).toMatch(/Failed to warn/i);
    });

    describe('list', () => {
        const listOf = warnings => {
            Case.find.mockReturnValue({
                sort: () => ({ limit: () => Promise.resolve(warnings) }),
            });
        };

        test('says so when there are none', async () => {
            listOf([]);
            const interaction = makeInteraction({ subcommand: 'list', options: { user: TARGET } });
            await command('warn').execute(interaction);
            expect(lastReply(interaction)).toMatch(/has no warnings/i);
        });

        test('lists them newest first with their case ids', async () => {
            listOf([
                { caseId: 7, reason: 'flooding',  createdAt: new Date('2026-02-01T00:00:00Z') },
                { caseId: 4, reason: 'name-calling', createdAt: new Date('2026-01-01T00:00:00Z') },
            ]);
            const interaction = makeInteraction({ subcommand: 'list', options: { user: TARGET } });
            await command('warn').execute(interaction);

            const shown = lastReply(interaction);
            expect(shown).toMatch(/#7/);
            expect(shown).toMatch(/2026-02-01/);
            expect(shown).toMatch(/flooding/);
        });

        // `reason` is a required string with no length cap, so it arrives at up
        // to Discord's own 6,000-character ceiling — and an embed description
        // allows 4,096. discord.js throws rather than truncating.
        test('drops whole lines rather than throwing on an over-long list', async () => {
            listOf(Array.from({ length: 20 }, (_, i) => ({
                caseId: i + 1,
                reason: 'x'.repeat(400),
                createdAt: new Date('2026-01-01T00:00:00Z'),
            })));
            const interaction = makeInteraction({ subcommand: 'list', options: { user: TARGET } });
            await command('warn').execute(interaction);

            const payload = interaction.replies[interaction.replies.length - 1];
            const data = payload.embeds[0].data;
            expect(data.description.length).toBeLessThanOrEqual(4096);
            expect(data.footer.text).toMatch(/of 20 warning\(s\) shown/);
        });
    });

    describe('remove', () => {
        test('deletes the case and quotes what it said', async () => {
            Case.findOne.mockResolvedValue({ _id: 'case-oid', caseId: 12, reason: 'flooding' });
            const interaction = makeInteraction({ subcommand: 'remove', options: { case_id: 12 } });
            await command('warn').execute(interaction);

            expect(Case.deleteOne).toHaveBeenCalledWith({ _id: 'case-oid' });
            expect(lastReply(interaction)).toMatch(/Warning Removed/);
            expect(lastReply(interaction)).toMatch(/flooding/);
        });

        // Scoped to this guild: a case id from another server is not this
        // moderator's to delete.
        test('refuses an id that is not a warning in this guild', async () => {
            Case.findOne.mockResolvedValue(null);
            const interaction = makeInteraction({ subcommand: 'remove', options: { case_id: 99 } });
            await command('warn').execute(interaction);

            expect(Case.findOne).toHaveBeenCalledWith({ guildId: GUILD_ID, caseId: 99, type: 'warn' });
            expect(Case.deleteOne).not.toHaveBeenCalled();
            expect(lastReply(interaction)).toMatch(/not found in this server/i);
        });
    });
});

// ── the permission surface, as declared ─────────────────────────────────────
//
// The gate in events/interactionCreate is what enforces these, and
// tests/commandPermissionGate.test.js proves the gate. What is left is that
// each command declares the bits it means — a command that forgets is a command
// the gate waves through.
describe('what the moderation commands require', () => {
    const EXPECTED = {
        ban:       [PermissionFlagsBits.BanMembers],
        softban:   [PermissionFlagsBits.BanMembers],
        unban:     [PermissionFlagsBits.BanMembers],
        massban:   [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild],
        kick:      [PermissionFlagsBits.KickMembers],
        mute:      [PermissionFlagsBits.ModerateMembers],
        unmute:    [PermissionFlagsBits.ModerateMembers],
        warn:      [PermissionFlagsBits.ModerateMembers],
        clear:     [PermissionFlagsBits.ManageMessages],
        slowmode:  [PermissionFlagsBits.ManageChannels],
        lockdown:  [PermissionFlagsBits.ManageGuild],
    };

    test.each(Object.entries(EXPECTED))('/%s requires exactly what it should', (name, bits) => {
        expect(command(name).requiredPermissions).toEqual(bits);
    });

    // massban is the one command that wants two bits, and the builder default
    // has to be the same pair — a default of one bit and a gate of two is a
    // command Discord offers to people it then refuses.
    test('massban declares both bits in its Discord default too', () => {
        const asDefault = BigInt(command('massban').data.default_member_permissions);
        expect(asDefault & PermissionFlagsBits.BanMembers).toBe(PermissionFlagsBits.BanMembers);
        expect(asDefault & PermissionFlagsBits.ManageGuild).toBe(PermissionFlagsBits.ManageGuild);
    });
});
