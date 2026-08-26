'use strict';

const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const config = require('../jest.config.js');
const pkg = JSON.parse(read('package.json'));
const ci = read('.github/workflows/ci.yml');

// #625/#635: coverage was 16% and nothing measured it. Two separate holes.
//
// Jest's default `collectCoverageFrom` only counts files some test already
// requires, so the reported number describes the tested subset of the codebase
// and rises when a test is deleted — the 171 files with no executed line were
// simply absent from it. And CI ran `npm test` bare, so no threshold applied
// even once the measurement was right.
//
// Both halves are load-bearing and both are one line to undo, which is what
// this file is here to notice.
describe('coverage ratchet', () => {
    test('coverage is measured over all of src, not just the tested part', () => {
        expect(config.collectCoverageFrom).toContain('src/**/*.js');
    });

    // The vendored Chart.js bundle is the one exclusion: minified, third-party
    // and copied in verbatim, so an upstream bump would otherwise move this
    // repo's coverage number. eslint.config.js and .prettierignore skip it too.
    test('the only exclusion is the vendored bundle', () => {
        const negated = config.collectCoverageFrom.filter(pattern => pattern.startsWith('!'));
        expect(negated).toEqual(['!src/dashboard/public/vendor/**']);
    });

    test('every metric has a threshold, and none of them is zero', () => {
        const global = config.coverageThreshold.global;
        for (const metric of ['statements', 'branches', 'functions', 'lines']) {
            expect([metric, typeof global[metric]]).toEqual([metric, 'number']);
            expect([metric, global[metric] > 0]).toEqual([metric, true]);
        }
    });

    // A threshold below what the suite already covers is not a ratchet: it is
    // room to delete tests in. These floors track the measured numbers and are
    // meant to be raised, never lowered.
    test('the thresholds sit near the coverage the suite actually has', () => {
        const global = config.coverageThreshold.global;
        expect(global.statements).toBeGreaterThanOrEqual(36);
        expect(global.branches).toBeGreaterThanOrEqual(25);
        expect(global.functions).toBeGreaterThanOrEqual(38);
        expect(global.lines).toBeGreaterThanOrEqual(37);
    });

    test('the summary Jest prints and the JSON the CI step reads are both produced', () => {
        expect(config.coverageReporters).toEqual(expect.arrayContaining(['text-summary', 'json-summary']));
    });

    test('CI runs the tests with coverage, which is what applies the thresholds', () => {
        const testJob = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n  publish:'));
        const run = testJob.match(/run: npm test.*/)?.[0] ?? '';
        expect(run).toMatch(/--coverage\b/);
        expect(run).toMatch(/--ci\b/);
    });

    test('there is a script that runs coverage locally the same way', () => {
        expect(pkg.scripts['test:coverage']).toMatch(/--coverage\b/);
    });
});
