const axios = require('axios');
const { guardedAgents, assertPublicHttpUrl } = require('../../../utils/outboundGuard');

// The endpoint the *operator* runs, from the environment or the shipped default.
// A guild's `ai.ollamaBaseUrl` is a dashboard setting, so it is attacker input
// the moment one guild admin is untrusted; this is not. The two localhost forms
// are both listed because the shipped default is one of them and an operator
// who types the other means the same machine.
const OPERATOR_DEFAULT = 'http://localhost:11434';
const LOCAL_ALIASES = ['http://localhost:11434', 'http://127.0.0.1:11434'];

// Trailing slashes only; anything else is compared verbatim, so "the operator's
// endpoint" means exactly that and not "any path on that host".
function normalize(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function operatorEndpoints() {
    const configured = normalize(process.env.OLLAMA_BASE_URL);
    return new Set(configured ? [configured, ...LOCAL_ALIASES] : LOCAL_ALIASES);
}

/**
 * Where this request may go, and how it is allowed to get there (#559).
 *
 * `ai` is a whitelisted settings parent, so any guild admin can write
 * `ai.ollamaBaseUrl`, and it used to reach `axios.post` unexamined — with the
 * response echoed back into a Discord channel. From inside the container that
 * reaches the metadata service, the Mongo host on the compose network, and
 * anything else the bot can see: a read primitive against the operator's own
 * infrastructure, driven from a settings field and rendered as a chat reply.
 *
 * Requests to the operator's own endpoint are made as they always were — it is
 * the operator's machine, usually localhost, and the whole point of the
 * provider. Any *other* base URL is somebody's configuration, so it must be a
 * plain http(s) URL, it must not be a literal private address, and it is
 * dialled through agents that refuse to open a socket to private or reserved
 * space. Those checks sit where the connection is made, so they also cover a
 * hostname that resolves privately only sometimes, and every hop of any
 * redirect axios follows.
 */
function resolveEndpoint(baseUrl) {
    const configured = normalize(baseUrl) || OPERATOR_DEFAULT;
    const url = `${configured}/api/chat`;

    if (operatorEndpoints().has(configured)) return { url, agents: {} };

    assertPublicHttpUrl(configured, 'ai.ollamaBaseUrl');
    return { url, agents: guardedAgents() };
}

function buildMessages({ systemPrompt, history, prompt }) {
    return [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
    ];
}

async function* stream({ baseUrl, model, systemPrompt, history, prompt, temperature, maxTokens, usageOut }) {
    const { url, agents } = resolveEndpoint(baseUrl);
    const response = await axios.post(url, {
        model,
        messages: buildMessages({ systemPrompt, history, prompt }),
        stream: true,
        options: { temperature, num_predict: maxTokens }
    }, { responseType: 'stream', timeout: 120000, ...agents });

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
    const { url, agents } = resolveEndpoint(baseUrl);
    const response = await axios.post(url, {
        model,
        messages: buildMessages({ systemPrompt, history, prompt }),
        stream: false,
        options: { temperature, num_predict: maxTokens }
    }, { timeout: 120000, ...agents });
    const text = response.data?.message?.content || '';
    const usage = (response.data?.prompt_eval_count != null || response.data?.eval_count != null) ? {
        inputTokens: response.data.prompt_eval_count || 0,
        outputTokens: response.data.eval_count || 0
    } : null;
    return { text, usage };
}

/**
 * The same policy, phrased for the dashboard: an error string, or null when the
 * value is one this provider would accept. Settings validation calls this
 * rather than re-deriving the rule, so what the form accepts and what the
 * request path allows cannot drift — including the operator's own endpoint,
 * which is legitimate however private its address is.
 */
function validateBaseUrl(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string') return 'ai.ollamaBaseUrl must be a string';
    try {
        resolveEndpoint(raw);
        return null;
    } catch (err) {
        return err.message;
    }
}

module.exports = {
    name: 'ollama',
    label: 'Ollama',
    defaultModel: 'llama3.2',
    // Local inference: no per-token cost.
    pricing: [{ match: /.*/, in: 0, out: 0 }],
    resolveAuth: aiSettings => ({
        baseUrl: aiSettings.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || OPERATOR_DEFAULT
    }),
    stream,
    complete,
    // Exported for settings validation, and for the tests that assert which
    // endpoints are dialled directly and which are forced through the guard.
    resolveEndpoint,
    validateBaseUrl
};
