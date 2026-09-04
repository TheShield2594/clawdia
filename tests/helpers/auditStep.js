'use strict';

/**
 * Runs a workflow's `npm audit` step for real, against a stubbed npm.
 *
 * Two workflows carry this step — the pull-request gate in ci.yml and the
 * weekly job in security-scan.yml — and they carry the same script on purpose,
 * because they have to report at the same bar. The branch inside it is shell:
 * asserting on the YAML would restate the script back to itself and prove
 * nothing about whether it tells a registry outage from a finding. So both are
 * driven, from here, over the same cases.
 *
 * `npm` is replaced with a stub that answers differently per attempt and counts
 * its calls — the count is what says a real finding was not retried — and
 * `sleep` is stubbed away so the 15s and 30s backoffs are not the suite's
 * runtime.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** What npm actually printed on the run that prompted the retry (#980, #962). */
const OUTAGE = [
    "npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - Service Unavailable",
    "{ error: 'Service Unavailable' }",
    'npm error audit endpoint returned an error',
].join('\n');

/**
 * A real finding. It names a denial-of-service advisory and a version range
 * with 503 in it, both of which a pattern matching on the HTTP code would read
 * as an outage and retry.
 */
const FINDING = [
    'qs  2.2.5 - 6.503.1',
    'Severity: high',
    'qs: Denial of Service via Attacker Controlled isBuffer',
    '1 high severity vulnerability',
].join('\n');

/** The registry's fault, said in npm's other words. */
const NETWORK_FAILURES = [
    ['a DNS failure', 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed'],
    ['a dropped connection', 'npm error code ECONNRESET'],
    ['a timeout', 'npm error code ETIMEDOUT'],
];

/**
 * @param {string} stepRun the step's `run:` script, straight out of the YAML
 * @param {Array<{says: string, exits: number}>} replies one per attempt; the
 *   last is repeated once exhausted
 * @returns {{status: number, stdout: string, calls: number}}
 */
function runAuditStep(stepRun, replies) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-audit-'));
    try {
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const calls = path.join(dir, 'calls');
        fs.writeFileSync(calls, '');

        // Each reply is a file the stub reads by attempt number.
        replies.forEach((reply, at) => {
            fs.writeFileSync(path.join(dir, `say-${at}`), reply.says);
            fs.writeFileSync(path.join(dir, `exit-${at}`), String(reply.exits));
        });

        fs.writeFileSync(path.join(bin, 'npm'), [
            '#!/bin/sh',
            `echo x >> ${JSON.stringify(calls)}`,
            `n=$(wc -l < ${JSON.stringify(calls)})`,
            `last=${replies.length - 1}`,
            'at=$((n - 1))',
            '[ "$at" -gt "$last" ] && at="$last"',
            `cat ${JSON.stringify(dir)}/say-"$at"`,
            `exit "$(cat ${JSON.stringify(dir)}/exit-"$at")"`,
        ].join('\n') + '\n', { mode: 0o755 });

        fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const script = path.join(dir, 'step.sh');
        fs.writeFileSync(script, stepRun);

        const result = spawnSync('bash', ['-e', script], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });

        return {
            status: result.status,
            stdout: `${result.stdout}${result.stderr}`,
            calls: fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length,
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The whole contract, as a `describe` a caller drops in around whichever step
 * it found. Written once because the two steps are one script: a case added
 * for one of them has to hold for the other or they have drifted, which is the
 * failure this shared block exists to make impossible to introduce quietly.
 *
 * @param {string} label how to name the workflow in the test titles
 * @param {() => object} step returns the parsed step, called lazily so a
 *   missing one fails inside a test rather than at collection time
 */
function describeAuditRetry(label, step) {
    describe(`${label} — telling an outage from a finding`, () => {
        const run = replies => runAuditStep(step().run, replies);

        test('the step is still a shell script this can run', () => {
            expect(step()).toBeDefined();
            expect(typeof step().run).toBe('string');
        });

        test('passes, once, on a clean tree', () => {
            const result = run([{ says: 'found 0 vulnerabilities', exits: 0 }]);

            expect(result.status).toBe(0);
            expect(result.calls).toBe(1);
        });

        test('fails on a real finding without retrying it', () => {
            // Retrying a finding would only ask the same question three times
            // and then report the wrong reason for the failure.
            const result = run([{ says: FINDING, exits: 1 }]);

            expect(result.status).not.toBe(0);
            expect(result.calls).toBe(1);
            expect(result.stdout).toContain('1 high severity vulnerability');
            expect(result.stdout).not.toContain('could not reach the registry');
        });

        test('rides out an outage that clears', () => {
            const result = run([
                { says: OUTAGE, exits: 1 },
                { says: 'found 0 vulnerabilities', exits: 0 },
            ]);

            expect(result.status).toBe(0);
            expect(result.calls).toBe(2);
        });

        test('gives up on an outage that does not, and says which it was', () => {
            const result = run([{ says: OUTAGE, exits: 1 }]);

            // Still red — an un-audited tree is not a clean one. What changes
            // is that the log says the audit did not run, rather than implying
            // a vulnerability nobody can find.
            expect(result.status).not.toBe(0);
            expect(result.calls).toBeGreaterThan(1);
            expect(result.stdout).toContain('::error::');
            expect(result.stdout).toContain('has not been audited');
        });

        test.each(NETWORK_FAILURES)('treats %s as the registry\'s fault too', (_case, says) => {
            const result = run([{ says, exits: 1 }, { says: 'found 0 vulnerabilities', exits: 0 }]);

            expect(result.status).toBe(0);
            expect(result.calls).toBe(2);
        });
    });
}

module.exports = { runAuditStep, describeAuditRetry, OUTAGE, FINDING, NETWORK_FAILURES };
