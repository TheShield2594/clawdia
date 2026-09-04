#!/usr/bin/env node
'use strict';

/**
 * Per-subsystem coverage floors, and a list of the files no test has ever
 * loaded (#625).
 *
 * jest.config.js already holds a global ratchet, and that was #625's own
 * recommendation — it is what stops the total sliding. What it cannot express
 * is where the coverage is. `src/services/ai` is at 80% and
 * `src/commands/economy` at 20%; the global number is a weighted average of the
 * two, so deleting every AI test would cost about four points of a 37% total
 * and the run would stay green. A whole subsystem can go to zero without the
 * one number that guards it moving far enough to notice.
 *
 * So this checks four more things, from the same coverage-summary.json the CI
 * step already reads:
 *
 *   1. A floor per directory. Each one sits a few points under what the suite
 *      measured when it was recorded, which is enough slack for a refactor and
 *      nowhere near enough for a deleted suite.
 *
 *   2. A list of the files with no executed statement at all; the point is that
 *      the list may shrink and must not grow. A file on it that has since been
 *      covered is also an error — a stale entry is permission to un-cover it
 *      again.
 *
 *      `coveredOnlyByIntegration` is the second list, and it exists because
 *      this runs against whichever suites the run included. tests/integration/
 *      needs a real mongod, so a contributor whose machine cannot fetch one
 *      runs without it while CI runs with it — and a file only those suites
 *      reach is zero-coverage in the first run and covered in the second.
 *      Listing it separately makes both runs agree instead of one of them
 *      being wrong.
 *
 *   3. A list of the files something loads but nothing runs (#908). "No executed
 *      statement" is a narrower thing than it sounds: a file a test only
 *      `require`s has its `const` declarations and its `module.exports` counted
 *      as executed statements, so it sits at 1-10% with no function and no
 *      branch ever entered — off list 2, and inside a large directory small
 *      enough to hide under list 1's slack. Eighty-three files were in exactly
 *      that state when this was written. So this asks a different question of
 *      the same summary: did any of the file's own logic run at all?
 *
 *      This list has no "it is covered now" rule, and that is the one place it
 *      differs from list 2. The twenty files under src/migrations are inert
 *      without tests/integration/ and fully executed with it, so a strict rule
 *      here would put CI and a local run into permanent disagreement over them
 *      — the failure `coveredOnlyByIntegration` exists to prevent, twenty times
 *      over. A stale entry is reported at the end of a run instead, and
 *      `--update` prunes nothing on its own: dropping one is a hand edit, which
 *      is the reviewable diff that says a file grew tests.
 *
 *   4. A record of the floors that are zero, which is a floor that guards
 *      nothing (#907). A directory whose branch coverage measures 0.9% gets a
 *      floor of 0 from the rule above, and 0 is satisfied by every possible
 *      state — including that subsystem's branch coverage going to nothing at
 *      all. Deleting every branch test under `economy/fish` passed. So a zero
 *      floor is recorded by name in `unguarded`, on the same terms as list 2:
 *      it may shrink and it must not grow. A subsystem that slides to zero
 *      fails the run instead of quietly acquiring a floor that means nothing,
 *      and the ones that are already there are a short list somebody can read
 *      rather than five zeroes among a hundred and fifty numbers.
 *
 *   5. Per-file floors, for the few files where a directory floor is too coarse
 *      to say anything. `src/utils` is seventy-odd files, so three points of
 *      directory slack is room enough for one of them to lose its coverage
 *      outright; the money primitives under it are few enough to list by hand
 *      and are the ones where that matters. The set is hand-maintained on
 *      purpose — `--update` refreshes the numbers but never adds or drops a
 *      file, so widening it stays a decision somebody made in a diff.
 *
 * One consequence worth naming: the directory floors are recorded from the
 * integration-excluded run, the same baseline jest.config.js uses, so the
 * number CI sees is that or better — `src/migrations` measures 45.8% here and
 * 81.8% in CI. That keeps a local run honest, and it does mean the floor for a
 * directory the integration suites cover is looser than CI's own measurement.
 *
 * The numbers live in coverage-floors.json rather than here, so raising them is
 * a reviewable diff rather than an edit buried in a script. `--update` rewrites
 * that file from the current run: use it when coverage has gone up, never to
 * make a failure go away.
 *
 *   npm run coverage:check
 *   npm run coverage:check -- --update
 *
 * These floors are not Jest `coverageThreshold` path keys deliberately. Jest
 * subtracts every path-keyed group from the global group, so adding directory
 * keys there would quietly redefine the global ratchet to mean "everything
 * except the directories listed" — the opposite of what both are for.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUMMARY_PATH = path.join(ROOT, 'coverage', 'coverage-summary.json');
const FLOORS_PATH = path.join(ROOT, 'coverage-floors.json');

const METRICS = ['statements', 'branches', 'functions', 'lines'];

/** How far under the measurement a newly recorded floor sits, in points. */
const SLACK = 3;

/** Coverage of a directory is the coverage of the files under it, added up. */
function aggregate(files) {
    const totals = Object.fromEntries(METRICS.map(m => [m, { covered: 0, total: 0 }]));
    for (const entry of files) {
        for (const metric of METRICS) {
            totals[metric].covered += entry[metric].covered;
            totals[metric].total += entry[metric].total;
        }
    }
    return Object.fromEntries(METRICS.map(m => [
        m,
        totals[m].total === 0 ? 100 : (totals[m].covered * 100) / totals[m].total,
    ]));
}

/** Every measured file, keyed by its repo-relative path. */
function readSummary() {
    if (!fs.existsSync(SUMMARY_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
    const files = new Map();
    for (const [absolute, entry] of Object.entries(raw)) {
        if (absolute === 'total') continue;
        files.set(path.relative(ROOT, absolute).split(path.sep).join('/'), entry);
    }
    return files;
}

// A file belongs to exactly one bucket: the directory it sits in. Not a prefix
// match — `src/services` would then swallow `src/services/ai`, and a bucket that
// contains a much larger sibling is a bucket whose floor says nothing about it.
const dirOf = file => file.split('/').slice(0, -1).join('/');

/** Every directory the run measured a file in. */
function directoriesIn(files) {
    return [...new Set([...files.keys()].map(dirOf))].sort();
}

/** Files with something to execute, none of which any test executed. */
function zeroCoverageFiles(files) {
    return [...files.entries()]
        .filter(([, entry]) => entry.statements.total > 0 && entry.statements.covered === 0)
        .map(([file]) => file)
        .sort();
}

/**
 * Files something loaded but nothing ran (#908).
 *
 * A `require` executes the file's top level — its imports, its constants, the
 * `module.exports` at the bottom — and Istanbul counts every one of those as an
 * executed statement. So "has an executed statement" is satisfied by a file no
 * test has ever called into, which is what let a money primitive sit at 1% and
 * appear on no list. Functions and branches are the parts only a call reaches,
 * and both have to be untouched: a file whose only function is an arrow inside
 * a `.map` at module level is doing its work at require time, and is not what
 * this is looking for.
 *
 * A file with no function to call — a table of constants — is not on this list
 * for the same reason it is not on the zero-coverage one: there is nothing
 * there to run.
 */
function inertFiles(files) {
    return [...files.entries()]
        .filter(([, entry]) => entry.statements.covered > 0
            && entry.functions.total > 0
            && entry.functions.covered === 0
            && entry.branches.covered === 0)
        .map(([file]) => file)
        .sort();
}

/**
 * How much there is to measure in each directory, per metric.
 *
 * A percentage cannot tell "0% of 400 branches" from "0% of nothing": a
 * directory of constant tables has no branch to cover and a floor of 0 on it is
 * the only honest number, while the same 0 on a directory of command handlers is
 * the hole #907 is about. The denominator is what separates them.
 */
function denominators(files, directories) {
    return Object.fromEntries(directories.map(dir => [
        dir,
        Object.fromEntries(METRICS.map(metric => [
            metric,
            [...files.entries()]
                .filter(([file]) => dirOf(file) === dir)
                .reduce((sum, [, entry]) => sum + entry[metric].total, 0),
        ])),
    ]));
}

/**
 * The directory/metric pairs whose floor would be zero — a floor that guards
 * nothing — over the directories that have something to measure.
 */
function unguardedFloors(directories, totals) {
    const out = {};
    for (const [dir, required] of Object.entries(directories)) {
        const metrics = METRICS.filter(m => required[m] === 0 && (totals[dir]?.[m] ?? 0) > 0);
        if (metrics.length) out[dir] = metrics;
    }
    return out;
}

function measure(files, directories) {
    return Object.fromEntries(directories.map(dir => [
        dir,
        aggregate([...files.entries()].filter(([file]) => dirOf(file) === dir).map(([, entry]) => entry)),
    ]));
}

function update(files, floors) {
    // A directory that appeared since the floors were recorded gets one now,
    // rather than being a subsystem with no floor at all.
    const measured = measure(files, directoriesIn(files));
    const directories = {};
    for (const [dir, pcts] of Object.entries(measured)) {
        directories[dir] = Object.fromEntries(METRICS.map(m => [
            m,
            // Never lower a floor on an update: coverage that dropped since the
            // floor was set is the failure this exists to report, not a new
            // baseline to write down.
            Math.max(floors.directories[dir]?.[m] ?? 0, Math.max(0, Math.floor(pcts[m]) - SLACK)),
        ]));
    }
    // An integration-only file reads as zero in an integration-excluded run, so
    // re-recording from one would move it onto `neverExecuted` and lose the
    // distinction. Keep it where it is.
    const integrationOnly = new Set(floors.coveredOnlyByIntegration ?? []);

    // The per-file floors are a hand-maintained set: refreshed here, never
    // extended here. Adding a file is the point at which somebody decided it
    // was worth guarding one file at a time, and that belongs in a diff.
    const perFile = {};
    for (const [file, required] of Object.entries(floors.files ?? {})) {
        const entry = files.get(file);
        perFile[file] = Object.fromEntries(METRICS.map(m => [
            m,
            entry
                ? Math.max(required[m] ?? 0, Math.max(0, Math.floor(entry[m].pct) - SLACK))
                : required[m] ?? 0,
        ]));
    }

    // Union, not replacement. An update run that included tests/integration/
    // sees the twenty migration files run their functions and would drop them,
    // and the next run without it would fail on twenty files nobody touched.
    // Shrinking this list is a hand edit, deliberately.
    const inert = new Set([
        ...(floors.loadedButNeverRun ?? []).filter(file => files.has(file)),
        ...inertFiles(files).filter(file => !integrationOnly.has(file)),
    ]);

    // Recomputed rather than carried over, the way `neverExecuted` is: a floor
    // that rose above zero must lose its entry, or the entry is standing
    // permission for it to fall back.
    const unguarded = unguardedFloors(directories, denominators(files, directoriesIn(files)));

    const next = {
        ...floors,
        directories,
        unguarded,
        files: perFile,
        neverExecuted: zeroCoverageFiles(files).filter(file => !integrationOnly.has(file)),
        loadedButNeverRun: [...inert].sort(),
        coveredOnlyByIntegration: [...integrationOnly].sort(),
    };
    fs.writeFileSync(FLOORS_PATH, `${JSON.stringify(next, null, 4)}\n`);
    return next;
}

function check(files, floors) {
    const failures = [];
    const measured = measure(files, directoriesIn(files));

    // A new directory with no floor is a subsystem outside the ratchet, which is
    // the hole this whole file exists to close.
    for (const dir of directoriesIn(files)) {
        if (!floors.directories[dir]) {
            failures.push(`${dir} is new and has no recorded floor — rerun with --update`);
        }
    }

    for (const [dir, required] of Object.entries(floors.directories)) {
        if (!measured[dir]) {
            failures.push(`${dir} has a floor but no measured file — drop it from coverage-floors.json`);
            continue;
        }
        for (const metric of METRICS) {
            const actual = measured[dir][metric];
            if (actual + 1e-9 < required[metric]) {
                failures.push(
                    `${dir} ${metric} ${actual.toFixed(2)}% is below its floor of ${required[metric]}%`
                );
            }
        }
    }

    // A floor of 0 is satisfied by any state at all, so the directories carrying
    // one are exactly the ones with no safety net — and they were the ones with
    // the least coverage, which is where a net is worth most (#907). They are
    // named in `unguarded` instead: the list may shrink and must not grow, so a
    // subsystem sliding to zero fails here rather than quietly being floored at
    // a number that cannot fail.
    const totals = denominators(files, directoriesIn(files));
    const shouldBeUnguarded = unguardedFloors(floors.directories, totals);
    const recordedUnguarded = floors.unguarded ?? {};

    for (const [dir, metrics] of Object.entries(shouldBeUnguarded)) {
        if (!measured[dir]) continue;
        const recorded = recordedUnguarded[dir] ?? [];
        const unrecorded = metrics.filter(m => !recorded.includes(m));
        if (unrecorded.length) {
            failures.push(
                `${dir} has a floor of 0 for ${unrecorded.join(', ')}, which guards nothing — ` +
                'add tests to raise it, or record it under `unguarded` in coverage-floors.json'
            );
        }
    }
    for (const [dir, metrics] of Object.entries(recordedUnguarded)) {
        if (!measured[dir]) {
            failures.push(`${dir} is recorded as unguarded but was not measured — drop it`);
            continue;
        }
        // An entry whose floor is no longer zero is permission to let it fall
        // back to zero, which is the state it was recorded to make visible.
        const stale = metrics.filter(m => !(shouldBeUnguarded[dir] ?? []).includes(m));
        if (stale.length) {
            failures.push(
                `${dir} is recorded as unguarded for ${stale.join(', ')} but has a real floor now — ` +
                'drop those from `unguarded` in coverage-floors.json'
            );
        }
    }

    // Per-file floors. Same rule as a directory's, on a file that a directory
    // floor is too coarse to say anything about.
    for (const [file, required] of Object.entries(floors.files ?? {})) {
        const entry = files.get(file);
        if (!entry) {
            failures.push(`${file} has a per-file floor but was not measured — drop it from coverage-floors.json`);
            continue;
        }
        for (const metric of METRICS) {
            if (entry[metric].pct + 1e-9 < required[metric]) {
                failures.push(
                    `${file} ${metric} ${entry[metric].pct.toFixed(2)}% is below its floor of ${required[metric]}%`
                );
            }
        }
    }

    // Two lists, because the run this is checking may or may not have included
    // tests/integration/. Those suites need a real mongod, so a contributor
    // whose machine cannot fetch one runs without them — and CI does run them.
    // A file covered only by an integration suite therefore reads as
    // zero-coverage in one run and covered in the other, and neither is wrong.
    const integrationOnly = new Set(floors.coveredOnlyByIntegration ?? []);
    const recorded = new Set(floors.neverExecuted);
    const zero = zeroCoverageFiles(files);

    for (const file of zero) {
        if (!recorded.has(file) && !integrationOnly.has(file)) {
            failures.push(`${file} has no executed line and is not on the recorded list`);
        }
    }
    // A file that is covered now but still listed as never executed is standing
    // permission to un-cover it. Not applied to the integration-only list: being
    // covered is exactly what that list predicts of a run that included them.
    for (const file of floors.neverExecuted) {
        if (files.has(file) && !zero.includes(file)) {
            failures.push(
                `${file} is covered now — move it to coveredOnlyByIntegration ` +
                'if only tests/integration/ reaches it, or drop it'
            );
        }
    }
    // The integration list has to stay honest in the other direction: an entry
    // that no longer exists is noise, and one that is covered by the ordinary
    // suite belongs nowhere on either list.
    for (const file of integrationOnly) {
        if (!files.has(file)) {
            failures.push(`${file} is listed as integration-covered but was not measured — drop it`);
        }
    }

    // The third list (#908): a file something loads but nothing runs. It may
    // shrink and must not grow, and unlike the list above it has no "covered
    // now" failure — src/migrations reads as inert without tests/integration/
    // and as covered with it, so a strict rule would make the two runs
    // contradict each other over twenty files. `stale` is reported instead.
    const inertRecorded = new Set(floors.loadedButNeverRun ?? []);
    const inert = inertFiles(files);

    for (const file of inert) {
        if (!inertRecorded.has(file) && !integrationOnly.has(file)) {
            failures.push(
                `${file} is loaded but none of its functions or branches ever run — ` +
                'give it a test, or record it if that is genuinely all it does'
            );
        }
    }
    // An entry naming a file that is gone is noise on a list whose whole value
    // is that somebody reads it.
    for (const file of inertRecorded) {
        if (!files.has(file)) {
            failures.push(`${file} is listed as never run but was not measured — drop it`);
        }
    }
    const staleInert = [...inertRecorded].filter(file => files.has(file) && !inert.includes(file));

    return { failures, measured, zero, inert, staleInert };
}

function main() {
    const wantsUpdate = process.argv.includes('--update');
    const files = readSummary();

    if (!files) {
        console.error('[coverage] coverage/coverage-summary.json not found — run `npm run test:coverage` first.');
        process.exit(1);
    }

    const floors = JSON.parse(fs.readFileSync(FLOORS_PATH, 'utf8'));

    if (wantsUpdate) {
        const next = update(files, floors);
        console.log(`[coverage] floors updated for ${Object.keys(next.directories).length} director(ies); ` +
            `${next.neverExecuted.length} file(s) with no executed line.`);
        return;
    }

    const { failures, measured, zero, inert, staleInert } = check(files, floors);

    for (const [dir, pcts] of Object.entries(measured)) {
        const shown = METRICS.map(m => `${m[0]}${pcts[m].toFixed(1)}`).join(' ');
        console.log(`[coverage] ${dir.padEnd(28)} ${shown}`);
    }
    console.log(`[coverage] ${zero.length} file(s) with no executed line, ` +
        `${inert.length} loaded but never run.`);
    if (staleInert.length) {
        // Not a failure: see the note on list 3 at the top of this file. It is
        // said out loud because a list nobody prunes is a list nobody reads.
        console.log(`[coverage] ${staleInert.length} recorded file(s) run their own code now — ` +
            'drop them from loadedButNeverRun:');
        for (const file of staleInert) console.log(`  - ${file}`);
    }

    if (failures.length) {
        console.error('\n[coverage] the per-subsystem ratchet failed:');
        for (const failure of failures) console.error(`  - ${failure}`);
        console.error('\nAdd tests, or — only if coverage genuinely moved for a good reason —');
        console.error('rerun with `npm run coverage:check -- --update` and explain it in the commit.');
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = {
    aggregate, check, update, zeroCoverageFiles, inertFiles, measure, directoriesIn, dirOf,
    denominators, unguardedFloors,
    METRICS, SLACK, FLOORS_PATH,
};
