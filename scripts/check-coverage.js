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
 * So this checks two more things, from the same coverage-summary.json the CI
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
    const next = {
        ...floors,
        directories,
        neverExecuted: zeroCoverageFiles(files).filter(file => !integrationOnly.has(file)),
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

    return { failures, measured, zero };
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

    const { failures, measured, zero } = check(files, floors);

    for (const [dir, pcts] of Object.entries(measured)) {
        const shown = METRICS.map(m => `${m[0]}${pcts[m].toFixed(1)}`).join(' ');
        console.log(`[coverage] ${dir.padEnd(28)} ${shown}`);
    }
    console.log(`[coverage] ${zero.length} file(s) with no executed line.`);

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
    aggregate, check, update, zeroCoverageFiles, measure, directoriesIn, dirOf,
    METRICS, SLACK, FLOORS_PATH,
};
