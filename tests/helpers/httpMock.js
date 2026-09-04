'use strict';

/**
 * One `fetch` mock, split back into per-method handlers (#932).
 *
 * The MCP suites were written against `axios.get` and `axios.post` as separate
 * mocks, and that separation is not incidental: on the HTTP+SSE transport the
 * GET *is* the standing event stream and the POSTs are the messages, so a test
 * describes two quite different servers. `fetch` is one function, so this puts
 * the split back — and the handlers keep the `(url, payload)` shape the axios
 * ones had, because that is what the tests are actually about.
 *
 * `payload` is the request body parsed back from JSON, since that is what these
 * call sites send and what every assertion here reads. A body that is not JSON
 * is passed through untouched, and the raw init is always the third argument.
 */

/**
 * Installs the mock on `globalThis.fetch`.
 *
 * Call it from a `beforeEach`: the suites that use this also restore mocks
 * between tests, and a spy installed once at module load would not survive.
 *
 * @returns {{get: jest.Mock, post: jest.Mock, del: jest.Mock, fetch: jest.Mock}}
 */
function installHttpMock() {
    const get = jest.fn();
    const post = jest.fn();
    const del = jest.fn();
    const byMethod = { GET: get, POST: post, DELETE: del };

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        const handler = byMethod[method];
        // Not a silent undefined: a request this suite never described is a bug
        // in the test or a call the code was not supposed to make.
        if (!handler) throw new Error(`unexpected ${method} ${url}`);
        return handler(url, parseBody(init.body), init);
    });

    return { get, post, del, fetch: fetchMock };
}

function parseBody(body) {
    if (typeof body !== 'string') return body;
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

module.exports = { installHttpMock };
