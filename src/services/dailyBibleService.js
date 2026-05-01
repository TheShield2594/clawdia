const cron = require('node-cron');
const Guild = require('../models/Guild');
const { getDailyVerse, lookupVerse, createVerseEmbed } = require('./bibleService');

const bibleJobs = new Map();

function validateTime(time) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time || '');
    if (!match) return '08:00';
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return '08:00';
    return time;
}

function validateTimezone(tz) {
    if (!tz) return 'UTC';
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return tz;
    } catch {
        return 'UTC';
    }
}

function timeToCron(time) {
    const [hour, minute] = validateTime(time).split(':').map(Number);
    return `${minute} ${hour} * * *`;
}

async function postDailyVerse(client, guildId, channelId, translation) {
    try {
        const verseData = await getDailyVerse();
        if (!verseData) return;

        // Re-fetch in the guild's configured translation when it isn't the default KJV
        let displayVerse = verseData;
        if (translation && translation !== 'kjv' && verseData.reference) {
            const translated = await lookupVerse(verseData.reference, translation);
            if (translated?.text) displayVerse = translated;
        }

        let channel = client.channels.cache.get(channelId);
        if (!channel) channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') return;

        const embed = createVerseEmbed(displayVerse, '📖 Daily Bible Verse');
        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error(`[BibleService] Failed to post daily verse for guild ${guildId}:`, err);
    }
}

function scheduleBibleVerse(client, guildId, bv) {
    const key = guildId;

    if (bibleJobs.has(key)) {
        bibleJobs.get(key).stop();
        bibleJobs.delete(key);
    }

    if (!bv?.enabled || !bv?.channelId) return;

    const safeTime = validateTime(bv.time);
    const safeTz = validateTimezone(bv.timezone);

    if (safeTime !== bv.time) {
        console.warn(`[BibleService] Invalid time "${bv.time}" for guild ${guildId}, falling back to ${safeTime}`);
    }
    if (safeTz !== bv.timezone) {
        console.warn(`[BibleService] Invalid timezone "${bv.timezone}" for guild ${guildId}, falling back to UTC`);
    }

    const cronExpr = timeToCron(safeTime);

    const job = cron.schedule(
        cronExpr,
        () => postDailyVerse(client, guildId, bv.channelId, bv.translation),
        { timezone: safeTz }
    );
    bibleJobs.set(key, job);
    console.log(`[BibleService] Scheduled daily verse for guild ${guildId} at ${safeTime} (${safeTz})`);
}

async function startDailyBibleService(client) {
    try {
        const guilds = await Guild.find({
            'bibleVerse.enabled': true,
            'bibleVerse.channelId': { $ne: null }
        });

        for (const guild of guilds) {
            scheduleBibleVerse(client, guild.guildId, guild.bibleVerse);
        }

        console.log(`[BibleService] Started daily verse scheduler for ${guilds.length} guild(s)`);
    } catch (err) {
        console.error('[BibleService] Failed to start daily Bible service:', err);
    }
}

function rescheduleBibleVerse(client, guildId) {
    Guild.findOne({ guildId })
        .then(guild => {
            if (!guild) return;
            scheduleBibleVerse(client, guildId, guild.bibleVerse);
        })
        .catch(console.error);
}

module.exports = { startDailyBibleService, rescheduleBibleVerse };
