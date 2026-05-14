/**
 * agentService — runs an agentic loop for a designated agent channel.
 *
 * Supports OpenAI and Anthropic tool-use natively.
 * Falls back to a plain completion for other providers (Gemini, Ollama).
 *
 * Composio tools are fetched based on the apps the server owner has connected
 * for the specific channel, and executed against the Composio API on each tool call.
 */

const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { getTools, executeAction } = require('./composioService');

const MAX_TOOL_ROUNDS = 5;
const DISCORD_MAX = 1900;

function pickProvider(guildSettings) {
    const ai = guildSettings?.ai || {};
    const provider = ai.provider || 'openai';
    const model = ai.model;

    switch (provider) {
        case 'openai':
            return { provider: 'openai', model: model || 'gpt-4o-mini', apiKey: ai.openaiKey || process.env.OPENAI_API_KEY };
        case 'anthropic':
            return { provider: 'anthropic', model: model || 'claude-haiku-4-5-20251001', apiKey: ai.anthropicKey || process.env.ANTHROPIC_API_KEY };
        case 'openrouter':
            return { provider: 'openai', model: model || 'openai/gpt-4o-mini', apiKey: ai.openrouterKey || process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' };
        default:
            // gemini/ollama don't support tool-calling in the same way; fall back
            return { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY };
    }
}

// -----------------------------------------------------------------------
// OpenAI tool-calling loop
// -----------------------------------------------------------------------
async function runOpenAI({ model, apiKey, baseURL, systemPrompt, userMessage, tools, execute }) {
    const openai = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
    ];
    const toolsParam = tools.length ? tools : undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await openai.chat.completions.create({
            model,
            messages,
            tools: toolsParam,
            tool_choice: toolsParam ? 'auto' : undefined
        });

        const choice = response.choices[0];
        messages.push(choice.message);

        if (!choice.message.tool_calls?.length || choice.finish_reason === 'stop') {
            return choice.message.content || '*(no response)*';
        }

        for (const call of choice.message.tool_calls) {
            let result;
            try {
                result = await execute(call.function.name, JSON.parse(call.function.arguments));
            } catch (err) {
                result = { error: err.message };
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
    }

    const last = messages.filter(m => m.role === 'assistant').pop();
    return last?.content || '*(reached tool call limit)*';
}

// -----------------------------------------------------------------------
// Anthropic tool-use loop
// -----------------------------------------------------------------------
async function runAnthropic({ model, apiKey, systemPrompt, userMessage, tools, execute }) {
    const anthropic = new Anthropic({ apiKey });

    const anthropicTools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} }
    }));

    const messages = [{ role: 'user', content: userMessage }];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await anthropic.messages.create({
            model,
            system: systemPrompt,
            messages,
            tools: anthropicTools.length ? anthropicTools : undefined,
            max_tokens: 1024
        });

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'end_turn' || !response.content.some(b => b.type === 'tool_use')) {
            return response.content.filter(b => b.type === 'text').map(b => b.text).join('') || '*(no response)*';
        }

        const toolResults = [];
        for (const block of response.content.filter(b => b.type === 'tool_use')) {
            let result;
            try {
                result = await execute(block.name, block.input);
            } catch (err) {
                result = { error: err.message };
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        messages.push({ role: 'user', content: toolResults });
    }

    const last = messages.filter(m => m.role === 'assistant').pop();
    if (Array.isArray(last?.content)) {
        return last.content.filter(b => b.type === 'text').map(b => b.text).join('') || '*(reached tool call limit)*';
    }
    return '*(reached tool call limit)*';
}

// -----------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {object} opts.guildSettings   - full Guild document
 * @param {string} opts.userMessage
 * @param {string} opts.channelFocus    - optional focus text for this agent channel
 * @param {string[]} opts.enabledApps   - app names available in this channel
 * @param {string} opts.userName        - display name of the user
 */
async function runAgent({ guildId, guildSettings, userMessage, channelFocus, enabledApps, userName }) {
    const composioKey = guildSettings?.integrations?.composioApiKey || null;

    // Fetch tools from Composio (empty array if key missing or no apps connected)
    const tools = composioKey && enabledApps?.length
        ? await getTools(guildId, composioKey, enabledApps)
        : [];

    const execute = (actionName, input) => executeAction(guildId, composioKey, actionName, input);

    const focusLine = channelFocus ? `Your focus for this channel: ${channelFocus}.` : '';
    const systemPrompt = [
        `You are an intelligent assistant integrated into a Discord server. ${focusLine}`,
        `You have access to tools that let you take real actions on behalf of the server owner.`,
        `Be concise. Format responses for Discord (plain text or markdown, no code blocks for prose).`,
        `When you use a tool, briefly describe what you did in your final response.`,
        `User talking to you: ${userName}`
    ].filter(Boolean).join(' ');

    const { provider, model, apiKey, baseURL } = pickProvider(guildSettings);

    if (!apiKey) {
        return '⚠️ No AI provider API key is configured. Add one in the dashboard under AI settings.';
    }

    let reply;
    if (provider === 'anthropic') {
        reply = await runAnthropic({ model, apiKey, systemPrompt, userMessage, tools, execute });
    } else {
        reply = await runOpenAI({ model, apiKey, baseURL, systemPrompt, userMessage, tools, execute });
    }

    return reply.length > DISCORD_MAX ? reply.slice(0, DISCORD_MAX - 3) + '...' : reply;
}

module.exports = { runAgent };
