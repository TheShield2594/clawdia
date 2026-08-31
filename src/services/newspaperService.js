const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const { getCompletion, resolveProviderConfig } = require('./aiService');
const { collectSignals, signalUserIds, buildDataSummary, buildSections } = require('./newspaper/signals');
const { handlesGuild } = require('../utils/sharding');

/**
 * The weekly server newspaper.
 *
 * What the paper can report on lives in `./newspaper/signals.js` — one entry per
 * section, each owning its own query and both of its renderings (#836). This
 * file is the paper around them: resolve the names, ask the model for an
 * edition, and print the plain one when there is no model or the model failed.
 *
 * The AI half is best-effort by construction. The stats are collected before
 * anything is asked of a provider, so a provider that is down costs the guild
 * its narrator and not its paper.
 */

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

// `requester` attributes an on-demand run (the /newspaper preview) to the user
// who asked for it, so it counts against the guild's AI limits like any other
// user-initiated call. The scheduled path passes nothing: it runs on a cadence
// the guild itself configures, and is bounded by that rather than by a
// per-user window it has no user for.
async function generateNewspaper(client, guildDoc, preloadedGuild, requester) {
    const { guildId } = guildDoc;
    const sections = guildDoc.newspaper?.sections ?? {};
    const currency = guildDoc.economy?.currency ?? '💰';
    const includeQuote = sections.quoteOfTheWeek !== false;

    const stats = await collectSignals({ guildId, guildDoc, sections });

    // Use pre-fetched guild when available (avoids a duplicate guilds.fetch)
    const discordGuild = preloadedGuild ?? await client.guilds.fetch(guildId).catch(() => null);

    // Every name the collected signals want, resolved in one members.fetch —
    // which is why the signals declare their user ids rather than resolving
    // their own.
    const usernameMap = await resolveUsernames(discordGuild, signalUserIds(stats));
    const renderContext = { names: usernameMap, currency };
    const dataSummary = buildDataSummary(stats, renderContext);

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    let narrativeText = null;

    // Use AI if configured
    if (guildDoc.ai?.enabled) {
        try {
            const { provider, model, apiKey, baseUrl, mcpServers, rateLimit } = resolveProviderConfig(guildDoc.ai);
            if (apiKey || provider === 'ollama') {
                const quoteInstruction = includeQuote
                    ? 'End with a witty "Quote of the Week" that you invent yourself based on the server activity.'
                    : '';
                narrativeText = await getCompletion({
                    provider, model, apiKey, baseUrl, mcpServers, rateLimit,
                    // A scheduled run has no userId, and the tool budget is
                    // keyed on one — leaving MCP on would be the only
                    // unbounded tool path in the codebase. The stats are all
                    // in the prompt; there is nothing to look up anyway.
                    mcp: false,
                    userId: requester?.userId,
                    channelId: requester?.channelId,
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
            // A limit refusal is the guild's own setting talking, not a provider
            // fault: the /newspaper preview should say so rather than silently
            // hand back the AI-less fallback as if nothing was configured.
            if (err?.rateLimited && requester) throw err;
            console.error('[newspaper] AI generation failed:', err.message);
        }
    }

    // Fallback: build a plain-text newspaper without AI
    if (!narrativeText) {
        narrativeText = buildFallbackNewspaper(stats, renderContext, guildDoc.name, dateStr);
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

/**
 * The paper as it prints with no model: every signal's own lines, under its own
 * heading, in registry order.
 *
 * This is the edition a guild with no AI configured always gets, and the one a
 * guild with AI gets on the week its provider is down — so it has to be a whole
 * paper rather than an apology.
 */
function buildFallbackNewspaper(stats, renderContext, guildName, dateStr) {
    const lines = [`**📰 ${guildName || 'Server'} Weekly**`, `*${dateStr}*`, ''];

    for (const block of buildSections(stats, renderContext)) {
        lines.push(...block, '');
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
        // Per-guild job: each shard posts only for guilds it can reach.
        if (!handlesGuild(guildId, client)) continue;

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

            // The claimed document, not the one the sweep started from. Both are
            // this guild, but `claimed` was read at claim time and `guildDoc`
            // when the sweep began — which can be several guilds and several
            // Discord round trips earlier. The signals read `activeWar`,
            // `dynamicPricing` and `shop` off it (./newspaper/signals.js), and
            // those are exactly the fields a war resolution or a price recalc
            // moves in between.
            const embed = await generateNewspaper(client, claimed, dg);
            await channel.send({ embeds: [embed] });
        } catch (err) {
            console.error(`[newspaper] postScheduledNewspapers failed for guild ${guildId}:`, err.message);
        }
    }
}

module.exports = { generateNewspaper, postScheduledNewspapers };
