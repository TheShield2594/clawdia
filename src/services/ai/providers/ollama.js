const { guardedDispatcher, assertPublicHttpUrl } = require('../../../utils/outboundGuard');
const { request, fetchHeaders, discardBody, bodyStream } = require('../../../utils/httpFetch');
const { toolkitFor, mapWithLimit, roundsFor, MAX_PARALLEL_TOOL_CALLS } = require('../mcp/toolkit');

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
 * `ai.ollamaBaseUrl`, and it used to reach the HTTP client unexamined — with the
 * response echoed back into a Discord channel. From inside the container that
 * reaches the metadata service, the Mongo host on the compose network, and
 * anything else the bot can see: a read primitive against the operator's own
 * infrastructure, driven from a settings field and rendered as a chat reply.
 *
 * Requests to the operator's own endpoint are made as they always were — it is
 * the operator's machine, usually localhost, and the whole point of the
 * provider. Any *other* base URL is somebody's configuration, so it must be a
 * plain http(s) URL, it must not be a literal private address, and it is
 * dialled through a dispatcher that refuses to open a socket to private or
 * reserved space. Those checks sit where the connection is made, so they also
 * cover a hostname that resolves privately only sometimes, and every hop of any
 * redirect `fetch` follows.
 *
 * `dispatcher` is undefined for the operator's own endpoint, which is what
 * hands the request to the global one — an operator running Ollama on
 * localhost is the ordinary case, and the guard would refuse it.
 */
function resolveEndpoint(baseUrl) {
    const configured = normalize(baseUrl) || OPERATOR_DEFAULT;
    const url = `${configured}/api/chat`;

    if (operatorEndpoints().has(configured)) return { url, dispatcher: undefined };

    assertPublicHttpUrl(configured, 'ai.ollamaBaseUrl');
    return { url, dispatcher: guardedDispatcher() };
}

/**
 * Which locally-served models can be shown an image (#839).
 *
 * Unlike the hosted providers there is no list to check against: Ollama serves
 * whatever the operator pulled, under whatever tag they pulled it as. So this
 * is a name match against the multimodal families — a model without vision
 * given an image does not ignore it, it fails the request or answers about
 * nothing — and anything unrecognised is asked in text alone, which is what
 * every Ollama guild had before this existed.
 */
const VISION_MODELS = /(llava|bakllava|moondream|minicpm-v|internvl|pixtral|vision|[-:]vl\b|qwen2\.?5?-?vl|llama-?4|gemma-?3|mistral-small3)/i;

// `gemma3:1b` is the one member of an otherwise multimodal family that ships
// without the vision tower.
const TEXT_ONLY_TAGS = /gemma-?3[.:]?\d*:?1b/i;

function supportsVision(model) {
    const name = String(model || '');
    return VISION_MODELS.test(name) && !TEXT_ONLY_TAGS.test(name);
}

function buildMessages({ systemPrompt, history, prompt, images, model }) {
    // Ollama takes images as a sibling array of base64 strings rather than as
    // content blocks — no data URL, no mime type, just the bytes.
    const usable = supportsVision(model) ? (images || []) : [];
    return [
        { role: 'system', content: systemPrompt },
        ...history,
        {
            role: 'user',
            content: prompt,
            ...(usable.length ? { images: usable.map(image => image.base64) } : {})
        }
    ];
}

// Ollama takes the same function-tool shape as the OpenAI-compatible APIs.
// Whether the *model* can use them is another matter — a model without tool
// support ignores the field, which is why nothing here depends on tools being
// called, only on handling them when they are.
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

function usageOf(payload) {
    if (!payload) return null;
    if (payload.prompt_eval_count == null && payload.eval_count == null) return null;
    return {
        inputTokens: payload.prompt_eval_count || 0,
        outputTokens: payload.eval_count || 0
    };
}

function addUsage(totals, round) {
    if (!round) return;
    totals.inputTokens += round.inputTokens;
    totals.outputTokens += round.outputTokens;
}

// Ollama sends arguments as an object, but some builds send the JSON text
// instead, so both are accepted rather than trusting one shape.
function argsOf(call) {
    const raw = call?.function?.arguments;
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }
    return {};
}

/**
 * Append the model's tool calls and their results, ready for the next round.
 *
 * The calls run concurrently and the results are appended in the order they
 * were asked for — older Ollama builds ignore `tool_name` and match a result to
 * its call by position, so that order is load-bearing.
 */
async function runToolCalls({ toolkit, messages, calls, content }) {
    messages.push({ role: 'assistant', content: content || '', tool_calls: calls });

    const results = await mapWithLimit(calls, MAX_PARALLEL_TOOL_CALLS, async call => {
        const args = argsOf(call);
        if (args === null) {
            return `Those arguments were not valid JSON, so the tool was not run: ${call.function.arguments}`;
        }
        return toolkit.call(call?.function?.name || '', args);
    });

    calls.forEach((call, index) => {
        // tool_name is what current Ollama builds use to match a result to its
        // call; older ones ignore the field and match by order.
        messages.push({ role: 'tool', tool_name: call?.function?.name || '', content: results[index] });
    });
}

function requestBody({ model, messages, temperature, maxTokens, stream, tools }) {
    return {
        model,
        messages,
        stream,
        ...(tools ? { tools } : {}),
        options: { temperature, num_predict: maxTokens }
    };
}

/**
 * One streamed round of the NDJSON chat API.
 *
 * The text is yielded straight through to the caller, and everything the next
 * round needs — the tool calls, the token counts, the assistant text as one
 * string — is collected into `out`. A generator cannot hand back both through
 * `yield*`, and an out-parameter reads better here than nesting one generator
 * inside another to get at its return value.
 */
async function* streamRound({ url, dispatcher, body, out }) {
    // The 120s bounds the wait for headers, as it did under axios: a model
    // generating a long answer holds the body open for as long as it takes,
    // and a clock on the whole response would cut off the slow ones.
    const response = await fetchHeaders(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 120000,
        dispatcher,
    });
    if (!response.ok) {
        await discardBody(response);
        throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    let buf = '';
    for await (const chunk of bodyStream(response)) {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const json = JSON.parse(line);
                if (json.message?.content) {
                    out.content += json.message.content;
                    yield json.message.content;
                }
                if (Array.isArray(json.message?.tool_calls)) out.calls.push(...json.message.tool_calls);
                if (json.done) out.usage = usageOf(json);
            } catch { /* skip malformed line */ }
        }
    }
}

/**
 * The same pieces, with a blank line in front of the first one.
 *
 * A round's text has to be separated from the round before it, and the round
 * before it is only known to have produced any once it is over — so the
 * separator goes on the front of the next one, and only if that one says
 * anything at all.
 */
async function* separated(pieces) {
    let first = true;
    for await (const piece of pieces) {
        if (first) {
            yield '\n\n';
            first = false;
        }
        yield piece;
    }
}

async function* stream({ baseUrl, model, systemPrompt, history, prompt, images, temperature, maxTokens, usageOut, useMcp = true, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, sample, toolBudget, botTools, botToolsOnly, maxRounds, turnBudgetMs }) {
    const toolkit = await toolkitFor({ useMcp, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, sample, toolBudget, botTools, botToolsOnly, maxRounds, turnBudgetMs });
    const rounds = roundsFor(toolkit);
    const { url, dispatcher } = resolveEndpoint(baseUrl);
    const messages = buildMessages({ systemPrompt, history, prompt, images, model });

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    // A round that calls tools often says something first, and the answer
    // arrives in the round after it — two pieces of prose, not one sentence.
    let wroteText = false;

    for (let round = 0; ; round++) {
        // Withholding the tools on the final round leaves the model nothing to
        // do but answer, so a turn can never end on an unanswered tool call.
        const offerTools = Boolean(toolkit) && round < rounds;
        const body = requestBody({
            model, messages, temperature, maxTokens,
            stream: true,
            tools: offerTools ? toolParams(toolkit) : null
        });

        const out = { content: '', calls: [], usage: null };
        if (wroteText) yield* separated(streamRound({ url, dispatcher, body, out }));
        else yield* streamRound({ url, dispatcher, body, out });
        if (out.content) wroteText = true;

        if (out.usage) {
            sawUsage = true;
            addUsage(totals, out.usage);
        }
        // No tools offered means no more rounds, whatever the model sent back.
        if (!out.calls.length || !offerTools) break;
        await runToolCalls({ toolkit, messages, calls: out.calls, content: out.content });
    }

    if (usageOut && sawUsage) usageOut.usage = totals;
}

async function complete({ baseUrl, model, systemPrompt, history, prompt, images, temperature, maxTokens, useMcp = true, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, sample, toolBudget, botTools, botToolsOnly, maxRounds, turnBudgetMs }) {
    const toolkit = await toolkitFor({ useMcp, mcpServers, onToolEvent, mcpConfirm, confirmTool, elicit, sample, toolBudget, botTools, botToolsOnly, maxRounds, turnBudgetMs });
    const rounds = roundsFor(toolkit);
    const { url, dispatcher } = resolveEndpoint(baseUrl);
    const messages = buildMessages({ systemPrompt, history, prompt, images, model });

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    const parts = [];

    for (let round = 0; ; round++) {
        const offerTools = Boolean(toolkit) && round < rounds;
        // Not streamed, so unlike `streamRound` the clock covers the whole
        // response: the body here is one JSON object the model has finished.
        const response = await request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody({
                model, messages, temperature, maxTokens,
                stream: false,
                tools: offerTools ? toolParams(toolkit) : null
            })),
            timeout: 120000,
            dispatcher,
        });
        if (!response.ok) {
            await discardBody(response);
            throw new Error(`Ollama returned HTTP ${response.status}`);
        }
        const payload = await response.json();

        const usage = usageOf(payload);
        if (usage) {
            sawUsage = true;
            addUsage(totals, usage);
        }

        const message = payload?.message;
        const content = message?.content || '';
        if (content) parts.push(content);
        const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

        // The round that stops calling tools is the answer — or the last round,
        // where there were none to call. Text alongside a call is a preamble,
        // and it is kept rather than dropped so a guild with streaming off
        // reads the same reply a guild with it on watched arrive.
        if (!calls.length || !offerTools) return { text: parts.join('\n\n'), usage: sawUsage ? totals : null };
        await runToolCalls({ toolkit, messages, calls, content });
    }
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
    // Tools are offered through the bot's own MCP client. Models without tool
    // support simply never call one.
    mcp: 'client',
    supportsVision,
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
