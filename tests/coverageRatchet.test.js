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
// Several fixtures below floor a directory at 0 to mean "not what this test is
// about". Since #907 that is itself a failure — a floor of 0 is satisfied by
// every possible state — unless the directory is recorded as unguarded, so
// those fixtures say so rather than tripping a rule they are not testing.
const NO_FLOOR = { statements: 0, branches: 0, functions: 0, lines: 0 };
const unguardedAll = dir => ({ [dir]: ['statements', 'branches', 'functions', 'lines'] });

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
        expect(global.statements).toBeGreaterThanOrEqual(47);
        expect(global.branches).toBeGreaterThanOrEqual(37);
        expect(global.functions).toBeGreaterThanOrEqual(48);
        expect(global.lines).toBeGreaterThanOrEqual(48);
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

    // #786 is the same argument for the economy commands, which had 86 of 97
    // command files never invoking execute() and the money-moving ones at zero
    // branches. A floor of 3 would not notice the harness being deleted.
    test('the economy floor reflects the harness that now drives those commands', () => {
        expect(floors.directories['src/commands/economy'].branches).toBeGreaterThanOrEqual(12);
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
            directories: { src: NO_FLOOR }, unguarded: unguardedAll('src'),
            neverExecuted: [],
        });
        expect(failures.join('\n')).toMatch(/src\/fresh.js has no executed line/);
    });

    // A stale entry is standing permission to un-cover the file again.
    test('a listed file that is covered now fails, so the list cannot rot', () => {
        const files = new Map([['src/covered.js', file(12, 12)]]);
        const { failures } = check(files, {
            directories: { src: NO_FLOOR }, unguarded: unguardedAll('src'),
            neverExecuted: ['src/covered.js'],
        });
        expect(failures.join('\n')).toMatch(/src\/covered.js is covered now/);
    });
});

// #908. The list above catches a file at *exactly* zero statements, and that is
// a narrower net than it reads as. A `require` executes a file's imports, its
// constants and its `module.exports`, and Istanbul counts each of those, so a
// file no test ever calls into sits at 1-10% rather than 0 — off that list, and
// small enough inside a large directory to hide under the three points of slack
// a directory floor carries. Eighty-three files were in that state, several of
// them money primitives.
describe('the files that are loaded but never run', () => {
    const floors = JSON.parse(read('coverage-floors.json'));
    const { check, update, inertFiles } = require('../scripts/check-coverage.js');

    const file = (stmt, fn, branch) => ({
        statements: { covered: stmt, total: 100, pct: stmt },
        functions: { covered: fn, total: 10, pct: fn * 10 },
        branches: { covered: branch, total: 20, pct: branch * 5 },
        lines: { covered: stmt, total: 100, pct: stmt },
    });

    const dirs = { src: NO_FLOOR };
    const floorsFor = overrides => ({
        directories: dirs, unguarded: unguardedAll('src'),
        neverExecuted: [], loadedButNeverRun: [], ...overrides,
    });

    test('the recorded list names real files', () => {
        expect(floors.loadedButNeverRun.length).toBeGreaterThan(0);
        for (const name of floors.loadedButNeverRun) {
            expect([name, fs.existsSync(path.join(root, name))]).toEqual([name, true]);
        }
    });

    test('a file is not on it twice — the two lists do not overlap', () => {
        for (const name of floors.loadedButNeverRun) {
            expect(floors.neverExecuted).not.toContain(name);
            expect(floors.coveredOnlyByIntegration).not.toContain(name);
        }
    });

    test('a required-but-uncalled file counts, even at 10% statements', () => {
        // The exact shape the old check missed.
        expect(inertFiles(new Map([['src/a.js', file(10, 0, 0)]]))).toEqual(['src/a.js']);
    });

    test('one executed function is enough to be off it', () => {
        expect(inertFiles(new Map([['src/a.js', file(10, 1, 0)]]))).toEqual([]);
    });

    test('so is one executed branch, for a file whose work is a branch', () => {
        expect(inertFiles(new Map([['src/a.js', file(10, 0, 1)]]))).toEqual([]);
    });

    test('a file with no function to call is not on it', () => {
        // A table of constants has nothing to run, which is not the same as
        // having something to run that nothing ran.
        const table = { ...file(10, 0, 0), functions: { covered: 0, total: 0, pct: 100 } };
        expect(inertFiles(new Map([['src/data/table.js', table]]))).toEqual([]);
    });

    test('a newly inert file fails', () => {
        const files = new Map([['src/fresh.js', file(10, 0, 0)]]);
        const { failures } = check(files, floorsFor());
        expect(failures.join('\n')).toMatch(/src\/fresh.js is loaded but none of its functions or branches ever run/);
    });

    test('a recorded one does not', () => {
        const files = new Map([['src/known.js', file(10, 0, 0)]]);
        const { failures } = check(files, floorsFor({ loadedButNeverRun: ['src/known.js'] }));
        expect(failures).toEqual([]);
    });

    test('an integration-only file does not, either', () => {
        const files = new Map([['src/only.js', file(10, 0, 0)]]);
        const { failures } = check(files, floorsFor({ coveredOnlyByIntegration: ['src/only.js'] }));
        expect(failures).toEqual([]);
    });

    test('an entry naming a file that is gone fails', () => {
        const files = new Map([['src/a.js', file(10, 5, 5)]]);
        const { failures } = check(files, floorsFor({ loadedButNeverRun: ['src/gone.js'] }));
        expect(failures.join('\n')).toMatch(/src\/gone.js is listed as never run but was not measured/);
    });

    // The one place this list differs from `neverExecuted`, and the reason is
    // the same one `coveredOnlyByIntegration` exists for: the twenty files under
    // src/migrations are inert without tests/integration/ and fully executed
    // with it. A "covered now" failure would make CI and a local run contradict
    // each other over every one of them, so it is reported, not failed.
    test('a recorded file that runs its own code now is reported, not failed', () => {
        const files = new Map([['src/known.js', file(80, 8, 16)]]);
        const { failures, staleInert } = check(files, floorsFor({ loadedButNeverRun: ['src/known.js'] }));
        expect(failures).toEqual([]);
        expect(staleInert).toEqual(['src/known.js']);
    });

    test('an update run keeps an entry it happened to see covered', () => {
        // The same asymmetry from the writing side: re-recording from a run that
        // did include tests/integration/ must not drop the migrations, or the
        // next run without it fails on twenty files nobody touched.
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        const files = new Map([['src/known.js', file(80, 8, 16)], ['src/b.js', file(10, 0, 0)]]);
        const next = update(files, floorsFor({ loadedButNeverRun: ['src/known.js'] }));
        expect(next.loadedButNeverRun).toEqual(['src/b.js', 'src/known.js']);
        spy.mockRestore();
    });
});

// The other half of #908: three points of slack on a directory floor is, inside
// a seventy-file directory like src/utils, enough room to absorb one file losing
// its coverage outright. The money primitives are the files where that matters
// and are few enough to name, so they carry a floor each — and so, since #890,
// do the three economy commands that move coins between wallets themselves.
describe('per-file floors', () => {
    const floors = JSON.parse(read('coverage-floors.json'));
    const { check, update, METRICS } = require('../scripts/check-coverage.js');

    const file = pct => Object.fromEntries(
        METRICS.map(m => [m, { covered: pct, total: 100, pct }]),
    );

    test('the money primitives are the ones floored', () => {
        // Named rather than derived: the point of a hand-maintained list is
        // that adding to it is a decision, so the test is the decision written
        // down. `chargeExact`/`refundCharge` live in balanceDebit.js — the pair
        // #884 named, and the closest thing in the tree to this bug's shape.
        //
        // The three commands joined them in #890 for the same reason one file
        // down: they mutate wallets directly, they had branch coverage at or
        // near zero, and src/commands/economy is a hundred-file directory whose
        // floor cannot notice one of them going back to that.
        //
        // debitKey.js joined in #969, on the same footing as payoutKey.js beside
        // it: it is the primitive that decides whether a debit whose outcome was
        // never learned gets refunded or not, and both wrong answers make or
        // unmake coins.
        //
        // economyFreeze.js joined in #870. It is four lines of logic and one
        // filter clause, which is exactly why it belongs here: the clause is
        // spread into the filter of every shared debit, so nothing about it
        // being uncovered would look like a failure — the debits would simply
        // stop refusing a frozen member and every one of their tests would
        // still pass.
        //
        // casinoJackpotService.js joined in #873's casino pass. It is not a
        // primitive but it is the largest single payout the bot makes, and the
        // only pot in the casino that exists outside anybody's balance: it
        // claims coins out of a shared pool, credits them in a separate write,
        // and recovers the gap on the next boot. It sat at 14.6% statements and
        // 0% branches once before (#784), inside a services directory whose
        // floor is a hundred files wide and could not have noticed.
        //
        // market.js, gift.js and marketService.js joined in #873's third pass,
        // over the two commands where a player hands something straight to
        // another player. They are the only place in the economy where an item
        // and coins move in opposite directions in one flow, and the pass found
        // five unwinds that put value back and reported whether they had done
        // so from the absence of an exception. Both commands sit inside
        // directory floors — `src/commands/economy` at 35% statements — that a
        // file losing its coverage outright would not move.
        expect(Object.keys(floors.files).sort()).toEqual([
            'src/commands/economy/bank.js',
            'src/commands/economy/duel.js',
            'src/commands/economy/gift.js',
            'src/commands/economy/invest.js',
            'src/commands/economy/market.js',
            'src/services/casinoJackpotService.js',
            'src/services/marketService.js',
            'src/utils/balanceDebit.js',
            'src/utils/balanceDelta.js',
            'src/utils/coinTransfer.js',
            'src/utils/creditOrOwe.js',
            'src/utils/debitKey.js',
            'src/utils/duelEscrow.js',
            'src/utils/economyFreeze.js',
            'src/utils/owedPayout.js',
            'src/utils/payoutKey.js',
            'src/utils/placeWager.js',
            'src/utils/refundWager.js',
        ]);
    });

    test('each one names a real file and floors every metric above zero', () => {
        for (const [name, required] of Object.entries(floors.files)) {
            expect([name, fs.existsSync(path.join(root, name))]).toEqual([name, true]);
            for (const metric of METRICS) {
                // A floor of zero is not a floor; these files are all well
                // covered, and the numbers are what says so.
                expect([name, metric, required[metric] > 0]).toEqual([name, metric, true]);
            }
        }
    });

    test('a file below its own floor fails, whatever its directory is doing', () => {
        // The bug: one file collapsing inside a directory big enough to dilute
        // it. The directory here is passing; the file is not.
        const files = new Map([
            ['src/utils/money.js', file(2)],
            ['src/utils/big.js', file(99)],
        ]);
        const { failures } = check(files, {
            directories: { 'src/utils': { statements: 50, branches: 50, functions: 50, lines: 50 } },
            neverExecuted: [], loadedButNeverRun: [],
            files: { 'src/utils/money.js': { statements: 90, branches: 90, functions: 90, lines: 90 } },
        });
        expect(failures.join('\n')).toMatch(/src\/utils\/money.js statements 2.00% is below its floor of 90%/);
    });

    test('a file at or above its floor passes', () => {
        const files = new Map([['src/utils/money.js', file(90)]]);
        const { failures } = check(files, {
            directories: { 'src/utils': NO_FLOOR }, unguarded: unguardedAll('src/utils'),
            neverExecuted: [], loadedButNeverRun: [],
            files: { 'src/utils/money.js': { statements: 90, branches: 90, functions: 90, lines: 90 } },
        });
        expect(failures).toEqual([]);
    });

    test('a floor for a file that no longer exists fails', () => {
        const files = new Map([['src/utils/money.js', file(90)]]);
        const { failures } = check(files, {
            directories: { 'src/utils': NO_FLOOR }, unguarded: unguardedAll('src/utils'),
            neverExecuted: [], loadedButNeverRun: [],
            files: { 'src/utils/gone.js': { statements: 90, branches: 90, functions: 90, lines: 90 } },
        });
        expect(failures.join('\n')).toMatch(/src\/utils\/gone.js has a per-file floor but was not measured/);
    });

    test('an update refreshes the numbers but never widens the set', () => {
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        const files = new Map([['src/utils/money.js', file(99)], ['src/utils/other.js', file(99)]]);
        const next = update(files, {
            directories: { 'src/utils': NO_FLOOR }, unguarded: unguardedAll('src/utils'),
            neverExecuted: [], loadedButNeverRun: [],
            files: { 'src/utils/money.js': { statements: 10, branches: 10, functions: 10, lines: 10 } },
        });
        // Raised to the measurement less the usual slack, and nothing else
        // joined the set on its own.
        expect(Object.keys(next.files)).toEqual(['src/utils/money.js']);
        expect(next.files['src/utils/money.js'].statements).toBe(96);
        spy.mockRestore();
    });

    test('a per-file floor is never lowered by an update', () => {
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        const files = new Map([['src/utils/money.js', file(5)]]);
        const next = update(files, {
            directories: { 'src/utils': NO_FLOOR }, unguarded: unguardedAll('src/utils'),
            neverExecuted: [], loadedButNeverRun: [],
            files: { 'src/utils/money.js': { statements: 90, branches: 90, functions: 90, lines: 90 } },
        });
        expect(next.files['src/utils/money.js'].statements).toBe(90);
        spy.mockRestore();
    });
});

// The check runs against whichever suites the run included, and that is not one
// fixed set: tests/integration/ needs a real mongod, so a contributor whose
// machine cannot fetch one runs without it while CI runs with it. A file only
// those suites reach is zero-coverage in the first run and covered in the
// second, and neither reading is wrong — which is what sent CI red the first
// time this landed, on src/models/MigrationRecord.js.
// #907. A floor of 0 is satisfied by any state at all, including a subsystem's
// branch coverage dropping to nothing — deleting every branch test under
// `economy/fish` passed. And the directories carrying one were exactly the ones
// with the least coverage, so the net was absent precisely where it was worth
// most. They are named instead, on the same terms as the zero-coverage list:
// the set may shrink and must not grow.
describe('floors of zero, which guard nothing', () => {
    const floors = JSON.parse(read('coverage-floors.json'));
    const { check, update, unguardedFloors, denominators, METRICS } = require('../scripts/check-coverage.js');

    const file = (covered, total) => Object.fromEntries(
        METRICS.map(m => [m, { covered, total, pct: total ? (covered * 100) / total : 100 }]),
    );

    const floorsFor = (directories, overrides = {}) => ({
        directories, neverExecuted: [], loadedButNeverRun: [], ...overrides,
    });

    test('the recorded entries name directories that exist and really are unfloored', () => {
        for (const [dir, metrics] of Object.entries(floors.unguarded ?? {})) {
            expect([dir, fs.existsSync(path.join(root, dir))]).toEqual([dir, true]);
            expect(metrics.length).toBeGreaterThan(0);
            for (const metric of metrics) {
                expect([dir, metric, METRICS]).toContainEqual(metric);
                // An entry beside a real floor would be permission to drop back
                // to zero, which is the state it was recorded to make visible.
                expect([dir, metric, floors.directories[dir][metric]]).toEqual([dir, metric, 0]);
            }
        }
    });

    test('an unrecorded zero fails, saying which metric guards nothing', () => {
        const files = new Map([['src/thing/a.js', file(0, 100)]]);
        const { failures } = check(files, floorsFor({ 'src/thing': { statements: 5, branches: 0, functions: 5, lines: 5 } }));

        expect(failures.join('\n')).toMatch(/src\/thing has a floor of 0 for branches, which guards nothing/);
    });

    test('a recorded one passes', () => {
        // Covered everywhere except branches, which is the shape the recorded
        // directories are actually in.
        const files = new Map([['src/thing/a.js', {
            statements: { covered: 60, total: 100, pct: 60 },
            branches: { covered: 0, total: 100, pct: 0 },
            functions: { covered: 60, total: 100, pct: 60 },
            lines: { covered: 60, total: 100, pct: 60 },
        }]]);
        const { failures } = check(files, floorsFor(
            { 'src/thing': { statements: 5, branches: 0, functions: 5, lines: 5 } },
            { unguarded: { 'src/thing': ['branches'] } },
        ));

        expect(failures).toEqual([]);
    });

    test('a directory with nothing to measure needs no entry', () => {
        // A folder of constant tables has no branch to cover, and 0 is the only
        // honest floor for it. A percentage cannot tell that from a subsystem of
        // command handlers at zero; the denominator can.
        const files = new Map([['src/tables/a.js', file(0, 0)]]);
        const { failures } = check(files, floorsFor({ 'src/tables': { statements: 0, branches: 0, functions: 0, lines: 0 } }));

        expect(failures).toEqual([]);
    });

    test('an entry that has a real floor now fails, so the list cannot rot', () => {
        const files = new Map([['src/thing/a.js', file(60, 100)]]);
        const { failures } = check(files, floorsFor(
            { 'src/thing': { statements: 50, branches: 50, functions: 50, lines: 50 } },
            { unguarded: { 'src/thing': ['branches'] } },
        ));

        expect(failures.join('\n')).toMatch(/src\/thing is recorded as unguarded for branches but has a real floor now/);
    });

    test('an entry naming a directory that is gone fails', () => {
        const files = new Map([['src/thing/a.js', file(60, 100)]]);
        const { failures } = check(files, floorsFor(
            { 'src/thing': { statements: 50, branches: 50, functions: 50, lines: 50 } },
            { unguarded: { 'src/gone': ['branches'] } },
        ));

        expect(failures.join('\n')).toMatch(/src\/gone is recorded as unguarded but was not measured/);
    });

    test('an update records a new zero rather than letting it in silently', () => {
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        // 2% branches: the three points of slack put the recorded floor at 0.
        const files = new Map([['src/thing/a.js', {
            statements: { covered: 60, total: 100, pct: 60 },
            branches: { covered: 2, total: 100, pct: 2 },
            functions: { covered: 60, total: 100, pct: 60 },
            lines: { covered: 60, total: 100, pct: 60 },
        }]]);

        const next = update(files, floorsFor({ 'src/thing': { statements: 0, branches: 0, functions: 0, lines: 0 } }));

        expect(next.directories['src/thing'].branches).toBe(0);
        expect(next.unguarded).toEqual({ 'src/thing': ['branches'] });
        spy.mockRestore();
    });

    test('and drops one whose floor has risen off zero', () => {
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        const files = new Map([['src/thing/a.js', file(60, 100)]]);

        const next = update(files, floorsFor(
            { 'src/thing': { statements: 0, branches: 0, functions: 0, lines: 0 } },
            { unguarded: { 'src/thing': ['branches'] } },
        ));

        expect(next.directories['src/thing'].branches).toBe(57);
        expect(next.unguarded).toEqual({});
        spy.mockRestore();
    });

    test('the denominator is what separates the two zeroes', () => {
        const files = new Map([
            ['src/handlers/a.js', file(0, 400)],
            ['src/tables/b.js', file(0, 0)],
        ]);
        const totals = denominators(files, ['src/handlers', 'src/tables']);

        expect(totals['src/handlers'].branches).toBe(400);
        expect(totals['src/tables'].branches).toBe(0);

        const zeroFloors = { statements: 0, branches: 0, functions: 0, lines: 0 };
        expect(unguardedFloors({ 'src/handlers': zeroFloors, 'src/tables': zeroFloors }, totals))
            .toEqual({ 'src/handlers': METRICS });
    });
});

describe('files only the integration suites reach', () => {
    const floors = JSON.parse(read('coverage-floors.json'));
    const { check, METRICS } = require('../scripts/check-coverage.js');

    const file = (covered, total) => Object.fromEntries(
        METRICS.map(m => [m, { covered, total }]),
    );

    const dirs = { src: NO_FLOOR };
    const unguarded = unguardedAll('src');

    test('the recorded entries are real files, and are not on the other list', () => {
        for (const name of floors.coveredOnlyByIntegration) {
            expect([name, fs.existsSync(path.join(root, name))]).toEqual([name, true]);
            expect(floors.neverExecuted).not.toContain(name);
        }
    });

    test('one reading zero passes — that is the run without integration', () => {
        const files = new Map([['src/only.js', file(0, 10)]]);
        const { failures } = check(files, {
            directories: dirs, unguarded, neverExecuted: [], coveredOnlyByIntegration: ['src/only.js'],
        });
        expect(failures).toEqual([]);
    });

    test('the same one reading covered passes too — that is CI', () => {
        const files = new Map([['src/only.js', file(10, 10)]]);
        const { failures } = check(files, {
            directories: dirs, unguarded, neverExecuted: [], coveredOnlyByIntegration: ['src/only.js'],
        });
        expect(failures).toEqual([]);
    });

    // Without this the list is a place to hide a file that no longer exists.
    test('an entry that was not measured at all fails', () => {
        const files = new Map([['src/other.js', file(10, 10)]]);
        const { failures } = check(files, {
            directories: dirs, unguarded, neverExecuted: [], coveredOnlyByIntegration: ['src/gone.js'],
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
        const { failures } = check(files, { directories: dirs, unguarded, neverExecuted: ['src/a.js'] });
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
            directories: { src: NO_FLOOR }, unguarded: unguardedAll('src'),
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
