const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const Conversation = require('../models/Conversation');

const DEFAULT_MODELS = {
    openai: 'gpt-4o-mini',
    gemini: 'gemini-1.5-flash',
    anthropic: 'claude-haiku-4-5-20251001',
    ollama: 'llama3.2',
    openrouter: 'openai/gpt-4o-mini'
};

const DISCORD_MAX_LEN = 2000;
const STREAM_EDIT_INTERVAL_MS = 1200;

// userId -> [timestamps] for sliding-window rate limiting (in-memory)
const rateLimits = new Map();

function checkRateLimit(userId, limit, windowMin) {
    if (!limit || limit <= 0) return true;
    const now = Date.now();
    const windowMs = (windowMin || 10) * 60 * 1000;
    const arr = (rateLimits.get(userId) || []).filter(t => now - t < windowMs);
    if (arr.length >= limit) {
        rateLimits.set(userId, arr);
        return false;
    }
    arr.push(now);
    rateLimits.set(userId, arr);
    return true;
}

async function loadHistory(guildId, channelId, userId, max) {
    if (!max || max <= 0) return { doc: null, messages: [] };
    const doc = await Conversation.findOne({ guildId, channelId, userId });
    if (!doc) return { doc: null, messages: [] };
    const msgs = doc.messages.slice(-max).map(m => ({ role: m.role, content: m.content }));
    return { doc, messages: msgs };
}

async function appendHistory(guildId, channelId, userId, userText, assistantText, max) {
    if (!max || max <= 0) return;
    let doc = await Conversation.findOne({ guildId, channelId, userId });
    if (!doc) {
        doc = new Conversation({ guildId, channelId, userId, messages: [] });
    }
    doc.messages.push({ role: 'user', content: userText });
    doc.messages.push({ role: 'assistant', content: assistantText });
    if (doc.messages.length > max * 2) {
        doc.messages = doc.messages.slice(-max * 2);
    }
    await doc.save();
}

async function clearHistory(guildId, channelId, userId) {
    await Conversation.deleteOne({ guildId, channelId, userId });
}

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

// ---------- Provider implementations ----------

async function* streamOpenAI({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, baseURL, defaultHeaders }) {
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
    ];
    const stream = await client.chat.completions.create({
        model, messages, temperature, max_tokens: maxTokens, stream: true
    });
    for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
    }
}

async function callOpenAINonStream({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, baseURL, defaultHeaders }) {
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
    ];
    const completion = await client.chat.completions.create({
        model, messages, temperature, max_tokens: maxTokens
    });
    return completion.choices[0].message.content || '';
}

async function* streamGemini({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens }) {
    const client = new GoogleGenerativeAI(apiKey);
    const generative = client.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
        generationConfig: { temperature, maxOutputTokens: maxTokens }
    });
    const chat = generative.startChat({
        history: history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
        }))
    });
    const result = await chat.sendMessageStream(prompt);
    for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
    }
}

async function callGeminiNonStream(args) {
    let out = '';
    for await (const piece of streamGemini(args)) out += piece;
    return out;
}

async function* streamAnthropic({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens }) {
    const client = new Anthropic({ apiKey });
    const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: prompt }
    ];
    const stream = await client.messages.stream({
        model,
        max_tokens: maxTokens,
        temperature,
        system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ],
        messages
    });
    for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield event.delta.text;
        }
    }
}

async function callAnthropicNonStream(args) {
    let out = '';
    for await (const piece of streamAnthropic(args)) out += piece;
    return out;
}

async function* streamOllama({ baseUrl, model, systemPrompt, history, prompt, temperature, maxTokens }) {
    const url = `${(baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
    ];
    const response = await axios.post(url, {
        model,
        messages,
        stream: true,
        options: { temperature, num_predict: maxTokens }
    }, { responseType: 'stream', timeout: 120000 });

    let buf = '';
    for await (const chunk of response.data) {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const json = JSON.parse(line);
                if (json.message?.content) yield json.message.content;
                if (json.done) return;
            } catch { /* skip malformed line */ }
        }
    }
}

async function callOllamaNonStream(args) {
    let out = '';
    for await (const piece of streamOllama(args)) out += piece;
    return out;
}

// OpenRouter is OpenAI-compatible
function openRouterArgs(base) {
    return {
        ...base,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
            'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/theshield2594/ultrabot',
            'X-Title': 'Ultrabot'
        }
    };
}

// ---------- Public API ----------

function resolveProviderConfig(aiSettings) {
    const provider = aiSettings.provider || 'openai';
    const model = aiSettings.model || DEFAULT_MODELS[provider];
    const temperature = aiSettings.temperature ?? 0.7;
    const maxTokens = aiSettings.maxTokens ?? 1024;

    let apiKey = null;
    let baseUrl = null;

    switch (provider) {
        case 'openai':
            apiKey = aiSettings.openaiKey || process.env.OPENAI_API_KEY;
            break;
        case 'gemini':
            apiKey = aiSettings.geminiKey || process.env.GEMINI_API_KEY;
            break;
        case 'anthropic':
            apiKey = aiSettings.anthropicKey || process.env.ANTHROPIC_API_KEY;
            break;
        case 'openrouter':
            apiKey = aiSettings.openrouterKey || process.env.OPENROUTER_API_KEY;
            break;
        case 'ollama':
            baseUrl = aiSettings.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
            break;
    }

    return { provider, model, temperature, maxTokens, apiKey, baseUrl };
}

async function* streamCompletion({ provider, model, apiKey, baseUrl, systemPrompt, history, prompt, temperature, maxTokens }) {
    const common = { model, systemPrompt, history, prompt, temperature, maxTokens };
    if (provider === 'openai') {
        yield* streamOpenAI({ apiKey, ...common });
    } else if (provider === 'gemini') {
        yield* streamGemini({ apiKey, ...common });
    } else if (provider === 'anthropic') {
        yield* streamAnthropic({ apiKey, ...common });
    } else if (provider === 'ollama') {
        yield* streamOllama({ baseUrl, ...common });
    } else if (provider === 'openrouter') {
        yield* streamOpenAI(openRouterArgs({ apiKey, ...common }));
    } else {
        throw new Error(`Unknown provider: ${provider}`);
    }
}

async function getCompletion({ provider, model, apiKey, baseUrl, systemPrompt, history, prompt, temperature, maxTokens }) {
    const common = { model, systemPrompt, history, prompt, temperature, maxTokens };
    if (provider === 'openai') return callOpenAINonStream({ apiKey, ...common });
    if (provider === 'gemini') return callGeminiNonStream({ apiKey, ...common });
    if (provider === 'anthropic') return callAnthropicNonStream({ apiKey, ...common });
    if (provider === 'ollama') return callOllamaNonStream({ baseUrl, ...common });
    if (provider === 'openrouter') return callOpenAINonStream(openRouterArgs({ apiKey, ...common }));
    throw new Error(`Unknown provider: ${provider}`);
}

async function handleAIChat(message, aiSettings) {
    const { provider, model, temperature, maxTokens, apiKey, baseUrl } = resolveProviderConfig(aiSettings);
    const providerLabel = {
        openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude',
        ollama: 'Ollama', openrouter: 'OpenRouter'
    }[provider] || provider;

    if (provider !== 'ollama' && !apiKey) {
        return message.reply(`${providerLabel} is not configured. Add an API key in the dashboard.`);
    }

    const content = message.content.trim();
    if (content.toLowerCase() === '!reset') {
        await clearHistory(message.guild.id, message.channel.id, message.author.id);
        return message.reply('Conversation history cleared.');
    }

    if (!checkRateLimit(message.author.id, aiSettings.rateLimitPerUser, aiSettings.rateLimitWindowMin)) {
        return message.reply(`Rate limit reached (${aiSettings.rateLimitPerUser} per ${aiSettings.rateLimitWindowMin}m). Please slow down.`);
    }

    const systemPrompt = aiSettings.systemPrompt || 'You are a helpful Discord bot assistant.';
    const maxHistory = aiSettings.maxHistory ?? 20;
    const useStreaming = aiSettings.streaming !== false;

    try {
        await message.channel.sendTyping();
        const { messages: history } = await loadHistory(
            message.guild.id, message.channel.id, message.author.id, maxHistory
        );

        const callArgs = { provider, model, apiKey, baseUrl, systemPrompt, history, prompt: content, temperature, maxTokens };

        let fullResponse = '';

        if (useStreaming) {
            const placeholder = await message.reply('…');
            let lastEdit = 0;
            let currentMsg = placeholder;
            let currentBuf = '';

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
        } else {
            const response = await withRetry(() => getCompletion(callArgs));
            fullResponse = response || '(empty response)';
            const chunks = chunkText(fullResponse);
            await message.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
                await message.channel.send(chunks[i]);
            }
        }

        if (fullResponse.trim()) {
            await appendHistory(
                message.guild.id, message.channel.id, message.author.id,
                content, fullResponse, maxHistory
            );
        }
    } catch (error) {
        console.error(`[AI:${provider}] error:`, error?.message || error);
        const detail = error?.status ? ` (HTTP ${error.status})` : '';
        await message.reply(`Sorry, I hit an error talking to ${providerLabel}${detail}.`).catch(() => {});
    }
}

module.exports = {
    handleAIChat,
    clearHistory,
    getCompletion,
    streamCompletion,
    resolveProviderConfig,
    DEFAULT_MODELS
};
