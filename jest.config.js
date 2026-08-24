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

    // Measured at the commit that added this file: statements 33.20,
    // branches 22.29, functions 35.83, lines 34.26 — over 368 files, of which
    // 15 have no executed line at all. Floored to the whole percent below each,
    // which leaves about 70 statements, 70 branches and 75 lines of slack: more
    // than an unrelated refactor moves, less than a deleted test suite.
    //
    // That measurement excluded tests/integration/, whose two suites need a
    // mongod that mongodb-memory-server downloads at run time — CI has it and
    // the machine this was measured on did not. They cover src/models and
    // src/migrations, which are already at 70% and 45% without them, so the
    // number CI sees is under a point higher. These floors are the conservative
    // end of that, which is the right end for a floor.
    coverageThreshold: {
        global: {
            statements: 33,
            branches: 22,
            functions: 35,
            lines: 34,
        },
    },
};
