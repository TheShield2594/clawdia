'use strict';

// Coverage measurement and the ratchet that holds it in place (#625, #635).
//
// Two things were missing and they only work together. Jest's default
// `collectCoverageFrom` counts a file only once some test requires it, so the
// reported percentage is a percentage of the code that is *already* tested —
// it goes up when you delete a test file and it never mentions the 15 files no
// test has ever loaded. And CI ran `npm test` with no threshold at all, so a
// slide from 33% to 10% would have been green.
//
// So: measure over all of src/, and fail the run if the numbers go backwards.
// The thresholds below are a ratchet, not a target. They are set just under
// the measured coverage of the commit that introduced them, which means the
// only way past them is to add tests. Raise them when coverage rises; the
// point is that nothing can quietly lower them.

module.exports = {
    collectCoverageFrom: [
        'src/**/*.js',
        // Chart.js, copied in verbatim and minified by scripts/vendor-chartjs.sh
        // (#685). eslint.config.js and .prettierignore skip it for the same
        // reason: it is not ours to test. Counted, it is 5,083 uncovered
        // statements and 4,590 uncovered branches — 13% and 17% of the
        // respective denominators — so leaving it in would let an upstream
        // Chart.js bump move this repo's coverage number.
        '!src/dashboard/public/vendor/**',
    ],

    // text-summary prints the four numbers into the CI log next to whichever
    // threshold failed; json-summary and lcov are the machine-readable forms,
    // for the step summary below and for anything reading coverage later.
    coverageReporters: ['text-summary', 'json-summary', 'lcov'],

    // Measured over the suite at the commit that raised these — 349 suites,
    // 6,893 tests, integration excluded: statements 51.49, branches 41.60,
    // functions 54.10, lines 52.77. Raised from 49/39/50/50 by the achievement
    // audit's suite and the economy audit of #873, which added the duel escrow,
    // crew-share and credit-or-owe suites; the measurement excludes the three
    // integration suites, so the number CI sees is this or better.
    //
    // Each floor is the whole percent below its measurement, which is not the
    // arbitrary rounding it looks like: because the four denominators differ by
    // most of an order of magnitude, one percent of each works out at a comparable
    // amount of actual code — 379 statements, 263 branches, 56 functions and 333
    // lines of slack. That is more than an unrelated refactor moves and less
    // than a deleted test suite, which is the window a ratchet wants.
    //
    // It is also why these are not rounded up to the nearest percent instead:
    // when they were last set, branches measured 36.00 on the nose and functions
    // 46.94, so a floor at the next whole number would have left none and 0.06 of
    // a point of headroom — less than an unrelated refactor moves, and enough to
    // fail the run after the one that set it.
    coverageThreshold: {
        global: {
            statements: 50,
            branches: 40,
            functions: 53,
            lines: 51,
        },
    },
};
