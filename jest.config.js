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

    // Measured by CI over the full suite — 181 suites, 3,139 tests — at the
    // commit that added this file: statements 33.36, branches 22.34, functions
    // 36.09, lines 34.42.
    //
    // Each floor is the whole percent below its measurement, which is not the
    // arbitrary rounding it looks like: because the four denominators differ by
    // most of an order of magnitude, one percent of each works out at a comparable
    // amount of actual code — 122 statements, 79 branches, 54 functions and 125
    // lines of slack. That is more than an unrelated refactor moves and less
    // than a deleted test suite, which is the window a ratchet wants.
    //
    // It is also why these are not rounded up to the nearest percent instead:
    // statements, branches and lines are all under a third of a point clear of
    // the next whole number, so a floor there would fail the run that set it.
    coverageThreshold: {
        global: {
            statements: 33,
            branches: 22,
            functions: 35,
            lines: 34,
        },
    },
};
