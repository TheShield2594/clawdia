const OpenAI = require('openai');

// USD per 1M tokens (input, output). Prefix-matched; unknown models report
// null cost via ai/usage.js.
const PRICING = [
    { match: /^gpt-4o-mini/i,   in: 0.15,  out: 0.60 },
    { match: /^gpt-4o/i,        in: 2.50,  out: 10.00 },
    { match: /^gpt-4\.1-mini/i, in: 0.40,  out: 1.60 },
    { match: /^gpt-4\.1-nano/i, in: 0.10,  out: 0.40 },
    { match: /^gpt-4\.1/i,      in: 2.00,  out: 8.00 },
    { match: /^o3-mini/i,       in: 1.10,  out: 4.40 },
    { match: /^o3/i,            in: 2.00,  out: 8.00 },
    { match: /^o1-mini/i,       in: 1.10,  out: 4.40 },
    { match: /^o1/i,            in: 15.00, out: 60.00 }
];

function buildMessages({ systemPrompt, history, prompt }) {
    return [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
    ];
}

async function* stream({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, baseURL, defaultHeaders, usageOut }) {
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const response = await client.chat.completions.create({
        model,
        messages: buildMessages({ systemPrompt, history, prompt }),
        temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true }
    });
    for await (const chunk of response) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
        if (usageOut && chunk.usage) {
            usageOut.usage = {
                inputTokens: chunk.usage.prompt_tokens || 0,
                outputTokens: chunk.usage.completion_tokens || 0
            };
        }
    }
}

async function complete({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, baseURL, defaultHeaders }) {
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const completion = await client.chat.completions.create({
        model,
        messages: buildMessages({ systemPrompt, history, prompt }),
        temperature,
        max_tokens: maxTokens
    });
    const text = completion.choices[0].message.content || '';
    const usage = completion.usage ? {
        inputTokens: completion.usage.prompt_tokens || 0,
        outputTokens: completion.usage.completion_tokens || 0
    } : null;
    return { text, usage };
}

module.exports = {
    name: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    pricing: PRICING,
    resolveAuth: aiSettings => ({ apiKey: aiSettings.openaiKey || process.env.OPENAI_API_KEY }),
    stream,
    complete
};
