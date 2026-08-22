'use strict';

// Every moderation command asked `member.bannable` / `.kickable` / `.moderatable`
// and stopped there. All three describe the *bot's* power over the target. None
// of them look at the moderator, so a trial mod holding only Ban Members could
// ban the head moderator — Discord's own UI refuses that, the bot did not.
//
// A repo-wide grep for `roles.highest` returned exactly one hit before this, in
// antiNukeService. These tests pin the rule and the call sites, since a guard
// nothing exercises is a guard that gets deleted in a refactor.

const fs   = require('fs');
const path = require('path');
const { hierarchyDenial, resolveMember, resolveMembers } = require('../src/utils/moderationHierarchy');

const OWNER_ID = 'owner-1';

// Enough of a GuildMember for the comparison: an id, a highest role with a
// position, and the guild's ownerId. comparePositionTo is what discord.js
// exposes and what the guard calls, so the fake implements it rather than
// letting the guard reach for `.position` directly.
function member(id, position, { ownerId = OWNER_ID } = {}) {
    return {
        id,
        guild: { ownerId },
        roles: {
            highest: {
                position,
                comparePositionTo: other => position - other.position,
            },
        },
    };
}

describe('hierarchyDenial', () => {
    test('lets a moderator act on someone strictly below them', () => {
        expect(hierarchyDenial(member('mod', 5), member('target', 3), 'ban')).toBeNull();
    });

    test('refuses a moderator acting on someone above them', () => {
        const denial = hierarchyDenial(member('trial-mod', 2), member('head-mod', 9), 'ban');
        expect(denial).toMatch(/cannot ban/i);
    });

    // The realistic case: two moderators handed the same role. Discord treats
    // equal as "no", and so does this.
    test('refuses a moderator acting on an equal', () => {
        expect(hierarchyDenial(member('mod-a', 5), member('mod-b', 5), 'kick')).not.toBeNull();
    });

    test('names the action it refused, so the message fits the command', () => {
        expect(hierarchyDenial(member('a', 1), member('b', 4), 'softban')).toContain('softban');
        expect(hierarchyDenial(member('a', 1), member('b', 4), 'mute')).toContain('mute');
    });

    test('the owner outranks everyone, including a member holding a higher role', () => {
        // Ownership is not a role position — an owner can sit at the bottom of
        // the list and still outrank the whole server.
        expect(hierarchyDenial(member(OWNER_ID, 0), member('admin', 50), 'ban')).toBeNull();
    });

    test('nobody may act on the owner, however high their own role', () => {
        const denial = hierarchyDenial(member('admin', 50), member(OWNER_ID, 1), 'ban');
        expect(denial).toMatch(/server owner/i);
    });

    test('a target who is not in the guild has no rank to outrank', () => {
        // massban's whole reason to exist: IDs of people who were never here.
        for (const absent of [null, undefined]) {
            expect(hierarchyDenial(member('mod', 5), absent, 'ban')).toBeNull();
        }
    });

    test('fails closed when the invoker is missing', () => {
        expect(hierarchyDenial(null, member('target', 1), 'ban')).not.toBeNull();
        expect(hierarchyDenial(undefined, member('target', 1), 'ban')).not.toBeNull();
    });

    test('fails closed when the comparison throws', () => {
        const broken = {
            id: 'mod',
            guild: { ownerId: OWNER_ID },
            roles: { highest: { comparePositionTo() { throw new Error('different guild'); } } },
        };
        expect(hierarchyDenial(broken, member('target', 1), 'ban')).not.toBeNull();
    });

    test('fails closed on a member with no roles at all rather than throwing', () => {
        const shapeless = { id: 'mod', guild: { ownerId: OWNER_ID } };
        expect(() => hierarchyDenial(shapeless, member('target', 1), 'ban')).not.toThrow();
        expect(hierarchyDenial(shapeless, member('target', 1), 'ban')).not.toBeNull();
    });

    test('still compares when only the target knows the ownerId', () => {
        // interaction.member is built from the interaction payload and its
        // .guild is the same object in practice, but the guard reads either end.
        const invoker = { id: 'mod', roles: { highest: { position: 9, comparePositionTo: o => 9 - o.position } } };
        expect(hierarchyDenial(invoker, member('target', 2), 'ban')).toBeNull();
        expect(hierarchyDenial(invoker, member(OWNER_ID, 2), 'ban')).toMatch(/server owner/i);
    });
});

// A hierarchy check that only runs on cache hits is one an attacker skips by
// picking a quiet target. GuildMemberManager is capped at 200 per guild and swept
// hourly (utils/cacheOptions), so the cache is a recently-seen sample, not a
// roster — these cover the resolution that turns a miss into a real answer.
describe('resolveMember', () => {
    // Discord answers "not in this guild" with error code 10007; anything else it
    // throws is a transport failure that says nothing about membership. The fake
    // keeps that distinction because the whole point of these tests is that the
    // code does too.
    const unknownMember = () => Object.assign(new Error('Unknown Member'), { code: 10007 });

    const fakeGuild = ({ cached = {}, fetched = {} } = {}) => ({
        members: {
            cache: { get: id => cached[id] },
            fetch: jest.fn(async arg => {
                if (typeof arg === 'string') {
                    if (!fetched[arg]) throw unknownMember();
                    return fetched[arg];
                }
                const wanted = arg.user;
                return new Map(wanted.filter(id => fetched[id]).map(id => [id, fetched[id]]));
            }),
        },
    });

    test('uses the cache when it has the member, without a round trip', async () => {
        const guild = fakeGuild({ cached: { u1: { id: 'u1' } } });
        await expect(resolveMember(guild, 'u1'))
            .resolves.toEqual({ member: { id: 'u1' }, indeterminate: false });
        expect(guild.members.fetch).not.toHaveBeenCalled();
    });

    test('fetches on a cache miss rather than calling them a non-member', async () => {
        const guild = fakeGuild({ fetched: { u2: { id: 'u2' } } });
        await expect(resolveMember(guild, 'u2'))
            .resolves.toEqual({ member: { id: 'u2' }, indeterminate: false });
        expect(guild.members.fetch).toHaveBeenCalledWith('u2');
    });

    test('reports a confirmed non-member as absent, not as unsettled', async () => {
        // The ban-by-id case: Discord said 10007, so there really is no member
        // and no rank to compare. The commands may proceed.
        await expect(resolveMember(fakeGuild(), 'stranger'))
            .resolves.toEqual({ member: null, indeterminate: false });
    });

    // The fail-open this distinction exists to prevent: a 429 or 5xx used to
    // return the same null as a confirmed non-member, and the ban-shaped commands
    // proceed when no member is found — so a failed lookup skipped both the
    // hierarchy check and the bot's own bannable check, on a target who might
    // well outrank the moderator. A rate limit is a state a caller can provoke.
    test.each([
        ['a rate limit', Object.assign(new Error('rate limited'), { code: 0, status: 429 })],
        ['a server error', Object.assign(new Error('server error'), { status: 500 })],
        ['a timeout', new Error('ETIMEDOUT')],
    ])('reports %s as indeterminate, never as absent', async (_label, error) => {
        const guild = { members: { cache: { get: () => undefined }, fetch: async () => { throw error; } } };
        await expect(resolveMember(guild, 'u3'))
            .resolves.toEqual({ member: null, indeterminate: true });
    });

    describe('resolveMembers', () => {
        test('asks for the uncached ids only, in one call', async () => {
            const guild = fakeGuild({ cached: { a: { id: 'a' } }, fetched: { b: { id: 'b' }, c: { id: 'c' } } });
            const { members, indeterminate } = await resolveMembers(guild, ['a', 'b', 'c']);

            expect(guild.members.fetch).toHaveBeenCalledTimes(1);
            expect(guild.members.fetch).toHaveBeenCalledWith({ user: ['b', 'c'] });
            expect([...members.keys()].sort()).toEqual(['a', 'b', 'c']);
            expect(indeterminate.size).toBe(0);
        });

        test('omits ids that belong to nobody in the guild, and settles them', async () => {
            // The batch fetch drops non-members rather than erroring, so a
            // successful call is a real answer for every id it covered.
            const guild = fakeGuild({ fetched: { b: { id: 'b' } } });
            const { members, indeterminate } = await resolveMembers(guild, ['b', 'ghost']);

            expect(members.has('b')).toBe(true);
            expect(members.has('ghost')).toBe(false);
            expect(indeterminate.size).toBe(0);
        });

        test('skips the round trip entirely when everything is cached', async () => {
            const guild = fakeGuild({ cached: { a: { id: 'a' }, b: { id: 'b' } } });
            const { indeterminate } = await resolveMembers(guild, ['a', 'b']);
            expect(guild.members.fetch).not.toHaveBeenCalled();
            expect(indeterminate.size).toBe(0);
        });

        // Same fail-open as above, with a wider blast radius: massban would have
        // banned every uncached id in the batch with no check at all.
        test('a failed batch marks its ids unsettled rather than absent', async () => {
            const guild = {
                members: {
                    cache: { get: id => (id === 'a' ? { id: 'a' } : undefined) },
                    fetch: async () => { throw new Error('gateway timeout'); },
                },
            };
            const { members, indeterminate } = await resolveMembers(guild, ['a', 'b', 'c']);

            expect([...members.keys()]).toEqual(['a']);
            expect([...indeterminate].sort()).toEqual(['b', 'c']);
        });
    });
});

// The guard only helps where it is called. These read the commands the issue
// named, so removing a call site fails here rather than in production.
describe('the commands that take a target call the guard', () => {
    const cases = [
        ['ban.js', 'moderation'],
        ['kick.js', 'moderation'],
        ['mute.js', 'moderation'],
        ['softban.js', 'moderation'],
        ['massban.js', 'moderation'],
    ];

    test.each(cases)('%s', (file, dir) => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'commands', dir, file), 'utf8',
        );
        expect(source).toContain("require('../../utils/moderationHierarchy')");
        expect(source).toMatch(/hierarchyDenial\(interaction\.member,/);
    });

    test('massban checks each target rather than once for the batch', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'commands', 'moderation', 'massban.js'), 'utf8',
        );
        const loopStart = source.indexOf('for (const userId of ids)');
        const banCall   = source.indexOf('guild.members.ban(userId');
        expect(loopStart).toBeGreaterThan(-1);
        expect(banCall).toBeGreaterThan(loopStart);

        // The call that matters is the one between the loop opening and the ban,
        // not the require at the top of the file.
        const callInLoop = source.indexOf('hierarchyDenial(interaction.member', loopStart);
        expect(callInLoop).toBeGreaterThan(loopStart);
        expect(callInLoop).toBeLessThan(banCall);
    });

    test('massban also checks bannable, which it never did', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'commands', 'moderation', 'massban.js'), 'utf8',
        );
        expect(source).toContain('bannable');
    });

    // Resolving the target is only half of it: the commands have to refuse when
    // the lookup came back unsettled. Returning `indeterminate` and then banning
    // anyway is the same fail-open with an extra field.
    test.each([
        ['ban.js', /guild\.members\.ban\(|\.ban\(user/],
        ['softban.js', /guild\.members\.ban\(/],
        ['massban.js', /guild\.members\.ban\(userId/],
    ])('%s refuses before banning when the lookup is unsettled', (file, banPattern) => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'commands', 'moderation', file), 'utf8',
        );

        const check = source.search(/indeterminate/);
        const ban   = source.search(banPattern);
        expect(check).toBeGreaterThan(-1);
        expect(ban).toBeGreaterThan(-1);
        expect(check).toBeLessThan(ban);

        // And it stops there rather than falling through to the ban.
        expect(source).toMatch(/indeterminate[\s\S]{0,400}?(return interaction\.reply|continue;)/);
    });

    // The ban-shaped commands proceed when no member is found, so a cache-only
    // lookup would let the guard be skipped by targeting anyone not recently
    // seen. kick and mute refuse outright on a miss, so they fail closed either
    // way and are left alone here.
    test.each([['ban.js'], ['softban.js'], ['massban.js']])(
        '%s resolves the target rather than reading the capped member cache',
        file => {
            const source = fs.readFileSync(
                path.join(__dirname, '..', 'src', 'commands', 'moderation', file), 'utf8',
            );
            expect(source).toMatch(/resolveMembers?\(/);
            expect(source).not.toContain('members.cache.get');
        },
    );
});
