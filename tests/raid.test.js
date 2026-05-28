'use strict';

jest.mock('discord.js', () => ({
    EmbedBuilder: jest.fn().mockImplementation(() => ({
        setColor: jest.fn().mockReturnThis(),
        setTitle: jest.fn().mockReturnThis(),
        setDescription: jest.fn().mockReturnThis(),
        addFields: jest.fn().mockReturnThis(),
        setTimestamp: jest.fn().mockReturnThis(),
    })),
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
}));

const { handleMemberJoin, setRaidMode, raidModeActive, raidModeActivatedBy } = require('../src/services/raidService');
const Guild = require('../src/models/Guild');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use unique guild IDs per test to keep the in-memory joinLog clean between runs.
let _guildSeq = 0;
function freshGuildId() { return `guild_${++_guildSeq}`; }

function makeGuildSettings(guildId, overrides = {}) {
    return {
        guildId,
        raidDetection: {
            enabled: true,
            threshold: 3,
            windowSeconds: 60,
            minAccountAgeDays: 7,
            action: 'alert',
            alertChannelId: null,
            quarantineRoleId: null,
            autoDisable: true,
            calmWindowSeconds: 300,
            requireManualDisable: false,
            raidModeActive: false,
            raidModeActivatedBy: null,
            raidModeActivatedAt: null,
            ...(overrides.raidDetection || {}),
        },
        moderation: { logChannelId: 'log1' },
    };
}

function makeSharedGuild(guildId) {
    return {
        id: guildId,
        members: { cache: new Map() },
        channels: { cache: new Map() },
        roles: { cache: new Map() },
    };
}

function makeMember(guild) {
    const member = {
        id: `user_${Math.random().toString(36).slice(2)}`,
        guild,
        user: {
            // 1 day old — below the 7-day minAccountAgeDays threshold
            createdTimestamp: Date.now() - 86_400_000,
        },
        kickable: true,
        kick: jest.fn().mockResolvedValue(undefined),
        roles: { add: jest.fn().mockResolvedValue(undefined) },
    };
    return member;
}

function makeOldMember(guild) {
    const member = makeMember(guild);
    // 30 days old — above threshold, should never be actioned
    member.user.createdTimestamp = Date.now() - 30 * 86_400_000;
    return member;
}

// ---------------------------------------------------------------------------
// Reset shared in-memory state between tests.
// joinLog is not exported; unique guild IDs prevent cross-test bleed.
// ---------------------------------------------------------------------------

beforeEach(() => {
    raidModeActive.clear();
    raidModeActivatedBy.clear();
    Guild.findOne.mockReset();
    Guild.updateOne.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// handleMemberJoin
// ---------------------------------------------------------------------------

describe('handleMemberJoin', () => {
    test('returns early when guild has no settings', async () => {
        Guild.findOne.mockResolvedValue(null);
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        await handleMemberJoin(makeMember(guild), {});
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('returns early when raid detection is disabled', async () => {
        const gid = freshGuildId();
        Guild.findOne.mockResolvedValue(makeGuildSettings(gid, { raidDetection: { enabled: false } }));
        await handleMemberJoin(makeMember(makeSharedGuild(gid)), {});
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('logs joins below threshold without activating raid mode', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        Guild.findOne.mockResolvedValue(makeGuildSettings(gid));

        await handleMemberJoin(makeMember(guild), {});
        await handleMemberJoin(makeMember(guild), {});

        expect(raidModeActive.has(gid)).toBe(false);
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('activates raid mode and sends alert when threshold is reached', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        const alertChannel = { send: jest.fn().mockResolvedValue(undefined) };
        guild.channels.cache.set('alert1', alertChannel);

        Guild.findOne.mockResolvedValue(
            makeGuildSettings(gid, { raidDetection: { alertChannelId: 'alert1' } })
        );

        for (let i = 0; i < 3; i++) {
            await handleMemberJoin(makeMember(guild), {});
        }

        expect(raidModeActive.has(gid)).toBe(true);
        expect(raidModeActivatedBy.get(gid)).toBe('auto');
        expect(alertChannel.send).toHaveBeenCalledTimes(1);
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: gid },
            expect.objectContaining({
                $set: expect.objectContaining({ 'raidDetection.raidModeActive': true }),
            })
        );
    });

    test('raidModeActive is set before alertChannel.send (double-activation guard)', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);

        let raidActiveAtSendTime = false;
        guild.channels.cache.set('alert1', {
            send: jest.fn().mockImplementation(() => {
                raidActiveAtSendTime = raidModeActive.has(gid);
                return Promise.resolve();
            }),
        });

        Guild.findOne.mockResolvedValue(
            makeGuildSettings(gid, { raidDetection: { alertChannelId: 'alert1' } })
        );

        for (let i = 0; i < 3; i++) {
            await handleMemberJoin(makeMember(guild), {});
        }

        expect(raidActiveAtSendTime).toBe(true);
    });

    test('kicks new accounts in bulk when raid triggers with kick action', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        Guild.findOne.mockResolvedValue(makeGuildSettings(gid, { raidDetection: { action: 'kick' } }));

        const members = [makeMember(guild), makeMember(guild), makeMember(guild)];
        members.forEach(m => guild.members.cache.set(m.id, m));

        for (const m of members) {
            await handleMemberJoin(m, {});
        }

        const kicked = members.filter(m => m.kick.mock.calls.length > 0);
        expect(kicked.length).toBeGreaterThan(0);
    });

    test('quarantines new accounts in bulk when raid triggers with quarantine action', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        const qRole = { id: 'qrole' };
        guild.roles.cache.set('qrole', qRole);

        Guild.findOne.mockResolvedValue(
            makeGuildSettings(gid, {
                raidDetection: { action: 'quarantine', quarantineRoleId: 'qrole' },
            })
        );

        const members = [makeMember(guild), makeMember(guild), makeMember(guild)];
        members.forEach(m => guild.members.cache.set(m.id, m));

        for (const m of members) {
            await handleMemberJoin(m, {});
        }

        const quarantined = members.filter(m => m.roles.add.mock.calls.length > 0);
        expect(quarantined.length).toBeGreaterThan(0);
    });

    test('applies configured action to new joins when raid mode is already active', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        raidModeActive.add(gid);
        raidModeActivatedBy.set(gid, 'manual');

        Guild.findOne.mockResolvedValue(
            makeGuildSettings(gid, {
                raidDetection: {
                    action: 'kick',
                    raidModeActive: true,
                    raidModeActivatedBy: 'manual',
                },
            })
        );

        const member = makeMember(guild);
        await handleMemberJoin(member, {});

        expect(member.kick).toHaveBeenCalledTimes(1);
    });

    test('does not action accounts above minAccountAgeDays', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        Guild.findOne.mockResolvedValue(makeGuildSettings(gid, { raidDetection: { action: 'kick' } }));

        const members = [makeOldMember(guild), makeOldMember(guild), makeOldMember(guild)];
        members.forEach(m => guild.members.cache.set(m.id, m));

        for (const m of members) {
            await handleMemberJoin(m, {});
        }

        const kicked = members.filter(m => m.kick.mock.calls.length > 0);
        expect(kicked.length).toBe(0);
    });

    test('handles DB error gracefully without throwing', async () => {
        Guild.findOne.mockRejectedValue(new Error('DB down'));
        const guild = makeSharedGuild(freshGuildId());
        await expect(handleMemberJoin(makeMember(guild), {})).resolves.toBeUndefined();
    });

    test('syncs raidModeActive from DB field on first join after restart', async () => {
        const gid = freshGuildId();
        const guild = makeSharedGuild(gid);
        Guild.findOne.mockResolvedValue(
            makeGuildSettings(gid, {
                raidDetection: { raidModeActive: true, raidModeActivatedBy: 'manual' },
            })
        );

        await handleMemberJoin(makeMember(guild), {});

        expect(raidModeActive.has(gid)).toBe(true);
        expect(raidModeActivatedBy.get(gid)).toBe('manual');
    });
});

// ---------------------------------------------------------------------------
// setRaidMode
// ---------------------------------------------------------------------------

describe('setRaidMode', () => {
    test('enables raid mode and sends alert', async () => {
        const gid = freshGuildId();
        const alertChannel = { send: jest.fn().mockResolvedValue(undefined) };
        const guild = { channels: { cache: new Map([['alert1', alertChannel]]) } };
        const settings = makeGuildSettings(gid, { raidDetection: { alertChannelId: 'alert1' } });

        await setRaidMode(gid, guild, true, settings);

        expect(raidModeActive.has(gid)).toBe(true);
        expect(raidModeActivatedBy.get(gid)).toBe('manual');
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: gid },
            expect.objectContaining({
                $set: expect.objectContaining({ 'raidDetection.raidModeActive': true }),
            })
        );
        expect(alertChannel.send).toHaveBeenCalledTimes(1);
    });

    test('disables raid mode and sends alert', async () => {
        const gid = freshGuildId();
        raidModeActive.add(gid);
        raidModeActivatedBy.set(gid, 'auto');

        const alertChannel = { send: jest.fn().mockResolvedValue(undefined) };
        const guild = { channels: { cache: new Map([['alert1', alertChannel]]) } };
        const settings = makeGuildSettings(gid, { raidDetection: { alertChannelId: 'alert1' } });

        await setRaidMode(gid, guild, false, settings);

        expect(raidModeActive.has(gid)).toBe(false);
        expect(raidModeActivatedBy.has(gid)).toBe(false);
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: gid },
            expect.objectContaining({
                $set: expect.objectContaining({ 'raidDetection.raidModeActive': false }),
            })
        );
        expect(alertChannel.send).toHaveBeenCalledTimes(1);
    });

    test('falls back to moderation logChannelId when no alertChannelId is set', async () => {
        const gid = freshGuildId();
        const logChannel = { send: jest.fn().mockResolvedValue(undefined) };
        const guild = { channels: { cache: new Map([['log1', logChannel]]) } };
        const settings = makeGuildSettings(gid);

        await setRaidMode(gid, guild, true, settings);

        expect(logChannel.send).toHaveBeenCalledTimes(1);
    });

    test('does not throw when alert channel is not in cache', async () => {
        const gid = freshGuildId();
        const guild = { channels: { cache: new Map() } };
        const settings = makeGuildSettings(gid);

        await expect(setRaidMode(gid, guild, true, settings)).resolves.toBeUndefined();
        expect(raidModeActive.has(gid)).toBe(true);
    });
});
