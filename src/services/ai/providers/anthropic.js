const Anthropic = require('@anthropic-ai/sdk');
const { decryptSecret } = require('../../../config/secretBox');
const {
    buildAnthropicMcpParams,
    requiresApproval,
    MCP_BETA,
    DEFAULT_MCP_ROUTE
} = require('../../../config/mcpServers');
const { toolkitFor, mapWithLimit, MAX_TOOL_ROUNDS, MAX_PARALLEL_TOOL_CALLS } = require('../mcp/toolkit');

// Anthropic can reach MCP servers two ways, and this module is the only place
// that has to know it.
//
// The connector is Anthropic's: the server list travels on the request, they
// open the connections, and no tool loop runs here at all. It is the cheaper
// route and the blind one — the bot never sees a call, so everything the bot
// does with a call is absent. That is the approval prompt, the line in the
// reply naming the tool, the activity ledger and the result caps, none of which
// can exist on a call the bot is not making.
//
// The client route is the one every other provider already uses: the toolkit in
// src/services/ai/mcp/ lists the tools, they go out as ordinary Anthropic tool
// definitions, and the loop below runs the calls. Same servers, same guild
// config — only the side that opens the socket differs.
//
// Which one a request takes is the guild's `ai.mcpRoute`, defaulting to `auto`,
// where the answer is "the connector unless the guild has asked for something
// only the client route can do".

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

/**
 * Which route this request takes, and the toolkit for it when that is client.
 *
 * Returns null for the connector route and for a request with no servers to
 * reach, both of which fall through to the plain path below unchanged.
 */
async function clientToolkit(req) {
    if (req.useMcp === false) return null;

    const route = req.mcpRoute || DEFAULT_MCP_ROUTE;
    // `auto` follows the approval policy: a guild that asked to be consulted
    // must not lose that by picking Claude in a dropdown on another tab.
    const client = route === 'client'
        || (route !== 'connector' && requiresApproval(req.mcpConfirm, req.mcpServers));

    return client ? toolkitFor(req) : null;
}

// MCP tools as Anthropic tool definitions. The toolkit has already done
// everything that is the same for every provider, so this is a rename.
//
// Called once per round, never hoisted out of the loop: the toolkit's
// definitions grow when the model loads a deferred tool (#795), and a list
// captured before the first request would never declare the tool it just asked
// for — leaving the model able to see a tool in the catalogue and never call it.
function toolParams(toolkit) {
    return toolkit.definitions.map(def => ({
        name: def.name,
        description: def.description,
        input_schema: def.inputSchema
    }));
}

function toolUsesOf(content) {
    return (content || []).filter(block => block.type === 'tool_use');
}

/**
 * Run the calls in one round and build the message that answers them.
 *
 * Concurrent, like every other provider's loop: the model asked for all of them
 * before it saw any answer. The results keep the order they were asked in,
 * which is not load-bearing here — each one carries its own tool_use_id — but
 * makes the transcript read the way the round happened.
 */
async function runToolCalls(toolkit, uses) {
    const results = await mapWithLimit(uses, MAX_PARALLEL_TOOL_CALLS, use =>
        toolkit.call(use.name, use.input && typeof use.input === 'object' ? use.input : {}));

    return uses.map((use, index) => ({
        type: 'tool_result',
        tool_use_id: use.id,
        content: results[index]
    }));
}

function addUsage(totals, usage) {
    if (!usage) return false;
    totals.inputTokens += usage.input_tokens || 0;
    totals.outputTokens += usage.output_tokens || 0;
    return true;
}

/**
 * The client-side tool loop, streamed.
 *
 * A round that calls tools often says something first — "let me look that up" —
 * and the answer arrives in the round after it. Those are two separate pieces
 * of prose, so a blank line goes between them rather than the second sentence
 * running into the first.
 */
async function* streamWithTools(client, req, toolkit) {
    const { model, systemPrompt, history, prompt, temperature, maxTokens, usageOut } = req;
    const base = baseRequest({ model, systemPrompt, temperature, maxTokens });
    const messages = buildMessages(history, prompt);

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    let wroteText = false;

    for (let round = 0; ; round++) {
        // The last permitted round goes out with no tools, which leaves the
        // model nothing to do but answer — otherwise a turn could end on a tool
        // call and the user would get an empty message.
        const offerTools = round < MAX_TOOL_ROUNDS;
        const response = await client.messages.stream({
            ...base,
            messages,
            ...(offerTools ? { tools: toolParams(toolkit) } : {})
        });

        let roundText = false;
        for await (const event of response) {
            if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') continue;
            if (!roundText && wroteText) yield '\n\n';
            roundText = true;
            wroteText = true;
            yield event.delta.text;
        }

        const final = await response.finalMessage();
        sawUsage = addUsage(totals, final.usage) || sawUsage;

        const uses = toolUsesOf(final.content);
        if (!uses.length || !offerTools) break;

        messages.push({ role: 'assistant', content: final.content });
        messages.push({ role: 'user', content: await runToolCalls(toolkit, uses) });
    }

    if (usageOut && sawUsage) usageOut.usage = totals;
}

/** The same loop, unstreamed. */
async function completeWithTools(client, req, toolkit) {
    const { model, systemPrompt, history, prompt, temperature, maxTokens } = req;
    const base = baseRequest({ model, systemPrompt, temperature, maxTokens });
    const messages = buildMessages(history, prompt);

    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    const parts = [];

    for (let round = 0; ; round++) {
        const offerTools = round < MAX_TOOL_ROUNDS;
        const response = await client.messages.create({
            ...base,
            messages,
            ...(offerTools ? { tools: toolParams(toolkit) } : {})
        });

        const text = textOf(response.content);
        if (text) parts.push(text);
        sawUsage = addUsage(totals, response.usage) || sawUsage;

        const uses = toolUsesOf(response.content);
        if (!uses.length || !offerTools) break;

        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: await runToolCalls(toolkit, uses) });
    }

    return {
        text: parts.join('\n\n'),
        usage: sawUsage ? totals : null
    };
}

async function* stream(req) {
    const { apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, usageOut, useMcp = true, mcpServers } = req;
    const client = new Anthropic({ apiKey });

    const toolkit = await clientToolkit(req);
    if (toolkit) {
        yield* streamWithTools(client, req, toolkit);
        return;
    }

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

async function complete(req) {
    const { apiKey, model, systemPrompt, history, prompt, temperature, maxTokens, useMcp = true, mcpServers } = req;
    const client = new Anthropic({ apiKey });

    const toolkit = await clientToolkit(req);
    if (toolkit) return completeWithTools(client, req, toolkit);

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
    // Anthropic is the one provider that can connect to MCP servers itself. It
    // can also be asked to work like the others — see clientToolkit above — so
    // this is what it does by default, not the only thing it does.
    mcp: 'native',
    resolveAuth: aiSettings => ({ apiKey: decryptSecret(aiSettings.anthropicKey) || process.env.ANTHROPIC_API_KEY }),
    stream,
    complete
};
