'use strict';

/**
 * #906. `seasonalEventService` sat at 3.6% statements — the lowest figure of any
 * service that moves value, and it moves two kinds of it.
 *
 * The multipliers are the larger one: `getEventCoinMultiplier` scales what every
 * earning command in the guild pays out, so an event that is over but still
 * reads as 1.25x pays a quarter more to everyone, indefinitely, and nothing
 * about that looks like an error. The event currency is the other — it is the
 * only thing the event shop takes, so a spend that debits nothing is a free
 * shop and a grant that overwrites is a player's balance gone.
 *
 * `checkSeasonalEvents` is the batch that writes the multipliers in the first
 * place: hourly, across every guild, out of the calendar. It is driven here
 * against a pinned clock, because a test that reads the real one asserts a
 * different branch every month (the same reason tests/seasonalEventWindows.js
 * pins it).
 */

const { useFixedClock, setClock } = require('./helpers/fixedClock');

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const Guild = require('../src/models/Guild');
const { SEASONAL_EVENTS } = require('../src/data/seasonalEvents');
const {
    checkSeasonalEvents,
    getEventCoinMultiplier,
    getEventXpMultiplier,
    hasActiveEvent,
    getEventCurrencyId,
    getEventCrossSystemType,
    addEventCurrency,
    getEventCurrencyBalance,
    spendEventCurrency,
    buildClearedEvent,
} = require('../src/services/seasonalEventService');

const GUILD = 'guild-1';

// Inside the summer festival's window (July 1–31), which is the event with a
// coin multiplier above 1 — the one where getting the end wrong costs coins.
const IN_SUMMER = '2026-07-15T12:00:00Z';
// Between every configured window: no month has an event on the 20th of March.
const NO_SEASON = '2026-03-20T12:00:00Z';

const activeEvent = (fields = {}) => ({
    type: 'summer_festival', name: 'Summer Festival', emoji: '🏖️',
    coinMultiplier: 1.25, xpMultiplier: 1.0,
    startedAt: new Date('2026-07-01T00:00:00Z'),
    endsAt: new Date('2026-08-01T00:00:00Z'),
    startedBy: 'auto',
    ...fields,
});

describe('the multipliers every payout is scaled by', () => {
    useFixedClock(IN_SUMMER);

    test('a guild with no event pays exactly what it earned', () => {
        expect(getEventCoinMultiplier({})).toBe(1.0);
        expect(getEventXpMultiplier({})).toBe(1.0);
        expect(getEventCoinMultiplier({ activeEvent: buildClearedEvent() })).toBe(1.0);
        expect(hasActiveEvent({ activeEvent: buildClearedEvent() })).toBe(false);
    });

    test('a running event applies its own multipliers', () => {
        const settings = { activeEvent: activeEvent({ coinMultiplier: 1.25, xpMultiplier: 1.5 }) };

        expect(getEventCoinMultiplier(settings)).toBe(1.25);
        expect(getEventXpMultiplier(settings)).toBe(1.5);
        expect(hasActiveEvent(settings)).toBe(true);
    });

    // The failure that pays a quarter more to everyone forever: an event whose
    // end date has passed but whose document nobody has cleared yet. The hourly
    // sweep clears it, and until it runs these have to answer 1.0 on their own.
    test('an event past its end date stops multiplying, cleared or not', () => {
        const settings = { activeEvent: activeEvent({ endsAt: new Date('2026-07-14T00:00:00Z') }) };

        expect(getEventCoinMultiplier(settings)).toBe(1.0);
        expect(getEventXpMultiplier(settings)).toBe(1.0);
        expect(hasActiveEvent(settings)).toBe(false);
        expect(getEventCrossSystemType(settings)).toBeNull();
    });

    test('an event with no end date runs until something clears it', () => {
        const settings = { activeEvent: activeEvent({ endsAt: null }) };

        expect(getEventCoinMultiplier(settings)).toBe(1.25);
        expect(hasActiveEvent(settings)).toBe(true);
    });

    test('an event that declares no multiplier does not multiply', () => {
        const settings = { activeEvent: activeEvent({ coinMultiplier: undefined, xpMultiplier: undefined }) };

        expect(getEventCoinMultiplier(settings)).toBe(1.0);
        expect(getEventXpMultiplier(settings)).toBe(1.0);
    });
});

describe('which currency an event pays in', () => {
    useFixedClock(IN_SUMMER);

    test('names the currency the event definition declares', () => {
        expect(getEventCurrencyId({ activeEvent: activeEvent() })).toBe('shells');
    });

    // An admin's custom event has no definition behind it, so there is no
    // currency to credit — commands have to see null rather than a bad id they
    // would then write balances under.
    test('a custom or absent event has no currency', () => {
        expect(getEventCurrencyId({ activeEvent: activeEvent({ type: 'custom' }) })).toBeNull();
        expect(getEventCurrencyId({})).toBeNull();
        expect(getEventCurrencyId({ activeEvent: activeEvent({ type: 'not_an_event' }) })).toBeNull();
    });

    test('only an event that declares a cross-system hook reports one', () => {
        expect(getEventCrossSystemType({ activeEvent: activeEvent({ type: 'winter_hunt' }) })).toBe('winter_hunt');
        expect(getEventCrossSystemType({ activeEvent: activeEvent({ type: 'summer_festival' }) })).toBeNull();
    });
});

describe('event currency balances', () => {
    test('a first grant creates the balance and later ones add to it', () => {
        const user = {};

        addEventCurrency(user, 'shells', 10);
        addEventCurrency(user, 'shells', 5);

        expect(user.eventCurrency).toEqual([{ currencyId: 'shells', amount: 15 }]);
        expect(getEventCurrencyBalance(user, 'shells')).toBe(15);
    });

    test('two events keep separate balances', () => {
        const user = { eventCurrency: [{ currencyId: 'candy', amount: 40 }] };

        addEventCurrency(user, 'shells', 10);

        expect(getEventCurrencyBalance(user, 'candy')).toBe(40);
        expect(getEventCurrencyBalance(user, 'shells')).toBe(10);
    });

    test('a grant of nothing, or to no currency, writes nothing', () => {
        const user = { eventCurrency: [{ currencyId: 'shells', amount: 10 }] };

        addEventCurrency(user, 'shells', 0);
        addEventCurrency(user, 'shells', -5);
        addEventCurrency(user, null, 10);

        expect(user.eventCurrency).toEqual([{ currencyId: 'shells', amount: 10 }]);
    });

    test('a balance nobody has is zero, not undefined', () => {
        expect(getEventCurrencyBalance({}, 'shells')).toBe(0);
        expect(getEventCurrencyBalance({ eventCurrency: [] }, 'shells')).toBe(0);
        expect(getEventCurrencyBalance({ eventCurrency: [] }, null)).toBe(0);
    });

    // The event shop's whole guard: it takes the items only if this said yes.
    test('spending debits exactly what it took', () => {
        const user = { eventCurrency: [{ currencyId: 'shells', amount: 30 }] };

        expect(spendEventCurrency(user, 'shells', 20)).toBe(true);
        expect(getEventCurrencyBalance(user, 'shells')).toBe(10);
    });

    test('a spend it cannot afford takes nothing and says so', () => {
        const user = { eventCurrency: [{ currencyId: 'shells', amount: 5 }] };

        expect(spendEventCurrency(user, 'shells', 6)).toBe(false);
        expect(getEventCurrencyBalance(user, 'shells')).toBe(5);
    });

    test('spending a currency the player has never held is refused', () => {
        const user = { eventCurrency: [] };

        expect(spendEventCurrency(user, 'shells', 1)).toBe(false);
        expect(spendEventCurrency({}, 'shells', 1)).toBe(false);
    });

    test('a spend of nothing is refused rather than treated as a free purchase', () => {
        const user = { eventCurrency: [{ currencyId: 'shells', amount: 5 }] };

        expect(spendEventCurrency(user, 'shells', 0)).toBe(false);
        expect(spendEventCurrency(user, 'shells', -10)).toBe(false);
        expect(getEventCurrencyBalance(user, 'shells')).toBe(5);
    });

    test('spending all of it leaves the entry at zero, not negative', () => {
        const user = { eventCurrency: [{ currencyId: 'shells', amount: 5 }] };

        expect(spendEventCurrency(user, 'shells', 5)).toBe(true);
        expect(user.eventCurrency[0].amount).toBe(0);
    });
});

describe('the hourly sweep', () => {
    useFixedClock(IN_SUMMER);

    const channel = { isTextBased: () => true, send: jest.fn(async () => {}) };
    let client;

    beforeEach(() => {
        jest.clearAllMocks();
        client = {
            guilds: {
                cache: new Map([[GUILD, {
                    id: GUILD,
                    channels: { fetch: jest.fn(async () => channel) },
                }]]),
            },
        };
        Guild.findOneAndUpdate.mockResolvedValue({});
    });

    const seedGuilds = (...guilds) => Guild.find.mockReturnValue({ lean: async () => guilds });
    const written = () => Guild.findOneAndUpdate.mock.calls[0]?.[1].$set.activeEvent;

    test('starts the season the calendar says is running, with its multipliers and shop', async () => {
        seedGuilds({ guildId: GUILD, activeEvent: null, economy: { announcementChannelId: 'chan-1' } });

        await checkSeasonalEvents(client);

        const event = written();
        expect(event.type).toBe('summer_festival');
        expect(event.coinMultiplier).toBe(SEASONAL_EVENTS.summer_festival.coinMultiplier);
        expect(event.xpMultiplier).toBe(SEASONAL_EVENTS.summer_festival.xpMultiplier);
        expect(event.startedBy).toBe('auto');
        expect(event.eventShop).toHaveLength(SEASONAL_EVENTS.summer_festival.shop.length);
        // Unlimited stock, not "none left" — the shop reads -1 as no limit.
        expect(event.eventShop.every(item => item.stock === -1)).toBe(true);
    });

    // The end date is the one the multipliers are read against for the rest of
    // the month, so it has to be the day after the window's last day, not the
    // day of.
    test('the event it starts ends after the last day of the window, at midnight UTC', async () => {
        seedGuilds({ guildId: GUILD, activeEvent: null });

        await checkSeasonalEvents(client);

        expect(written().endsAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    test('leaves a running event alone rather than restarting it every hour', async () => {
        seedGuilds({ guildId: GUILD, activeEvent: activeEvent() });

        await checkSeasonalEvents(client);

        expect(Guild.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('clears an event whose end date has passed, multipliers included', async () => {
        seedGuilds({
            guildId: GUILD,
            activeEvent: activeEvent({ endsAt: new Date('2026-07-14T00:00:00Z') }),
            economy: { announcementChannelId: 'chan-1' },
        });

        await checkSeasonalEvents(client);

        const cleared = written();
        expect(cleared.type).toBeNull();
        expect(cleared.coinMultiplier).toBe(1.0);
        expect(cleared.xpMultiplier).toBe(1.0);
        expect(cleared.eventShop).toEqual([]);
        // One write: the expired event is cleared and not immediately restarted.
        expect(Guild.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    test('clears an auto-started event once its season is out of the calendar', async () => {
        setClock(NO_SEASON);
        seedGuilds({ guildId: GUILD, activeEvent: activeEvent({ endsAt: null, startedBy: 'auto' }) });

        await checkSeasonalEvents(client);

        expect(written().type).toBeNull();
    });

    // An admin's event is theirs to end. The seasonal sweep clearing it would
    // take away a multiplier they turned on deliberately.
    test('does not clear an admin-started event when no season is running', async () => {
        setClock(NO_SEASON);
        seedGuilds({ guildId: GUILD, activeEvent: activeEvent({ endsAt: null, startedBy: 'admin-1' }) });

        await checkSeasonalEvents(client);

        expect(Guild.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('starts nothing outside every configured window', async () => {
        setClock(NO_SEASON);
        seedGuilds({ guildId: GUILD, activeEvent: null });

        await checkSeasonalEvents(client);

        expect(Guild.findOneAndUpdate).not.toHaveBeenCalled();
    });

    // The sweep runs over every guild in the database, including the ones this
    // shard is not connected to. Writing an event to one of those would turn on
    // a multiplier nobody could see or announce.
    test('skips a guild this client is not in', async () => {
        seedGuilds({ guildId: 'elsewhere', activeEvent: null });

        await checkSeasonalEvents(client);

        expect(Guild.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('reads only the fields it needs off each guild', async () => {
        seedGuilds();

        await checkSeasonalEvents(client);

        expect(Guild.find).toHaveBeenCalledWith({}, 'guildId activeEvent economy.announcementChannelId');
    });

    test('announces the start in the guild economy channel', async () => {
        seedGuilds({ guildId: GUILD, activeEvent: null, economy: { announcementChannelId: 'chan-1' } });

        await checkSeasonalEvents(client);

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send.mock.calls[0][0].embeds[0].data.title).toContain('Summer Festival');
    });

    // The write is the part that matters; the announcement is not. A channel
    // that was deleted must not stop the event starting, or leave the sweep
    // throwing before it reaches the next guild.
    test('a failed announcement does not stop the event, or the guilds after it', async () => {
        client.guilds.cache.get(GUILD).channels.fetch = jest.fn(async () => { throw new Error('unknown channel'); });
        seedGuilds({ guildId: GUILD, activeEvent: null, economy: { announcementChannelId: 'gone' } });

        await expect(checkSeasonalEvents(client)).resolves.toBeUndefined();
        expect(written().type).toBe('summer_festival');
    });
});
