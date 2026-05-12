const Guild = require('../models/Guild');
const { SEASONAL_EVENTS, getActiveSeasonalEvent } = require('../data/seasonalEvents');

/**
 * Check all guilds for seasonal event auto-start/auto-end and apply changes.
 * Called hourly by the cron scheduler.
 */
async function checkSeasonalEvents(client) {
    const now = new Date();
    const currentSeasonal = getActiveSeasonalEvent();

    const guilds = await Guild.find({}).lean();

    for (const guild of guilds) {
        const discordGuild = client.guilds.cache.get(guild.guildId);
        if (!discordGuild) continue;

        const active = guild.activeEvent;

        // Auto-end expired custom/admin events
        if (active?.type && active.endsAt && new Date(active.endsAt) <= now) {
            await Guild.findOneAndUpdate(
                { guildId: guild.guildId },
                { $set: { activeEvent: buildClearedEvent() } }
            );
            await announceEventEnd(discordGuild, active, guild);
            continue;
        }

        // Auto-start seasonal event if none is running
        if (!active?.type && currentSeasonal) {
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

            await Guild.findOneAndUpdate(
                { guildId: guild.guildId },
                { $set: { activeEvent: newEvent } }
            );

            await announceEventStart(discordGuild, newEvent, guild);
        }

        // Auto-end a running seasonal event when the date range has passed
        if (active?.type && active.startedBy === 'auto' && !currentSeasonal) {
            await Guild.findOneAndUpdate(
                { guildId: guild.guildId },
                { $set: { activeEvent: buildClearedEvent() } }
            );
            await announceEventEnd(discordGuild, active, guild);
        }
    }
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
            .setTitle(`${eventData.emoji ?? '🎉'} ${eventData.name} Has Begun!`)
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
            .setColor('#888888')
            .setTitle(`${eventData.emoji ?? '🎉'} ${eventData.name} Has Ended`)
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
    addEventCurrency,
    getEventCurrencyBalance,
    spendEventCurrency,
    buildClearedEvent,
};
