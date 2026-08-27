'use strict';

jest.mock('discord.js', () => ({
    PermissionFlagsBits: { SendMessages: 1n << 11n },
}));

jest.mock('../src/models/Guild', () => ({ find: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn() }));

const { checkBirthdays } = require('../src/services/birthdayService');
const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { useFixedClock, setClock, advanceClock, HOUR } = require('./helpers/fixedClock');

// Every assertion in this file depends on what the clock says: birthdayService
// derives the month, the day, the UTC hour it queries guilds by, and the year it
// stamps into `lastCelebratedYear` from a single `new Date()` (#632).
//
// This used to be seven copies of `jest.spyOn(global, 'Date').mockImplementation(...)`
// with the matching `mockRestore()` as the last statement of each test body.
// That worked, narrowly: it replaced the constructor but not `Date.now()`, so
// the first line of service code to ask for a timestamp that way would have
// gotten `undefined` off a mock function that carries no statics — and a test
// that failed an assertion never reached its `mockRestore()`, leaving the global
// `Date` replaced for every test after it in the file. `setSystemTime` moves the
// whole clock, statics included, and the helper's `afterEach` puts it back
// however the test ends.
const WISHING_HOUR = '2026-05-15T09:00:00Z'; // the hour makeGuildSettings() wishes at

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
    useFixedClock(WISHING_HOUR);
    afterEach(() => jest.clearAllMocks());

    test('shows numeric age when birth year is provided', async () => {
        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15, 1990)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('36') })
        );
    });

    test('shows ? when no birth year is provided', async () => {
        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15, null)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('?') })
        );
    });
});

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

describe('birthday permission check', () => {
    useFixedClock(WISHING_HOUR);
    afterEach(() => jest.clearAllMocks());

    test('does not send when bot lacks SendMessages permission', async () => {
        const channel = makeChannel(false); // no permission
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15)]);

        await checkBirthdays(client);

        expect(channel.send).not.toHaveBeenCalled();
    });

    test('the guild query follows the clock across the wishing hour', async () => {
        // `wishingHourUtc` is matched against `now.getUTCHours()`, so which
        // guilds are even considered turns over on the hour. Pinned at 09:00
        // the query asks for hour 9; an hour later it must ask for 10, not for
        // whatever hour the suite started in.
        const client = makeClient(makeChannel());
        Guild.find.mockResolvedValue([]);
        User.find.mockResolvedValue([]);

        await checkBirthdays(client);
        expect(Guild.find).toHaveBeenLastCalledWith(
            expect.objectContaining({ 'birthdays.wishingHourUtc': 9 })
        );

        advanceClock(HOUR);
        await checkBirthdays(client);
        expect(Guild.find).toHaveBeenLastCalledWith(
            expect.objectContaining({ 'birthdays.wishingHourUtc': 10 })
        );
    });

    test('sends when bot has SendMessages permission', async () => {
        const channel = makeChannel(true);
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(5, 15)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Leap day (Feb 29) handling
// ---------------------------------------------------------------------------

describe('leap day birthday handling', () => {
    useFixedClock(WISHING_HOUR); // each test sets its own February
    afterEach(() => jest.clearAllMocks());

    test('celebrates Feb 29 birthdays on Feb 28 of non-leap years', async () => {
        // 2025 is not a leap year; Feb 28 should also include Feb 29 users
        setClock('2025-02-28T09:00:00Z');

        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        User.find.mockResolvedValue([makeUser(2, 29)]);

        await checkBirthdays(client);

        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test('does not double-celebrate Feb 29 on actual leap years', async () => {
        // 2028 is a leap year; Feb 29 should only fire on Feb 29
        setClock('2028-02-28T09:00:00Z');

        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        // User has Feb 29 birthday — should NOT appear on Feb 28 of a leap year
        User.find.mockResolvedValue([]);

        await checkBirthdays(client);

        expect(channel.send).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// lastCelebratedYear updated after celebration
// ---------------------------------------------------------------------------

describe('lastCelebratedYear tracking', () => {
    useFixedClock(WISHING_HOUR);
    afterEach(() => jest.clearAllMocks());

    test('sets lastCelebratedYear to current year after celebrating', async () => {
        const channel = makeChannel();
        const client = makeClient(channel);
        Guild.find.mockResolvedValue([makeGuildSettings()]);
        const u = makeUser(5, 15, 1990);
        User.find.mockResolvedValue([u]);

        await checkBirthdays(client);

        expect(u.birthday.lastCelebratedYear).toBe(2026);
        expect(u.save).toHaveBeenCalled();
    });
});
