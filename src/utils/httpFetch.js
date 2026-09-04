'use strict';

/**
 * What axios did for this codebase that `fetch` does not (#932).
 *
 * Migrating to the platform client is mostly a change of spelling — `data`
 * becomes a body reader, `validateStatus: () => true` becomes the default, a
 * lowercase header map becomes `headers.get()`. Four things are not spellings
 * at all, though, and each one was load-bearing somewhere:
 *
 *   - a readable error. `fetch` reports every transport failure as
 *     `TypeError: fetch failed` and hangs the real one off `cause`. The real
 *     one is the whole message here — "Refusing to connect to 169.254.169.254"
 *     is what an admin who typed a bad MCP URL needs to read, and it is what
 *     outboundGuard exists to produce.
 *   - `timeout`, which on a streamed response bounded the wait for *headers*
 *     and not the body. Several callers depend on exactly that: the MCP
 *     transports put their own deadline on the read, and an SSE channel is a
 *     body that is supposed to stay open for the session.
 *   - `responseType: 'stream'`, which handed back a Node `Readable`. Everything
 *     that reads a body here — the event-stream parsers, the NDJSON reader — is
 *     written against Node stream iteration and `destroy()`.
 *   - `maxContentLength`, which refused a body past a size rather than buffering
 *     whatever somebody else's server decided to send.
 *
 * None of them is worth a dependency, and each is a few lines here. There is
 * deliberately no `get`/`post`/`json` layer on top: `request` takes and returns
 * exactly what `fetch` does, so there is still one request idiom in the tree.
 *
 * One behaviour did change with the move. axios capped redirects per call
 * (three for discovery and the MCP transports, zero where a credential is
 * sent); `fetch` has no such option, so a bounded follow is now its own default
 * of twenty and a *refused* follow is `redirect: 'manual'`, which the two
 * credential-carrying OAuth posts use. Every hop is still dialled through the
 * caller's dispatcher, so the SSRF guarantee is unchanged either way — and on a
 * cross-origin hop `fetch` drops the `Authorization` header, which axios did
 * not.
 */

const { Readable } = require('stream');

/**
 * `fetch`, with the reason a request failed left where a caller will read it.
 *
 * `TypeError: fetch failed` is what every connection failure looks like from
 * outside — a refused private address, a name that does not resolve, a reset
 * mid-handshake — with the sentence that says which one on `cause`. Almost
 * every caller here puts `err.message` in front of a person, so the cause is
 * promoted to the message and its `code` (`EPRIVATEADDR`, `ECONNREFUSED`,
 * `ENOTFOUND`) is carried along beside it.
 *
 * An abort is left alone: `AbortSignal.timeout` and an explicit `abort(reason)`
 * both reject with the reason itself and never set `cause`, so a timeout still
 * arrives spelled the way the caller spelled it.
 *
 * `timeout` is an init field here as it was an axios config field, and it
 * bounds the whole request — headers and body. `fetch` ignores init keys it
 * does not know, so the number stays on the request description rather than
 * being turned into a signal at every call site and disappearing.
 */
async function request(url, init = {}) {
    const signal = init.signal
        ?? (Number.isFinite(init.timeout) ? AbortSignal.timeout(init.timeout) : undefined);
    try {
        return await fetch(url, { ...init, signal });
    } catch (err) {
        const cause = err?.cause;
        if (!cause?.message) throw err;
        const error = new Error(cause.message, { cause: err });
        error.code = cause.code ?? err.code ?? null;
        throw error;
    }
}

/**
 * `request`, with `timeout` bounding the wait for response *headers* only.
 *
 * The timer is cleared the moment the headers land, so the body is left
 * unbounded on purpose — a caller that streams either wants no clock on the
 * body (an SSE session) or puts its own deadline on the read, which is the
 * one that can be extended while a person answers an elicitation. Use
 * `request` for the requests that should be bounded end to end; this is the
 * other case, and the two are spelled differently so a reader can tell which
 * one a call site chose.
 *
 * The abort reason is spelled the way axios spelled it, because it reaches an
 * admin through the MCP error path and "timeout of 15000ms exceeded" is what
 * the existing messages are written against.
 *
 * @param {string} url
 * @param {object} init `fetch` init plus `timeout`, minus `signal` — this owns that
 * @returns {Promise<Response>}
 */
async function fetchHeaders(url, init) {
    const { timeout } = init;
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error(`timeout of ${timeout}ms exceeded`)),
        timeout,
    );
    timer.unref?.();
    try {
        return await request(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A response body as a Node `Readable`.
 *
 * `Readable.fromWeb` rather than iterating the web stream directly, because
 * `destroy()` is how every reader in this tree lets go of a body it has
 * finished with or refuses to finish — and on the wrapper that cancels the
 * underlying stream, which is what actually releases the socket.
 *
 * A 204, a HEAD, or a body already consumed has `body === null`; an empty
 * stream stands in for it so callers do not each need the null branch.
 */
function bodyStream(response) {
    return response.body ? Readable.fromWeb(response.body) : Readable.from([]);
}

/**
 * The whole body as a Buffer, refusing anything past `limit` bytes.
 *
 * Read chunk by chunk rather than `arrayBuffer()` and a length check after: the
 * point of the limit is not to end up holding what a server sent, and a check
 * on the finished buffer has already lost that. `Content-Length` is not trusted
 * for it either — it is somebody else's number, and a chunked response has none.
 *
 * @throws {Error} `code: 'ETOOLARGE'` once the limit is passed
 */
async function readCapped(response, limit) {
    const chunks = [];
    let seen = 0;
    for await (const chunk of bodyStream(response)) {
        seen += chunk.length;
        if (seen > limit) {
            const error = new Error(`response exceeded ${limit} bytes`);
            error.code = 'ETOOLARGE';
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/** `readCapped`, as UTF-8 text. */
async function readCappedText(response, limit) {
    return (await readCapped(response, limit)).toString('utf8');
}

module.exports = { request, fetchHeaders, bodyStream, readCapped, readCappedText };
