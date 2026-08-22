const { GoogleGenAI } = require('@google/genai');

// Google's current SDK. It replaces `@google/generative-ai`, which Google
// retired in favour of this one — that package still installs but no longer
// gets model or API updates, so a new Gemini model would arrive here unusable.
//
// The shapes that changed, since they are the whole of the diff:
//   new GoogleGenerativeAI(key)          → new GoogleGenAI({ apiKey })
//   client.getGenerativeModel().startChat → client.chats.create()
//   generationConfig / systemInstruction  → one `config` block
//   response.text()                       → response.text (a getter)
//   result.stream                         → the awaited return value itself
//   usage after the stream, via .response → usageMetadata on the chunks

const PRICING = [
    { match: /flash-lite/i, in: 0.075, out: 0.30 },
    { match: /2\.0-flash/i, in: 0.10,  out: 0.40 },
    { match: /1\.5-flash/i, in: 0.075, out: 0.30 },
    { match: /1\.5-pro/i,   in: 1.25,  out: 5.00 },
    { match: /pro/i,        in: 1.25,  out: 5.00 },
    { match: /flash/i,      in: 0.10,  out: 0.40 }
];

function startChat({ apiKey, model, systemPrompt, history, temperature, maxTokens }) {
    const client = new GoogleGenAI({ apiKey });
    return client.chats.create({
        model,
        config: {
            systemInstruction: systemPrompt,
            temperature,
            maxOutputTokens: maxTokens
        },
        history: history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
        }))
    });
}

function usageOf(meta) {
    if (!meta) return null;
    return {
        inputTokens: meta.promptTokenCount || 0,
        outputTokens: meta.candidatesTokenCount || 0
    };
}

async function* stream(req) {
    const chat = startChat(req);
    const result = await chat.sendMessageStream({ message: req.prompt });

    // Usage now rides on the chunks rather than on a separate response object
    // awaited after the stream. Each chunk that carries it carries the running
    // total, so the last one seen is the total for the turn.
    let lastUsage = null;
    for await (const chunk of result) {
        if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
        const text = chunk.text;
        if (text) yield text;
    }

    if (req.usageOut && lastUsage) {
        req.usageOut.usage = usageOf(lastUsage);
    }
}

async function complete(req) {
    const chat = startChat(req);
    const response = await chat.sendMessage({ message: req.prompt });
    // `.text` is undefined when the model returned no text part at all — a
    // safety block, or a response that was only tool calls.
    return { text: response.text ?? '', usage: usageOf(response.usageMetadata) };
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
