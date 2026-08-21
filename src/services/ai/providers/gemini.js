const { GoogleGenerativeAI } = require('@google/generative-ai');

const PRICING = [
    { match: /flash-lite/i, in: 0.075, out: 0.30 },
    { match: /2\.0-flash/i, in: 0.10,  out: 0.40 },
    { match: /1\.5-flash/i, in: 0.075, out: 0.30 },
    { match: /1\.5-pro/i,   in: 1.25,  out: 5.00 },
    { match: /pro/i,        in: 1.25,  out: 5.00 },
    { match: /flash/i,      in: 0.10,  out: 0.40 }
];

function startChat({ apiKey, model, systemPrompt, history, temperature, maxTokens }) {
    const client = new GoogleGenerativeAI(apiKey);
    const generative = client.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
        generationConfig: { temperature, maxOutputTokens: maxTokens }
    });
    return generative.startChat({
        history: history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
        }))
    });
}

async function* stream(req) {
    const chat = startChat(req);
    const result = await chat.sendMessageStream(req.prompt);
    for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
    }
    if (req.usageOut) {
        try {
            const final = await result.response;
            const meta = final?.usageMetadata;
            if (meta) {
                req.usageOut.usage = {
                    inputTokens: meta.promptTokenCount || 0,
                    outputTokens: meta.candidatesTokenCount || 0
                };
            }
        } catch { /* usage metadata unavailable — leave unset */ }
    }
}

async function complete(req) {
    const chat = startChat(req);
    const result = await chat.sendMessage(req.prompt);
    const text = result.response.text();
    const meta = result.response.usageMetadata;
    const usage = meta ? {
        inputTokens: meta.promptTokenCount || 0,
        outputTokens: meta.candidatesTokenCount || 0
    } : null;
    return { text, usage };
}

module.exports = {
    name: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-2.0-flash',
    pricing: PRICING,
    resolveAuth: aiSettings => ({ apiKey: aiSettings.geminiKey || process.env.GEMINI_API_KEY }),
    stream,
    complete
};
