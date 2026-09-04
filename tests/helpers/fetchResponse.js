'use strict';

/**
 * Response builders for the suites that mock `fetch` (#932).
 *
 * These build *real* `Response` objects rather than the `{ status, headers,
 * data }` literals the axios mocks used to hand back. That matters more than it
 * looks: the code under test reads `headers.get()`, branches on `body === null`,
 * and wraps the body with `Readable.fromWeb` — all of which a hand-written
 * literal would have to imitate, and would imitate slightly wrong. A `Response`
 * also enforces the rules a server is held to (no body on a 204, a header name
 * that is actually a header name), so a test cannot describe a response no
 * server could send.
 *
 * The one thing they do not do is fail: a test that wants a connection error
 * rejects the `fetch` mock itself, which is what `fetch` does for that case.
 */

const { Readable } = require('stream');

/**
 * A body in whichever shape the caller had: text, a Buffer, a Node stream, or
 * anything iterable. `null` for the responses that have none.
 */
function bodyOf(body) {
    if (body === null || body === undefined) return null;
    if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
    const stream = typeof body.pipe === 'function' ? body : Readable.from(body);
    return Readable.toWeb(stream);
}

/** A response with an explicit content type. */
function response(body, { status = 200, headers = {} } = {}) {
    return new Response(bodyOf(body), { status, headers });
}

/** `application/json`, from a value that is serialised here. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

/** `text/plain`, for the bodies that are a server's own explanation. */
function textResponse(body, status = 200, headers = {}) {
    return response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

/**
 * `text/event-stream`, from a list of JSON-RPC messages.
 *
 * Every message is sent as one `message` event, which is the shape both of this
 * tree's SSE readers are written against.
 */
function sseResponse(events, { status = 200, headers = {} } = {}) {
    const text = events.map(event => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join('');
    return response(text, {
        status,
        headers: { 'content-type': 'text/event-stream', ...headers },
    });
}

/** 202 with no body: what a server returns for a notification. */
function acceptedResponse() {
    return new Response(null, { status: 202 });
}

/**
 * The JSON body a `fetch` mock was called with.
 *
 * Assertions used to read `axios.post.mock.calls[n][1]` — the payload object,
 * because axios serialised it. `fetch` is given the string, so the tests parse
 * it back rather than each writing the same `JSON.parse`.
 */
function payloadOf(call) {
    return JSON.parse(call[1].body);
}

module.exports = {
    response,
    jsonResponse,
    textResponse,
    sseResponse,
    acceptedResponse,
    payloadOf,
};
