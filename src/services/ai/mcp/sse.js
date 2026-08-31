'use strict';

const axios = require('axios');
const { guardedAgents, assertPublicHttpUrl } = require('../../../utils/outboundGuard');

/**
 * The MCP transport that came before Streamable HTTP (#838).
 *
 * Protocol revision 2024-11-05 split a connection in two. The client opens a
 * long-lived `GET` that answers `text/event-stream` and holds it for the life of
 * the session; the server's first event on it is `endpoint`, naming a second URL
 * to POST to. Every request the client sends goes to that URL and is answered
 * `202 Accepted` with an empty body — the actual JSON-RPC response arrives, some
 * time later, back down the standing stream, matched to its request by id.
 *
 * Streamable HTTP folded both halves into one endpoint, and this client speaks
 * that. But a large number of deployed servers still speak only the older one —
 * Atlassian's hosted endpoint is the reason src/dashboard/routes/api/mcpServers.js
 * carried a note about a preset it could not ship — and to those servers a bare
 * POST is a 404 or a 405 with no way to complete a handshake.
 *
 * So this is the second half: a standing channel that resolves to the endpoint
 * URL the server names, demultiplexes everything that arrives on it, and stays
 * open until the client closes it or the far side hangs up.
 *
 * Two properties this file is responsible for, both because the endpoint URL is
 * chosen by somebody else's server:
 *
 *   - It goes through outboundGuard like every other address a guild admin can
 *     influence. A server that answers `endpoint` with `http://169.254.169.254/`
 *     is asking the bot to POST to a metadata service on its behalf.
 *   - It has to be same-origin with the URL the admin configured. The guard
 *     stops the private-address case; same-origin stops the rest — an endpoint
 *     pointing at another public host would send that server's credential, and
 *     the guild's tool arguments, somewhere the admin never named.
 */

// Per event, not per connection. The standing stream is open for the life of the
// session and carries every response the server sends, so a cumulative cap would
// simply be a slow timer on a working connection; what actually needs bounding
// is one message, which is what a caller parses into memory.
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

// How long the server has to name its endpoint before the channel is judged not
// to speak this transport at all. Short: this runs inside a handshake somebody
// is waiting on, and a server that answers `text/event-stream` and then says
// nothing is a wrong URL far more often than it is a slow one.
const ENDPOINT_TIMEOUT_MS = 15000;

/**
 * Feed an SSE byte stream to `onEvent`, one `{ event, data }` at a time.
 *
 * A hand-rolled parser rather than a dependency, and a second one in this
 * package rather than a shared one with client.js's `readEventStream`, because
 * the two want different things. That reader is looking for one response and
 * stops at it; this one never stops, has no request of its own, and needs the
 * `event:` field — which the other deliberately ignores, since on a Streamable
 * HTTP POST every event is a message.
 *
 * Fields other than `event` and `data` (`id`, `retry`) are parsed and dropped:
 * MCP uses neither, and last-event-id resumption is a Streamable HTTP feature.
 */
async function pumpEvents(stream, onEvent) {
    let buffer = '';
    let event = null;
    let data = [];
    // What the event being assembled has cost so far. The cap has to be against
    // this rather than against `buffer` alone: `buffer` is drained of every
    // complete line on each pass, so a server sending one enormous event as ten
    // thousand short `data:` lines keeps it small the whole way down while the
    // array behind it grows without limit. `buffer` is still counted, for the
    // opposite shape — a single huge line with no newline in it, which never
    // reaches `data` at all.
    let eventBytes = 0;

    const dispatch = () => {
        if (data.length) onEvent({ event, data: data.join('\n') });
        event = null;
        data = [];
        eventBytes = 0;
    };

    const refuseIfTooBig = extra => {
        if (eventBytes + extra <= MAX_EVENT_BYTES) return;
        stream.destroy();
        throw new Error(`event exceeded ${MAX_EVENT_BYTES} bytes`);
    };

    for await (const chunk of stream) {
        buffer += chunk.toString('utf8');

        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);

            if (line === '') { dispatch(); continue; }
            if (line.startsWith(':')) continue;

            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            else if (field === 'data') {
                // Checked as the line lands, not once the chunk is drained: the
                // blank line that ends an event resets the counter, so a
                // too-large event that arrives complete in one read would be
                // dispatched and forgotten before any check after this loop.
                data.push(value);
                eventBytes += value.length;
                refuseIfTooBig(0);
            }
        }

        // What is left in `buffer` is a line with no newline yet, which the
        // counter above cannot see: the other shape of an oversized event is a
        // single unterminated line that never reaches `data` at all.
        refuseIfTooBig(buffer.length);
    }

    // A stream that ends without a trailing blank line still carries its last
    // event, and on this transport that event is somebody's tool result.
    dispatch();
}

/**
 * Resolve the URL a server named in its `endpoint` event.
 *
 * Relative in every implementation seen in the wild — `/messages?sessionId=…` —
 * which is why it is resolved against the configured URL rather than parsed on
 * its own, and why same-origin is a check rather than a given.
 *
 * @param {string} raw the event's data
 * @param {string} base the URL the admin configured
 * @param {string} label the server's name, for the error an admin reads
 * @returns {string}
 */
function resolveEndpoint(raw, base, label) {
    let endpoint;
    try {
        endpoint = new URL(String(raw).trim(), base);
    } catch {
        throw new Error(`${label} named an endpoint that is not a URL: ${String(raw).slice(0, 120)}`);
    }

    if (endpoint.origin !== new URL(base).origin) {
        throw new Error(
            `${label} pointed its message endpoint at ${endpoint.origin}, which is not the host it was configured as. `
            + 'Refusing to send this server\'s credential somewhere else.'
        );
    }

    // The origin is the configured one, so this can only fail for a URL that was
    // never dialable — but it is the same guard every other address goes
    // through, and it is cheap.
    return assertPublicHttpUrl(endpoint.toString(), `${label} message endpoint`).toString();
}

/**
 * The standing GET stream for one HTTP+SSE session.
 *
 * Owned by the client that made it: `open()` resolves once the server has named
 * its message endpoint, `onMessage` gets every JSON-RPC message that follows,
 * and `onClosed` fires exactly once when the stream ends for any reason — which
 * is the client's cue to fail everything still waiting for an answer, because on
 * this transport a closed stream is the only way a pending request can ever
 * learn it will not be answered.
 */
class SseChannel {
    /**
     * @param {object} options
     * @param {string} options.url the configured MCP endpoint, dialled with GET
     * @param {Function} options.headers `() => object`, asked at open time so an
     *        OAuth access token refreshed since construction is the one used
     * @param {string} options.label the server's name, for messages
     * @param {Function} options.onMessage `(message) => void` per JSON-RPC message
     * @param {Function} options.onClosed `(error|null) => void`, once
     */
    constructor({ url, headers, label, onMessage, onClosed }) {
        this.url = url;
        this.headers = headers;
        this.label = label;
        this.onMessage = onMessage;
        this.onClosed = onClosed;
        this.stream = null;
        this.closed = false;
        this.endpoint = null;
    }

    /** @returns {Promise<string>} the message endpoint the server named */
    async open() {
        let response;
        try {
            response = await axios.get(this.url, {
                headers: { ...this.headers(), Accept: 'text/event-stream' },
                responseType: 'stream',
                // Headers only, which is the whole point: the body is the
                // session and must not be on a clock.
                timeout: ENDPOINT_TIMEOUT_MS,
                maxRedirects: 3,
                validateStatus: () => true,
                ...guardedAgents(),
            });
        } catch (err) {
            throw new Error(err.message || 'could not open the event stream', { cause: err });
        }

        if (response.status >= 400) {
            response.data?.destroy?.();
            throw new Error(`HTTP ${response.status} opening the event stream`);
        }
        if (!String(response.headers['content-type'] || '').includes('text/event-stream')) {
            response.data?.destroy?.();
            throw new Error('the server did not answer the event stream with text/event-stream');
        }

        this.stream = response.data;

        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.close();
                reject(new Error(`${this.label} opened a stream but never named its message endpoint`));
            }, ENDPOINT_TIMEOUT_MS);
            timer.unref?.();

            const fail = err => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            };

            pumpEvents(this.stream, ({ event, data }) => {
                if (!settled && event === 'endpoint') {
                    let endpoint;
                    try {
                        endpoint = resolveEndpoint(data, this.url, this.label);
                    } catch (err) {
                        this.close();
                        fail(err);
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    this.endpoint = endpoint;
                    resolve(endpoint);
                    return;
                }

                // Every non-endpoint event on this transport is a message. The
                // `event:` name is not read: servers variously send `message`,
                // nothing at all, and their own labels, and the payload is
                // self-describing JSON-RPC either way.
                if (event === 'endpoint') return;
                let message;
                try {
                    message = JSON.parse(data);
                } catch {
                    return;   // Not JSON: a keepalive or a server's own noise.
                }
                if (message && typeof message === 'object') this.onMessage(message);
            })
                .then(() => this.finish(null), err => this.finish(err))
                // The endpoint promise is what a caller is waiting on before the
                // channel is up; after that, a stream ending is `onClosed`'s
                // business and this must not reject into nowhere.
                .then(() => fail(new Error(`${this.label} closed the event stream before naming an endpoint`)));
        });
    }

    /** Fires `onClosed` once, whatever ended the stream. */
    finish(error) {
        if (this.closed) return;
        this.closed = true;
        this.onClosed(error);
    }

    close() {
        this.stream?.destroy?.();
        this.finish(null);
    }
}

module.exports = { SseChannel, pumpEvents, resolveEndpoint, MAX_EVENT_BYTES, ENDPOINT_TIMEOUT_MS };
