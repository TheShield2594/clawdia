const axios = require('axios');

function chatUrl(baseUrl) {
    return `${(baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;
}

function buildMessages({ systemPrompt, history, prompt }) {
    return [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
    ];
}

async function* stream({ baseUrl, model, systemPrompt, history, prompt, temperature, maxTokens, usageOut }) {
    const response = await axios.post(chatUrl(baseUrl), {
        model,
        messages: buildMessages({ systemPrompt, history, prompt }),
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
                if (json.done) {
                    if (usageOut) {
                        usageOut.usage = {
                            inputTokens: json.prompt_eval_count || 0,
                            outputTokens: json.eval_count || 0
                        };
                    }
                    return;
                }
            } catch { /* skip malformed line */ }
        }
    }
}

async function complete({ baseUrl, model, systemPrompt, history, prompt, temperature, maxTokens }) {
    const response = await axios.post(chatUrl(baseUrl), {
        model,
        messages: buildMessages({ systemPrompt, history, prompt }),
        stream: false,
        options: { temperature, num_predict: maxTokens }
    }, { timeout: 120000 });
    const text = response.data?.message?.content || '';
    const usage = (response.data?.prompt_eval_count != null || response.data?.eval_count != null) ? {
        inputTokens: response.data.prompt_eval_count || 0,
        outputTokens: response.data.eval_count || 0
    } : null;
    return { text, usage };
}

module.exports = {
    name: 'ollama',
    label: 'Ollama',
    defaultModel: 'llama3.2',
    // Local inference: no per-token cost.
    pricing: [{ match: /.*/, in: 0, out: 0 }],
    resolveAuth: aiSettings => ({
        baseUrl: aiSettings.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
    }),
    stream,
    complete
};
