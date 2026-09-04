'use strict';

/**
 * #902 — the security gates run between commits, not only on them.
 *
 * ci.yml triggers on push, pull_request and workflow_dispatch. Both of its
 * security gates — `npm audit` and the Trivy scan — therefore fire when
 * somebody commits and at no other time, so a new advisory against a
 * dependency, or a CVE disclosed against the Alpine base layer, went unnoticed
 * for as long as the repo was quiet. Dependabot covers the dependency half
 * when it raises a bump. Nothing re-scanned the *published* image, which is the
 * one self-hosters are running.
 *
 * The thresholds below are read out of ci.yml rather than written down twice.
 * Two scans of the same surface reporting at different bars is worse than one
 * scan: the scheduled run starts raising things the pull request gate will
 * not, and the difference looks like a new finding.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { describeAuditRetry } = require('./helpers/auditStep');

const WORKFLOWS = path.join(__dirname, '..', '.github', 'workflows');

const load = file => yaml.load(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'));

const workflows = fs.readdirSync(WORKFLOWS)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(file => ({ file, doc: load(file) }));

// `on:` is YAML 1.1's boolean true, which js-yaml parses as the key `true`.
const triggers = doc => doc.on || doc[true] || {};

const stepsOf = job => (job && job.steps) || [];
const allSteps = doc => Object.values(doc.jobs || {}).flatMap(stepsOf);
const runScript = doc => allSteps(doc).map(s => s.run || '').join('\n');

const scannerStep = doc => allSteps(doc).find(s => /trivy|grype|snyk/i.test(s.uses || ''));

// Found by what it does, not by its filename: a workflow renamed or split
// should still satisfy this, and a test keyed on the name would pass against a
// file that no longer scans anything.
const scheduled = workflows.filter(({ doc }) => triggers(doc).schedule);
const scanner = scheduled.find(({ doc }) => /npm audit/.test(runScript(doc)) || scannerStep(doc));

const ci = load('ci.yml');

describe('the security gates run on a schedule', () => {
    test('some workflow is scheduled at all', () => {
        expect(scheduled.map(w => w.file)).not.toEqual([]);
    });

    test('and it is the one that scans', () => {
        expect(scanner).toBeDefined();
    });

    test('on a cron that comes round at least monthly', () => {
        const crons = triggers(scanner.doc).schedule.map(entry => entry.cron);
        expect(crons.length).toBeGreaterThan(0);

        for (const cron of crons) {
            const fields = cron.trim().split(/\s+/);
            expect([cron, fields.length]).toEqual([cron, 5]);
            // A month field that names months would make this fire a few times
            // a year, which for a CVE feed is not meaningfully better than the
            // nothing it replaced.
            expect([cron, fields[3]]).toEqual([cron, '*']);
        }
    });

    test('and can also be run on demand, for the week you need it now', () => {
        expect(triggers(scanner.doc)).toHaveProperty('workflow_dispatch');
    });
});

describe('the dependency half', () => {
    test('runs npm audit', () => {
        expect(runScript(scanner.doc)).toMatch(/npm audit/);
    });

    test('at the same level as the gate on a pull request', () => {
        const level = script => /--audit-level=(\w+)/.exec(script);

        const gate = level(Object.values(ci.jobs).flatMap(stepsOf).map(s => s.run || '').join('\n'));
        expect(gate).not.toBeNull();

        // Read from ci.yml, so raising or lowering the bar there moves both.
        expect(level(runScript(scanner.doc))[1]).toBe(gate[1]);
    });
});

// The first scheduled run failed on `npm warn audit 503 Service Unavailable`
// from the registry's bulk advisory endpoint. `npm audit` exits non-zero both
// when it found advisories and when it never managed to ask, so the step read
// an outage as a finding — the same conflation the image check was fixed for,
// pointing the other way.
//
// Run for real against a stub, for the same reason the image check is: the
// branch is shell, and asserting on the YAML would restate it back to itself.
// The cases live in tests/helpers/auditStep.js because ci.yml's gate now runs
// the same script and has to answer them identically (#980).
describeAuditRetry(
    'the weekly audit',
    () => allSteps(scanner.doc).find(s => /npm audit/.test(s.run || '')),
);

describe('the image half', () => {
    const step = () => scannerStep(scanner.doc);

    test('scans an image', () => {
        expect(step()).toBeDefined();
    });

    test('the published one, which nothing else re-scans', () => {
        // ci.yml scans the image it just built, before pushing it. The tag is
        // what is deployed, and a CVE disclosed after the build lands there.
        //
        // The ref may be an expression reading a step output, so follow one
        // hop back to the step that computes it before looking for the tag.
        const ref = step().with['image-ref'];
        const output = /\$\{\{\s*steps\.([\w-]+)\.outputs\./.exec(ref);
        const source = output
            ? allSteps(scanner.doc).find(s => s.id === output[1])
            : { run: ref };

        expect([ref, source]).not.toEqual([ref, undefined]);
        expect(`${source.run || ''}${output ? '' : ref}`).toMatch(/:latest/);
    });

    test('and a finding fails the job rather than being printed and ignored', () => {
        expect(String(step().with['exit-code'])).toBe('1');
    });

    test('at the same severity and unfixed policy as ci.yml', () => {
        const built = Object.values(ci.jobs).flatMap(stepsOf)
            .find(s => /trivy/i.test(s.uses || ''));
        expect(built).toBeDefined();

        expect(step().with.severity).toBe(built.with.severity);
        expect(step().with['ignore-unfixed']).toBe(built.with['ignore-unfixed']);
    });
});

// The existence check decides whether the scan runs at all, so the one thing it
// must never do is answer "nothing to scan" to a question it could not ask. A
// failed login or a registry outage makes `docker manifest inspect` non-zero
// exactly like a missing tag does, and the first version of this step treated
// them alike — which would have reported the job green in precisely the case
// where the gate did not run.
//
// Run for real, against a stub on PATH, because the branch is shell: asserting
// on the YAML would only restate the script back to itself.
describe('the existence check', () => {
    const step = allSteps(scanner.doc).find(s => s.id === 'image');

    /**
     * Run the step's own script with `docker` stubbed to the given output and
     * exit status.
     *
     * @returns {{status: number, stdout: string, outputs: string}}
     */
    const runWith = ({ says, exits }) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-scan-'));
        try {
            const bin = path.join(dir, 'bin');
            fs.mkdirSync(bin);
            fs.writeFileSync(
                path.join(bin, 'docker'),
                `#!/bin/sh
printf '%s\n' ${JSON.stringify(says)} >&2
exit ${exits}
`,
                { mode: 0o755 },
            );

            const script = path.join(dir, 'step.sh');
            fs.writeFileSync(script, step.run);
            const outputs = path.join(dir, 'outputs');
            fs.writeFileSync(outputs, '');

            // `bash -e {0}` is the shell GitHub runs a `run:` block with.
            const result = spawnSync('bash', ['-e', script], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH}`,
                    REGISTRY: 'ghcr.io',
                    IMAGE_NAME: 'owner/repo',
                    GITHUB_OUTPUT: outputs,
                },
            });

            return {
                status: result.status,
                stdout: `${result.stdout}${result.stderr}`,
                outputs: fs.readFileSync(outputs, 'utf8'),
            };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };

    test('the step is still a shell script this can run', () => {
        // If it is ever replaced by an action, this whole suite is measuring
        // nothing and should say so rather than passing.
        expect(step).toBeDefined();
        expect(typeof step.run).toBe('string');
    });

    test('reports the image when the registry has it', () => {
        const run = runWith({ says: '{"schemaVersion":2}', exits: 0 });

        expect(run.status).toBe(0);
        expect(run.outputs).toContain('found=true');
        expect(run.outputs).toContain('ref=ghcr.io/owner/repo:latest');
    });

    test('skips, without failing, when the registry says the tag is not there', () => {
        const run = runWith({ says: 'manifest unknown', exits: 1 });

        expect(run.status).toBe(0);
        expect(run.outputs).toContain('found=false');
        expect(run.outputs).not.toContain('found=true');
        expect(run.stdout).toContain('::warning::');
    });

    test('and for a package that does not exist at all', () => {
        const run = runWith({ says: 'name unknown: repository name not known', exits: 1 });

        expect(run.status).toBe(0);
        expect(run.outputs).toContain('found=false');
    });

    test.each([
        ['a rejected credential', 'unauthorized: authentication required'],
        ['a revoked token', 'denied: requested access to the resource is denied'],
        ['the registry being down', 'Get "https://ghcr.io/v2/": EOF'],
        ['no route to it at all', 'dial tcp: lookup ghcr.io: no such host'],
    ])('fails the job on %s', (_case, says) => {
        const run = runWith({ says, exits: 1 });

        // The point of the whole branch: this must not read as "nothing has
        // been published", because the scan would then be skipped and the job
        // would go green having checked nothing.
        expect(run.status).not.toBe(0);
        expect(run.outputs).not.toContain('found=true');
        expect(run.stdout).toContain('::error::');
        // The registry's own words, so whoever reads the log can act on it.
        expect(run.stdout).toContain(says);
    });
});

describe('it stays out of the way of publishing', () => {
    test('it publishes nothing itself', () => {
        // The reason this is not a `schedule:` trigger on ci.yml: a scheduled
        // run of that workflow would rebuild and repoint `:latest` every week
        // for no reason, and contend the group that serializes publishing.
        const pushes = allSteps(scanner.doc)
            .filter(s => /build-push-action/.test(s.uses || ''))
            .filter(s => s.with && s.with.push === true);

        expect(pushes).toEqual([]);
    });

    test('and asks for no more than read access', () => {
        const asked = [
            ...Object.values(scanner.doc.permissions || {}),
            ...Object.values(scanner.doc.jobs).flatMap(job => Object.values(job.permissions || {})),
        ];
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.filter(level => level !== 'read')).toEqual([]);
    });
});
