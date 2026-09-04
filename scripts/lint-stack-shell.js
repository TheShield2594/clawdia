#!/usr/bin/env node
'use strict';

// Checks the shell scripts that live *inside* the two stack files (#940).
//
// `shellcheck scripts/*.sh` covers the scripts on disk and misses the largest
// shell script in the repository: the backup entrypoint, eleven kilobytes of it
// in docker-compose.yml and again in portainer-stack.yml, plus the replica-set
// initialiser beside it. That is the code that takes the dumps #872 is about
// and writes the status files #899 is about — shell nobody runs by hand and
// nobody reads until the night it is needed.
//
// Two checks, and the first is the one that earned this file. A string
// entrypoint is split into arguments by compose before `sh` ever sees it, so a
// single quote anywhere inside the script — an apostrophe in a comment is
// enough — closes the quote that opened it and the rest of the script becomes
// positional arguments. That is what had happened to both backup entrypoints:
// "the day's backup" in a comment two thirds of the way down truncated the
// script mid-`if`, so the container did nothing but report a syntax error, and
// nothing anywhere said so. So:
//
//   1. every embedded entrypoint must split into exactly `sh -c <script>`, and
//   2. shellcheck must be clean on the script that splitting produces.
//
// Check 1 needs no tools and is what tests/stackEntrypointShell.test.js runs on
// every `npm test`. Check 2 needs shellcheck and runs in CI.
//
//   node scripts/lint-stack-shell.js          both checks
//   node scripts/lint-stack-shell.js --list   name what was found, and stop
//
// Requires an installed node_modules for js-yaml, and shellcheck on PATH for
// check 2 (ubuntu-latest ships it; `apt-get install shellcheck` locally).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const STACKS = ['docker-compose.yml', 'portainer-stack.yml'];

/**
 * Split a command string into arguments the way compose does before handing
 * them to the container — POSIX quoting, no expansion, no operators.
 *
 * Deliberately its own eighty lines rather than a `docker compose config` call:
 * this has to run inside `npm test`, on a machine with no Docker, and the whole
 * point is to answer "how many arguments is this?" before anyone deploys it.
 *
 * @param {string} input - the raw `entrypoint:` or `command:` string
 * @returns {string[]|null} the arguments, or null if a quote is left open
 */
function splitArguments(input) {
    const args = [];
    let current = null;
    let quote = null;

    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];

        if (quote === "'") {
            if (char === "'") quote = null;
            else current += char;
            continue;
        }

        if (quote === '"') {
            // Inside double quotes a backslash only escapes these four.
            if (char === '\\' && '"\\$`'.includes(input[i + 1])) {
                current += input[i + 1];
                i += 1;
            } else if (char === '"') {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '\\' && i + 1 < input.length) {
            current = (current ?? '') + input[i + 1];
            i += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            current = current ?? '';
            continue;
        }

        if (/\s/.test(char)) {
            if (current !== null) args.push(current);
            current = null;
            continue;
        }

        current = (current ?? '') + char;
    }

    if (quote) return null;
    if (current !== null) args.push(current);
    return args;
}

/**
 * Every embedded shell script in one stack file, as it will actually be run.
 *
 * @param {string} file - repo-relative path of the stack file
 * @returns {{file: string, service: string, key: string, raw: string,
 *            args: string[]|null, shell: string|null, script: string|null}[]}
 */
function embeddedShell(file) {
    const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const found = [];

    for (const [service, definition] of Object.entries(doc?.services ?? {})) {
        for (const key of ['entrypoint', 'command']) {
            const raw = definition?.[key];
            // The list form is already split and needs none of this; a string
            // is the form compose has to lex, which is the form that bites.
            if (typeof raw !== 'string' || !/^\s*(sh|bash)\s+-c\s/.test(raw)) continue;

            const args = splitArguments(raw);
            const wrapped = args !== null && args.length === 3 && args[1] === '-c';

            found.push({
                file,
                service,
                key,
                raw,
                args,
                shell: wrapped ? args[0] : null,
                // `$$` is compose's escape for a literal `$`: the container
                // sees one dollar where the YAML holds two. Undone here, or
                // shellcheck reads every variable as the PID of the shell.
                script: wrapped ? args[2].replace(/\$\$/g, '$') : null,
            });
        }
    }

    return found;
}

/**
 * Check 1: the string splits into exactly `sh -c <script>`.
 *
 * @param {ReturnType<typeof embeddedShell>[number]} entry
 * @returns {string|null} what is wrong with it, or null
 */
function splittingProblem(entry) {
    const where = `${entry.file} → ${entry.service}.${entry.key}`;

    if (entry.args === null) {
        return `${where}: unterminated quote — compose cannot split this at all.`;
    }

    if (entry.args.length !== 3 || entry.args[1] !== '-c') {
        // Point at the offender rather than the symptom: the script ends where
        // the quote closed, and the next argument is the first word after it.
        const script = entry.args[2] ?? '';
        const truncated = `${entry.raw.split('\n')[0]}…`;
        return [
            `${where}: splits into ${entry.args.length} arguments, not 3.`,
            `  The script \`sh -c\` receives stops after ${script.length} of ${entry.raw.length} characters;`,
            `  everything past it (starting "${entry.args[3] ?? ''}") is passed as positional arguments and never runs.`,
            '  Almost always an apostrophe in a comment closing the quote that opened at:',
            `    ${truncated}`,
            '  Reword it — compose has no way to escape a single quote inside this form.',
        ].join('\n');
    }

    return null;
}

/**
 * Check 2: shellcheck on the script that splitting produced.
 *
 * `--severity=warning` for the same reason `npm audit` is gated at `high` and
 * the image scan at HIGH,CRITICAL: dense shell inside a YAML string collects
 * style findings the way any dense shell does, and a gate that is normally red
 * is a gate everyone learns to merge past. Warnings and errors are the levels
 * that describe something that can go wrong at three in the morning.
 *
 * @param {ReturnType<typeof embeddedShell>[number]} entry
 * @param {string} dir - a temporary directory to write the script into
 * @returns {{status: number, output: string}}
 */
function shellcheck(entry, dir) {
    const file = path.join(dir, `${entry.service}-${entry.key}.sh`);
    fs.writeFileSync(file, `#!/bin/${entry.shell}\n${entry.script}\n`);

    const run = spawnSync('shellcheck', ['--shell', entry.shell, '--severity=warning', file], {
        encoding: 'utf8',
    });

    if (run.error) {
        if (run.error.code === 'ENOENT') {
            console.error('shellcheck is not on PATH. Install it (apt-get install shellcheck) and re-run.');
            process.exit(2);
        }
        throw run.error;
    }

    // The temp path means nothing to a reader; name the stack and the service
    // the shell actually lives in.
    const where = `${entry.file} → ${entry.service}.${entry.key}`;
    return { status: run.status, output: `${run.stdout}${run.stderr}`.split(file).join(where) };
}

function main() {
    const entries = STACKS.flatMap(embeddedShell);

    // A stack file rewritten so that nothing matches would otherwise pass by
    // checking nothing at all, silently — which is one instance of exactly the
    // failure mode this script exists for.
    if (entries.length === 0) {
        console.error(`No embedded shell found in ${STACKS.join(' or ')}.`);
        console.error('Either the entrypoints moved or this stopped recognising them; both need a look.');
        process.exit(1);
    }

    if (process.argv.includes('--list')) {
        for (const entry of entries) {
            const size = entry.script === null ? 'does not split' : `${entry.script.length} chars`;
            console.log(`${entry.file} → ${entry.service}.${entry.key} (${size})`);
        }
        return;
    }

    const problems = entries.map(splittingProblem).filter(Boolean);
    for (const problem of problems) console.error(problem);

    // No point shellchecking a script that is not the script that will run.
    if (problems.length > 0) process.exit(1);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-stack-shell-'));
    let failed = 0;

    try {
        for (const entry of entries) {
            const { status, output } = shellcheck(entry, dir);
            if (output.trim()) console.log(output.trimEnd());
            if (status !== 0) failed += 1;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(
        failed === 0
            ? `shellcheck: ${entries.length} embedded entrypoints clean`
            : `shellcheck: ${failed} of ${entries.length} embedded entrypoints have findings`
    );

    if (failed > 0) process.exit(1);
}

if (require.main === module) main();

module.exports = { STACKS, embeddedShell, splitArguments, splittingProblem };
