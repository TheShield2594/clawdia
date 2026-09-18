'use strict';

/**
 * Drives the game RNG deterministically in tests.
 *
 * The economy services draw their payout-steering rolls from
 * src/utils/secureRandom.js (crypto in production) rather than `Math.random()`,
 * because those payouts feed the weekly-champion leaderboard and the big-win log
 * (CodeQL js/insecure-randomness). A test can no longer pin outcomes by mocking
 * `Math.random` alone.
 *
 * These helpers point BOTH the secureRandom seam AND `Math.random` at the same
 * implementation, so a code path that mixes the two (a service roll plus a
 * command-side `Math.random`) consumes one shared sequence in call order —
 * exactly the behaviour a single `Math.random` mock used to give. `mockRandom`
 * takes the same argument shapes as `jest.spyOn(Math,'random').mock…`:
 *   mockRandom(0.5)            → every draw returns 0.5
 *   mockRandom(() => next())   → every draw calls the function
 * Call `restoreRandom()` in afterEach (safe to call when nothing was mocked).
 */

const secureRandomModule = require('../../src/utils/secureRandom');

function mockRandom(implOrValue) {
    const impl = typeof implOrValue === 'function' ? implOrValue : () => implOrValue;
    secureRandomModule.__setRandomSourceForTests(impl);
    jest.spyOn(Math, 'random').mockImplementation(impl);
    return impl;
}

function restoreRandom() {
    secureRandomModule.__setRandomSourceForTests(null);
    if (jest.isMockFunction(Math.random)) Math.random.mockRestore();
}

module.exports = { mockRandom, restoreRandom };
