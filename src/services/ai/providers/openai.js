const OpenAI = require('openai');
const { decryptSecret } = require('../../../config/secretBox');
const { toolkitFor, mapWithLimit, MAX_TOOL_ROUNDS, MAX_PARALLEL_TOOL_CALLS } = require('../mcp/toolkit');

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

// MCP tools, in the shape the chat completions API takes. The toolkit has
// already done the work that is the same for every provider — discovery,
// filtering, one unambiguous name per tool — so this is a rename.
function toolParams(toolkit) {
    return toolkit.definitions.map(def => ({
        type: 'function',
        function: {
            name: def.name,
            description: def.description,
            parameters: def.inputSchema
        }
    }));
}

function usageOf(raw) {
    if (!raw) return null;
    return {
        inputTokens: raw.prompt_tokens || 0,
        outputTokens: raw.completion_tokens || 0
    };
}

// A tool-calling turn is one request per round, so the totals the guild is
// billed for are the sum. Within a round the last usage report wins, because
// some OpenAI-compatible endpoints send a running total rather than a final one.
function addUsage(totals, round) {
    if (!round) return;
    totals.inputTokens += round.inputTokens;
    totals.outputTokens += round.outputTokens;
}

// Streamed tool calls arrive as fragments keyed by index: the name in one
// delta, the arguments a few characters at a time across the next several.
function accumulateToolCalls(pending, deltas) {
    for (const delta of deltas || []) {
        const index = delta.index ?? pending.size;
        const slot = pending.get(index) || { id: '', name: '', args: '' };
        if (delta.id) slot.id = delta.id;
        if (delta.function?.name) slot.name += delta.function.name;
        if (delta.function?.arguments) slot.args += delta.function.arguments;
        pending.set(index, slot);
    }
}

function toolCallsOf(message) {
    return (message?.tool_calls || []).map((call, index) => ({
        id: call.id || `call_${index}`,
        name: call.function?.name || '',
        args: call.function?.arguments || ''
    }));
}

/**
 * Append the model's tool calls and their results to the conversation.
 *
 * The calls in one round are independent of each other — the model asked for
 * all of them before seeing any answer — so they run concurrently and the round
 * costs the slowest of them rather than the sum. The results still go back in
 * the order they were asked for, because that is the order the assistant
 * message above lists them in.
 *
 * Arguments that do not parse are handed back as the error rather than dropped:
 * a model that emitted truncated JSON can see what it sent and try again, and
 * the alternative is a turn that silently loses a tool call.
 */
async function runToolCalls({ toolkit, messages, calls, content }) {
    messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.args || '{}' }
        }))
    });

    const results = await mapWithLimit(calls, MAX_PARALLEL_TOOL_CALLS, async call => {
        let args;
        try {
            args = call.args ? JSON.parse(call.args) : {};
        } catch {
            return `Those arguments were not valid JSON, so the tool was not run: ${call.args}`;
        }
        return toolkit.call(call.name, args);
    });

    calls.forEach((call, index) => {
        messages.push({ role: 'tool', tool_call_id: call.id, content: results[index] });
    });
}

async function* stream({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, baseURL, defaultHeaders, usageOut, useMcp = true, mcpServers, onToolEvent, mcpConfirm, confirmTool, toolBudget }) {
    const toolkit = await toolkitFor({ useMcp, mcpServers, onToolEvent, mcpConfirm, confirmTool, toolBudget });
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const messages = buildMessages({ systemPrompt, history, prompt });

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    // A round that calls tools often says something first — "let me look that
    // up" — and the answer arrives in the round after it. Two pieces of prose,
    // so a blank line goes between them rather than the second sentence running
    // into the first.
    let wroteText = false;

    for (let round = 0; ; round++) {
        // On the last permitted round the tools are withheld, which leaves the
        // model nothing to do but answer. Without that a turn could end on a
        // tool call, and the user would get an empty message.
        const offerTools = Boolean(toolkit) && round < MAX_TOOL_ROUNDS;

        const response = await client.chat.completions.create({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            ...(offerTools ? { tools: toolParams(toolkit) } : {})
        });

        let content = '';
        let roundUsage = null;
        const pending = new Map();

        for await (const chunk of response) {
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
                if (!content && wroteText) yield '\n\n';
                content += delta.content;
                wroteText = true;
                yield delta.content;
            }
            if (delta?.tool_calls) accumulateToolCalls(pending, delta.tool_calls);
            if (chunk.usage) {
                sawUsage = true;
                roundUsage = usageOf(chunk.usage);
            }
        }
        addUsage(totals, roundUsage);

        const calls = [...pending.values()].filter(call => call.name);
        // No tools offered means no more rounds: whatever this one produced is
        // the answer, even if the model tried to call something anyway.
        if (!calls.length || !offerTools) break;
        await runToolCalls({ toolkit, messages, calls, content });
    }

    if (usageOut && sawUsage) usageOut.usage = totals;
}

async function complete({ apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, baseURL, defaultHeaders, useMcp = true, mcpServers, onToolEvent, mcpConfirm, confirmTool, toolBudget }) {
    const toolkit = await toolkitFor({ useMcp, mcpServers, onToolEvent, mcpConfirm, confirmTool, toolBudget });
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const messages = buildMessages({ systemPrompt, history, prompt });

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    const parts = [];

    for (let round = 0; ; round++) {
        const offerTools = Boolean(toolkit) && round < MAX_TOOL_ROUNDS;

        const completion = await client.chat.completions.create({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(offerTools ? { tools: toolParams(toolkit) } : {})
        });

        if (completion.usage) {
            sawUsage = true;
            addUsage(totals, usageOf(completion.usage));
        }

        const message = completion.choices?.[0]?.message;
        const content = message?.content || '';
        if (content) parts.push(content);
        const calls = toolCallsOf(message).filter(call => call.name);

        // Text emitted alongside a tool call is a preamble ("let me look that
        // up"); the answer is the round that stops calling tools — or the last
        // round, where none were offered to call. The preamble is kept rather
        // than dropped, so a guild with streaming off reads the same reply a
        // guild with it on watched arrive.
        if (!calls.length || !offerTools) {
            return { text: parts.join('\n\n'), usage: sawUsage ? totals : null };
        }
        await runToolCalls({ toolkit, messages, calls, content });
    }
}

module.exports = {
    name: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    pricing: PRICING,
    // MCP works here through the bot's own client: the tools are discovered,
    // offered to the model as functions, and called from the loop above.
    mcp: 'client',
    resolveAuth: aiSettings => ({ apiKey: decryptSecret(aiSettings.openaiKey) || process.env.OPENAI_API_KEY }),
    stream,
    complete
};
