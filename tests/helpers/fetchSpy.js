'use strict';

/**
 * One `fetch` mock covering both of the `fetch`es the code calls.
 *
 * `httpFetch.request` sends a request that carries a guarded dispatcher through
 * the `undici` package's own `fetch` and everything else through the platform
 * one (see `fetchFor` there). A suite that mocks only `globalThis.fetch` would
 * let the guarded requests through to the network, so this installs the same
 * mock on both and hands back a single `jest.fn` to configure and assert on.
 *
 * `mockRestore()` on the returned mock restores both spies, and so does
 * `jest.restoreAllMocks()`.
 *
 * @returns {jest.Mock}
 */
function spyOnFetch() {
    const undici = require('undici');
    const mock = jest.fn();
    const spies = [
        jest.spyOn(globalThis, 'fetch').mockImplementation((...args) => mock(...args)),
        jest.spyOn(undici, 'fetch').mockImplementation((...args) => mock(...args)),
    ];
    mock.mockRestore = () => spies.forEach(spy => spy.mockRestore());
    return mock;
}

module.exports = { spyOnFetch };
