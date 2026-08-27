'use strict';

const axios = require('axios');
const { guardedAgents, assertPublicHttpUrl } = require('../../../utils/outboundGuard');
const { version: CLAWDIA_VERSION } = require('../../../../package.json');

/**
 * A small MCP client speaking the Streamable HTTP transport.
 *
 * Anthropic's connector opens these connections on their side, which is why the
 * feature used to be Anthropic-only. To offer the same servers to OpenAI,
 * Gemini, Ollama and OpenRouter the bot has to be the MCP client itself: connect
 * to the server, list its tools, hand them to whichever model the guild picked,
 * and run the calls the model asks for.
 *
 * What is implemented is the half of the protocol a client can drive: the
 * handshake, tools (list and call), resources (list and read), prompts (list
 * and get), and session teardown. The other half — sampling, roots, elicitation,
 * anything the *server* initiates — is not, and the client advertises exactly
 * that in its capabilities so a server does not try.
 *
 * The three feature families are asked about only when the server said in its
 * handshake that it has them, which is what `capabilities` is for: a server
 * offering tools and nothing else is never sent a resources/list it would only
 * answer with "method not found".
 *
 * The URL is a dashboard field, so *the bot* now dials somewhere a guild admin
 * chose. That is the SSRF shape src/utils/outboundGuard.js exists for, and every
 * request here goes through it: literal private addresses are refused up front,
 * and hostnames are checked in the resolver at connect time, on the first
 * request and on every redirect hop.
 */

// The revision this client implements. A server that negotiates down to an
// older one is honoured by echoing whatever it returns on later requests.
const PROTOCOL_VERSION = '2025-06-18';

const CONNECT_TIMEOUT_MS = 20000;
// Tool calls do real work on the far side — a repo search, a calendar query —
// so they get longer than the handshake does, but not long enough to hold a
// Discord reply open indefinitely.
const CALL_TIMEOUT_MS = 45000;

// A response body is parsed into memory, so it needs a ceiling; a tool result
// larger than this is a server misbehaving, not something a model can use.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// The list methods are paginated. Ten pages is far more than any real server
// needs and stops a server that always returns a cursor from looping forever.
const MAX_LIST_PAGES = 10;

// JSON-RPC's "no such method". A server that advertised a capability and then
// refuses the method for it has answered the question — it has none of that
// thing — rather than failed, so the list methods read this as an empty list.
const METHOD_NOT_FOUND = -32601;

// The shared servers — DeepWiki, Context7 without a key — rate-limit, and a
// 429 that says "try again in two seconds" is worth waiting out rather than
// reporting to a Discord channel as a failure. Only once, and only for a wait
// the turn can afford: a server asking for a minute is telling us to come back
// later, not to hold a reply open.
const MAX_RETRY_AFTER_MS = 5000;

class McpError extends Error {
    constructor(message, { status = null, code = null, sessionExpired = false } = {}) {
        super(message);
        this.name = 'McpError';
        this.status = status;
        this.code = code;
        // Sessions expire; the caller reconnects once rather than failing the
        // whole conversation over a server that recycled its state.
        this.sessionExpired = sessionExpired;
    }
}

// Node streams are async-iterable, so both body readers are written against the
// same iteration and differ only in what they do with the bytes.
async function* readChunks(stream) {
    let seen = 0;
    for await (const chunk of stream) {
        seen += chunk.length;
        if (seen > MAX_RESPONSE_BYTES) {
            stream.destroy();
            throw new McpError(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
        }
        yield chunk.toString('utf8');
    }
}

async function collectText(stream) {
    let text = '';
    try {
        for await (const chunk of readChunks(stream)) text += chunk;
    } catch (err) {
        if (err instanceof McpError) throw err;
        // A body that stops mid-flight is still worth reporting with what arrived.
    }
    return text;
}

function jsonRpcResult(message) {
    if (!message || typeof message !== 'object') {
        throw new McpError('server sent no JSON-RPC response');
    }
    if (message.error) {
        const { code, message: text } = message.error;
        throw new McpError(text || `JSON-RPC error ${code}`, { code });
    }
    return message.result ?? {};
}

/**
 * Pull the JSON-RPC response with `id` out of an SSE stream.
 *
 * The transport lets a server answer one POST with a stream rather than a
 * single JSON body, and put progress notifications on it before the answer.
 * Anything that is not the response being waited for is skipped, and the stream
 * is dropped as soon as the answer arrives — the server is allowed to hold it
 * open afterwards, and waiting that out would stall the turn.
 */
async function readEventStream(stream, id) {
    let buffer = '';
    let data = [];

    const finish = () => {
        if (!data.length) return undefined;
        const text = data.join('\n');
        data = [];
        if (!text.trim()) return undefined;
        try {
            const message = JSON.parse(text);
            return message && message.id === id ? message : undefined;
        } catch {
            return undefined;
        }
    };

    for await (const chunk of readChunks(stream)) {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);

            if (line === '') {
                const message = finish();
                if (message) {
                    stream.destroy();
                    return message;
                }
                continue;
            }
            if (line.startsWith(':')) continue;
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
    }

    // A stream that ended without a blank line still carries its last event.
    const trailing = finish();
    if (trailing) return trailing;
    throw new McpError('server closed the stream without answering');
}

function parseJsonBody(text, id) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new McpError(`server sent a non-JSON response: ${text.slice(0, 200)}`);
    }
    // Batched responses are legal even for a single request.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const match = list.find(m => m && m.id === id);
    if (!match) throw new McpError('server response did not answer the request');
    return match;
}

/**
 * How long the server asked us to wait, in milliseconds, or null.
 *
 * Retry-After is either a count of seconds or an HTTP date; both are in the
 * wild. A value outside what the turn can afford comes back as null, so the
 * caller reports the 429 instead of sleeping on it.
 */
function retryAfterMs(header) {
    if (header === undefined || header === null) return null;

    const raw = String(header).trim();
    if (!raw) return null;

    const seconds = Number(raw);
    const ms = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(raw) - Date.now();

    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

// HTTP failures are what an admin actually sees when a URL or token is wrong,
// so they say which of the two it probably is.
function httpError(status, body) {
    const detail = body.trim().slice(0, 300);
    if (status === 401 || status === 403) {
        return new McpError(`HTTP ${status} — the server rejected the authorization token${detail ? `: ${detail}` : ''}`, { status });
    }
    if (status === 404 || status === 405) {
        return new McpError(`HTTP ${status} — no MCP endpoint at this URL${detail ? `: ${detail}` : ''}`, { status, sessionExpired: status === 404 });
    }
    if (status === 429) {
        return new McpError(`HTTP 429 — the server is rate-limiting this connection${detail ? `: ${detail}` : ''}`, { status });
    }
    return new McpError(`HTTP ${status}${detail ? `: ${detail}` : ''}`, { status });
}

class McpHttpClient {
    /**
     * @param {object} options
     * @param {string} options.url    the server's MCP endpoint
     * @param {string|null} [options.authorizationToken]
     * @param {string} [options.label] name used in error messages
     */
    constructor({ url, authorizationToken = null, label = 'MCP server' }) {
        // Throws for anything that is not a plain http(s) URL, and for a literal
        // private address — the one destination that is knowable before DNS.
        this.url = assertPublicHttpUrl(url, `${label} URL`).toString();
        this.label = label;
        this.token = typeof authorizationToken === 'string' && authorizationToken.trim()
            ? authorizationToken.trim()
            : null;
        this.sessionId = null;
        this.protocolVersion = null;
        this.serverInfo = null;
        this.capabilities = {};
        this.initialized = false;
        this.nextId = 0;
    }

    headers() {
        const headers = {
            'Content-Type': 'application/json',
            // Either shape is acceptable to us; the server picks.
            Accept: 'application/json, text/event-stream',
            'User-Agent': `Clawdia/${CLAWDIA_VERSION} (+https://github.com/TheShield2594/clawdia)`
        };
        if (this.token) {
            // A token pasted with its scheme already on it is passed through, so
            // "Bearer x" does not become "Bearer Bearer x".
            headers.Authorization = /^(bearer|basic|token) /i.test(this.token)
                ? this.token
                : `Bearer ${this.token}`;
        }
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
        return headers;
    }

    async post(payload, { id = null, timeout = CONNECT_TIMEOUT_MS, retryable = true } = {}) {
        let response;
        try {
            response = await axios.post(this.url, payload, {
                headers: this.headers(),
                responseType: 'stream',
                timeout,
                maxRedirects: 3,
                // Non-2xx is read as a body rather than thrown, so the server's
                // own explanation reaches the admin.
                validateStatus: () => true,
                ...guardedAgents()
            });
        } catch (err) {
            throw new McpError(err.message || 'request failed', { code: err.code || null });
        }

        if (response.status === 429 && retryable) {
            // Only when the server said how long, and only when it is a wait a
            // Discord reply can sit through. A 429 with no Retry-After, or one
            // asking for a minute, is an answer rather than a hiccup.
            const wait = retryAfterMs(response.headers['retry-after']);
            if (wait !== null) {
                response.data?.destroy?.();
                await new Promise(resolve => setTimeout(resolve, wait));
                return this.post(payload, { id, timeout, retryable: false });
            }
        }

        if (response.status >= 400) {
            throw httpError(response.status, await collectText(response.data));
        }

        const sessionId = response.headers['mcp-session-id'];
        if (sessionId) this.sessionId = sessionId;

        // 202 is the answer to a notification: accepted, nothing to read.
        if (id === null || response.status === 202) {
            response.data?.destroy?.();
            return null;
        }

        const contentType = String(response.headers['content-type'] || '');
        return contentType.includes('text/event-stream')
            ? readEventStream(response.data, id)
            : parseJsonBody(await collectText(response.data), id);
    }

    async request(method, params, { timeout } = {}) {
        const id = ++this.nextId;
        const message = await this.post({ jsonrpc: '2.0', id, method, params }, { id, timeout });
        return jsonRpcResult(message);
    }

    async notify(method, params) {
        await this.post({ jsonrpc: '2.0', method, params: params ?? {} });
    }

    /** Handshake: initialize, adopt whatever session and version come back, confirm. */
    async initialize() {
        if (this.initialized) return this;

        const result = await this.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            // Empty on purpose: this client answers no server-initiated
            // requests, so it claims no capability that would invite one.
            capabilities: {},
            clientInfo: { name: 'clawdia', version: CLAWDIA_VERSION }
        });

        this.protocolVersion = typeof result.protocolVersion === 'string'
            ? result.protocolVersion
            : PROTOCOL_VERSION;
        this.serverInfo = result.serverInfo || null;
        // What the server says it has. Only ever read to skip a round trip for
        // something it has already said it does not offer, so a server that
        // under-reports costs itself a feature rather than costing us a reply.
        this.capabilities = result.capabilities && typeof result.capabilities === 'object'
            ? result.capabilities
            : {};
        this.initialized = true;

        await this.notify('notifications/initialized');
        return this;
    }

    /**
     * Whether the server said in its handshake that it has this feature.
     *
     * Asked before every list, so the two families a tool loop does not need —
     * resources and prompts — cost nothing at all on a server that has neither.
     */
    supports(feature) {
        const value = this.capabilities?.[feature];
        return Boolean(value) && typeof value === 'object';
    }

    /**
     * Every entry of one paginated list, keyed on the field it arrives under.
     *
     * The three lists differ only in the method name, the array field and what
     * makes an entry usable — a tool or a prompt needs a name, a resource needs
     * a URI — so they share this rather than three copies of the cursor loop.
     */
    async listPaged(method, field, isUsable) {
        await this.initialize();

        const items = [];
        let cursor;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const result = await this.request(method, cursor ? { cursor } : {});
            for (const item of result[field] || []) {
                if (item && typeof item === 'object' && isUsable(item)) items.push(item);
            }
            cursor = result.nextCursor;
            if (!cursor) break;
        }
        return items;
    }

    /**
     * A list the server said it had, or an empty one if it turns out not to.
     *
     * Only for the two families that are asked about because `capabilities`
     * said they exist. A server that advertises resources and then refuses
     * resources/list has answered the question — it has none — and that is
     * worth less than losing a reply over. tools/list is not routed through
     * here: a server with no tools is a connection an admin needs told about.
     */
    async listAdvertised(feature, method, field, isUsable) {
        await this.initialize();
        if (!this.supports(feature)) return [];
        try {
            return await this.listPaged(method, field, isUsable);
        } catch (err) {
            if (err instanceof McpError && err.code === METHOD_NOT_FOUND) return [];
            throw err;
        }
    }

    /** Every tool the server exposes, following pagination to the end. */
    async listTools() {
        return this.listPaged('tools/list', 'tools', tool => typeof tool.name === 'string' && tool.name);
    }

    /**
     * Every resource the server publishes — the documents behind the knowledge
     * side of MCP, each one a URI with a name and usually a description.
     *
     * Resource *templates* (a URI with holes in it, filled in from arguments)
     * are deliberately not listed: nothing here has arguments to fill them with,
     * and a template read with the wrong ones is a request to somebody else's
     * server for a document nobody asked for.
     */
    async listResources() {
        return this.listAdvertised('resources', 'resources/list', 'resources',
            resource => typeof resource.uri === 'string' && resource.uri);
    }

    /**
     * One resource's contents: text blocks, and blobs for anything that is not.
     *
     * Unlike a tool call this is a plain read, so an MCP-level failure is a
     * failure — there is no `isError` shape to hand back, and a caller that
     * cannot read a document has nothing to say about it but so.
     */
    async readResource(uri) {
        await this.initialize();
        const result = await this.request('resources/read', { uri }, { timeout: CALL_TIMEOUT_MS });
        return Array.isArray(result.contents) ? result.contents : [];
    }

    /** Every prompt template the server offers, with the arguments each takes. */
    async listPrompts() {
        return this.listAdvertised('prompts', 'prompts/list', 'prompts',
            prompt => typeof prompt.name === 'string' && prompt.name);
    }

    /**
     * One prompt template, filled in.
     *
     * Arguments are strings on the wire whatever they mean — the spec has no
     * schema for them, only names — so anything else is stringified rather than
     * sent as a shape the server has to guess at.
     */
    async getPrompt(name, args) {
        await this.initialize();

        const argumentStrings = {};
        for (const [key, value] of Object.entries(args && typeof args === 'object' ? args : {})) {
            if (value === undefined || value === null) continue;
            argumentStrings[key] = typeof value === 'string' ? value : String(value);
        }

        const result = await this.request(
            'prompts/get',
            { name, arguments: argumentStrings },
            { timeout: CALL_TIMEOUT_MS }
        );
        return {
            description: typeof result.description === 'string' ? result.description : '',
            messages: Array.isArray(result.messages) ? result.messages : []
        };
    }

    /**
     * Run one tool. The MCP-level failure (`isError`) is returned rather than
     * thrown: "that repository does not exist" is an answer the model should see
     * and work around, not a reason to abandon the reply.
     */
    async callTool(name, args) {
        await this.initialize();
        const result = await this.request(
            'tools/call',
            { name, arguments: args && typeof args === 'object' ? args : {} },
            { timeout: CALL_TIMEOUT_MS }
        );
        return {
            content: Array.isArray(result.content) ? result.content : [],
            structuredContent: result.structuredContent ?? null,
            isError: result.isError === true
        };
    }

    /** Best-effort session teardown. A server without sessions has nothing to do. */
    async close() {
        if (!this.sessionId) {
            this.initialized = false;
            return;
        }
        try {
            await axios.delete(this.url, {
                headers: this.headers(),
                timeout: CONNECT_TIMEOUT_MS,
                validateStatus: () => true,
                ...guardedAgents()
            });
        } catch {
            // Terminating a session is a courtesy; the server times it out anyway.
        }
        this.sessionId = null;
        this.initialized = false;
    }
}

module.exports = {
    McpHttpClient,
    McpError,
    retryAfterMs,
    MAX_RETRY_AFTER_MS,
    METHOD_NOT_FOUND,
    PROTOCOL_VERSION,
    MAX_RESPONSE_BYTES,
    CALL_TIMEOUT_MS
};
