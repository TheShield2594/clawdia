const User = require('../../models/User');
const { resolveMcpServers } = require('../../config/mcpServers');
const { providers, mcpMode } = require('./providers');
const { resolveProviderConfig, streamCompletion, getCompletion } = require('./index');
const { retrieveKnowledge, buildKnowledgeContext } = require('./knowledge');
const { loadHistory, appendHistory, clearHistory } = require('./history');
const { peekRateLimit, peekChannelRateLimit, userRateLimitKey } = require('./rateLimit');
const { buildActionsAddendum, extractAction, executeAction } = require('./actions');

// Discord transport for the AI chat loop: rate limiting, prompt assembly,
// message streaming/chunking, and post-processing. Everything provider-shaped
// lives behind streamCompletion/getCompletion.

const DISCORD_MAX_LEN = 2000;
const STREAM_EDIT_INTERVAL_MS = 800;
// Discord typing indicator expires after 10s — refresh every 8s during long generations
const TYPING_REFRESH_INTERVAL_MS = 8000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { retries = 2, baseDelayMs = 800 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const status = err?.status || err?.response?.status;
            // A rate-limited call is refused before the provider is touched, so
            // retrying it only burns more of the same budget and cannot succeed
            // inside the window. It has no HTTP status, which the check below
            // would otherwise read as a transient network failure.
            if (err?.rateLimited) throw err;
            const retryable = !status || status === 408 || status === 429 || status >= 500;
            if (!retryable || i === retries) throw err;
            await sleep(baseDelayMs * Math.pow(2, i));
        }
    }
    throw lastErr;
}

function chunkText(text, size = DISCORD_MAX_LEN) {
    if (text.length <= size) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > size) {
        let cut = remaining.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = remaining.lastIndexOf(' ', size);
        if (cut < size * 0.5) cut = size;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

async function handleAIChat(message, aiSettings) {
    const { provider, model, temperature, maxTokens, apiKey, baseUrl, mcpServers, rateLimit } = resolveProviderConfig(aiSettings);
    const providerDef = providers.get(provider);
    const providerLabel = providerDef?.label || provider;

    if (provider !== 'ollama' && !apiKey) {
        return message.reply(`${providerLabel} is not configured. Add an API key in the dashboard.`);
    }

    const modelError = providerDef?.validateModel?.(model);
    if (modelError) {
        return message.reply(modelError);
    }

    const content = message.content.trim();
    if (content.toLowerCase() === '!reset') {
        await clearHistory(message.guild.id, message.channel.id, message.author.id);
        return message.reply('Conversation history cleared.');
    }

    // A peek, not a consuming check: the slot is spent inside getCompletion /
    // streamCompletion, which is what actually bounds provider spend. This is
    // only here to refuse before the history load, knowledge retrieval and
    // prompt assembly below, and to say so in the channel where the user asked.
    // The same key enforcement will consume, so the peek and the spend agree.
    if (!peekRateLimit(userRateLimitKey(message.guild.id, message.author.id), rateLimit.perUser, rateLimit.windowMin)) {
        return message.reply(`Rate limit reached (${rateLimit.perUser} per ${rateLimit.windowMin}m). Please slow down.`);
    }

    if (!peekChannelRateLimit(message.channel.id, rateLimit.perChannel, rateLimit.windowMin)) {
        return message.reply(`This channel has reached the AI request limit. Please wait before sending more AI requests here.`);
    }

    const maxHistory = aiSettings.maxHistory ?? 20;
    const useStreaming = aiSettings.streaming !== false;

    // The streaming path posts this "…" before the first chunk arrives, so an
    // error after that point has to land *in* it. Left alone it stays in the
    // channel as a permanent ellipsis next to a separate error message.
    let placeholder = null;

    // Build system prompt: base + pinned memories + knowledge context + action instructions
    let systemPrompt = aiSettings.systemPrompt || 'You are a helpful Discord bot assistant.';

    const userDoc = await User.findOne({ userId: message.author.id, guildId: message.guild.id }).lean();
    const pinnedMemories = userDoc?.pinnedMemories?.length ? userDoc.pinnedMemories : null;

    const { entries: kbEntries, isBackground: kbIsBackground } = await retrieveKnowledge(message.guild.id, content);
    if (kbEntries.length) {
        systemPrompt += buildKnowledgeContext(kbEntries);
    }
    if (aiSettings.actionsEnabled) {
        // Every provider can reach MCP servers now — Anthropic through its own
        // connector, the rest through the bot's MCP client — so this only asks
        // whether the provider supports them at all and whether any resolve
        // after the config file and the guild's list are merged.
        const mcpActive = Boolean(mcpMode(provider)) && resolveMcpServers(mcpServers).length > 0;
        systemPrompt += buildActionsAddendum(userDoc?.timezone, { mcpActive });
    }

    try {
        await message.channel.sendTyping();
        const { messages: rawHistory } = await loadHistory(
            message.guild.id, message.channel.id, message.author.id, maxHistory
        );

        // Prepend pinned memories as a user-context message so the model treats
        // them as reference information, not authoritative system instructions.
        const history = pinnedMemories
            ? [
                { role: 'user', content: `[My saved context for this conversation]\n${pinnedMemories.map(m => `- ${m.content}`).join('\n')}` },
                { role: 'assistant', content: 'Understood, I have noted your saved context.' },
                ...rawHistory
              ]
            : rawHistory;

        const usageOut = {};
        const callArgs = {
            provider, model, apiKey, baseUrl, systemPrompt, history,
            prompt: content, temperature, maxTokens, mcpServers,
            guildId: message.guild.id, usageOut,
            // Who the request is for, so the limit is enforced where the spend
            // happens rather than only in the peek above.
            rateLimit, userId: message.author.id, channelId: message.channel.id
        };

        let fullResponse = '';

        if (useStreaming) {
            placeholder = await message.reply('…');
            let lastEdit = 0;
            let currentMsg = placeholder;
            let currentBuf = '';
            const sentMessages = [placeholder]; // all Discord messages emitted during streaming

            // Keep the typing indicator alive for long generations
            const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), TYPING_REFRESH_INTERVAL_MS);

            try {
                await withRetry(async () => {
                    fullResponse = '';
                    currentBuf = '';
                    for await (const piece of streamCompletion(callArgs)) {
                        fullResponse += piece;
                        currentBuf += piece;
                        if (currentBuf.length >= DISCORD_MAX_LEN - 50) {
                            await currentMsg.edit(currentBuf.slice(0, DISCORD_MAX_LEN));
                            const overflow = currentBuf.slice(DISCORD_MAX_LEN);
                            currentMsg = await message.channel.send(overflow || '…');
                            sentMessages.push(currentMsg);
                            currentBuf = overflow;
                            lastEdit = Date.now();
                            continue;
                        }
                        const now = Date.now();
                        if (now - lastEdit >= STREAM_EDIT_INTERVAL_MS) {
                            await currentMsg.edit(currentBuf || '…').catch(() => {});
                            lastEdit = now;
                        }
                    }
                    if (currentBuf) await currentMsg.edit(currentBuf).catch(() => {});
                });
            } finally {
                clearInterval(typingInterval);
            }

            // Post-process: reconcile sentMessages against the canonical cleanText chunks
            if (aiSettings.actionsEnabled) {
                const { cleanText, action } = extractAction(fullResponse);
                if (action) {
                    // Derive the canonical chunks from cleanText so every sent message
                    // reflects exactly the visible response (no ACTION payload leaking out).
                    const canonicalChunks = cleanText.trim() ? chunkText(cleanText) : [];
                    for (let i = 0; i < sentMessages.length; i++) {
                        if (i < canonicalChunks.length) {
                            await sentMessages[i].edit(canonicalChunks[i]).catch(() => {});
                        } else {
                            // Extra messages that existed only to hold overflow or ACTION text
                            await sentMessages[i].delete().catch(() => {});
                        }
                    }
                    fullResponse = cleanText;
                    await executeAction(action, message);
                }
            }
        } else {
            let response = await withRetry(() => getCompletion(callArgs));
            response = response || '(empty response)';

            if (aiSettings.actionsEnabled) {
                const { cleanText, action } = extractAction(response);
                if (action) {
                    response = cleanText || '';
                    await executeAction(action, message);
                }
            }

            fullResponse = response;
            if (fullResponse.trim()) {
                const chunks = chunkText(fullResponse);
                await message.reply(chunks[0]);
                for (let i = 1; i < chunks.length; i++) {
                    await message.channel.send(chunks[i]);
                }
            }
        }

        if (fullResponse.trim()) {
            await appendHistory(
                message.guild.id, message.channel.id, message.author.id,
                content, fullResponse, maxHistory
            );
            if (kbEntries.length && !kbIsBackground) {
                const prefix = '📚 Sources: ';
                const limit = DISCORD_MAX_LEN - prefix.length - 10;
                let body = '';
                let omitted = 0;
                for (const entry of kbEntries) {
                    const title = entry.title.length > 80 ? entry.title.slice(0, 77) + '…' : entry.title;
                    const part = body ? `, ${title}` : title;
                    if (body.length + part.length > limit) { omitted++; continue; }
                    body += part;
                }
                if (omitted) body += ` (+${omitted} more)`;
                await message.channel.send(prefix + body).catch(err =>
                    console.error('[AI] citations footer send failed:', err?.message || err)
                );
            }
        }
    } catch (error) {
        // Reuse the streaming placeholder if one is already on screen, so the
        // failure replaces the "…" instead of leaving it dangling beside it.
        const report = async text => {
            if (placeholder) {
                const edited = await placeholder.edit(text).then(() => true).catch(() => false);
                if (edited) return;
            }
            await message.reply(text).catch(() => {});
        };

        // The peek above passed but somebody else took the last slot in between.
        if (error?.rateLimited) {
            await report(error.scope === 'channel'
                ? 'This channel has reached the AI request limit. Please wait before sending more AI requests here.'
                : `Rate limit reached (${error.limit} per ${error.windowMin}m). Please slow down.`);
            return;
        }
        console.error(`[AI:${provider}] error:`, error?.message || error);
        const status = error?.status || error?.response?.status;
        let detail = status ? ` (HTTP ${status})` : '';
        if (status === 401) detail += ' — check your API key';
        else if (status === 404) detail += ' — model not found; check your model name in the AI settings';
        else if (status === 429) detail += ' — rate limit exceeded';
        else if (status === 503) detail += ' — provider unavailable';
        await report(`Sorry, I hit an error talking to ${providerLabel}${detail}.`);
    }
}

module.exports = { handleAIChat };
