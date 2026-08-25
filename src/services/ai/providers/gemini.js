const { GoogleGenAI } = require('@google/genai');
const { toolkitFor, mapWithLimit, MAX_TOOL_ROUNDS, MAX_PARALLEL_TOOL_CALLS } = require('../mcp/toolkit');

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

// Gemini takes an OpenAPI subset, not JSON Schema: it has its own key list and
// rejects a declaration outright when it meets one it does not know. MCP servers
// publish plain JSON Schema — `$schema`, `additionalProperties` and `$ref` and
// all — so everything outside this list is dropped rather than forwarded.
const SCHEMA_KEYS = [
    'description', 'enum', 'format', 'maxItems', 'maximum', 'minItems',
    'minimum', 'nullable', 'pattern', 'required', 'title'
];

/**
 * One MCP tool's JSON Schema as something Gemini will accept.
 *
 * Returns undefined for a schema with no properties at all: a declaration for a
 * tool that takes no arguments is sent without a `parameters` block, which is
 * what the API expects, rather than with an empty object it may reject.
 */
function toGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;

    const out = {};
    for (const key of SCHEMA_KEYS) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }

    // `type: ["string", "null"]` is JSON Schema's way of saying optional; Gemini
    // spells that as one type plus `nullable`.
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const concrete = types.find(t => typeof t === 'string' && t !== 'null');
    if (concrete) out.type = concrete.toUpperCase();
    if (types.length > 1 && types.includes('null')) out.nullable = true;

    if (schema.properties && typeof schema.properties === 'object') {
        const properties = {};
        for (const [name, value] of Object.entries(schema.properties)) {
            const converted = toGeminiSchema(value);
            if (converted) properties[name] = converted;
        }
        if (Object.keys(properties).length) out.properties = properties;
    }
    if (schema.items) {
        const items = toGeminiSchema(schema.items);
        if (items) out.items = items;
    }
    if (Array.isArray(schema.anyOf)) {
        const anyOf = schema.anyOf.map(toGeminiSchema).filter(Boolean);
        if (anyOf.length) out.anyOf = anyOf;
    }

    // A required list naming properties that were dropped would be rejected.
    if (Array.isArray(out.required)) {
        out.required = out.required.filter(name => out.properties?.[name]);
        if (!out.required.length) delete out.required;
    }

    if (out.type === 'OBJECT' && !out.properties) return undefined;
    return Object.keys(out).length ? out : undefined;
}

function functionDeclarations(toolkit) {
    return toolkit.definitions.map(def => {
        const parameters = toGeminiSchema(def.inputSchema);
        return {
            name: def.name,
            description: def.description,
            ...(parameters ? { parameters } : {})
        };
    });
}

function startChat({ apiKey, model, systemPrompt, history, temperature, maxTokens }, { toolkit = null, priorHistory = null } = {}) {
    const client = new GoogleGenAI({ apiKey });
    return client.chats.create({
        model,
        config: {
            systemInstruction: systemPrompt,
            temperature,
            maxOutputTokens: maxTokens,
            ...(toolkit ? { tools: [{ functionDeclarations: functionDeclarations(toolkit) }] } : {})
        },
        history: priorHistory || history.map(h => ({
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

// Each round is its own request, so the guild is billed for the sum of them.
function addUsage(totals, round) {
    if (!round) return;
    totals.inputTokens += round.inputTokens;
    totals.outputTokens += round.outputTokens;
}

/**
 * Run the calls Gemini asked for and build the message that answers them.
 *
 * Function responses go back as parts of the next message, which is what makes
 * the loop here look like an ordinary conversation turn. The calls themselves
 * run concurrently — Gemini asked for all of them before seeing any answer, so
 * nothing in the round depends on the one before it — and the parts stay in the
 * order they were asked for.
 */
async function runToolCalls(toolkit, calls) {
    const results = await mapWithLimit(calls, MAX_PARALLEL_TOOL_CALLS, call =>
        toolkit.call(call.name, call.args || {}));

    return calls.map((call, index) => ({
        functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: { result: results[index] }
        }
    }));
}

/**
 * The same conversation, continued with no tools declared.
 *
 * Falls back to the chat as it is if the SDK cannot hand back its history —
 * the round counter still ends the loop, and continuing is better than sending
 * function responses into a chat that never saw the call they answer.
 */
function withoutTools(req, chat) {
    if (typeof chat.getHistory !== 'function') return chat;
    return startChat(req, { priorHistory: chat.getHistory() });
}

function callsOf(source) {
    return (source?.functionCalls || []).filter(call => call && typeof call.name === 'string');
}

async function* stream(req) {
    const toolkit = await toolkitFor(req);
    let chat = startChat(req, { toolkit });
    let message = req.prompt;

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const result = await chat.sendMessageStream({ message });

        // Usage now rides on the chunks rather than on a separate response
        // object awaited after the stream. Each chunk that carries it carries
        // the running total, so the last one seen is the total for the round.
        let lastUsage = null;
        const calls = [];
        for await (const chunk of result) {
            if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
            calls.push(...callsOf(chunk));
            const text = chunk.text;
            if (text) yield text;
        }
        if (lastUsage) {
            sawUsage = true;
            addUsage(totals, usageOf(lastUsage));
        }

        if (!calls.length) break;
        message = await runToolCalls(toolkit, calls);
        // The next request is the last one allowed, so it goes out with no
        // tools declared: the model's only remaining move is to answer. The
        // conversation so far comes from the chat itself, since it holds the
        // function-call turn these responses answer.
        if (round + 1 === MAX_TOOL_ROUNDS) chat = withoutTools(req, chat);
    }

    if (req.usageOut && sawUsage) req.usageOut.usage = totals;
}

async function complete(req) {
    const toolkit = await toolkitFor(req);
    let chat = startChat(req, { toolkit });
    let message = req.prompt;

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    let text = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const response = await chat.sendMessage({ message });
        if (response.usageMetadata) {
            sawUsage = true;
            addUsage(totals, usageOf(response.usageMetadata));
        }

        // `.text` is undefined when the model returned no text part at all — a
        // safety block, or a response that was only tool calls.
        text = response.text ?? '';

        const calls = callsOf(response);
        if (!calls.length) break;
        message = await runToolCalls(toolkit, calls);
        if (round + 1 === MAX_TOOL_ROUNDS) chat = withoutTools(req, chat);
    }

    return { text, usage: sawUsage ? totals : null };
}

module.exports = {
    name: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-2.0-flash',
    pricing: PRICING,
    // MCP tools are declared as Gemini functions and called from the loop here.
    mcp: 'client',
    resolveAuth: aiSettings => ({ apiKey: aiSettings.geminiKey || process.env.GEMINI_API_KEY }),
    stream,
    complete,
    // Exported for the tests that pin what an MCP schema turns into.
    toGeminiSchema
};
