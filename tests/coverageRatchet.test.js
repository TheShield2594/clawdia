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

// The half the global number cannot express (#625). One percentage over all of
// src says nothing about where the coverage is: src/services/ai/mcp is at 94%
// and src/commands/economy at 18%, so deleting every MCP test costs about four
// points of a 37% total and the run stays green. A whole subsystem can go to
// zero without the number that guards it moving far enough to notice.
describe('per-subsystem floors', () => {
    const floors = JSON.parse(read('coverage-floors.json'));
    const {
        aggregate, check, dirOf, METRICS,
    } = require('../scripts/check-coverage.js');

    const file = (covered, total) => Object.fromEntries(
        METRICS.map(m => [m, { covered, total }]),
    );

    test('every directory that holds a measured file has a floor', () => {
        // Not asserted against a live coverage run — the run that produced the
        // file may not have happened. The script itself fails on a directory
        // with no floor; this holds the recorded list against the tree.
        const recorded = Object.keys(floors.directories);
        expect(recorded.length).toBeGreaterThan(20);
        for (const dir of recorded) {
            expect([dir, fs.existsSync(path.join(root, dir))]).toEqual([dir, true]);
        }
    });

    test('the moderation and casino directories the issue named are floored', () => {
        for (const dir of ['src/commands/moderation', 'src/games/casino', 'src/migrations', 'src/events']) {
            expect(Object.keys(floors.directories)).toContain(dir);
            expect(floors.directories[dir].statements).toBeGreaterThan(0);
        }
    });

    // #628 raised this directory from 1.6% branches; the floor is what stops it
    // going back, and a floor of zero would not.
    test('the moderation floor reflects the tests that now drive those commands', () => {
        expect(floors.directories['src/commands/moderation'].branches).toBeGreaterThanOrEqual(60);
    });

    test('a file belongs to its own directory, not to every parent of it', () => {
        // src/services would otherwise swallow src/services/ai, and a bucket
        // that contains a much larger sibling says nothing about it.
        expect(dirOf('src/services/ai/mcp/client.js')).toBe('src/services/ai/mcp');
        expect(dirOf('src/index.js')).toBe('src');
    });

    test('a directory below its floor fails', () => {
        const files = new Map([['src/thing/a.js', file(1, 100)]]);
        const { failures } = check(files, {
            directories: { 'src/thing': { statements: 50, branches: 50, functions: 50, lines: 50 } },
            neverExecuted: [],
        });
        expect(failures.join('\n')).toMatch(/src\/thing statements 1.00% is below its floor of 50%/);
    });

    test('a directory at or above its floor passes', () => {
        const files = new Map([['src/thing/a.js', file(60, 100)]]);
        const { failures } = check(files, {
            directories: { 'src/thing': { statements: 60, branches: 60, functions: 60, lines: 60 } },
            neverExecuted: [],
        });
        expect(failures).toEqual([]);
    });

    // The hole a new subsystem would otherwise walk straight through.
    test('a directory with no recorded floor fails', () => {
        const files = new Map([['src/brand-new/a.js', file(100, 100)]]);
        const { failures } = check(files, { directories: {}, neverExecuted: [] });
        expect(failures.join('\n')).toMatch(/src\/brand-new is new and has no recorded floor/);
    });

    test('a floor for a directory that no longer exists fails', () => {
        const files = new Map([['src/thing/a.js', file(100, 100)]]);
        const { failures } = check(files, {
            directories: {
                'src/thing': { statements: 0, branches: 0, functions: 0, lines: 0 },
                'src/deleted': { statements: 10, branches: 10, functions: 10, lines: 10 },
            },
            neverExecuted: [],
        });
        expect(failures.join('\n')).toMatch(/src\/deleted has a floor but no measured file/);
    });

    test('an empty directory is 100%, not a division by zero', () => {
        expect(aggregate([file(0, 0)]).statements).toBe(100);
    });
});

// The other thing one number hides: a file no test has ever loaded contributes
// its whole size to the denominator and nothing to the numerator, which is
// indistinguishable from a file that is merely badly covered. Fourteen of them
// exist. The list may shrink; it must not grow.
describe('the files with no executed line', () => {
    const floors = JSON.parse(read('coverage-floors.json'));
    const { check, zeroCoverageFiles, METRICS } = require('../scripts/check-coverage.js');

    const file = (covered, total) => Object.fromEntries(
        METRICS.map(m => [m, { covered, total }]),
    );

    test('the recorded list names real files', () => {
        expect(floors.neverExecuted.length).toBeGreaterThan(0);
        for (const name of floors.neverExecuted) {
            expect([name, fs.existsSync(path.join(root, name))]).toEqual([name, true]);
        }
    });

    // The two entry points are on it for a reason worth keeping visible: both
    // call process.exit, and index.js opens a gateway connection on the way.
    test('it still contains the entry points, which cannot be required in a test', () => {
        expect(floors.neverExecuted).toEqual(expect.arrayContaining(['src/index.js', 'src/shard.js']));
    });

    test('a file with nothing executed is one with statements and no covered statement', () => {
        const files = new Map([
            ['src/a.js', file(0, 12)],
            ['src/b.js', file(3, 12)],
            // A file with nothing in it to execute is not an uncovered file.
            ['src/c.js', file(0, 0)],
        ]);
        expect(zeroCoverageFiles(files)).toEqual(['src/a.js']);
    });

    test('a newly unexecuted file fails', () => {
        const files = new Map([['src/fresh.js', file(0, 12)]]);
        const { failures } = check(files, {
            directories: { src: { statements: 0, branches: 0, functions: 0, lines: 0 } },
            neverExecuted: [],
        });
        expect(failures.join('\n')).toMatch(/src\/fresh.js has no executed line/);
    });

    // A stale entry is standing permission to un-cover the file again.
    test('a listed file that is covered now fails, so the list cannot rot', () => {
        const files = new Map([['src/covered.js', file(12, 12)]]);
        const { failures } = check(files, {
            directories: { src: { statements: 0, branches: 0, functions: 0, lines: 0 } },
            neverExecuted: ['src/covered.js'],
        });
        expect(failures.join('\n')).toMatch(/src\/covered.js is covered now/);
    });
});

// The check runs against whichever suites the run included, and that is not one
// fixed set: tests/integration/ needs a real mongod, so a contributor whose
// machine cannot fetch one runs without it while CI runs with it. A file only
// those suites reach is zero-coverage in the first run and covered in the
// second, and neither reading is wrong — which is what sent CI red the first
// time this landed, on src/models/MigrationRecord.js.
describe('files only the integration suites reach', () => {
    const floors = JSON.parse(read('coverage-floors.json'));
    const { check, METRICS } = require('../scripts/check-coverage.js');

    const file = (covered, total) => Object.fromEntries(
        METRICS.map(m => [m, { covered, total }]),
    );

    const dirs = { src: { statements: 0, branches: 0, functions: 0, lines: 0 } };

    test('the recorded entries are real files, and are not on the other list', () => {
        for (const name of floors.coveredOnlyByIntegration) {
            expect([name, fs.existsSync(path.join(root, name))]).toEqual([name, true]);
            expect(floors.neverExecuted).not.toContain(name);
        }
    });

    test('one reading zero passes — that is the run without integration', () => {
        const files = new Map([['src/only.js', file(0, 10)]]);
        const { failures } = check(files, {
            directories: dirs, neverExecuted: [], coveredOnlyByIntegration: ['src/only.js'],
        });
        expect(failures).toEqual([]);
    });

    test('the same one reading covered passes too — that is CI', () => {
        const files = new Map([['src/only.js', file(10, 10)]]);
        const { failures } = check(files, {
            directories: dirs, neverExecuted: [], coveredOnlyByIntegration: ['src/only.js'],
        });
        expect(failures).toEqual([]);
    });

    // Without this the list is a place to hide a file that no longer exists.
    test('an entry that was not measured at all fails', () => {
        const files = new Map([['src/other.js', file(10, 10)]]);
        const { failures } = check(files, {
            directories: dirs, neverExecuted: [], coveredOnlyByIntegration: ['src/gone.js'],
        });
        expect(failures.join('\n')).toMatch(/src\/gone.js is listed as integration-covered/);
    });

    // The failure CI actually hit: an integration-covered file left on the
    // never-executed list fails in CI and passes locally, which is the worst of
    // both. The message has to say where it belongs.
    test('a never-executed entry that CI covers is told where to go', () => {
        const files = new Map([['src/only.js', file(10, 10)]]);
        const { failures } = check(files, {
            directories: dirs, neverExecuted: ['src/only.js'], coveredOnlyByIntegration: [],
        });
        expect(failures.join('\n')).toMatch(/move it to coveredOnlyByIntegration/);
    });

    test('the list is optional — a floors file without one still checks', () => {
        const files = new Map([['src/a.js', file(0, 10)]]);
        const { failures } = check(files, { directories: dirs, neverExecuted: ['src/a.js'] });
        expect(failures).toEqual([]);
    });
});

describe('re-recording the floors', () => {
    const { update, METRICS } = require('../scripts/check-coverage.js');

    const file = (covered, total) => Object.fromEntries(
        METRICS.map(m => [m, { covered, total }]),
    );

    // An integration-only file reads as zero in an integration-excluded run, so
    // re-recording from one would quietly move it onto `neverExecuted` and put
    // the CI failure straight back.
    test('an integration-only entry survives an update run that sees it as zero', () => {
        const written = [];
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation((_p, body) => written.push(body));

        const files = new Map([['src/only.js', file(0, 10)], ['src/b.js', file(5, 10)]]);
        const next = update(files, {
            directories: { src: { statements: 0, branches: 0, functions: 0, lines: 0 } },
            neverExecuted: [],
            coveredOnlyByIntegration: ['src/only.js'],
        });

        expect(next.coveredOnlyByIntegration).toEqual(['src/only.js']);
        expect(next.neverExecuted).not.toContain('src/only.js');
        expect(written).toHaveLength(1);
        spy.mockRestore();
    });

    test('a floor is never lowered by an update', () => {
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        const files = new Map([['src/a.js', file(1, 100)]]);
        const next = update(files, {
            directories: { src: { statements: 40, branches: 40, functions: 40, lines: 40 } },
            neverExecuted: [],
        });
        expect(next.directories.src.statements).toBe(40);
        spy.mockRestore();
    });
});

describe('the per-subsystem ratchet is wired up', () => {
    test('CI checks the floors as well as the global thresholds', () => {
        const testJob = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n  publish:'));
        expect(testJob).toMatch(/run: npm run coverage:check/);
    });

    test('the same check is one command locally', () => {
        expect(pkg.scripts['coverage:check']).toMatch(/check-coverage\.js/);
    });
});
