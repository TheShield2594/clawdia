const cron = require('node-cron');
const SummaryJob = require('../models/SummaryJob');
const Guild = require('../models/Guild');
const { getCompletion, resolveProviderConfig } = require('./aiService');
const { runJob } = require('../utils/jobRunner');
const { EmbedBuilder } = require('discord.js');
const COLORS = require('../utils/embedColors');

const MAX_TRANSCRIPT_CHARS = 6000;
const DIGEST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// A run claims its daily slot for this long. 23h rather than 24 so a run that
// fired late (catch-up after downtime) does not push the next day's past its
// configured time for good.
const REFIRE_GUARD_MS = 23 * 60 * 60 * 1000;
// Only the last MAX_TRANSCRIPT_CHARS of transcript survive, so there is no
// point paginating a busy channel arbitrarily deep into the 24h window — the
// newest few hundred messages already overflow what the summary can read.
const MAX_DIGEST_PAGES_PER_CHANNEL = 5;

function localHourMinute(timezone) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone || 'UTC',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        });
        const parts = formatter.formatToParts(new Date());
        const h = parts.find(p => p.type === 'hour');
        const m = parts.find(p => p.type === 'minute');
        return {
            hour: parseInt(h ? h.value : '0', 10),
            minute: parseInt(m ? m.value : '0', 10)
        };
    } catch {
        const now = new Date();
        return { hour: now.getUTCHours(), minute: now.getUTCMinutes() };
    }
}

async function runSummaryJob(job, client) {
    const guild = await client.guilds.fetch(job.guildId).catch(() => null);
    if (!guild) return false;

    const srcChannel = guild.channels.cache.get(job.sourceChannelId)
        || await guild.channels.fetch(job.sourceChannelId).catch(() => null);
    if (!srcChannel || !srcChannel.isTextBased()) return false;

    const fetched = await srcChannel.messages.fetch({ limit: 100 });
    const transcript = [...fetched.values()]
        .reverse()
        .filter(m => !m.author.bot && m.content?.trim())
        .map(m => `[${m.author.displayName || m.author.username}]: ${m.content}`)
        .join('\n')
        .slice(-MAX_TRANSCRIPT_CHARS);

    if (!transcript) return false;

    const guildSettings = await Guild.findOne({ guildId: job.guildId });
    if (!guildSettings?.ai?.enabled) return false;

    const config = resolveProviderConfig(guildSettings.ai);
    // No userId/channelId: this is a scheduled job, not a request. The guild's
    // per-user AI limit has no user to bill it to, and bounding a digest by a
    // per-channel window would silently drop the run the guild configured.
    // Its cadence is the bound.
    const summary = await getCompletion({
        ...config,
        systemPrompt: 'You are a helpful assistant that creates concise summaries of Discord channel activity.',
        history: [],
        prompt: `Summarize the key topics, decisions, and highlights from these Discord messages as bullet points:\n\n${transcript}`,
        guildId: job.guildId
    });

    const dstChannel = guild.channels.cache.get(job.targetChannelId)
        || await guild.channels.fetch(job.targetChannelId).catch(() => null);
    if (!dstChannel || !dstChannel.isTextBased()) return false;

    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const header = `**${job.label}** — <#${job.sourceChannelId}>\n${date}\n\n`;
    const full = header + summary;

    if (full.length <= 2000) {
        await dstChannel.send(full);
    } else {
        await dstChannel.send(header.trimEnd());
        let remaining = summary;
        while (remaining.length > 0) {
            await dstChannel.send(remaining.slice(0, 2000));
            remaining = remaining.slice(2000);
        }
    }

    job.lastRun = new Date();
    await job.save();
    return true;
}

async function runDailyDigest(guildSettings, client) {
    const digest = guildSettings.ai?.dailyDigest;
    if (!digest?.enabled || !digest.channelId) return false;

    const guild = await client.guilds.fetch(guildSettings.guildId).catch(() => null);
    if (!guild) return false;

    const dstChannel = guild.channels.cache.get(digest.channelId)
        || await guild.channels.fetch(digest.channelId).catch(() => null);
    if (!dstChannel || !dstChannel.isTextBased()) return false;

    const cutoff = new Date(Date.now() - DIGEST_LOOKBACK_MS);
    const sourceIds = digest.sourceChannelIds?.length
        ? digest.sourceChannelIds
        : guild.channels.cache.filter(c => c.isTextBased()).map(c => c.id);

    const lines = [];
    for (const channelId of sourceIds) {
        const channel = guild.channels.cache.get(channelId)
            || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) continue;

        // Paginate through the lookback window, newest first, bounded: one
        // busy channel must not hold the whole scheduler tick (#824).
        const channelMessages = [];
        let before;
        let done = false;
        for (let page = 0; !done && page < MAX_DIGEST_PAGES_PER_CHANNEL; page++) {
            const fetchOpts = { limit: 100 };
            if (before) fetchOpts.before = before;
            const batch = await channel.messages.fetch(fetchOpts).catch(() => null);
            if (!batch || !batch.size) break;
            for (const msg of batch.values()) {
                if (msg.createdAt < cutoff) { done = true; break; }
                channelMessages.push(msg);
            }
            if (!done && batch.size < 100) break;
            before = batch.last()?.id;
        }

        const recent = channelMessages
            .filter(m => !m.author.bot && m.content?.trim())
            .reverse()
            .map(m => `[#${channel.name}] ${m.author.displayName || m.author.username}: ${m.content}`);
        lines.push(...recent);
    }

    if (!lines.length) {
        const embed = new EmbedBuilder()
            .setTitle('Daily Server Digest')
            .setDescription('No activity in the last 24 hours.')
            .setColor(COLORS.INFO)
            .setTimestamp();
        await dstChannel.send({ embeds: [embed] });
        guildSettings.ai.dailyDigest.lastRun = new Date();
        await guildSettings.save();
        return true;
    }

    const transcript = lines.join('\n').slice(-MAX_TRANSCRIPT_CHARS);
    const persona = guildSettings.ai?.systemPrompt || 'You are a helpful Discord bot assistant.';

    const config = resolveProviderConfig(guildSettings.ai);
    // No userId/channelId: this is a scheduled job, not a request. The guild's
    // per-user AI limit has no user to bill it to, and bounding a digest by a
    // per-channel window would silently drop the run the guild configured.
    // Its cadence is the bound.
    const summary = await getCompletion({
        ...config,
        systemPrompt: persona,
        history: [],
        prompt: `Summarize today's activity in this Discord server. Write in the same tone and voice as your persona. Focus on key topics, decisions, and highlights. Keep it concise and engaging:\n\n${transcript}`,
        guildId: guildSettings.guildId
    });

    const date = new Date().toLocaleDateString('en-US', {
        timeZone: digest.timezone || 'UTC',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const embed = new EmbedBuilder()
        .setTitle('Daily Server Digest')
        .setDescription(summary?.slice(0, 4096) || '(no summary generated)')
        .setFooter({ text: date })
        .setColor(COLORS.INFO)
        .setTimestamp();

    await dstChannel.send({ embeds: [embed] });
    guildSettings.ai.dailyDigest.lastRun = new Date();
    await guildSettings.save();
    return true;
}

// Has the configured wall-clock time already passed today? Due-ness is a
// window from that time to midnight, not the exact minute (#824): a tick lost
// to the overlap guard, a slow digest, or downtime used to cost the whole
// day's run, because the next tick no longer matched hour/minute equality.
// The REFIRE_GUARD_MS check on lastRun is what stops the window re-firing.
function timeHasPassed(nowHour, nowMinute, dueHour, dueMinute) {
    return nowHour > dueHour || (nowHour === dueHour && nowMinute >= dueMinute);
}

async function runSchedulerTick(client) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - REFIRE_GUARD_MS);
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();

    const jobs = await SummaryJob.find({
        enabled: true,
        $or: [{ hour: { $lt: utcHour } }, { hour: utcHour, minute: { $lte: utcMinute } }]
    });

    for (const job of jobs) {
        if (job.lastRun && now - job.lastRun < REFIRE_GUARD_MS) continue;

        // Atomic claim before the run, mirroring the newspaper (#824): the slot
        // is spent up front, so a run that fails half-way — or a concurrent
        // worker — cannot fire again every minute for the rest of the day.
        const claimed = await SummaryJob.findOneAndUpdate(
            { _id: job._id, enabled: true, $or: [{ lastRun: null }, { lastRun: { $lte: cutoff } }] },
            { $set: { lastRun: now } },
            { new: true }
        );
        if (!claimed) continue;

        await runJob('summaryService', 'runSummaryJob', () => runSummaryJob(claimed, client), {
            guildId: claimed.guildId,
            payload: { jobId: String(claimed._id), label: claimed.label },
        });
    }

    // Check guild-level daily digests
    const guildsWithDigest = await Guild.find({
        'ai.enabled': true,
        'ai.dailyDigest.enabled': true,
        'ai.dailyDigest.channelId': { $ne: null }
    }).lean(false);

    for (const guildSettings of guildsWithDigest) {
        const digest = guildSettings.ai.dailyDigest;
        const { hour, minute } = localHourMinute(digest.timezone);
        if (!timeHasPassed(hour, minute, digest.hour, digest.minute)) continue;
        if (digest.lastRun && now - digest.lastRun < REFIRE_GUARD_MS) continue;

        const claimed = await Guild.findOneAndUpdate(
            {
                guildId: guildSettings.guildId,
                'ai.enabled': true,
                'ai.dailyDigest.enabled': true,
                $or: [
                    { 'ai.dailyDigest.lastRun': null },
                    { 'ai.dailyDigest.lastRun': { $lte: cutoff } }
                ]
            },
            { $set: { 'ai.dailyDigest.lastRun': now } }
        );
        if (!claimed) continue;

        await runJob('summaryService', 'runDailyDigest', () => runDailyDigest(guildSettings, client), {
            guildId: guildSettings.guildId,
        });
    }
}

function startSummaryService(client) {
    // Check every minute whether any daily job is due
    cron.schedule('* * * * *', () =>
        runJob('summaryService', 'scheduler', () => runSchedulerTick(client))
    );

    console.log('[SummaryService] Started');
}

module.exports = { startSummaryService, runSummaryJob, runDailyDigest, __test__: { runSchedulerTick, timeHasPassed, REFIRE_GUARD_MS } };
