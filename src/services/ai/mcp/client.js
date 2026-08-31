'use strict';

const axios = require('axios');
const { guardedAgents, assertPublicHttpUrl } = require('../../../utils/outboundGuard');
const { isOAuthChallenge } = require('./oauth');
const { SseChannel } = require('./sse');
const { version: CLAWDIA_VERSION } = require('../../../../package.json');

/**
 * A small MCP client speaking both of MCP's HTTP transports.
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
 * Two transports, picked by asking rather than by configuration (#838).
 * Streamable HTTP — one endpoint, every request a POST that is answered on its
 * own response — is what this client tries first and what a modern server
 * speaks. A server built against the 2024-11-05 revision answers that POST with
 * a 404 or a 405, because to it the endpoint is a `GET` that opens a standing
 * event stream and names a *second* URL to post to; the handshake falls back to
 * that on those two statuses, and `./sse.js` holds the standing channel. Nothing
 * above `post` knows which one is in use.
 *
 * The URL is a dashboard field, so *the bot* now dials somewhere a guild admin
 * chose. That is the SSRF shape src/utils/outboundGuard.js exists for, and every
 * request here goes through it: literal private addresses are refused up front,
 * and hostnames are checked in the resolver at connect time, on the first
 * request and on every redirect hop. The older transport adds one more address
 * the bot did not choose — the endpoint the server names — and sse.js puts that
 * through the same guard and requires it to be same-origin besides.
 */

// The revision this client implements. A server that negotiates down to an
// older one is honoured by echoing whatever it returns on later requests.
const PROTOCOL_VERSION = '2025-06-18';

// The revision that introduced the transport in ./sse.js, offered when the
// handshake has fallen back to it: a server old enough to speak only HTTP+SSE
// is a server that may not recognise a later revision string.
const SSE_PROTOCOL_VERSION = '2024-11-05';

// What a Streamable HTTP POST looks like when the URL is really an HTTP+SSE
// endpoint. 405 is the server saying POST is not a method it has here; 404 is
// the same answer from a server that routes the two verbs separately. Either
// one, on the handshake, is the cue to try the older transport.
const SSE_FALLBACK_STATUSES = new Set([404, 405]);

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

// JSON-RPC's "it went wrong on my side", which is what a client answers a
// server request it accepted and then could not carry out.
const INTERNAL_ERROR = -32603;

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
 * single JSON body, and put notifications on it before the answer. Those are
 * handed to `onNotification` — `notifications/progress` is a long tool call
 * saying how far it has got, which is the one thing a user watching an
 * ellipsis wants to know — and everything else is skipped. The stream is
 * dropped as soon as the answer arrives: the server is allowed to hold it open
 * afterwards, and waiting that out would stall the turn.
 *
 * A stream can also carry a *request* from the server — an `elicitation/create`
 * asking the person for something the tool needs (#838). Those have both an id
 * and a method, which is what tells them from the two kinds of message that
 * have only one, and they go to `onServerRequest`. It is called and not
 * awaited: answering means asking a human, the reply comes back as a separate
 * POST, and the tool result is still coming down this stream in the meantime.
 */
async function readEventStream(stream, id, onNotification = null, onServerRequest = null) {
    let buffer = '';
    let data = [];

    /**
     * The event just completed, if it was the response being waited for.
     *
     * A notification is delivered on the way past and reported as "not it", so
     * the loop keeps reading. A JSON-RPC notification is a message with a
     * method and no id; a server-initiated request has both; a response to
     * some other request on the same stream has only an id, and is skipped.
     *
     * `method` is tested before the id, and that order is load-bearing. Each
     * side numbers its own outgoing requests, so the two counters share a
     * namespace by accident and will eventually collide — a server that has
     * sent a few requests over a pooled session lands on the id of the call in
     * flight. Matching on the id first would then return the server's
     * *request* as though it were our answer, which reads as a result with no
     * content ("the tool returned no output") while the server waits out a
     * question nobody will ever answer. A message carrying a method is never a
     * response, whatever id it has.
     */
    const finish = () => {
        if (!data.length) return undefined;
        const text = data.join('\n');
        data = [];
        if (!text.trim()) return undefined;

        let message;
        try {
            message = JSON.parse(text);
        } catch {
            return undefined;
        }
        if (!message || typeof message !== 'object') return undefined;
        if (typeof message.method !== 'string') {
            return message.id === id ? message : undefined;
        }

        const listener = message.id === undefined ? onNotification : onServerRequest;
        try {
            // A server request with no handler is answered by the caller's own
            // "method not found", which is `post`'s business rather than this
            // reader's; here there is simply nobody to hand it to.
            if (listener) listener(message);
        } catch (err) {
            // A listener that throws is a bug in whoever is watching, not a
            // reason to lose the tool result still coming down this stream.
            console.warn(`[MCP] ${message.id === undefined ? 'notification' : 'request'} listener failed: ${err.message}`);
        }
        return undefined;
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
    // Batched responses are legal even for a single request, and a batch may
    // carry the server's own requests alongside the answer. `method` rules
    // those out before the id is looked at, for the same reason the event
    // reader does it in that order: the two sides number their requests
    // independently, so an id match alone is not proof of a response.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const match = list.find(m => m && m.id === id && typeof m.method !== 'string');
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

/**
 * A notification handler that reports one request's progress and ignores
 * everything else.
 *
 * The token is echoed back by the server, and the spec allows it to be a string
 * or a number, so the two are compared as text rather than trusting a server to
 * send back the type it was given. `total` is optional — a server that knows it
 * has 40 files to read says so, one that is simply working says only that it is
 * still working — and so is the human-readable `message`.
 */
function progressReader(token, onProgress) {
    return notification => {
        if (notification.method !== 'notifications/progress') return;

        const params = notification.params;
        if (!params || typeof params !== 'object') return;
        if (String(params.progressToken) !== String(token)) return;

        const progress = Number(params.progress);
        if (!Number.isFinite(progress)) return;
        const total = Number(params.total);

        onProgress({
            progress,
            total: Number.isFinite(total) && total > 0 ? total : null,
            message: typeof params.message === 'string' ? params.message : null
        });
    };
}

/**
 * `read`, bounded by what is left of the call's deadline.
 *
 * axios's `timeout` only covers the wait for response *headers*. With
 * `responseType: 'stream'` a server could return `200 text/event-stream` and
 * then never answer the request id, which left the event-stream reader
 * iterating forever — a Discord reply that never finishes, holding one of the
 * per-server slots in connections.js the whole time (#816). The timer destroys
 * the stream as well as rejecting, so the socket is released rather than left
 * open behind a promise nobody is waiting on any more.
 */
async function readWithDeadline(read, stream, deadline) {
    let timer;
    try {
        return await Promise.race([
            read,
            new Promise((_, reject) => {
                const abort = () => {
                    // The read is about to lose the race; whatever destroying
                    // the stream makes it throw has nowhere to go and must not
                    // surface as an unhandled rejection.
                    read.catch(() => {});
                    stream?.destroy?.();
                    reject(new McpError(
                        'the server sent response headers but no answer before the deadline',
                        { code: 'ETIMEDOUT' }
                    ));
                };

                // Re-aimed rather than re-armed. The deadline moves when an
                // elicitation puts the exchange in front of a person (#838),
                // and the two ways to handle that are a timer that fires only
                // to discover it should not have, or the extension moving the
                // timer. The second is one `clearTimeout` per extension
                // instead of one wakeup per deadline, and it keeps this a
                // one-shot timer rather than a self-rescheduling one.
                deadline.reschedule = () => {
                    clearTimeout(timer);
                    timer = setTimeout(abort, Math.max(1, deadline.at - Date.now()));
                    timer.unref?.();
                };
                deadline.reschedule();
            })
        ]);
    } finally {
        deadline.reschedule = null;
        clearTimeout(timer);
    }
}

// HTTP failures are what an admin actually sees when a URL or token is wrong,
// so they say which of the two it probably is.
//
// `challenge` is the server's `WWW-Authenticate` header, carried on the error
// rather than logged: a 401 on a server that wants OAuth is not a bad token, it
// is the first step of the flow (#796), and the dashboard's Connect button
// reads the `resource_metadata` out of it to find the authorization server.
function httpError(status, body, challenge = null) {
    const detail = body.trim().slice(0, 300);
    if (status === 401 || status === 403) {
        const wantsOAuth = status === 401 && isOAuthChallenge(challenge);
        const err = new McpError(
            wantsOAuth
                ? `HTTP 401 — this server wants an OAuth login rather than a token${detail ? `: ${detail}` : ''}`
                : `HTTP ${status} — the server rejected the authorization token${detail ? `: ${detail}` : ''}`,
            { status },
        );
        err.wwwAuthenticate = challenge;
        err.needsOAuth = wantsOAuth;
        return err;
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
     * @param {Function|null} [options.getAccessToken] `({force}) => token|null`
     *        for an OAuth connection (#796). Asked before every request rather
     *        than once at construction, because an access token expires while a
     *        pooled client is sitting idle and the store is what knows when to
     *        refresh. `force` is the 401 path: the server rejected a token this
     *        believed was live, so refresh and try once more.
     * @param {Function|null} [options.onNotification] `(notification) => void`
     *        for every server-sent notification on every stream this client
     *        reads (#838), as opposed to `request`'s per-call `onProgress`,
     *        which is scoped to the one request that asked for it. This is what
     *        `notifications/tools/list_changed` arrives on — a message about the
     *        connection rather than about any one request, and one no caller is
     *        in a position to be waiting for.
     * @param {boolean} [options.elicitation] whether to tell servers this
     *        client can put a question to a person (#838). A declaration rather
     *        than a handler, because the handler is per *request*: this client
     *        is pooled by (url, credential), so one instance is shared by every
     *        guild pointed at that server, and a person to ask belongs to one
     *        Discord message rather than to the connection. The question
     *        arrives on the stream of the tool call that caused it, which is
     *        exactly the scope that knows whose channel to ask in — see
     *        `callTool`'s `onElicit`. A request with nobody behind it is
     *        answered `cancel`, which is the spec's "no choice was made".
     * @param {boolean} [options.sampling] whether to tell servers this client
     *        will run a completion on their behalf (#838). Declared on the
     *        connection and answered per request for the same reason
     *        `elicitation` is: the capability is negotiated once in a handshake
     *        every guild on this URL shares, and the guild whose model, key and
     *        budget would pay for it belongs to one Discord message. A request
     *        with no handler behind it is refused rather than answered, since
     *        there is no "declined" shape for a completion.
     * @param {'auto'|'http'|'sse'} [options.transport] which HTTP transport to
     *        speak (#838). `auto` tries Streamable HTTP and falls back to the
     *        older HTTP+SSE on the handshake's 404 or 405, which is the
     *        negotiation the spec describes and the right answer for a URL an
     *        admin pasted. The two explicit values exist for tests and for a
     *        server whose behaviour is already known.
     */
    constructor({
        url,
        authorizationToken = null,
        label = 'MCP server',
        getAccessToken = null,
        onNotification = null,
        elicitation = false,
        sampling = false,
        transport = 'auto',
    }) {
        // Throws for anything that is not a plain http(s) URL, and for a literal
        // private address — the one destination that is knowable before DNS.
        this.url = assertPublicHttpUrl(url, `${label} URL`).toString();
        this.label = label;
        this.token = typeof authorizationToken === 'string' && authorizationToken.trim()
            ? authorizationToken.trim()
            : null;
        this.getAccessToken = typeof getAccessToken === 'function' ? getAccessToken : null;
        this.onNotification = typeof onNotification === 'function' ? onNotification : null;
        this.elicitation = Boolean(elicitation);
        this.sampling = Boolean(sampling);
        this.transport = ['http', 'sse'].includes(transport) ? transport : 'auto';
        // The standing GET stream of the older transport, and what is still
        // waiting for an answer on it. Both stay empty on Streamable HTTP,
        // where a response arrives on the POST that asked for it.
        this.sse = null;
        this.sseEndpoint = null;
        this.opening = null;
        this.pending = new Map();
        this.sessionId = null;
        this.protocolVersion = null;
        this.serverInfo = null;
        this.capabilities = {};
        this.initialized = false;
        // The handshake in flight, so concurrent callers wait on one rather
        // than each starting their own.
        this.handshake = null;
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

    /**
     * Puts the current OAuth access token on `this.token`, refreshing it if the
     * store says it is due — or, with `force`, whether or not it says so.
     *
     * A connection with no OAuth grant is left exactly as it was, so the static
     * token path is untouched. A store that cannot produce a token is not an
     * error either: the request goes out unauthenticated and fails with the
     * server's own message, which is more useful than one invented here.
     */
    async authorize({ force = false } = {}) {
        if (!this.getAccessToken) return false;
        let token;
        try {
            token = await this.getAccessToken({ force });
        } catch (err) {
            console.warn(`[MCP] could not get an access token for "${this.label}": ${err.message}`);
            return false;
        }
        const changed = Boolean(token) && token !== this.token;
        if (token) this.token = token;
        return changed;
    }

    /**
     * The two notification audiences as one listener, or null when there is
     * neither.
     *
     * A request's own progress reader and the connection-level handler both
     * want every notification on the stream, and neither should be able to stop
     * the other seeing one — so the second is delivered in a `finally`, and a
     * listener that throws costs its own delivery rather than the other's.
     */
    notificationSink(perRequest) {
        if (!this.onNotification) return perRequest || null;
        if (!perRequest) return this.onNotification;
        return notification => {
            try {
                perRequest(notification);
            } finally {
                this.onNotification(notification);
            }
        };
    }

    /**
     * One message to the server, by whichever transport this connection uses.
     *
     * Everything above this — the handshake, the lists, `callTool` — is written
     * against "send this, get that back" and does not know which of the two it
     * is on. The split is here because that is the only place the two differ:
     * Streamable HTTP answers the POST that asked, and HTTP+SSE answers 202 and
     * puts the response on the standing stream some time later.
     */
    async post(payload, options = {}) {
        return this.transport === 'sse'
            ? this.postOverSse(payload, options)
            : this.postOverHttp(payload, options);
    }

    async postOverHttp(payload, { id = null, timeout = CONNECT_TIMEOUT_MS, retryable = true, authRetried = false, onNotification = null, onServerRequest = null } = {}) {
        await this.authorize();

        // One deadline for the whole exchange, headers and body alike. The
        // axios timeout below only bounds the wait for headers; every body
        // read after it gets whatever is left of the same budget.
        // An object rather than a number, because an elicitation moves it: the
        // time a person spends answering the server's question is not time the
        // server spent failing to answer ours.
        const deadline = { at: Date.now() + timeout, reschedule: null };
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
                return this.postOverHttp(payload, { id, timeout, retryable: false, authRetried, onNotification, onServerRequest });
            }
        }

        if (response.status >= 400) {
            // Read before anything decides what to do with it: the body is the
            // server's own explanation and the stream can only be consumed once.
            const body = await readWithDeadline(collectText(response.data), response.data, deadline);
            const challenge = response.headers['www-authenticate'] ?? null;

            // A 401 on an OAuth connection is the ordinary end of an access
            // token's life — one that expired early, a scope that changed, a
            // server that rotated its keys — so it is worth one forced refresh
            // and one retry before it becomes an error somebody has to read.
            // Only once, and only when the refresh actually produced a different
            // token: retrying with the same credential is the same request again.
            if (response.status === 401 && this.getAccessToken && !authRetried
                && await this.authorize({ force: true })) {
                return this.postOverHttp(payload, { id, timeout, retryable, authRetried: true, onNotification, onServerRequest });
            }

            throw httpError(response.status, body, challenge);
        }

        const sessionId = response.headers['mcp-session-id'];
        if (sessionId) this.sessionId = sessionId;

        // 202 is the answer to a notification: accepted, nothing to read.
        if (id === null || response.status === 202) {
            response.data?.destroy?.();
            return null;
        }

        const contentType = String(response.headers['content-type'] || '');
        const read = contentType.includes('text/event-stream')
            ? readEventStream(
                response.data,
                id,
                this.notificationSink(onNotification),
                request => this.answerServerRequest(request, onServerRequest, deadline)
            )
            : collectText(response.data).then(text => parseJsonBody(text, id));
        return readWithDeadline(read, response.data, deadline);
    }

    /**
     * The standing event stream for the older transport, opened once.
     *
     * Coalesced like the handshake is: the first request on a fresh connection
     * is `initialize`, but a pooled client that lost its stream can have several
     * callers discover that at the same moment, and two GETs would be two
     * sessions with the far side answering into whichever stream it opened last.
     */
    async openSseChannel() {
        if (this.sseEndpoint) return this.sseEndpoint;
        if (this.opening) return this.opening;

        this.opening = (async () => {
            await this.authorize();
            const channel = new SseChannel({
                url: this.url,
                headers: () => this.headers(),
                label: this.label,
                onMessage: message => this.dispatchSseMessage(message),
                onClosed: error => this.sseClosed(error),
            });
            const endpoint = await channel.open();
            this.sse = channel;
            this.sseEndpoint = endpoint;
            return endpoint;
        })().finally(() => { this.opening = null; });

        return this.opening;
    }

    /**
     * Route one message off the standing stream.
     *
     * The three shapes are told apart the same way `readEventStream` tells them
     * apart, and for the same reason: a message carrying a `method` is never a
     * response, whatever id it has, because the two sides number their requests
     * independently and will eventually collide.
     *
     * A notification goes to every request still waiting as well as to the
     * connection-level sink. On this transport there is no per-request stream to
     * scope it with — one socket carries everything — so a progress
     * notification is offered to all of them and each ignores what is not its
     * own: `progressReader` already matches on the token, which is exactly the
     * filter that scoping would otherwise have provided.
     */
    dispatchSseMessage(message) {
        if (typeof message.method !== 'string') {
            const waiter = this.pending.get(message.id);
            if (waiter) {
                this.pending.delete(message.id);
                waiter.resolve(message);
            }
            return;
        }

        if (message.id === undefined) {
            for (const waiter of this.pending.values()) {
                try {
                    waiter.onNotification?.(message);
                } catch (err) {
                    console.warn(`[MCP] notification listener failed: ${err.message}`);
                }
            }
            try {
                this.onNotification?.(message);
            } catch (err) {
                console.warn(`[MCP] notification listener failed: ${err.message}`);
            }
            return;
        }

        // A server request — an elicitation, or a request for a completion.
        // Nothing on the wire says which of this connection's in-flight calls it
        // belongs to: the older transport has one stream and no correlation
        // field, and the spec adds none.
        //
        // Guessing is safe only within one turn. This client is pooled by
        // (url, credential), and for a static-token or tokenless server that
        // key has no guild in it — so two guilds pointed at the same public
        // server share one socket, and answering "whichever call is newest"
        // could put guild A's question in guild B's channel and bill B's model
        // budget for it. Inside one turn the same guess is harmless: same
        // person, same channel, same ledger, and the only thing got wrong is
        // which of that turn's calls the question is attributed to.
        //
        // So the turn is what is compared. Where every in-flight call belongs
        // to one, the newest is answered; where they span more than one, the
        // request is refused as unattributable rather than answered by the
        // wrong tenant — `answerServerRequest` declines an elicitation and
        // errors a sampling request, both of which a server can read.
        //
        // The chosen waiter's *deadline* goes with its handlers, and that is
        // load-bearing. The id on this message is the server's own — each side
        // numbers its requests independently — so looking `pending` up by it
        // finds either nothing or an unrelated call of ours that happens to
        // share the number. Either way `extendDeadline` would move a deadline
        // nobody is waiting on, and the call the question actually belongs to
        // would be killed underneath the prompt still sitting in the channel.
        let chosen = null;
        const owners = new Set();
        for (const waiter of this.pending.values()) {
            const offered = waiter.onServerRequest;
            if (!offered || !(offered.elicit || offered.sample)) continue;
            // An unstamped caller counts as its own turn rather than merging
            // with every other unstamped one, so a missing owner can only ever
            // make this more cautious.
            owners.add(offered.owner ?? waiter);
            chosen = waiter;
        }

        if (owners.size > 1) {
            console.warn(
                `[MCP] "${this.label}" sent a ${message.method} while calls from more than one turn were in flight; `
                + 'refusing it rather than answering it as the wrong one'
            );
            chosen = null;
        }

        this.answerServerRequest(message, chosen?.onServerRequest ?? null,
            chosen?.deadline ?? { at: Date.now() + CALL_TIMEOUT_MS, reschedule: null });
    }

    /**
     * The stream ended, so nothing still waiting on it can ever be answered.
     *
     * On Streamable HTTP a dead socket fails the one request that owned it. Here
     * it fails all of them, and takes the session with it — the session *is* the
     * stream, so the next caller has to handshake again rather than posting to
     * an endpoint the server has forgotten.
     */
    sseClosed(error) {
        this.sse = null;
        this.sseEndpoint = null;
        this.initialized = false;
        this.protocolVersion = null;

        const waiters = [...this.pending.values()];
        this.pending.clear();
        for (const waiter of waiters) {
            waiter.reject(new McpError(
                error
                    ? `the server closed the event stream: ${error.message}`
                    : 'the server closed the event stream before answering',
                { sessionExpired: true },
            ));
        }
    }

    /**
     * One message over the older transport: POST to the endpoint the server
     * named, then wait for the answer to arrive on the standing stream.
     *
     * The POST's own response carries nothing — 202 with an empty body is the
     * expected answer, and a body that does come back is discarded — so the
     * waiter is registered *before* the POST goes out. A server fast enough to
     * answer on the stream before its own 202 has been read is otherwise a
     * response with nobody left to give it to.
     */
    async postOverSse(payload, { id = null, timeout = CONNECT_TIMEOUT_MS, onNotification = null, onServerRequest = null } = {}) {
        const endpoint = await this.openSseChannel();

        const deadline = { at: Date.now() + timeout, reschedule: null };
        let waiting = null;
        if (id !== null) {
            waiting = new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject, onNotification, onServerRequest, deadline });
            });
        }

        try {
            await this.deliver(endpoint, payload, { timeout, deadline });
        } catch (err) {
            // Nothing is coming back for this one. The entry goes, and the
            // promise nobody will now await is marked handled — the throw below
            // is what the caller sees.
            if (id !== null) this.pending.delete(id);
            waiting?.catch(() => {});
            throw err;
        }

        if (id === null) return null;

        try {
            return await readWithDeadline(waiting, null, deadline);
        } finally {
            // On the timeout path the entry is still registered, and a late
            // answer arriving against an id nobody is waiting for would sit in
            // the map for the life of the session.
            this.pending.delete(id);
        }
    }

    /**
     * Hand one message to the endpoint the server named, and read nothing back.
     *
     * The POST's own response carries no answer — 202 with an empty body is what
     * a server on this transport returns, and a body that does arrive is
     * discarded — so this returns as soon as the server has accepted it. The
     * answer comes down the standing stream, and the waiter for it was
     * registered before this was called: a server fast enough to answer on the
     * stream before its own 202 has been read is otherwise a response with
     * nobody left to give it to.
     *
     * The two retries are the same two `postOverHttp` does, for the same
     * reasons, and they are why this is a function rather than four lines
     * inline. A 429 naming a wait the turn can afford is worth sitting out
     * rather than reporting; a 401 on an OAuth connection is the ordinary end
     * of an access token's life and is worth one forced refresh. Neither is
     * specific to a transport — the older one carries the same credential to
     * the same kind of server — and a connection that reconnected only on
     * Streamable HTTP would be an OAuth server on this transport failing every
     * time its hourly token expired.
     *
     * The pending waiter survives both: the retry re-sends the same payload
     * under the same id, which is safe precisely because a 429 and a 401 are
     * both the server refusing the message rather than acting on it.
     */
    async deliver(endpoint, payload, { timeout, deadline, retryable = true, authRetried = false }) {
        await this.authorize();

        let response;
        try {
            response = await axios.post(endpoint, payload, {
                headers: this.headers(),
                // The body is empty by design, but a server is free to send one
                // and axios would otherwise buffer it into memory unread.
                responseType: 'stream',
                timeout,
                maxRedirects: 3,
                validateStatus: () => true,
                ...guardedAgents()
            });
        } catch (err) {
            throw new McpError(err.message || 'request failed', { code: err.code || null });
        }

        if (response.status === 429 && retryable) {
            const wait = retryAfterMs(response.headers['retry-after']);
            if (wait !== null) {
                response.data?.destroy?.();
                await new Promise(resolve => setTimeout(resolve, wait));
                return this.deliver(endpoint, payload, { timeout, deadline, retryable: false, authRetried });
            }
        }

        if (response.status >= 400) {
            // Read before anything decides what to do with it: the body is the
            // server's own explanation and the stream can only be consumed once.
            //
            // Under the exchange's deadline, because `responseType: 'stream'`
            // means the axios timeout above bounded the wait for *headers*
            // only. A server that answers 500 and then stalls the body would
            // otherwise hang here forever — and this runs before `postOverSse`
            // installs its own deadline on the reply, so the waiter would sit
            // in `pending` and the caller's promise would never settle either
            // way. `postOverHttp` bounds the identical read.
            const body = await readWithDeadline(collectText(response.data), response.data, deadline);
            const challenge = response.headers['www-authenticate'] ?? null;

            if (response.status === 401 && this.getAccessToken && !authRetried
                && await this.authorize({ force: true })) {
                return this.deliver(endpoint, payload, { timeout, deadline, retryable, authRetried: true });
            }

            throw httpError(response.status, body, challenge);
        }

        response.data?.destroy?.();
        return null;
    }

    /**
     * Answer a request the *server* sent us, on a POST of its own.
     *
     * The transport has no way to write back up the stream a request arrived
     * on, so the answer is an ordinary POST carrying a JSON-RPC response with
     * the server's id on it. Nothing waits for it here: the tool result is
     * still coming down the original stream, and answering an elicitation
     * means asking a person, which takes as long as a person takes.
     *
     * The deadline is pushed out for exactly that reason. Sixty seconds of
     * somebody reading a question is not sixty seconds of the server failing to
     * answer, and without this the tool call the elicitation belongs to would
     * be killed underneath the prompt still sitting in the channel — and the
     * server left holding a request nobody will ever answer.
     *
     * A method this client does not serve is refused with JSON-RPC's own "no
     * such method" rather than ignored, because a server that gets no answer
     * waits for one: an unanswered request is a tool call that hangs until its
     * own deadline instead of failing in a sentence.
     *
     * The two methods it does serve differ in what "nobody is here" means. An
     * elicitation with no handler is answered `cancel` — the spec's "no choice
     * was made", which is exactly what happened. A sampling request has no such
     * shape: its result type is a completion, so the only honest way to say "I
     * will not run one" is an error, which is what `onSample` throwing produces.
     *
     * @param {object} request the server's JSON-RPC request
     * @param {?{elicit: ?Function, sample: ?Function}} handlers the per-request
     *        handlers, which is the scope that knows whose channel to ask in
     *        and whose budget would pay
     * @param {object} deadline the exchange's deadline, pushed out while a
     *        person is being waited on
     */
    async answerServerRequest(request, handlers, deadline) {
        const reply = body => this.post({ jsonrpc: '2.0', id: request.id, ...body })
            .catch(err => console.warn(`[MCP] could not answer "${this.label}"'s ${request.method}: ${err.message}`));

        // Handed to a handler rather than applied around it: only the handler
        // knows how long it is about to be, and a fixed extension would be
        // either too short for a person or long enough to hold a Discord reply
        // open on a server that asked and then went away.
        const extendDeadline = ms => {
            deadline.at = Math.max(deadline.at, Date.now() + ms);
            deadline.reschedule?.();
        };

        const handler = request.method === 'elicitation/create' ? handlers?.elicit
            : request.method === 'sampling/createMessage' ? handlers?.sample
                : undefined;

        if (handler === undefined && !['elicitation/create', 'sampling/createMessage'].includes(request.method)) {
            return reply({ error: { code: METHOD_NOT_FOUND, message: `${request.method} is not supported by this client` } });
        }
        if (typeof handler !== 'function') {
            // The capability is the connection's and the person is the
            // request's, so a scheduled task or a command parsing the reply as
            // JSON reaches here with nobody behind it.
            return request.method === 'elicitation/create'
                ? reply({ result: { action: 'cancel' } })
                : reply({ error: { code: INTERNAL_ERROR, message: 'no user is available to authorise this request' } });
        }

        try {
            return reply({ result: await handler(request.params ?? {}, { extendDeadline }) });
        } catch (err) {
            console.warn(`[MCP] "${this.label}" asked for ${request.method} and it failed: ${err.message}`);
            return reply({ error: { code: INTERNAL_ERROR, message: err.message || 'the client could not answer' } });
        }
    }

    /**
     * One JSON-RPC request.
     *
     * `onProgress` is opt-in per request because the token is what asks for the
     * notifications: a server sends them only for a request that carried one,
     * so a caller with nothing to show is not sent updates it would throw away.
     * The request id doubles as the token — it is already unique per connection,
     * which is what the spec asks of it.
     *
     * `onElicit` and `onSample` are opt-in for a different reason: both end at a
     * person — one answering a question, one approving a spend — and a request
     * is the smallest scope that knows which one (#838).
     */
    async request(method, params, { timeout, onProgress, onElicit, onSample, owner = null } = {}) {
        const id = ++this.nextId;
        const wantsProgress = typeof onProgress === 'function';
        const body = wantsProgress
            ? { ...(params && typeof params === 'object' ? params : {}), _meta: { progressToken: id } }
            : params;

        const message = await this.post(
            { jsonrpc: '2.0', id, method, params: body },
            {
                id,
                timeout,
                onNotification: wantsProgress ? progressReader(id, onProgress) : null,
                onServerRequest: { elicit: onElicit, sample: onSample, owner },
            }
        );
        return jsonRpcResult(message);
    }

    async notify(method, params) {
        await this.post({ jsonrpc: '2.0', method, params: params ?? {} });
    }

    /**
     * Handshake: initialize, adopt whatever session and version come back, confirm.
     *
     * Coalesced, because there are three families of request now and nothing
     * orders them: a `/ai mcp prompts` landing while a message is reading the
     * same server's resources would otherwise open two handshakes on one
     * client, and the second `notifications/initialized` would arrive against
     * whichever session id came back last.
     */
    async initialize() {
        if (this.initialized) return this;
        if (this.handshake) return this.handshake;

        this.handshake = this.handshakeOnce().finally(() => { this.handshake = null; });
        return this.handshake;
    }

    /**
     * Negotiate the transport, then handshake over whichever one answered.
     *
     * The spec's own backwards-compatibility recipe: POST an initialize and, if
     * the server rejects the method or has nothing at that path for POST, treat
     * that as "this is the older transport" and open the GET stream instead.
     * Only on the handshake — a 404 later is a session the server has forgotten,
     * which is a different thing with a different fix — and only once, because
     * a second failure is a URL that is not an MCP endpoint at all and the
     * admin needs told that rather than told about SSE.
     *
     * A successful fallback sticks for the life of the client, so the cost is
     * one refused POST per connection rather than per request. A failed one is
     * undone, and the error an admin is shown is the *first* one — a URL with
     * no MCP server behind it fails both ways, and "no MCP endpoint at this
     * URL" is what is wrong with it. Reporting the second failure instead would
     * answer a pasted typo with a sentence about event streams.
     */
    async handshakeOnce() {
        try {
            return await this.negotiate();
        } catch (err) {
            if (this.transport !== 'auto' || !(err instanceof McpError) || !SSE_FALLBACK_STATUSES.has(err.status)) {
                throw err;
            }

            this.transport = 'sse';
            try {
                const client = await this.negotiate();
                console.log(`[MCP] "${this.label}" refused a Streamable HTTP POST (HTTP ${err.status}); connected over the older HTTP+SSE transport instead`);
                return client;
            } catch (sseErr) {
                // The stream may well be up — a server can name an endpoint and
                // then fail the initialize behind it — and this client is about
                // to go back to speaking Streamable HTTP, where nothing reads
                // it. Left open it is a socket held for the life of the pooled
                // client with no reader and no session behind it.
                await this.close();
                this.transport = 'auto';
                console.warn(`[MCP] "${this.label}" answered neither transport; the HTTP+SSE attempt said: ${sseErr.message}`);
                throw err;
            }
        }
    }

    async negotiate() {
        const result = await this.request('initialize', {
            // A server old enough to speak only HTTP+SSE predates every later
            // revision string, and some of them refuse one they do not know
            // rather than negotiating down.
            protocolVersion: this.transport === 'sse' ? SSE_PROTOCOL_VERSION : PROTOCOL_VERSION,
            capabilities: this.clientCapabilities(),
            clientInfo: { name: 'clawdia', version: CLAWDIA_VERSION }
        });

        this.protocolVersion = typeof result.protocolVersion === 'string'
            ? result.protocolVersion
            : (this.transport === 'sse' ? SSE_PROTOCOL_VERSION : PROTOCOL_VERSION);
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
     * What this client tells a server it will answer.
     *
     * Read off the handlers it was actually given, because a capability is a
     * promise: a server that is told `elicitation` and then gets "no such
     * method" has been sent down a path that ends in a tool call hanging until
     * its deadline. Declaring nothing is the honest answer for a caller with no
     * person to ask — a scheduled task, a command parsing the reply as JSON —
     * and it is also what this client did in every case before (#838).
     *
     * `roots` stays absent on purpose rather than by omission. It is the
     * client offering a filesystem for a server to work inside, and this client
     * is a Discord bot: there is no project directory a guild's question is
     * being asked about, and the honest answer to "what are your roots" is that
     * there are none.
     */
    clientCapabilities() {
        const capabilities = {};
        if (this.elicitation) capabilities.elicitation = {};
        if (this.sampling) capabilities.sampling = {};
        return capabilities;
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
    async callTool(name, args, { onProgress, timeout, onElicit, onSample, owner } = {}) {
        await this.initialize();
        // A caller with a deadline of its own can ask for less than the call
        // timeout, never more: a tool that answers in forty seconds is still a
        // tool the reply cannot wait for once the turn has ten left. The
        // handshake above keeps its own connect timeout either way.
        const limit = Number.isFinite(timeout)
            ? Math.max(1, Math.min(CALL_TIMEOUT_MS, timeout))
            : CALL_TIMEOUT_MS;

        const result = await this.request(
            'tools/call',
            { name, arguments: args && typeof args === 'object' ? args : {} },
            // Both handlers ride with the call rather than with the
            // connection: a question this tool raises, or a completion it wants
            // paid for, belongs to the message that asked for it, and the
            // pooled client is shared by every guild on this URL.
            { timeout: limit, onProgress, onElicit, onSample, owner }
        );
        return {
            content: Array.isArray(result.content) ? result.content : [],
            structuredContent: result.structuredContent ?? null,
            isError: result.isError === true
        };
    }

    /** Best-effort session teardown. A server without sessions has nothing to do. */
    async close() {
        // On the older transport the session *is* the standing stream: there is
        // no id to DELETE, and dropping the socket is what ends it. Done before
        // the early return below, since that transport never sets a session id.
        if (this.sse) {
            this.sse.close();
            this.sse = null;
            this.sseEndpoint = null;
        }

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
    SSE_PROTOCOL_VERSION,
    McpError,
    INTERNAL_ERROR,
    retryAfterMs,
    progressReader,
    MAX_RETRY_AFTER_MS,
    METHOD_NOT_FOUND,
    PROTOCOL_VERSION,
    MAX_RESPONSE_BYTES,
    CALL_TIMEOUT_MS
};
