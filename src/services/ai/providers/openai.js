const OpenAI = require('openai');
const { decryptSecret } = require('../../../config/secretBox');
const { toolkitFor, mapWithLimit, roundsFor, MAX_PARALLEL_TOOL_CALLS } = require('../mcp/toolkit');
const { dataUrl } = require('../vision');

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

// o-series reasoning models (o1, o3, o3-mini, …), bare or behind an
// OpenRouter-style `openai/` prefix. `gpt-4o` does not match: the `o` must
// start the model name or follow a slash.
function isReasoningModel(model) {
    return /(^|\/)o\d+(-|$)/i.test(model || '');
}

// The tuning knobs, in the shape this model accepts. Reasoning models take
// max_completion_tokens and reject non-default temperature — sending the
// chat-model parameters is a guaranteed 400 (#822).
function tuningParams(model, temperature, maxTokens) {
    if (isReasoningModel(model)) {
        return maxTokens != null ? { max_completion_tokens: maxTokens } : {};
    }
    return { temperature, max_tokens: maxTokens };
}

// Models that can be shown an image (#839). Everything in the 4o/4.1/5 and
// o-series lines is multimodal except the small reasoning models, which take
// text only and answer an image with a 400 rather than ignoring it — so the
// list is an allow list with those two carved back out, and anything not on it
// is asked in text alone.
const VISION_MODELS = /^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|o1|o3|o4)/i;
const TEXT_ONLY_MODELS = /^(o1-mini|o3-mini)/i;

function supportsVision(model) {
    const name = String(model || '');
    return VISION_MODELS.test(name) && !TEXT_ONLY_MODELS.test(name);
}

/**
 * The user turn: a plain string, or the content array a message with images
 * takes.
 *
 * The images ride as data URLs rather than as the Discord CDN link they came
 * from — see vision.js on why the bytes are fetched here rather than by the
 * provider — and the text goes first so the question is read before its
 * subject, which is the order the user typed it in.
 */
function userContent(prompt, images) {
    if (!images?.length) return prompt;
    return [
        ...(prompt ? [{ type: 'text', text: prompt }] : []),
        ...images.map(image => ({ type: 'image_url', image_url: { url: dataUrl(image) } }))
    ];
}

/**
 * Whether images may ride on this request.
 *
 * The model name decides, and this module is the one that knows what OpenAI's
 * names mean — so a caller cannot send an image to a model that would refuse
 * it. `visionCapable` is the exception, and it is not a caller overriding the
 * check: OpenRouter routes another vendor's model through this same request
 * path, and `anthropic/claude-…` is a name only that provider can judge. Where
 * it is given, it is the answer from whoever owns the id.
 */
function canSee({ model, visionCapable }) {
    return visionCapable ?? supportsVision(model);
}

function buildMessages({ systemPrompt, history, prompt, images, model, visionCapable }) {
    return [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userContent(prompt, canSee({ model, visionCapable }) ? images : null) }
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

/**
 * Endpoints that answered a stream with "I do not know what stream_options is".
 *
 * `stream_options: { include_usage: true }` is how a streamed OpenAI response
 * is made to report its token counts — without it the usage ledger has nothing
 * to charge and the guild's spend goes unmeasured — but it is an OpenAI
 * extension, and `baseURL` points this provider at anything that speaks the
 * chat-completions shape: llama.cpp, vLLM, LM Studio, a corporate gateway.
 * Several of those reject the unknown field with a 400 rather than ignoring it,
 * which turned "your usage numbers are missing" into "the bot cannot answer"
 * (#838).
 *
 * So it is sent by default and withdrawn on evidence: the first 400 that names
 * the parameter is retried without it, and the endpoint is remembered for the
 * life of the process so the next message pays no failed request. Usage for
 * that endpoint is then whatever the stream reports on its own, which for most
 * of them is nothing — the same position the bot was in before, and better than
 * a reply that does not arrive.
 */
const noStreamOptions = new Set();

// A 400 from an endpoint that has never heard of the field. Matched on the
// parameter name rather than on a status alone: a 400 for a bad model name or
// an over-long context is not something dropping usage reporting would fix,
// and retrying those would double every genuine failure.
function rejectsStreamOptions(err) {
    if (err?.status !== 400) return false;
    const text = `${err.message || ''} ${JSON.stringify(err.error ?? '')}`.toLowerCase();
    return text.includes('stream_options') || text.includes('include_usage');
}

/**
 * Open one streamed round, dropping `stream_options` for an endpoint that has
 * refused it before — or that refuses it now.
 *
 * The retry is safe to make because nothing has been consumed: a request that
 * fails at 400 produced no tokens, ran no tool, and cost nothing to repeat.
 */
async function openStream(client, params, endpoint) {
    if (noStreamOptions.has(endpoint)) return client.chat.completions.create(params);

    try {
        return await client.chat.completions.create({
            ...params,
            stream_options: { include_usage: true }
        });
    } catch (err) {
        if (!rejectsStreamOptions(err)) throw err;
        console.warn(`[AI:openai] ${endpoint} rejects stream_options; usage will go unreported for it`);
        noStreamOptions.add(endpoint);
        return client.chat.completions.create(params);
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

async function* stream({ apiKey, model, systemPrompt, history, prompt, images, temperature, maxTokens, visionCapable, baseURL, defaultHeaders, usageOut, useMcp = true, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, toolBudget, botTools, maxRounds, turnBudgetMs }) {
    const toolkit = await toolkitFor({ useMcp, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, toolBudget, botTools, maxRounds, turnBudgetMs });
    const rounds = roundsFor(toolkit);
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    // What `noStreamOptions` is keyed on. `baseURL` is undefined for OpenAI
    // itself, which is a key like any other — and the one endpoint guaranteed
    // never to end up in the set.
    const endpoint = baseURL || 'openai';
    const messages = buildMessages({ systemPrompt, history, prompt, images, model, visionCapable });

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
        const offerTools = Boolean(toolkit) && round < rounds;

        const response = await openStream(client, {
            model,
            messages,
            ...tuningParams(model, temperature, maxTokens),
            stream: true,
            ...(offerTools ? { tools: toolParams(toolkit) } : {})
        }, endpoint);

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

async function complete({ apiKey, model, systemPrompt, history, prompt, images, temperature, maxTokens, visionCapable, baseURL, defaultHeaders, useMcp = true, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, toolBudget, botTools, maxRounds, turnBudgetMs }) {
    const toolkit = await toolkitFor({ useMcp, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, toolBudget, botTools, maxRounds, turnBudgetMs });
    const rounds = roundsFor(toolkit);
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const messages = buildMessages({ systemPrompt, history, prompt, images, model, visionCapable });

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    const parts = [];

    for (let round = 0; ; round++) {
        const offerTools = Boolean(toolkit) && round < rounds;

        const completion = await client.chat.completions.create({
            model,
            messages,
            ...tuningParams(model, temperature, maxTokens),
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
    // Which models can be shown an image attachment. Asked by the registry so
    // the transport does not have to keep its own list.
    supportsVision,
    resolveAuth: aiSettings => ({ apiKey: decryptSecret(aiSettings.openaiKey) || process.env.OPENAI_API_KEY }),
    stream,
    complete
};
