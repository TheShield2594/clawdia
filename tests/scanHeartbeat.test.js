'use strict';

/**
 * #997 — the scheduled security scan is watched by something that cannot be
 * disabled with it.
 *
 * security-scan.yml runs the two gates on a weekly cron, for the quiet
 * stretches between releases when ci.yml's push-triggered copies never fire.
 * GitHub disables a repository's `schedule:` triggers after 60 days with no
 * activity, so the workflow whose whole purpose is the quiet stretch is switched
 * off by a long enough one — silently, because a disabled schedule stops
 * appearing rather than going red.
 *
 * The answer is a heartbeat in ci.yml, which runs on push and pull_request —
 * triggers GitHub never disables. It asks the API when security-scan.yml last
 * ran and fails when that is older than a weekly cron can explain. The branch is
 * shell, so — like the scan's own existence check — this drives the real script
 * against a stubbed API rather than asserting on the YAML, which would only
 * restate the script back to itself.
 *
 * The load-bearing property is the same one the scan's existence check has: it
 * must never read "the scan lapsed" from a question it could not ask. An API
 * outage, a malformed answer, or a repo with no history yet all warn and pass;
 * only a real, readable, stale answer fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const ci = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));

const jobs = ci.jobs;
const stepsOf = job => (jobs[job] && jobs[job].steps) || [];

// Found by what it does — it reads the runs API of the scanning workflow — not
// by its job name, so a rename does not turn this suite into assertions about a
// job that no longer exists.
const heartbeatJobName = Object.keys(jobs).find(name => stepsOf(name).some(
    s => /actions\/workflows\/.*\/runs/.test(s.run || '')));

const heartbeatJob = heartbeatJobName ? jobs[heartbeatJobName] : undefined;
const heartbeatStep = heartbeatJobName
    ? stepsOf(heartbeatJobName).find(s => /actions\/workflows\/.*\/runs/.test(s.run || ''))
    : undefined;

/** ISO timestamp `days` days before now, which is what the API returns. */
const daysAgo = days => new Date(Date.now() - days * 86400_000).toISOString();

/** A runs-API body with one run created at `created_at`, and a total. */
const runsBody = ({ created_at, total = 1 }) => JSON.stringify({
    total_count: total,
    workflow_runs: created_at ? [{ created_at }] : [],
});

/**
 * Run the heartbeat step's own script with `curl` stubbed to print `body` and
 * exit `curlExits`. `jq` and `date` are the real ones — the arithmetic and the
 * JSON parsing are part of what is under test.
 *
 * @returns {{status: number, stdout: string, summary: string}}
 */
const runWith = ({ body = '', curlExits = 0, repository = 'theshield2594/clawdia' }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-heartbeat-'));
    try {
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        // The stub ignores its arguments and answers with the fixture, the way
        // the runs endpoint would. `printf %s` keeps the JSON intact.
        fs.writeFileSync(
            path.join(bin, 'curl'),
            `#!/bin/sh
printf '%s' ${JSON.stringify(body)}
exit ${curlExits}
`,
            { mode: 0o755 },
        );

        const script = path.join(dir, 'step.sh');
        fs.writeFileSync(script, heartbeatStep.run);
        const summaryFile = path.join(dir, 'summary');
        fs.writeFileSync(summaryFile, '');
        const outputFile = path.join(dir, 'outputs');
        fs.writeFileSync(outputFile, '');

        // The literal step env (SCAN_WORKFLOW, STALE_DAYS) travels with the
        // script on the runner; GH_TOKEN is a secret expression there, a dummy
        // here. GITHUB_REPOSITORY and GITHUB_API_URL are runner defaults.
        // Literal step env travels with the script on the runner. Numbers
        // (STALE_DAYS) parse as numbers out of YAML, so coerce; only the secret
        // expressions (GH_TOKEN) are dropped, since they resolve to nothing
        // here and are supplied as a dummy below.
        const stepEnv = {};
        for (const [k, v] of Object.entries(heartbeatStep.env || {})) {
            if (typeof v === 'string' && v.includes('${{')) continue;
            stepEnv[k] = String(v);
        }

        const result = spawnSync('bash', ['-e', script], {
            encoding: 'utf8',
            env: {
                ...process.env,
                ...stepEnv,
                PATH: `${bin}:${process.env.PATH}`,
                GH_TOKEN: 'dummy-token',
                GITHUB_REPOSITORY: repository,
                GITHUB_API_URL: 'https://api.github.com',
                GITHUB_OUTPUT: outputFile,
                GITHUB_STEP_SUMMARY: summaryFile,
            },
        });

        return {
            status: result.status,
            stdout: `${result.stdout}${result.stderr}`,
            summary: fs.readFileSync(summaryFile, 'utf8'),
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

describe('the heartbeat is wired the way the issue asks', () => {
    test('there is a job that reads the scan workflow’s run history', () => {
        expect(heartbeatJob).toBeDefined();
        expect(typeof heartbeatStep.run).toBe('string');
    });

    test('it runs on the triggers GitHub never disables — push and pull_request', () => {
        // `on:` is YAML 1.1's boolean true, which js-yaml parses as the key `true`.
        const on = ci.on || ci[true] || {};
        expect(on).toHaveProperty('push');
        expect(on).toHaveProperty('pull_request');
        // And crucially it is *not* itself only a scheduled thing — that would
        // be the same problem one level up.
        expect(on).not.toHaveProperty('schedule');
    });

    test('it asks for no more than read access', () => {
        const asked = Object.values(heartbeatJob.permissions || {});
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.filter(level => level !== 'read')).toEqual([]);
    });

    test('it gates nothing — a lapsed scan does not stop shipping', () => {
        const publish = Object.keys(jobs).find(name => stepsOf(name).some(
            s => /build-push-action/.test(s.uses || '') && s.with && s.with.push === true));
        expect(publish).toBeDefined();
        expect(jobs[publish].needs || []).not.toContain(heartbeatJobName);
    });

    test('it watches the workflow that actually scans', () => {
        // The name it reads must be a real workflow file, or it watches nothing.
        const named = /SCAN_WORKFLOW:\s*(\S+)/.exec(yaml.dump(heartbeatStep.env || {}))
            || [null, heartbeatStep.env.SCAN_WORKFLOW];
        const file = heartbeatStep.env.SCAN_WORKFLOW;
        expect(file).toBeDefined();
        expect(fs.existsSync(path.join(ROOT, '.github', 'workflows', file))).toBe(true);
    });
});

describe('a scan that is still firing passes quietly', () => {
    test('a recent run is green and says how recent', () => {
        const run = runWith({ body: runsBody({ created_at: daysAgo(2) }) });

        expect(run.status).toBe(0);
        expect(run.stdout).not.toContain('::error::');
        expect(run.stdout).not.toContain('::warning::');
        expect(run.summary).toMatch(/still firing/);
    });

    test('a run right at the threshold is not yet a lapse', () => {
        // Strictly greater than STALE_DAYS fails; the boundary itself passes, so
        // a scan that ran exactly on time three weeks ago is not called stale.
        const run = runWith({ body: runsBody({ created_at: daysAgo(21) }) });

        expect(run.status).toBe(0);
        expect(run.stdout).not.toContain('::error::');
    });
});

describe('a scan that has stopped fails loudly', () => {
    test('a run older than the threshold fails the job and says why', () => {
        const run = runWith({ body: runsBody({ created_at: daysAgo(40), total: 5 }) });

        expect(run.status).toBe(1);
        expect(run.stdout).toContain('::error::');
        // The message names the fix, not just the fact.
        expect(run.stdout).toMatch(/Actions tab|workflow_dispatch/);
        expect(run.summary).toMatch(/has not run in \d+ days/);
    });
});

describe('a question it could not ask never reads as a lapse', () => {
    test('an API it could not reach warns and passes', () => {
        const run = runWith({ body: '', curlExits: 7 });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('::warning::');
        expect(run.stdout).not.toContain('::error::');
        expect(run.summary).toMatch(/not checked/i);
    });

    test('an answer that is not the JSON expected warns and passes', () => {
        const run = runWith({ body: '<html>502 Bad Gateway</html>', curlExits: 0 });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('::warning::');
        expect(run.stdout).not.toContain('::error::');
    });

    test('a repo with no scan history yet — a fork, or before the first run — warns and passes', () => {
        const run = runWith({ body: runsBody({ created_at: null, total: 0 }) });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('::warning::');
        expect(run.stdout).not.toContain('::error::');
        expect(run.summary).toMatch(/never run/);
    });

    test('an unparseable timestamp warns and passes rather than failing', () => {
        const run = runWith({ body: JSON.stringify({
            total_count: 1,
            workflow_runs: [{ created_at: 'not-a-date' }],
        }) });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('::warning::');
        expect(run.stdout).not.toContain('::error::');
    });
});
