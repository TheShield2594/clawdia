'use strict';

/**
 * Promise handles a test can settle when it chooses (#949).
 *
 * The alternative these replace is ordering by elapsed time: make one operation
 * sleep 10ms and another 1ms, and assert on what finished first. That is a
 * statement about a loaded CI runner rather than about the code — a scheduler
 * that delays the short sleep past the long one turns a correct implementation
 * red, and the failure looks like a bug in whatever it was testing.
 *
 * With a handle, the order is chosen rather than raced: the test starts both,
 * waits until both are genuinely in flight, and settles them in the order it
 * wants to prove is handled. Nothing sleeps, and the assertion says what it
 * means.
 *
 * Four suites had already grown their own copy of this by the time it was
 * worth sharing; they all use this one now.
 */

/** `{ promise, resolve, reject }` for a promise nothing settles on its own. */
function deferred() {
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    return { promise, ...settle };
}

/**
 * A set of handles keyed by name, plus the `started` half.
 *
 * The two-sided shape is what makes a concurrency assertion sound: `started`
 * says the work is genuinely in flight, so a test can wait for *both* before
 * settling either — which is what proves the two ran at once, rather than
 * inferring it from a peak counter that a sequential implementation could also
 * reach if the timing fell out that way.
 *
 * @param {string[]} names
 * @returns {{started: object, finish: object, allStarted: () => Promise<void>}}
 */
function gates(names) {
    const started = Object.fromEntries(names.map(name => [name, deferred()]));
    const finish = Object.fromEntries(names.map(name => [name, deferred()]));
    return {
        started,
        finish,
        allStarted: () => Promise.all(names.map(name => started[name].promise)),
    };
}

module.exports = { deferred, gates };
