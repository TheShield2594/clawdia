const Anthropic = require('@anthropic-ai/sdk');
const { buildAnthropicMcpParams, MCP_BETA } = require('../../../config/mcpServers');

// The MCP connector is Anthropic-specific: Claude opens the connection to each
// configured server itself, so there is no client-side tool loop here. The
// server list comes from the config file read by src/config/mcpServers.js —
// nothing about it is hardcoded, and with no config file present these helpers
// send exactly the request they always did.

const PRICING = [
    { match: /haiku-4/i,    in: 1.00,  out: 5.00 },
    { match: /sonnet-4/i,   in: 3.00,  out: 15.00 },
    { match: /opus-4/i,     in: 15.00, out: 75.00 },
    { match: /haiku-3-5/i,  in: 0.80,  out: 4.00 },
    { match: /sonnet-3-5/i, in: 3.00,  out: 15.00 },
    { match: /haiku/i,      in: 0.25,  out: 1.25 },
    { match: /sonnet/i,     in: 3.00,  out: 15.00 },
    { match: /opus/i,       in: 15.00, out: 75.00 }
];

// A turn that calls MCP tools can run long enough that the API hands back a
// partial response with stop_reason "pause_turn"; passing that content straight
// back resumes the same turn. Bounded so a slow or looping server cannot keep
// one Discord message generating forever.
const MAX_PAUSE_TURN_CONTINUATIONS = 3;

function baseRequest({ model, systemPrompt, temperature, maxTokens }) {
    return {
        model,
        max_tokens: maxTokens,
        temperature,
        system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ]
    };
}

// mcp_servers and the matching mcp_toolset entries are two halves of one
// feature — the API rejects either on its own — so they are added together or
// not at all, along with the beta flag that gates the connector. The connector
// lives on the beta endpoint, so requests without MCP stay on the plain one.
function mcpExtras(useMcp, guildServers) {
    if (!useMcp) return { params: {}, beta: false };
    const mcp = buildAnthropicMcpParams(guildServers);
    if (!mcp) return { params: {}, beta: false };
    return {
        params: { mcp_servers: mcp.mcp_servers, tools: mcp.tools, betas: [MCP_BETA] },
        beta: true
    };
}

function messagesApi(client, beta) {
    return beta ? client.beta.messages : client.messages;
}

// Responses that used MCP tools also carry mcp_tool_use / mcp_tool_result
// blocks; only the text belongs in a Discord message.
function textOf(content) {
    return (content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
}

function buildMessages(history, prompt) {
    return [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: prompt }
    ];
}

async function* stream({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, usageOut, useMcp = true, mcpServers }) {
    const client = new Anthropic({ apiKey });
    let messages = buildMessages(history, prompt);
    const base = baseRequest({ model, systemPrompt, temperature, maxTokens });
    const { params, beta } = mcpExtras(useMcp, mcpServers);
    const api = messagesApi(client, beta);

    let inputTokens = 0;
    let outputTokens = 0;

    for (let turn = 0; ; turn++) {
        const response = await api.stream({ ...base, ...params, messages });
        let turnOutput = 0;
        for await (const event of response) {
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                yield event.delta.text;
            } else if (event.type === 'message_start' && event.message?.usage) {
                inputTokens += event.message.usage.input_tokens || 0;
                turnOutput = event.message.usage.output_tokens || 0;
            } else if (event.type === 'message_delta' && event.usage) {
                // Final cumulative output_tokens arrive in message_delta
                turnOutput = event.usage.output_tokens || turnOutput;
            }
        }
        outputTokens += turnOutput;

        const final = await response.finalMessage();
        if (final.stop_reason !== 'pause_turn') break;
        if (turn >= MAX_PAUSE_TURN_CONTINUATIONS) {
            console.warn(`[AI:anthropic] still paused after ${MAX_PAUSE_TURN_CONTINUATIONS} continuations — returning the partial answer`);
            break;
        }
        messages = [...messages, { role: 'assistant', content: final.content }];
    }

    if (usageOut) usageOut.usage = { inputTokens, outputTokens };
}

async function complete({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, useMcp = true, mcpServers }) {
    const client = new Anthropic({ apiKey });
    let messages = buildMessages(history, prompt);
    const base = baseRequest({ model, systemPrompt, temperature, maxTokens });
    const { params, beta } = mcpExtras(useMcp, mcpServers);
    const api = messagesApi(client, beta);

    const parts = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;

    for (let turn = 0; ; turn++) {
        const response = await api.create({ ...base, ...params, messages });
        parts.push(textOf(response.content));
        if (response.usage) {
            sawUsage = true;
            inputTokens += response.usage.input_tokens || 0;
            outputTokens += response.usage.output_tokens || 0;
        }

        if (response.stop_reason !== 'pause_turn') break;
        if (turn >= MAX_PAUSE_TURN_CONTINUATIONS) {
            console.warn(`[AI:anthropic] still paused after ${MAX_PAUSE_TURN_CONTINUATIONS} continuations — returning the partial answer`);
            break;
        }
        messages = [...messages, { role: 'assistant', content: response.content }];
    }

    return {
        text: parts.join(''),
        usage: sawUsage ? { inputTokens, outputTokens } : null
    };
}

module.exports = {
    name: 'anthropic',
    label: 'Claude',
    defaultModel: 'claude-haiku-4-5',
    pricing: PRICING,
    resolveAuth: aiSettings => ({ apiKey: aiSettings.anthropicKey || process.env.ANTHROPIC_API_KEY }),
    stream,
    complete
};
