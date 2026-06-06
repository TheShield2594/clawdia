const { EmbedBuilder } = require('discord.js');
const Guild       = require('../models/Guild');
const User        = require('../models/User');
const Case        = require('../models/Case');
const Transaction = require('../models/Transaction');
const { getCompletion, resolveProviderConfig } = require('./aiService');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function collectStats(guildId, sections) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const data = {};

    if (sections.topEarners !== false) {
        data.topEarners = await User.find({ guildId })
            .sort({ balance: -1 })
            .limit(5)
            .select('userId balance')
            .lean();
    }

    if (sections.levelUps !== false) {
        data.topLevels = await User.find({ guildId })
            .sort({ level: -1 })
            .limit(5)
            .select('userId level xp')
            .lean();
    }

    if (sections.casinoHighlights !== false) {
        data.bigWins = await Transaction.find({
            guildId,
            type: { $in: ['gamble', 'casino_jackpot', 'duel_win'] },
            amount: { $gt: 0 },
            createdAt: { $gte: weekAgo }
        })
            .sort({ amount: -1 })
            .limit(5)
            .select('userId type amount note')
            .lean();
    }

    if (sections.moderationDigest !== false) {
        data.modCount = await Case.countDocuments({
            guildId,
            createdAt: { $gte: weekAgo }
        });
    }

    if (sections.gameStandouts !== false) {
        const [topHunter, topFisher, topMiner] = await Promise.all([
            User.findOne({ guildId, 'hunt.xp': { $gt: 0 } }).sort({ 'hunt.xp': -1 }).select('userId hunt').lean(),
            User.findOne({ guildId, 'fishing.xp': { $gt: 0 } }).sort({ 'fishing.xp': -1 }).select('userId fishing').lean(),
            User.findOne({ guildId, 'mining.xp': { $gt: 0 } }).sort({ 'mining.xp': -1 }).select('userId mining').lean(),
        ]);
        data.gameStandouts = { topHunter, topFisher, topMiner };
    }

    if (sections.newMembers !== false) {
        data.newMemberCount = await User.countDocuments({
            guildId,
            createdAt: { $gte: weekAgo }
        });
    }

    return data;
}

async function resolveUsernames(discordGuild, userIds) {
    const map = {};
    if (!discordGuild || !userIds.length) return map;
    try {
        const members = await discordGuild.members.fetch({ user: userIds }).catch(() => null);
        for (const uid of userIds) {
            if (!uid) continue;
            map[uid] = members?.get(uid)?.user?.username ?? `User ${uid.slice(-4)}`;
        }
    } catch {}
    return map;
}

function buildDataSummary(stats, usernameMap, currency, sections) {
    const lines = [];

    if (stats.topEarners?.length && sections.topEarners !== false) {
        lines.push('TOP EARNERS (ALL-TIME BALANCE):');
        stats.topEarners.forEach((u, i) =>
            lines.push(`  ${i + 1}. ${usernameMap[u.userId] || 'Unknown'} — ${(u.balance || 0).toLocaleString()} ${currency}`)
        );
    }

    if (stats.topLevels?.length && sections.levelUps !== false) {
        lines.push('\nTOP LEVELS:');
        stats.topLevels.forEach((u, i) =>
            lines.push(`  ${i + 1}. ${usernameMap[u.userId] || 'Unknown'} — Level ${u.level}`)
        );
    }

    if (stats.bigWins?.length && sections.casinoHighlights !== false) {
        lines.push('\nBIGGEST WINS THIS WEEK:');
        stats.bigWins.forEach((t) =>
            lines.push(`  ${usernameMap[t.userId] || 'Unknown'} — +${t.amount.toLocaleString()} ${currency} (${t.type.replace(/_/g, ' ')})`)
        );
    } else if (sections.casinoHighlights !== false) {
        lines.push('\nCASINO HIGHLIGHTS: A quiet week at the tables. No major wins.');
    }

    if (stats.modCount !== undefined && sections.moderationDigest !== false) {
        lines.push(`\nMODERATION: ${stats.modCount} action${stats.modCount !== 1 ? 's' : ''} taken this week.`);
    }

    if (stats.gameStandouts && sections.gameStandouts !== false) {
        const { topHunter, topFisher, topMiner } = stats.gameStandouts;
        const parts = [];
        if (topHunter) parts.push(`🏹 ${usernameMap[topHunter.userId] || 'Unknown'} leads hunting at level ${topHunter.hunt?.level ?? 1}`);
        if (topFisher) parts.push(`🎣 ${usernameMap[topFisher.userId] || 'Unknown'} leads fishing at level ${topFisher.fishing?.level ?? 1}`);
        if (topMiner)  parts.push(`⛏️ ${usernameMap[topMiner.userId]  || 'Unknown'} leads mining at level ${topMiner.mining?.level ?? 1}`);
        if (parts.length) lines.push('\nGAME STANDOUTS:\n  ' + parts.join('\n  '));
    }

    if (stats.newMemberCount !== undefined && sections.newMembers !== false) {
        lines.push(`\nNEW MEMBERS: ${stats.newMemberCount} new member${stats.newMemberCount !== 1 ? 's' : ''} joined this week.`);
    }

    return lines.join('\n');
}

async function generateNewspaper(client, guildDoc, preloadedGuild) {
    const { guildId } = guildDoc;
    const sections = guildDoc.newspaper?.sections ?? {};
    const currency = guildDoc.economy?.currency ?? '💰';
    const includeQuote = sections.quoteOfTheWeek !== false;

    const stats = await collectStats(guildId, sections);

    // Use pre-fetched guild when available (avoids a duplicate guilds.fetch)
    const discordGuild = preloadedGuild ?? await client.guilds.fetch(guildId).catch(() => null);

    // Gather user IDs to resolve
    const userIds = new Set();
    (stats.topEarners || []).forEach(u => userIds.add(u.userId));
    (stats.topLevels || []).forEach(u => userIds.add(u.userId));
    (stats.bigWins || []).forEach(t => userIds.add(t.userId));
    if (stats.gameStandouts?.topHunter) userIds.add(stats.gameStandouts.topHunter.userId);
    if (stats.gameStandouts?.topFisher) userIds.add(stats.gameStandouts.topFisher.userId);
    if (stats.gameStandouts?.topMiner)  userIds.add(stats.gameStandouts.topMiner.userId);

    const usernameMap = await resolveUsernames(discordGuild, [...userIds]);
    const dataSummary = buildDataSummary(stats, usernameMap, currency, sections);

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    let narrativeText = null;

    // Use AI if configured
    if (guildDoc.ai?.enabled) {
        try {
            const { provider, model, temperature, maxTokens, apiKey, baseUrl } = resolveProviderConfig(guildDoc.ai);
            if (apiKey || provider === 'ollama') {
                const quoteInstruction = includeQuote
                    ? 'End with a witty "Quote of the Week" that you invent yourself based on the server activity.'
                    : '';
                narrativeText = await getCompletion({
                    provider, model, apiKey, baseUrl,
                    temperature: 0.85,
                    maxTokens: 900,
                    systemPrompt:
                        'You are an enthusiastic community journalist writing a fun, personality-filled weekly server newspaper. ' +
                        'Write in a lively, upbeat tone. Use Discord-style formatting (bold, bullet lines). Keep it under 1800 characters.',
                    history: [],
                    prompt:
                        `Write this week's server newspaper for "${guildDoc.name || 'our server'}".\n\n` +
                        `Date: ${dateStr}\n\nServer stats this week:\n${dataSummary}\n\n` +
                        `Include a fun headline, a brief intro paragraph, and highlight the sections above. ` +
                        quoteInstruction,
                    guildId: guildDoc.guildId
                });
            }
        } catch (err) {
            console.error('[newspaper] AI generation failed:', err.message);
        }
    }

    // Fallback: build a plain-text newspaper without AI
    if (!narrativeText) {
        narrativeText = buildFallbackNewspaper(stats, usernameMap, currency, sections, guildDoc.name, dateStr);
    }

    // Chunk to Discord's 4096-char embed limit
    const description = narrativeText.length > 4000 ? narrativeText.slice(0, 3997) + '…' : narrativeText;

    return new EmbedBuilder()
        .setColor('#f5c518')
        .setTitle(`📰 ${guildDoc.name || 'Server'} Weekly — ${dateStr}`)
        .setDescription(description)
        .setFooter({ text: 'Your server, your story. Powered by Clawdia.' })
        .setTimestamp();
}

function buildFallbackNewspaper(stats, usernameMap, currency, sections, guildName, dateStr) {
    const lines = [`**📰 ${guildName || 'Server'} Weekly**`, `*${dateStr}*`, ''];

    if (stats.topEarners?.length && sections.topEarners !== false) {
        lines.push('**💰 Top Earners**');
        stats.topEarners.slice(0, 3).forEach((u, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            lines.push(`${medals[i]} **${usernameMap[u.userId] || 'Unknown'}** — ${(u.balance || 0).toLocaleString()} ${currency}`);
        });
        lines.push('');
    }

    if (stats.topLevels?.length && sections.levelUps !== false) {
        lines.push('**📈 Level Leaders**');
        stats.topLevels.slice(0, 3).forEach((u, i) => {
            lines.push(`${i + 1}. **${usernameMap[u.userId] || 'Unknown'}** — Level ${u.level}`);
        });
        lines.push('');
    }

    if (stats.bigWins?.length && sections.casinoHighlights !== false) {
        lines.push('**🎰 Casino Highlights**');
        stats.bigWins.slice(0, 3).forEach(t => {
            lines.push(`• **${usernameMap[t.userId] || 'Unknown'}** won **${t.amount.toLocaleString()} ${currency}**`);
        });
        lines.push('');
    }

    if (stats.modCount !== undefined && sections.moderationDigest !== false) {
        lines.push(`**🛡️ Moderation Digest** — ${stats.modCount} action${stats.modCount !== 1 ? 's' : ''} this week.`, '');
    }

    if (stats.gameStandouts && sections.gameStandouts !== false) {
        const { topHunter, topFisher, topMiner } = stats.gameStandouts;
        lines.push('**🎮 Game Standouts**');
        if (topHunter) lines.push(`🏹 **${usernameMap[topHunter.userId] || 'Unknown'}** — Hunt Level ${topHunter.hunt?.level ?? 1}`);
        if (topFisher) lines.push(`🎣 **${usernameMap[topFisher.userId] || 'Unknown'}** — Fishing Level ${topFisher.fishing?.level ?? 1}`);
        if (topMiner)  lines.push(`⛏️ **${usernameMap[topMiner.userId]  || 'Unknown'}** — Mining Level ${topMiner.mining?.level ?? 1}`);
        lines.push('');
    }

    if (stats.newMemberCount !== undefined && sections.newMembers !== false) {
        lines.push(`**👋 New Members** — ${stats.newMemberCount} new member${stats.newMemberCount !== 1 ? 's' : ''} joined this week.`, '');
    }

    lines.push('*Stay active — see you next issue!*');
    return lines.join('\n');
}

// Called by the scheduler: post to all guilds that are due for delivery.
async function postScheduledNewspapers(client) {
    const now = new Date();
    const currentDay  = now.getUTCDay();
    const currentHour = now.getUTCHours();
    const hourAgo     = new Date(now.getTime() - 60 * 60 * 1000);

    const guilds = await Guild.find({
        'newspaper.enabled': true,
        'newspaper.channelId': { $ne: null },
        'newspaper.deliveryDay': currentDay,
        'newspaper.deliveryHourUtc': currentHour,
        $or: [
            { 'newspaper.lastRunAt': null },
            { 'newspaper.lastRunAt': { $lte: hourAgo } }
        ]
    });

    for (const guildDoc of guilds) {
        const { guildId } = guildDoc;
        try {
            // Validate channel before consuming the weekly slot — misconfigured
            // channels must not burn lastRunAt.
            const dg = await client.guilds.fetch(guildId).catch(() => null);
            if (!dg) continue;
            const channel = await dg.channels.fetch(guildDoc.newspaper.channelId).catch(() => null);
            if (!channel?.isTextBased?.()) continue;

            // Atomic claim — only proceeds if another worker hasn't already run this hour.
            const claimed = await Guild.findOneAndUpdate(
                {
                    guildId,
                    'newspaper.enabled': true,
                    $or: [
                        { 'newspaper.lastRunAt': null },
                        { 'newspaper.lastRunAt': { $lte: hourAgo } }
                    ]
                },
                { $set: { 'newspaper.lastRunAt': now } },
                { new: false }
            );
            if (!claimed) continue;

            const embed = await generateNewspaper(client, guildDoc, dg);
            await channel.send({ embeds: [embed] });
        } catch (err) {
            console.error(`[newspaper] postScheduledNewspapers failed for guild ${guildId}:`, err.message);
        }
    }
}

module.exports = { generateNewspaper, postScheduledNewspapers };
