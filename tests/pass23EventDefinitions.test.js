'use strict';

/**
 * #873, pass 23 — the seasonal-event definition surface: `/event start`,
 * `/event end`, `/event status`, the hourly auto-start/auto-end sweep in
 * `seasonalEventService.checkSeasonalEvents`, and `/eventshop`'s browse title.
 *
 * None of it moves player currency, but it decides the coin and XP multipliers
 * every earning command pays at, and which event currency exists. What this
 * pass found:
 *
 *   - every write to `activeEvent` was a check-then-`$set` with no guard. The
 *     sweep's snapshot is taken at the top of the hour, so an admin's
 *     `/event start` landing in between was cleared or overwritten; two
 *     `/event start`s both passed the check; `/event end` cleared whatever was
 *     there by the time it wrote.
 *   - `/event end` on the seasonal event the calendar runs lasted until the
 *     next hourly tick, which started the same event again and announced it.
 *   - one guild's failed write aborted the sweep for every guild after it.
 *   - an event name had no length cap and is echoed into embed titles, which
 *     Discord rejects past 256 characters.
 */

const { useFixedClock } = require('./helpers/fixedClock');
const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction } = require('./helpers/fakeInteraction');

const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });
const mockUsers = fakeCollection('User', {});

jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

const eventCommand = require('../src/commands/economy/event');
const eventshop = require('../src/commands/economy/eventshop');
const {
    checkSeasonalEvents, eventLabel, EVENT_NAME_MAX,
} = require('../src/services/seasonalEventService');

const GUILD = 'guild-1';
const OTHER = 'guild-2';
const ADMIN = 'admin-1';
// Inside the summer festival's window (July 1–31).
const IN_SUMMER = '2026-07-15T12:00:00Z';
const SUMMER_ENDS = '2026-08-01T00:00:00.000Z';

const stored = (id = GUILD) => mockGuilds.get(id)?.activeEvent ?? null;

const summerAuto = (fields = {}) => ({
    type: 'summer_festival', name: 'Summer Festival', emoji: '🏖️',
    coinMultiplier: 1.25, xpMultiplier: 1.0,
    startedAt: new Date('2026-07-01T00:00:00Z'),
    endsAt: new Date(SUMMER_ENDS),
    startedBy: 'auto', eventShop: [],
    ...fields,
});

const customEvent = (fields = {}) => ({
    type: 'custom', name: 'Admin Party', emoji: '🎉',
    coinMultiplier: 2, xpMultiplier: 1.5,
    startedAt: new Date('2026-07-15T11:00:00Z'),
    endsAt: new Date('2026-07-16T11:00:00Z'),
    startedBy: ADMIN, eventShop: [],
    ...fields,
});

const channel = { isTextBased: () => true, send: jest.fn(async () => {}) };

function clientFor(...ids) {
    return {
        guilds: {
            cache: new Map(ids.map(id => [id, { id, channels: { fetch: jest.fn(async () => channel) } }])),
        },
    };
}

/** Run `between` after the next `method` read has been taken but before it is returned. */
function interleave(method, between) {
    const real = mockGuilds.model[method].getMockImplementation();
    mockGuilds.model[method].mockImplementationOnce((...args) => {
        const query = real(...args);
        return {
            ...query,
            lean: async () => {
                const snapshot = await query.lean();
                await between();
                return snapshot;
            },
        };
    });
}

async function run(subcommand, options = {}) {
    const interaction = makeInteraction({ subcommand, options, userId: ADMIN });
    interaction.memberPermissions = { has: () => true };
    interaction.guild.channels.fetch = jest.fn(async () => channel);
    await eventCommand.execute(interaction);
    return interaction;
}

const shown = interaction => JSON.stringify(interaction.replies);

useFixedClock(IN_SUMMER);

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGuilds.reset();
    mockUsers.reset();
});

afterEach(() => jest.restoreAllMocks());

// ── The sweep writes only over the event it read ─────────────────────────────

describe('the hourly sweep is guarded on the event it read', () => {
    test('does not overwrite an event an admin started after the sweep read the guild', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: { type: null } });
        interleave('find', () => mockGuilds.model.findOneAndUpdate(
            { guildId: GUILD }, { $set: { activeEvent: customEvent() } }));

        await checkSeasonalEvents(clientFor(GUILD));

        expect(stored().type).toBe('custom');
        expect(stored().startedBy).toBe(ADMIN);
        // A start that did not land is not announced either.
        expect(channel.send).not.toHaveBeenCalled();
    });

    test('does not clear an event an admin started over an expired one after the read', async () => {
        const expired = customEvent({ name: 'Old Party', endsAt: new Date('2026-07-15T00:00:00Z') });
        mockGuilds.seed({ guildId: GUILD, activeEvent: expired, economy: { announcementChannelId: 'c' } });
        const fresh = customEvent({ startedAt: new Date('2026-07-15T11:30:00Z') });
        interleave('find', () => mockGuilds.model.findOneAndUpdate(
            { guildId: GUILD }, { $set: { activeEvent: fresh } }));

        await checkSeasonalEvents(clientFor(GUILD));

        expect(stored().name).toBe('Admin Party');
        expect(stored().coinMultiplier).toBe(2);
        expect(channel.send).not.toHaveBeenCalled();
    });

    test('still clears an expired event nobody touched, and announces it', async () => {
        const expired = customEvent({ endsAt: new Date('2026-07-15T00:00:00Z') });
        mockGuilds.seed({ guildId: GUILD, activeEvent: expired, economy: { announcementChannelId: 'c' } });

        await checkSeasonalEvents(clientFor(GUILD));

        expect(stored().type).toBeNull();
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test('one guild whose write fails does not stop the sweep for the rest', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: { type: null } }, { guildId: OTHER, activeEvent: { type: null } });
        const real = mockGuilds.model.findOneAndUpdate.getMockImplementation();
        mockGuilds.model.findOneAndUpdate.mockImplementation((query, ...rest) =>
            (query.guildId === GUILD ? Promise.reject(new Error('write failed')) : real(query, ...rest)));

        try {
            await checkSeasonalEvents(clientFor(GUILD, OTHER));
        } finally {
            mockGuilds.model.findOneAndUpdate.mockImplementation(real);
        }

        expect(stored(GUILD).type).toBeNull();
        expect(stored(OTHER).type).toBe('summer_festival');
        expect(console.error).toHaveBeenCalled();
    });
});

// ── /event end sticks for the rest of the season ─────────────────────────────

describe('/event end on the running seasonal event', () => {
    test('is not undone by the next hourly tick', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: summerAuto() });

        const interaction = await run('end');
        expect(stored().type).toBeNull();
        expect(shown(interaction)).toContain('won\'t start again on its own');

        await checkSeasonalEvents(clientFor(GUILD));
        await checkSeasonalEvents(clientFor(GUILD));

        expect(stored().type).toBeNull();
        expect(mockGuilds.get(GUILD).eventAutoStartSkip.eventId).toBe('summer_festival');
        expect(mockGuilds.get(GUILD).eventAutoStartSkip.until.toISOString()).toBe(SUMMER_ENDS);
    });

    test('the hold lapses with the window, so next year runs as normal', async () => {
        mockGuilds.seed({
            guildId: GUILD, activeEvent: { type: null },
            eventAutoStartSkip: { eventId: 'summer_festival', until: new Date('2025-08-01T00:00:00Z') },
        });

        await checkSeasonalEvents(clientFor(GUILD));

        expect(stored().type).toBe('summer_festival');
    });

    test('an admin can still start it again on purpose', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: summerAuto() });
        await run('end');

        await run('start', { type: 'summer_festival', duration_hours: 24 });

        expect(stored().type).toBe('summer_festival');
        expect(stored().startedBy).toBe(ADMIN);
    });

    test('ending a custom event leaves the seasonal auto-start alone', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: customEvent() });

        await run('end');
        await checkSeasonalEvents(clientFor(GUILD));

        expect(mockGuilds.get(GUILD).eventAutoStartSkip?.eventId ?? null).toBeNull();
        expect(stored().type).toBe('summer_festival');
    });

    test('announces the end where the start was announced', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: customEvent({ announcementChannelId: 'chan-9' }) });

        await run('end');

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(channel.send.mock.calls[0][0])).toContain('Has Ended');
    });
});

// ── /event start and end are guarded on what they read ───────────────────────

describe('/event start and /event end write only over the event they read', () => {
    test('two starts racing: the second is refused, the first survives', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: { type: null } });
        interleave('findOne', () => mockGuilds.model.findOneAndUpdate(
            { guildId: GUILD }, { $set: { activeEvent: customEvent({ name: 'First' }) } }));

        const interaction = await run('start', { type: 'custom', name: 'Second' });

        expect(stored().name).toBe('First');
        expect(shown(interaction)).toContain('Another event was started');
    });

    test('starts over an expired event', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: customEvent({ endsAt: new Date('2026-07-01T00:00:00Z') }) });

        await run('start', { type: 'custom', name: 'Next' });

        expect(stored().name).toBe('Next');
    });

    test('a guild with no document yet is created with the event', async () => {
        await run('start', { type: 'custom', name: 'First Ever' });

        expect(stored().name).toBe('First Ever');
    });

    test('an end racing a new start does not clear the new event', async () => {
        const expired = customEvent({ name: 'Old', endsAt: new Date('2026-07-15T00:00:00Z') });
        mockGuilds.seed({ guildId: GUILD, activeEvent: expired });
        interleave('findOne', () => mockGuilds.model.findOneAndUpdate(
            { guildId: GUILD },
            { $set: { activeEvent: customEvent({ name: 'New', startedAt: new Date('2026-07-15T11:59:00Z') }) } }));

        const interaction = await run('end');

        expect(stored().name).toBe('New');
        expect(shown(interaction)).toContain('nothing was ended');
        expect(channel.send).not.toHaveBeenCalled();
    });
});

// ── Event names fit the embeds they are shown in ─────────────────────────────

describe('event names', () => {
    const longName = 'N'.repeat(400);

    test('the name option is capped at input', () => {
        const start = eventCommand.data.toJSON().options.find(o => o.name === 'start');
        const name = start.options.find(o => o.name === 'name');
        expect(name.max_length).toBe(EVENT_NAME_MAX);
    });

    test('a name stored before the cap renders shortened', () => {
        expect(eventLabel({ name: longName })).toHaveLength(EVENT_NAME_MAX);
        expect(eventLabel({ name: 'Short' })).toBe('Short');
        expect(eventLabel({})).toBe('Event');
    });

    test('/event status renders an over-long stored name instead of throwing', async () => {
        mockGuilds.seed({ guildId: GUILD, activeEvent: customEvent({ name: longName }) });

        const interaction = await run('status');

        const title = interaction.replies.at(-1).embeds[0].data.title;
        expect(title.length).toBeLessThanOrEqual(256);
    });

    test('/eventshop browse renders an over-long stored name instead of throwing', async () => {
        mockGuilds.seed({
            guildId: GUILD,
            activeEvent: customEvent({
                name: longName,
                eventShop: [{ itemId: 'x', name: 'Thing', description: '', emoji: '', cost: 1, stock: -1 }],
            }),
        });
        const interaction = makeInteraction({ subcommand: 'browse' });

        await eventshop.execute(interaction);

        const embed = interaction.replies.find(r => r?.embeds)?.embeds[0];
        expect(embed.data.title.length).toBeLessThanOrEqual(256);
    });
});
