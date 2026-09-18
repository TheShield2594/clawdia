'use strict';

// Shared CSPRNG helpers for the economy game rolls.
//
// Every mine/hunt/explore/crime roll feeds a payout that is written to the
// weekly-champion leaderboard (src/utils/weeklyChampion.js) and the big-win log
// (src/utils/bigWinLogger.js), and the champion standings decide a prize. That
// makes the rolls a security context: a predictable `Math.random()` sequence
// could be used to steer a payout and so the standings
// (CodeQL js/insecure-randomness). `crypto.randomInt` is not predictable, so
// every roll draws from it. fishService.js already used this exact form for its
// tournament rolls (alert #154); this is the shared home for it.
//
// `secureRandom()` is the drop-in replacement for a `Math.random()` float in
// [0, 1): it keeps 47 bits of resolution, which is ample for these comparisons
// and weightings. (`randomInt` caps its bound at 2**48 - 1, so 2**47 stays
// comfortably in range.)
const { randomInt } = require('crypto');

const RESOLUTION = 2 ** 47;

const cryptoSource = () => randomInt(RESOLUTION) / RESOLUTION;

// The float source, indirected through a variable so a test can drive the game
// rolls deterministically without mocking a global. Production only ever reads
// the crypto source above; `__setRandomSourceForTests` is the sole writer and
// is called only from the test suite (see tests/helpers/secureRandom.js).
let source = cryptoSource;

/** A cryptographically secure float in [0, 1), matching `Math.random()`. */
function secureRandom() {
    return source();
}

/** A secure integer in [min, max], inclusive of both ends. */
function secureRandInt(min, max) {
    return Math.floor(secureRandom() * (max - min + 1)) + min;
}

/** A uniformly chosen element of a non-empty array. */
function securePick(arr) {
    return arr[Math.floor(secureRandom() * arr.length)];
}

// Test seam. Passing a function makes every secureRandom() draw come from it;
// passing nothing restores the crypto source. Never called outside tests.
function __setRandomSourceForTests(fn) {
    source = typeof fn === 'function' ? fn : cryptoSource;
}

module.exports = { secureRandom, secureRandInt, securePick, __setRandomSourceForTests };
