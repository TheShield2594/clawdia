const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let openai;
let genAI;

if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
}

if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

async function getChatCompletion(prompt, systemPrompt = 'You are a helpful Discord bot assistant.', provider = 'openai', apiKey = null) {
    if (provider === 'openai') {
        const client = apiKey ? new OpenAI({ apiKey }) : openai;
        
        if (!client) {
            throw new Error('OpenAI API key not configured');
        }

        const completion = await client.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        return completion.choices[0].message.content;
    } else if (provider === 'gemini') {
        const client = apiKey ? new GoogleGenerativeAI(apiKey) : genAI;
        
        if (!client) {
            throw new Error('Gemini API key not configured');
        }

        const model = client.getGenerativeModel({ model: 'gemini-pro' });
        const fullPrompt = `${systemPrompt}\n\nUser: ${prompt}`;
        
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        return response.text();
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

    try {
        await message.channel.sendTyping();
        
        const response = await getChatCompletion(message.content, systemPrompt, provider, apiKey);
        
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

module.exports = { getChatCompletion, handleAIChat };