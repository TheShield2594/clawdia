const cron = require('node-cron');
const Guild = require('../models/Guild');
const { getDailyVerse, createVerseEmbed } = require('./bibleService');

const bibleJobs = new Map();

function timeToCron(time) {
    const [hour, minute] = (time || '08:00').split(':').map(Number);
    return `${minute ?? 0} ${hour ?? 8} * * *`;
}

async function postDailyVerse(client, guildId, channelId) {
    try {
        const verseData = await getDailyVerse();
        if (!verseData) return;

        let channel = client.channels.cache.get(channelId);
        if (!channel) channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') return;

        const embed = createVerseEmbed(verseData, '📖 Daily Bible Verse');
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

    const cronExpr = timeToCron(bv.time);
    const tz = bv.timezone || 'UTC';

    const job = cron.schedule(
        cronExpr,
        () => postDailyVerse(client, guildId, bv.channelId),
        { timezone: tz }
    );
    bibleJobs.set(key, job);
    console.log(`[BibleService] Scheduled daily verse for guild ${guildId} at ${bv.time} (${tz})`);
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
