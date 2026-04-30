const cron = require('node-cron');
const SummaryJob = require('../models/SummaryJob');
const Guild = require('../models/Guild');
const { getCompletion, resolveProviderConfig } = require('./aiService');

const MAX_TRANSCRIPT_CHARS = 6000;

async function runSummaryJob(job, client) {
    const guild = await client.guilds.fetch(job.guildId).catch(() => null);
    if (!guild) return;

    const srcChannel = guild.channels.cache.get(job.sourceChannelId)
        || await guild.channels.fetch(job.sourceChannelId).catch(() => null);
    if (!srcChannel || !srcChannel.isTextBased()) return;

    const fetched = await srcChannel.messages.fetch({ limit: 100 });
    const transcript = [...fetched.values()]
        .reverse()
        .filter(m => !m.author.bot && m.content?.trim())
        .map(m => `[${m.author.displayName || m.author.username}]: ${m.content}`)
        .join('\n')
        .slice(0, MAX_TRANSCRIPT_CHARS);

    if (!transcript) return;

    const guildSettings = await Guild.findOne({ guildId: job.guildId });
    if (!guildSettings?.ai?.enabled) return;

    const config = resolveProviderConfig(guildSettings.ai);
    const summary = await getCompletion({
        ...config,
        systemPrompt: 'You are a helpful assistant that creates concise summaries of Discord channel activity.',
        history: [],
        prompt: `Summarize the key topics, decisions, and highlights from these Discord messages as bullet points:\n\n${transcript}`
    });

    const dstChannel = guild.channels.cache.get(job.targetChannelId)
        || await guild.channels.fetch(job.targetChannelId).catch(() => null);
    if (!dstChannel || !dstChannel.isTextBased()) return;

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
}

function startSummaryService(client) {
    // Check every minute whether any daily job is due
    cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            const jobs = await SummaryJob.find({ enabled: true });

            for (const job of jobs) {
                if (now.getUTCHours() !== job.hour || now.getUTCMinutes() !== job.minute) continue;
                // Skip if already ran within the last 23 hours
                if (job.lastRun && now - job.lastRun < 23 * 60 * 60 * 1000) continue;

                runSummaryJob(job, client).catch(err =>
                    console.error(`[SummaryService] Job ${job._id} failed:`, err.message)
                );
            }
        } catch (err) {
            console.error('[SummaryService] Scheduler error:', err.message);
        }
    });

    console.log('[SummaryService] Started');
}

module.exports = { startSummaryService, runSummaryJob };
