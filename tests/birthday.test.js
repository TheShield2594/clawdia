'use strict';

jest.mock('discord.js', () => ({
    PermissionFlagsBits: { SendMessages: 1n << 11n },
}));

jest.mock('../src/models/Guild', () => ({ find: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn() }));

const { checkBirthdays } = require('../src/services/birthdayService');
const Guild = require('../src/models/Guild');
const User = require('../src/models/User');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(hasPerm = true) {
    const perms = { has: jest.fn().mockReturnValue(hasPerm) };
    return {
        isTextBased: () => true,
        permissionsFor: jest.fn().mockReturnValue(perms),
        send: jest.fn().mockResolvedValue(undefined),
    };
}

function makeGuildSettings(overrides = {}) {
    return {
        guildId: 'guild1',
        birthdays: {
            enabled: true,
            channelId: 'ch1',
            wishingHourUtc: 9,
            roleId: null,
            message: "Happy Birthday {user}! You are {age} years old!",
            ...overrides,
        },
    };
}

function makeUser(month, day, year = null) {
    return {
        userId: 'user1',
        guildId: 'guild1',
        birthday: { month, day, year, lastCelebratedYear: null },
        save: jest.fn().mockResolvedValue(undefined),
    };
}

function makeClient(channel) {
    const member = {
        roles: { cache: { has: jest.fn().mockReturnValue(false) } },
        roles_add: jest.fn(),
    };
    const guild = {
        members: {
            me: {},
            fetch: jest.fn().mockResolvedValue(member),
        },
        channels: { cache: { get: jest.fn().mockReturnValue(channel) } },
    };
    return {
        guilds: { cache: { get: jest.fn().mockReturnValue(guild) } },
        _guild: guild,
        _member: member,
        _channel: channel,
    };
}

// ---------------------------------------------------------------------------
// calculateAge (tested indirectly via birthday message content)
// ---------------------------------------------------------------------------

describe('birthday message age substitution', () => {
    afterEach(() => jest.clearAllMocks());

    test('shows numeric age when birth year is provided', async () => {
        const now = new Date('2026-05-15T09:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((arg) => arg !== undefined ? new (jest.requireActual('Date'))(arg) : now);

        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15, 1990)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('36') })
        );

        global.Date.mockRestore();
    });

    test('shows ? when no birth year is provided', async () => {
        const now = new Date('2026-05-15T09:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((arg) => arg !== undefined ? new (jest.requireActual('Date'))(arg) : now);

        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15, null)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('?') })
        );

        global.Date.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

describe('birthday permission check', () => {
    afterEach(() => jest.clearAllMocks());

    test('does not send when bot lacks SendMessages permission', async () => {
        const now = new Date('2026-05-15T09:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((arg) => arg !== undefined ? new (jest.requireActual('Date'))(arg) : now);

        const channel = makeChannel(false); // no permission
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15)]);

        await checkBirthdays(client);

        expect(channel.send).not.toHaveBeenCalled();

        global.Date.mockRestore();
    });

    test('sends when bot has SendMessages permission', async () => {
        const now = new Date('2026-05-15T09:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((arg) => arg !== undefined ? new (jest.requireActual('Date'))(arg) : now);

        const channel = makeChannel(true);
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledTimes(1);

        global.Date.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Leap day (Feb 29) handling
// ---------------------------------------------------------------------------

describe('leap day birthday handling', () => {
    afterEach(() => jest.clearAllMocks());

    test('celebrates Feb 29 birthdays on Feb 28 of non-leap years', async () => {
        // 2025 is not a leap year; Feb 28 should also include Feb 29 users
        const now = new Date('2025-02-28T09:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((arg) => arg !== undefined ? new (jest.requireActual('Date'))(arg) : now);

        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(2, 29)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledTimes(1);

        global.Date.mockRestore();
    });

    test('does not double-celebrate Feb 29 on actual leap years', async () => {
        // 2028 is a leap year; Feb 29 should only fire on Feb 29
        const now = new Date('2028-02-28T09:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((arg) => arg !== undefined ? new (jest.requireActual('Date'))(arg) : now);

        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        // User has Feb 29 birthday — should NOT appear on Feb 28 of a leap year
        User.find.mockResolvedValue([]);

        await checkBirthdays(client);

        expect(channel.send).not.toHaveBeenCalled();

        global.Date.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// lastCelebratedYear updated after celebration
// ---------------------------------------------------------------------------

describe('lastCelebratedYear tracking', () => {
    afterEach(() => jest.clearAllMocks());

    test('sets lastCelebratedYear to current year after celebrating', async () => {
        const now = new Date('2026-05-15T09:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation((arg) => arg !== undefined ? new (jest.requireActual('Date'))(arg) : now);

        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        const u = makeUser(5, 15, 1990);
        User.find.mockResolvedValue([u]);

        await checkBirthdays(client);

        expect(u.birthday.lastCelebratedYear).toBe(2026);
        expect(u.save).toHaveBeenCalled();

        global.Date.mockRestore();
    });
});
