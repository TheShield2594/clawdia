'use strict';

// `src/events/voiceStateUpdate.js` was at 0% while the service it calls,
// tempVoiceService, was at 97.6% — the rule proven and the wiring not. The
// handler is also the only home of voice XP: 50 lines of levelling that no
// other file touches and no test loaded.
//
// So this suite runs the real tempVoiceService through the handler for the two
// facts the wiring is there to produce — joining the lobby gets you a channel,
// the last leaver's channel goes away — and then drives the XP half against a
// pinned clock, because "how long were you in the channel" is otherwise
// whatever the run took.

const { PermissionFlagsBits } = require('discord.js');
const { useFixedClock, advanceClock, MINUTE } = require('./helpers/fixedClock');

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/models/User', () => ({
    findOne: jest.fn(),
    create: jest.fn(),
}));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/services/rivalryService', () => ({ checkRivalry: jest.fn() }));

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { checkRivalry } = require('../src/services/rivalryService');

const voiceStateUpdate = require('../src/events/voiceStateUpdate');

const GUILD_ID = '111222333444555666';
const LOBBY_ID = 'lobby-1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A guild whose bot member may manage channels and whose channel cache we control. */
function makeGuild({ channels = new Map(), canManage = true } = {}) {
    const created = {
        id: 'temp-1',
        members: { size: 0 },
        delete: jest.fn().mockResolvedValue(undefined),
    };
    const guild = {
        id: GUILD_ID,
        members: {
            me: { permissionsIn: jest.fn().mockReturnValue({ has: jest.fn().mockReturnValue(canManage) }) },
        },
        channels: {
            cache: { get: id => channels.get(id) ?? null },
            create: jest.fn().mockResolvedValue(created),
        },
    };
    guild._created = created;
    return guild;
}

function makeMember(guild, { bot = false, roleIds = [] } = {}) {
    return {
        id: 'user-1',
        user: { bot, username: 'ren', globalName: 'Ren' },
        displayName: 'Ren',
        roles: {
            cache: { some: predicate => roleIds.map(id => ({ id })).some(predicate) },
            add: jest.fn().mockResolvedValue(undefined),
        },
        voice: { setChannel: jest.fn().mockResolvedValue(undefined) },
    };
}

const state = (guild, channelId, member) => ({ guild, channelId, member });

function tempVoiceSettings(overrides = {}) {
    return {
        guildId: GUILD_ID,
        tempVoice: {
            enabled: true,
            lobbyChannelId: LOBBY_ID,
            categoryId: null,
            activeChannels: [],
            channelName: "{username}'s VC",
            userLimit: 0,
            bitrate: 64,
            ...overrides,
        },
    };
}

function levelingSettings(overrides = {}) {
    return {
        leveling: {
            enabled: true,
            voiceXpEnabled: true,
            rewardsEnabled: true,
            voiceXpRate: 1.0,
            noXpRoleIds: [],
            rewardChannelId: null,
            levelUpMessage: 'Congratulations {user}! You reached level {level}!',
            ...overrides,
        },
        levelRoles: [],
    };
}

/** A hydrated User document: the handler mutates it and calls save(). */
function makeUser(overrides = {}) {
    return { userId: 'user-1', guildId: GUILD_ID, xp: 0, level: 1, messages: 0, save: jest.fn().mockResolvedValue(undefined), ...overrides };
}

useFixedClock();

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue(null);
    Guild.updateOne.mockResolvedValue({});
    getGuildSettings.mockResolvedValue(null);
    User.findOne.mockResolvedValue(null);
    checkRivalry.mockResolvedValue(undefined);
});

describe('registration', () => {
    it('is registered for the gateway event it handles', () => {
        expect(voiceStateUpdate.name).toBe('voiceStateUpdate');
    });
});

describe('temp voice wiring', () => {
    it('creates a channel and moves the member into it when they join the lobby', async () => {
        Guild.findOne.mockResolvedValue(tempVoiceSettings());
        const guild = makeGuild();
        const member = makeMember(guild);

        await voiceStateUpdate.execute(
            state(guild, null, member),
            state(guild, LOBBY_ID, member),
            {}
        );

        expect(guild.channels.create).toHaveBeenCalledTimes(1);
        const request = guild.channels.create.mock.calls[0][0];
        expect(request.name).toBe("ren's VC");
        expect(request.permissionOverwrites[0]).toMatchObject({
            id: member.id,
            allow: expect.arrayContaining([PermissionFlagsBits.ManageChannels]),
        });
        expect(member.voice.setChannel).toHaveBeenCalledWith(guild._created);
        // The new channel is recorded, which is the only reason the teardown
        // below knows the channel is one of ours.
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: GUILD_ID },
            { $addToSet: { 'tempVoice.activeChannels': 'temp-1' } }
        );
    });

    it('deletes the temp channel the last member leaves', async () => {
        Guild.findOne.mockResolvedValue(tempVoiceSettings({ activeChannels: ['temp-1'] }));
        const emptied = { id: 'temp-1', members: { size: 0 }, delete: jest.fn().mockResolvedValue(undefined) };
        const guild = makeGuild({ channels: new Map([['temp-1', emptied]]) });
        const member = makeMember(guild);

        await voiceStateUpdate.execute(
            state(guild, 'temp-1', member),
            state(guild, null, member),
            {}
        );

        expect(emptied.delete).toHaveBeenCalled();
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: GUILD_ID },
            { $pull: { 'tempVoice.activeChannels': 'temp-1' } }
        );
    });

    it('leaves a temp channel someone else is still in alone', async () => {
        Guild.findOne.mockResolvedValue(tempVoiceSettings({ activeChannels: ['temp-1'] }));
        const occupied = { id: 'temp-1', members: { size: 1 }, delete: jest.fn() };
        const guild = makeGuild({ channels: new Map([['temp-1', occupied]]) });
        const member = makeMember(guild);

        await voiceStateUpdate.execute(
            state(guild, 'temp-1', member),
            state(guild, null, member),
            {}
        );

        expect(occupied.delete).not.toHaveBeenCalled();
    });
});

describe('voice XP', () => {
    /** Joins, waits `minutes`, then leaves — the shape every case below needs. */
    async function sitInVoice(guild, member, minutes) {
        await voiceStateUpdate.execute(state(guild, null, member), state(guild, 'vc-1', member), {});
        advanceClock(minutes * MINUTE);
        await voiceStateUpdate.execute(state(guild, 'vc-1', member), state(guild, null, member), {});
    }

    it('awards three XP a minute on leaving, and nothing on joining', async () => {
        getGuildSettings.mockResolvedValue(levelingSettings());
        const user = makeUser();
        User.findOne.mockResolvedValue(user);
        const guild = makeGuild();
        const member = makeMember(guild);

        await voiceStateUpdate.execute(state(guild, null, member), state(guild, 'vc-1', member), {});
        expect(User.findOne).not.toHaveBeenCalled();

        advanceClock(10 * MINUTE);
        await voiceStateUpdate.execute(state(guild, 'vc-1', member), state(guild, null, member), {});

        expect(user.xp).toBe(30);
        expect(user.save).toHaveBeenCalled();
    });

    it("scales the award by the guild's voice XP rate", async () => {
        getGuildSettings.mockResolvedValue(levelingSettings({ voiceXpRate: 2 }));
        const user = makeUser();
        User.findOne.mockResolvedValue(user);
        const guild = makeGuild();

        await sitInVoice(guild, makeMember(guild), 10);

        expect(user.xp).toBe(60);
    });

    it('pays nothing for less than a minute', async () => {
        getGuildSettings.mockResolvedValue(levelingSettings());
        const user = makeUser();
        User.findOne.mockResolvedValue(user);
        const guild = makeGuild();

        await sitInVoice(guild, makeMember(guild), 0.5);

        expect(User.findOne).not.toHaveBeenCalled();
        expect(user.save).not.toHaveBeenCalled();
    });

    it('pays nothing for a session that started before the bot was listening', async () => {
        // No join was recorded, so there is no start time to measure from and
        // crediting anything would be inventing one.
        getGuildSettings.mockResolvedValue(levelingSettings());
        const guild = makeGuild();
        const member = makeMember(guild);

        await voiceStateUpdate.execute(state(guild, 'vc-1', member), state(guild, null, member), {});

        expect(getGuildSettings).not.toHaveBeenCalled();
    });

    it('ignores bots', async () => {
        const guild = makeGuild();
        await sitInVoice(guild, makeMember(guild, { bot: true }), 10);

        expect(getGuildSettings).not.toHaveBeenCalled();
    });

    it.each([
        ['levelling is off', { enabled: false }],
        ['voice XP is off', { voiceXpEnabled: false }],
        ['rewards are off', { rewardsEnabled: false }],
    ])('pays nothing when %s', async (_label, overrides) => {
        getGuildSettings.mockResolvedValue(levelingSettings(overrides));
        const guild = makeGuild();

        await sitInVoice(guild, makeMember(guild), 10);

        expect(User.findOne).not.toHaveBeenCalled();
    });

    it('pays nothing to a member holding a no-XP role', async () => {
        getGuildSettings.mockResolvedValue(levelingSettings({ noXpRoleIds: ['muted-role'] }));
        const guild = makeGuild();

        await sitInVoice(guild, makeMember(guild, { roleIds: ['muted-role'] }), 10);

        expect(User.findOne).not.toHaveBeenCalled();
    });

    it('creates the user record on a first-ever session', async () => {
        getGuildSettings.mockResolvedValue(levelingSettings());
        User.findOne.mockResolvedValue(null);
        User.create.mockResolvedValue(makeUser());
        const guild = makeGuild();

        await sitInVoice(guild, makeMember(guild), 10);

        expect(User.create).toHaveBeenCalledWith({ userId: 'user-1', guildId: GUILD_ID, xp: 30, messages: 0 });
    });

    it('levels the member up, announces it, and grants the level role', async () => {
        const announce = { send: jest.fn().mockResolvedValue(undefined) };
        getGuildSettings.mockResolvedValue({
            ...levelingSettings({ rewardChannelId: 'announce-1' }),
            levelRoles: [{ level: 2, roleId: 'role-2' }, { level: 5, roleId: 'role-5' }],
        });
        const user = makeUser({ xp: 99, level: 1 });
        User.findOne.mockResolvedValue(user);
        const guild = makeGuild({ channels: new Map([['announce-1', announce]]) });
        const member = makeMember(guild);

        // Level 1 needs 200 XP. 99 already banked plus 3/minute for 40 minutes
        // is 219, which crosses it once and leaves 19 towards level 3.
        await sitInVoice(guild, member, 40);

        expect(user.level).toBe(2);
        expect(announce.send).toHaveBeenCalledWith('Congratulations <@user-1>! You reached level 2!');
        // The highest reward at or below the new level, not every one below it.
        expect(member.roles.add).toHaveBeenCalledTimes(1);
        expect(member.roles.add).toHaveBeenCalledWith('role-2');
    });

    it('checks for a rivalry once the XP is saved', async () => {
        getGuildSettings.mockResolvedValue(levelingSettings());
        const user = makeUser();
        User.findOne.mockResolvedValue(user);
        const guild = makeGuild();
        const client = { id: 'client' };

        await voiceStateUpdate.execute(state(guild, null, makeMember(guild)), state(guild, 'vc-1', makeMember(guild)), client);
        advanceClock(10 * MINUTE);
        await voiceStateUpdate.execute(state(guild, 'vc-1', makeMember(guild)), state(guild, null, makeMember(guild)), client);

        expect(checkRivalry).toHaveBeenCalledWith(client, guild, user);
    });

    it('logs a failed save rather than rejecting into the gateway', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        getGuildSettings.mockResolvedValue(levelingSettings());
        User.findOne.mockRejectedValue(new Error('mongo is down'));
        const guild = makeGuild();

        await expect(sitInVoice(guild, makeMember(guild), 10)).resolves.toBeUndefined();

        expect(errors).toHaveBeenCalledWith('Voice XP error:', expect.any(Error));
        errors.mockRestore();
    });
});
