'use strict';

const { resolveMcpServers } = require('../../../config/mcpServers');
const { entryFor, cachedList, withSession, sweepIdleSessions, mapWithLimit } = require('./connections');

/**
 * MCP prompts as something a person can run.
 *
 * `prompts/list` returns named templates that take arguments — "review this
 * pull request", "summarise this incident" — written by whoever runs the
 * server and kept up to date there. Most MCP clients have nowhere to put them.
 * A Discord bot does: a slash command is a name plus arguments, which is the
 * same shape, so `/ai mcp prompt` fills one in and answers with it.
 *
 * One command rather than one per prompt, because Discord registers a hundred
 * global commands and tests/commandCap pins how many of them this bot spends.
 * The prompt is named as an option (autocompleted from the servers, so nobody
 * has to remember one) and its arguments are collected from a single string.
 *
 * Nothing here is cached separately: the prompt list rides the same connection
 * pool as tools and resources, so the autocomplete that runs a keystroke after
 * `/ai mcp prompts` is answered from what that listing already fetched.
 */

// A prompt list is a menu, and Discord's autocomplete shows 25 entries. Past
// this a server is publishing a catalogue rather than a menu.
const MAX_PROMPTS_PER_SERVER = 100;

// What a user types into one command option. Discord's own ceiling is 6000 for
// a string option; this is the useful part of one.
const MAX_ARGUMENT_CHARS = 1500;

// Servers name their own prompts and arguments, and both end up in a Discord
// message and in a request. Both get a ceiling.
const MAX_NAME_LENGTH = 100;

/** Split "server/prompt" the way the autocomplete writes it. */
function splitQualifiedName(value) {
    const text = String(value || '').trim();
    const at = text.indexOf('/');
    if (at <= 0) return { server: null, name: text };
    return { server: text.slice(0, at), name: text.slice(at + 1) };
}

function qualify(serverName, promptName) {
    return `${serverName}/${promptName}`;
}

function listPrompts(entry, server) {
    return cachedList(entry, server, 'prompts', client => client.listPrompts());
}

/**
 * Every prompt the guild's servers offer, per server.
 *
 * A server that cannot be reached is reported with its error rather than
 * dropped: "the docs server is down" is the answer to why a prompt somebody
 * used yesterday is missing from the list today.
 */
async function listGuildPrompts(guildServers = []) {
    const servers = resolveMcpServers(guildServers);
    if (!servers.length) return [];

    sweepIdleSessions();

    return mapWithLimit(servers, servers.length, async server => {
        const entry = entryFor(server);
        try {
            const prompts = await listPrompts(entry, server);
            return {
                server: server.name,
                prompts: prompts.slice(0, MAX_PROMPTS_PER_SERVER).map(prompt => ({
                    name: String(prompt.name).slice(0, MAX_NAME_LENGTH),
                    title: typeof prompt.title === 'string' ? prompt.title : '',
                    description: typeof prompt.description === 'string' ? prompt.description : '',
                    arguments: normalizeArguments(prompt.arguments)
                })),
                error: null
            };
        } catch (err) {
            console.warn(`[MCP] "${server.name}" prompts are unavailable: ${err.message}`);
            return { server: server.name, prompts: [], error: err.message };
        }
    });
}

/** The argument list as the spec defines it: a name, some prose, and required-ness. */
function normalizeArguments(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(arg => arg && typeof arg.name === 'string' && arg.name)
        .map(arg => ({
            name: arg.name.slice(0, MAX_NAME_LENGTH),
            description: typeof arg.description === 'string' ? arg.description : '',
            required: arg.required === true
        }));
}

/**
 * Find one prompt by the name a user gave.
 *
 * "server/prompt" is what the autocomplete produces; a bare name is what
 * somebody types from memory, and is matched across every server. An ambiguous
 * bare name is reported rather than guessed at — two servers can both publish a
 * "summarise", and running the wrong one is worse than being asked which.
 */
function findPrompt(listings, value) {
    const { server, name } = splitQualifiedName(value);
    const wanted = name.toLowerCase();

    const matches = [];
    for (const listing of listings) {
        if (server && listing.server !== server) continue;
        for (const prompt of listing.prompts) {
            if (prompt.name.toLowerCase() === wanted) matches.push({ server: listing.server, prompt });
        }
    }

    if (!matches.length) return { error: `No MCP prompt named \`${name}\` — run \`/ai mcp prompts\` to see what is available.` };
    if (matches.length > 1) {
        const names = matches.map(match => `\`${qualify(match.server, match.prompt.name)}\``).join(', ');
        return { error: `More than one server offers \`${name}\` — ask for one of ${names}.` };
    }
    return matches[0];
}

/**
 * `key=value` pairs from one command option, quoted values included.
 *
 * The alternative was a modal, which Discord will only open in reply to an
 * interaction and cannot pre-fill from a list the bot has to fetch first — so
 * the arguments would still have to be typed, one round trip later. A string it
 * is, with the single-argument shorthand below so the common prompt (one
 * argument, a sentence of text) is typed the way anyone would expect.
 */
function parsePromptArguments(text, argumentSpec = []) {
    const raw = String(text || '').trim().slice(0, MAX_ARGUMENT_CHARS);
    if (!raw) return { values: {} };

    // One argument and no `key=` in sight: the whole string is that argument.
    if (argumentSpec.length === 1 && !/^\s*[A-Za-z_][A-Za-z0-9_-]*\s*=/.test(raw)) {
        return { values: { [argumentSpec[0].name]: raw } };
    }

    // Split on the `name=` markers rather than on whitespace, so a value runs
    // until the next argument starts. `topic=the outage since=yesterday` is how
    // people type this, and quoting every value is not.
    const marker = /(?:^|\s)([A-Za-z_][A-Za-z0-9_-]*)=/g;
    const hits = [];
    let match;
    while ((match = marker.exec(raw)) !== null) {
        hits.push({
            key: match[1],
            keyStart: match.index + match[0].length - match[1].length - 1,
            valueStart: match.index + match[0].length
        });
    }

    if (!hits.length) {
        return { error: 'Arguments are written as `name=value`, one per argument the prompt takes.' };
    }
    if (raw.slice(0, hits[0].keyStart).trim()) {
        return { error: 'Everything after the prompt name has to be a `name=value` pair — the text before the first one has nowhere to go.' };
    }

    const values = {};
    for (const [index, hit] of hits.entries()) {
        const end = index + 1 < hits.length ? hits[index + 1].keyStart : raw.length;
        const value = raw.slice(hit.valueStart, end).trim();
        // Quotes are optional here, so they are stripped rather than required.
        values[hit.key] = /^(".*"|'.*')$/s.test(value) ? value.slice(1, -1) : value;
    }
    return { values };
}

/** The arguments a prompt requires that were not supplied. */
function missingArguments(argumentSpec, values) {
    return argumentSpec
        .filter(arg => arg.required && !String(values[arg.name] ?? '').trim())
        .map(arg => arg.name);
}

/** One prompt message's text, whatever shape the server used to carry it. */
function messageText(content) {
    if (typeof content === 'string') return content;
    const blocks = Array.isArray(content) ? content : [content];

    const parts = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        } else if (block.type === 'resource' && typeof block.resource?.text === 'string') {
            // An embedded resource is the prompt carrying its own context —
            // the file being reviewed, the page being summarised.
            parts.push(block.resource.text);
        } else if (block.type) {
            parts.push(`[${block.type} content omitted]`);
        }
    }
    return parts.join('\n').trim();
}

/**
 * A filled-in prompt as a conversation the provider layer can take.
 *
 * A prompt is a list of messages, and this bot's completion call is a history
 * plus one final user turn, so the last user message becomes the turn and
 * everything before it becomes the history. A prompt that ends on an assistant
 * message is the prefill pattern, which no provider here exposes the same way:
 * the whole thing becomes history and the model is asked to continue, which is
 * the closest honest reading of it.
 */
function toConversation(messages) {
    const turns = [];
    for (const message of messages) {
        const text = messageText(message?.content);
        if (!text) continue;
        turns.push({ role: message?.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
    if (!turns.length) return null;

    const last = turns[turns.length - 1];
    if (last.role === 'user') {
        return { history: turns.slice(0, -1), prompt: last.content };
    }
    return { history: turns, prompt: 'Continue from the conversation above.' };
}

/**
 * Fetch one prompt from its server and turn it into a conversation.
 *
 * Throws only for a caller error (an unknown server). A server that refuses the
 * prompt comes back as `{ error }`, because that is a thing to tell the person
 * who ran the command rather than a fault to log.
 */
async function renderPrompt(guildServers, serverName, promptName, values) {
    const server = resolveMcpServers(guildServers).find(entry => entry.name === serverName);
    if (!server) return { error: `No MCP connection named \`${serverName}\`.` };

    const entry = entryFor(server);
    let result;
    try {
        result = await withSession(entry, server, client => client.getPrompt(promptName, values));
    } catch (err) {
        console.warn(`[MCP] "${serverName}" prompt "${promptName}" failed: ${err.message}`);
        return { error: `The "${serverName}" server could not fill in that prompt: ${err.message}` };
    }

    const conversation = toConversation(result.messages);
    if (!conversation) return { error: 'That prompt came back empty.' };

    return { description: result.description, ...conversation };
}

module.exports = {
    listGuildPrompts,
    findPrompt,
    renderPrompt,
    parsePromptArguments,
    missingArguments,
    toConversation,
    messageText,
    splitQualifiedName,
    qualify,
    MAX_ARGUMENT_CHARS,
    MAX_PROMPTS_PER_SERVER
};
