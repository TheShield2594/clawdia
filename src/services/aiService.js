const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let openai;
let genAI;

if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// channelId -> Map<userId, Array<{role, content}>>
const conversationHistory = new Map();
const MAX_HISTORY = 20;

function getHistory(channelId, userId) {
    if (!conversationHistory.has(channelId)) conversationHistory.set(channelId, new Map());
    const channelMap = conversationHistory.get(channelId);
    if (!channelMap.has(userId)) channelMap.set(userId, []);
    return channelMap.get(userId);
}

function appendHistory(channelId, userId, role, content) {
    const history = getHistory(channelId, userId);
    history.push({ role, content });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

function clearHistory(channelId, userId) {
    conversationHistory.get(channelId)?.delete(userId);
}

async function getChatCompletion(prompt, systemPrompt = 'You are a helpful Discord bot assistant.', provider = 'openai', apiKey = null, history = []) {
    if (provider === 'openai') {
        const client = apiKey ? new OpenAI({ apiKey }) : openai;

        if (!client) throw new Error('OpenAI API key not configured');

        const messages = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: prompt }
        ];

        const completion = await client.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages,
            max_tokens: 500,
            temperature: 0.7
        });

        return completion.choices[0].message.content;

    } else if (provider === 'gemini') {
        const client = apiKey ? new GoogleGenerativeAI(apiKey) : genAI;

        if (!client) throw new Error('Gemini API key not configured');

        const model = client.getGenerativeModel({ model: 'gemini-pro' });

        const historyForGemini = history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
        }));

        const chat = model.startChat({
            history: [
                { role: 'user', parts: [{ text: systemPrompt }] },
                { role: 'model', parts: [{ text: 'Understood. I will follow those instructions.' }] },
                ...historyForGemini
            ]
        });

        const result = await chat.sendMessage(prompt);
        return result.response.text();

    } else {
        throw new Error('Invalid AI provider specified');
    }
}

async function handleAIChat(message, systemPrompt, provider = 'openai', apiKey = null) {
    const providerName = provider === 'openai' ? 'OpenAI' : 'Gemini';

    if (provider === 'openai' && !openai && !apiKey) {
        return message.reply('OpenAI is not configured. Please add your OpenAI API key in the dashboard.');
    }

    if (provider === 'gemini' && !genAI && !apiKey) {
        return message.reply('Gemini is not configured. Please add your Gemini API key in the dashboard.');
    }

    if (message.content.trim().toLowerCase() === '!reset') {
        clearHistory(message.channel.id, message.author.id);
        return message.reply('Conversation history cleared!');
    }

    const history = getHistory(message.channel.id, message.author.id);

    try {
        await message.channel.sendTyping();

        const response = await getChatCompletion(message.content, systemPrompt, provider, apiKey, history);

        appendHistory(message.channel.id, message.author.id, 'user', message.content);
        appendHistory(message.channel.id, message.author.id, 'assistant', response);

        if (response.length > 2000) {
            await message.reply(response.substring(0, 1997) + '...');
        } else {
            await message.reply(response);
        }
    } catch (error) {
        console.error(`${providerName} chat error:`, error);
        await message.reply(`Sorry, I encountered an error processing your message with ${providerName}.`);
    }
}

module.exports = { getChatCompletion, handleAIChat, clearHistory };
