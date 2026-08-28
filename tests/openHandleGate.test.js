'use strict';

const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const ci  = read('.github/workflows/ci.yml');

// #630. `jest --forceExit` kills the run once the last assertion has finished,
// whether or not anything is still holding the event loop open. That is not a
// fix for a leak, it is the removal of the only signal that one exists: a
// Mongoose connection nobody disconnects, a `setInterval` nobody `.unref()`s, a
// listener on a socket that stays open — all of them look exactly like a clean
// exit once the process is shot in the head.
//
// It was added for a real reason. Three suites transitively loaded the native
// `canvas` addon and left a worker hanging, and `--forceExit` was the blunt way
// past that. The addon has since been bumped (canvas 3.2.3) and no longer does
// it: all 241 non-integration suites now exit on their own, and so does a suite
// that loads canvas and draws with it. The flag outlived its cause, and the
// cost of leaving it is that the *next* leak arrives silently.
//
// So the flag is gone, and this is what stops it coming back — because it will
// look like the obvious fix the first time a genuinely leaky test appears, and
// at that point the leak is the thing to fix.
describe('open-handle detection is not suppressed', () => {
    // Both scripts, not just `test`: `test:coverage` is the one a contributor
    // reaches for when the ratchet fails, and a leak masked there is masked in
    // the run most likely to be looked at closely.
    for (const script of ['test', 'test:coverage']) {
        test(`npm run ${script} does not pass --forceExit`, () => {
            expect([script, pkg.scripts[script]]).toEqual([script, expect.any(String)]);
            expect(pkg.scripts[script]).not.toMatch(/--forceExit\b/);
        });
    }

    // The flag can also be smuggled in past the scripts, as an argument on the
    // CI invocation itself. Comments are stripped first: the step above this
    // one explains at length why `--forceExit` is gone, and a naive search of
    // the job text finds that explanation and calls it a violation.
    test('CI does not add it back on the command line', () => {
        const testJob = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n  publish:'));
        const commands = testJob
            .split('\n')
            .filter(line => !/^\s*#/.test(line))
            .join('\n');
        expect(commands).not.toMatch(/--forceExit\b/);
    });

    // ...or globally, from the config, where it applies to every invocation at
    // once and no command line mentions it.
    test('jest.config.js does not set it either', () => {
        expect(require('../jest.config.js').forceExit).toBeUndefined();
    });

    // Removing `--forceExit` means a leaked handle hangs the run instead of
    // ending it, and an unbounded hang in CI is its own failure mode: it burns
    // the job's whole budget and takes the coverage and lint steps down with
    // it, so the run reports nothing at all. A step-level bound turns that into
    // a failed step with the other answers still intact.
    test('a hung test step is bounded, so the steps after it still report', () => {
        const step = ci.slice(ci.indexOf('- name: Run tests'), ci.indexOf('- name: Check per-subsystem'));
        expect(step).toMatch(/timeout-minutes: \d+/);

        const stepBudget = Number(step.match(/timeout-minutes: (\d+)/)[1]);
        // The job's own budget, which is declared before `steps:` — not the
        // per-step ones, of which this step is now one.
        const jobHeader = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n    steps:'));
        const jobBudget = Number(jobHeader.match(/timeout-minutes: (\d+)/)[1]);
        // Strictly under the job's own timeout, or the job dies first and the
        // bound has bought nothing.
        expect([stepBudget, stepBudget < jobBudget]).toEqual([stepBudget, true]);
    });
});
