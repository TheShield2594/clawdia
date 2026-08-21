const User = require('../../models/User');
const { resolveMcpServers } = require('../../config/mcpServers');
const { providers } = require('./providers');
const { resolveProviderConfig, streamCompletion, getCompletion } = require('./index');
const { retrieveKnowledge, buildKnowledgeContext } = require('./knowledge');
const { loadHistory, appendHistory, clearHistory } = require('./history');
const { checkRateLimit, checkChannelRateLimit } = require('./rateLimit');
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
    const { provider, model, temperature, maxTokens, apiKey, baseUrl, mcpServers } = resolveProviderConfig(aiSettings);
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

    if (!checkRateLimit(message.author.id, aiSettings.rateLimitPerUser, aiSettings.rateLimitWindowMin)) {
        return message.reply(`Rate limit reached (${aiSettings.rateLimitPerUser} per ${aiSettings.rateLimitWindowMin}m). Please slow down.`);
    }

    if (!checkChannelRateLimit(message.channel.id, aiSettings.rateLimitPerChannel, aiSettings.rateLimitWindowMin)) {
        return message.reply(`This channel has reached the AI request limit. Please wait before sending more AI requests here.`);
    }

    const maxHistory = aiSettings.maxHistory ?? 20;
    const useStreaming = aiSettings.streaming !== false;

    // Build system prompt: base + pinned memories + knowledge context + action instructions
    let systemPrompt = aiSettings.systemPrompt || 'You are a helpful Discord bot assistant.';

    const userDoc = await User.findOne({ userId: message.author.id, guildId: message.guild.id }).lean();
    const pinnedMemories = userDoc?.pinnedMemories?.length ? userDoc.pinnedMemories : null;

    const { entries: kbEntries, isBackground: kbIsBackground } = await retrieveKnowledge(message.guild.id, content);
    if (kbEntries.length) {
        systemPrompt += buildKnowledgeContext(kbEntries);
    }
    if (aiSettings.actionsEnabled) {
        // Only Anthropic requests carry MCP servers, and only if any resolve
        // after the config file and the guild's list are merged.
        const mcpActive = provider === 'anthropic' && resolveMcpServers(mcpServers).length > 0;
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
            guildId: message.guild.id, usageOut
        };

        let fullResponse = '';

        if (useStreaming) {
            const placeholder = await message.reply('…');
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
        console.error(`[AI:${provider}] error:`, error?.message || error);
        const status = error?.status || error?.response?.status;
        let detail = status ? ` (HTTP ${status})` : '';
        if (status === 401) detail += ' — check your API key';
        else if (status === 404) detail += ' — model not found; check your model name in the AI settings';
        else if (status === 429) detail += ' — rate limit exceeded';
        else if (status === 503) detail += ' — provider unavailable';
        await message.reply(`Sorry, I hit an error talking to ${providerLabel}${detail}.`).catch(() => {});
    }
}

module.exports = { handleAIChat };
