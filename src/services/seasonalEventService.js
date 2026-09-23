const Guild = require('../models/Guild');
const { SEASONAL_EVENTS, getActiveSeasonalEvent } = require('../data/seasonalEvents');
const COLORS = require('../utils/embedColors');
const { handlesGuild } = require('../utils/sharding');

// An event's name is echoed into embed titles, which Discord caps at 256
// characters, and discord.js throws rather than truncating. `/event start`'s
// `name` option had no limit (#873, pass 23); it is capped at input now, and
// this is the backstop for a name stored before that.
const EVENT_NAME_MAX = 100;

/** An event's display name, cut to EVENT_NAME_MAX. */
function eventLabel(event) {
    const label = String(event?.name || 'Event');
    return label.length > EVENT_NAME_MAX ? `${label.slice(0, EVENT_NAME_MAX - 1)}…` : label;
}

/**
 * Check all guilds for seasonal event auto-start/auto-end and apply changes.
 * Called hourly by the cron scheduler.
 */
async function checkSeasonalEvents(client) {
    const now = new Date();
    const currentSeasonal = getActiveSeasonalEvent();

    // Hourly, across every guild. Projected because a full Guild document drags in
    // the 3000-entry analytics.commandUsage array and the shop's image Buffers, and
    // this job reads none of it — only the active event, the one seasonal event an
    // admin ended early, and where to announce it.
    const guilds = await Guild.find({}, 'guildId activeEvent eventAutoStartSkip economy.announcementChannelId').lean();

    for (const guild of guilds) {
        // Per-guild job. Checked before the writes below rather than relying on
        // the cache miss: a shard that does not own this guild must not be the
        // one to start or end its event.
        if (!handlesGuild(guild.guildId, client)) continue;

        const discordGuild = client.guilds.cache.get(guild.guildId);
        if (!discordGuild) continue;

        // One guild's failed write must not cost every guild after it its
        // start or end until the next hour (#873, pass 23).
        try {
            await sweepGuild(guild, discordGuild, currentSeasonal, now);
        } catch (err) {
            console.error(`[seasonalEvents] sweep failed for guild ${guild.guildId}:`, err);
        }
    }
}

async function sweepGuild(guild, discordGuild, currentSeasonal, now) {
    const active = guild.activeEvent;

    // Every write below is guarded on the event this sweep read (#873, pass
    // 23). The read is a snapshot taken at the top of the hour, and an admin's
    // /event start or /event end can land between it and the write: unguarded,
    // the sweep cleared an event an admin had just started over an expired
    // one, or started the seasonal event over one an admin had just started.
    // A write that misses changed nothing, so it announces nothing either.

    // Auto-end expired custom/admin events
    if (active?.type && active.endsAt && new Date(active.endsAt) <= now) {
        const ended = await Guild.findOneAndUpdate(
            { guildId: guild.guildId, ...sameEventFilter(active) },
            { $set: { activeEvent: buildClearedEvent() } }
        );
        if (ended) await announceEventEnd(discordGuild, active, guild);
        return;
    }

    // Auto-start seasonal event if none is running, unless an admin ended this
    // one early. /event end used to last until the next hourly tick, which
    // started the same event again and announced it as new.
    if (!active?.type && currentSeasonal && !isAutoStartSkipped(guild, currentSeasonal.id, now)) {
        const eventDef = SEASONAL_EVENTS[currentSeasonal.id];
        const endsAt = getSeasonalEndDate(eventDef.autoStart);

        const newEvent = {
            type:           eventDef.id,
            name:           eventDef.name,
            emoji:          eventDef.emoji,
            color:          eventDef.color,
            startedAt:      now,
            endsAt,
            coinMultiplier: eventDef.coinMultiplier,
            xpMultiplier:   eventDef.xpMultiplier,
            startedBy:      'auto',
            announcementChannelId: guild.activeEvent?.announcementChannelId ?? null,
            eventShop:      eventDef.shop.map(s => ({
                itemId:      s.itemId,
                name:        s.name,
                description: s.description,
                emoji:       s.emoji,
                cost:        s.cost,
                stock:       -1
            }))
        };

        const started = await Guild.findOneAndUpdate(
            { guildId: guild.guildId, 'activeEvent.type': null },
            { $set: { activeEvent: newEvent } }
        );

        if (started) await announceEventStart(discordGuild, newEvent, guild);
    }

    // Auto-end a running seasonal event when the date range has passed
    if (active?.type && active.startedBy === 'auto' && !currentSeasonal) {
        const ended = await Guild.findOneAndUpdate(
            { guildId: guild.guildId, ...sameEventFilter(active) },
            { $set: { activeEvent: buildClearedEvent() } }
        );
        if (ended) await announceEventEnd(discordGuild, active, guild);
    }
}

/**
 * The filter that matches a guild only while it still runs `event` — the one a
 * caller read. `startedAt` is what tells two runs of the same type apart; a
 * cleared or never-set event is `type: null`, which also matches a guild
 * document written before `activeEvent` existed.
 */
function sameEventFilter(event) {
    if (!event?.type) return { 'activeEvent.type': null };
    return { 'activeEvent.type': event.type, 'activeEvent.startedAt': event.startedAt ?? null };
}

/** Whether an admin ended `eventId` early during the window that is still running. */
function isAutoStartSkipped(guild, eventId, now = new Date()) {
    const skip = guild?.eventAutoStartSkip;
    return Boolean(skip?.eventId === eventId && skip.until && new Date(skip.until) > now);
}

/**
 * The marker `/event end` leaves when it ends the seasonal event the calendar
 * is running, so the hourly sweep does not start it again until its window is
 * over. Null when the ended event is not the calendar's current one.
 */
function autoStartSkipFor(event) {
    const current = getActiveSeasonalEvent();
    if (!current || event?.type !== current.id) return null;
    return { eventId: current.id, until: getSeasonalEndDate(current.autoStart) };
}

/**
 * Returns the XP multiplier for the active event on this guild (1.0 if none).
 */
function getEventXpMultiplier(guildSettings) {
    const ev = guildSettings?.activeEvent;
    if (!ev?.type) return 1.0;
    if (ev.endsAt && new Date(ev.endsAt) <= new Date()) return 1.0;
    return ev.xpMultiplier ?? 1.0;
}

/**
 * Returns the coin multiplier for the active event on this guild (1.0 if none).
 */
function getEventCoinMultiplier(guildSettings) {
    const ev = guildSettings?.activeEvent;
    if (!ev?.type) return 1.0;
    if (ev.endsAt && new Date(ev.endsAt) <= new Date()) return 1.0;
    return ev.coinMultiplier ?? 1.0;
}

/**
 * Returns true if there is an active (non-expired) event on this guild.
 */
function hasActiveEvent(guildSettings) {
    const ev = guildSettings?.activeEvent;
    if (!ev?.type) return false;
    if (ev.endsAt && new Date(ev.endsAt) <= new Date()) return false;
    return true;
}

/**
 * Returns the event currency id for the guild's active event (null if none).
 */
function getEventCurrencyId(guildSettings) {
    const ev = guildSettings?.activeEvent;
    if (!ev?.type || ev.type === 'custom') return null;
    const def = SEASONAL_EVENTS[ev.type];
    return def?.currency?.id ?? null;
}

/**
 * Returns the cross-system event type string for the active event, or null.
 * Used by commands to gate cross-system bonus behaviour (e.g. 'winter_hunt').
 */
function getEventCrossSystemType(guildSettings) {
    const ev = guildSettings?.activeEvent;
    if (!ev?.type) return null;
    if (ev.endsAt && new Date(ev.endsAt) <= new Date()) return null;
    const def = SEASONAL_EVENTS[ev.type];
    return def?.crossSystem ? ev.type : null;
}

/**
 * Adds event currency to a user document (must call user.save() after).
 */
function addEventCurrency(user, currencyId, amount) {
    if (!currencyId || amount <= 0) return;
    if (!user.eventCurrency) user.eventCurrency = [];
    const entry = user.eventCurrency.find(e => e.currencyId === currencyId);
    if (entry) {
        entry.amount += amount;
    } else {
        user.eventCurrency.push({ currencyId, amount });
    }
}

/**
 * Gets current event currency balance for a user.
 */
function getEventCurrencyBalance(user, currencyId) {
    if (!currencyId || !user.eventCurrency) return 0;
    return user.eventCurrency.find(e => e.currencyId === currencyId)?.amount ?? 0;
}

/**
 * Spends event currency from a user document. Returns false if insufficient.
 * Must call user.save() after.
 */
function spendEventCurrency(user, currencyId, amount) {
    if (!currencyId || amount <= 0) return false;
    const entry = (user.eventCurrency ?? []).find(e => e.currencyId === currencyId);
    if (!entry || entry.amount < amount) return false;
    entry.amount -= amount;
    return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildClearedEvent() {
    return {
        type: null, name: null, emoji: null, color: null,
        startedAt: null, endsAt: null,
        coinMultiplier: 1.0, xpMultiplier: 1.0,
        startedBy: null, eventShop: []
    };
}

function getSeasonalEndDate(autoStart) {
    const now = new Date();
    const year = now.getUTCFullYear();
    // Day after the last day of the event window at midnight UTC
    return new Date(Date.UTC(year, autoStart.month - 1, autoStart.dayEnd + 1));
}

async function announceEventStart(discordGuild, eventData, guildDoc) {
    const channelId = eventData.announcementChannelId || guildDoc?.economy?.announcementChannelId;
    if (!channelId) return;
    try {
        const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return;
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setColor(eventData.color ?? '#5865F2')
            .setTitle(`${eventData.emoji ?? '🎉'} ${eventLabel(eventData)} Has Begun!`)
            .setDescription(buildEventDescription(eventData))
            .setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch { /* announcement failures are non-critical */ }
}

async function announceEventEnd(discordGuild, eventData, guildDoc) {
    const channelId = eventData.announcementChannelId || guildDoc?.economy?.announcementChannelId;
    if (!channelId) return;
    try {
        const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return;
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setColor(COLORS.NEUTRAL)
            .setTitle(`${eventData.emoji ?? '🎉'} ${eventLabel(eventData)} Has Ended`)
            .setDescription('Thank you for participating! The event has concluded.')
            .setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch { /* non-critical */ }
}

function buildEventDescription(ev) {
    const lines = [];
    if (ev.xpMultiplier > 1) lines.push(`⭐ **${ev.xpMultiplier}x XP** all event long`);
    if (ev.coinMultiplier > 1) lines.push(`💰 **${ev.coinMultiplier}x Coins** all event long`);
    if (ev.endsAt) lines.push(`⏰ Ends <t:${Math.floor(new Date(ev.endsAt) / 1000)}:R>`);
    lines.push('\nUse `/event status` to see details and `/eventshop` to spend your event currency!');
    return lines.join('\n');
}

module.exports = {
    checkSeasonalEvents,
    getEventXpMultiplier,
    getEventCoinMultiplier,
    hasActiveEvent,
    getEventCurrencyId,
    getEventCrossSystemType,
    addEventCurrency,
    getEventCurrencyBalance,
    spendEventCurrency,
    buildClearedEvent,
    sameEventFilter,
    autoStartSkipFor,
    announceEventEnd,
    eventLabel,
    EVENT_NAME_MAX,
};
