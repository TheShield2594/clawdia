'use strict';

/**
 * The two halves of "what happened to the image after it was built" — #952 and
 * #953.
 *
 * Both are a few lines of YAML that nothing else in the tree refers to, which
 * is the kind of thing a workflow rewrite drops and nobody notices for a
 * release. tests/ciSupplyChainGates.test.js exists for exactly that reason and
 * this is its neighbour, holding the two gaps that sat on the other side of the
 * push:
 *
 *   #952  `publish` rebuilds rather than promoting the artifact that was booted
 *         and scanned. That is documented and deliberate — promoting by digest
 *         needs `packages: write` in a job that also runs on pull requests. But
 *         a cache eviction between the jobs publishes an image nothing ever
 *         looked at, and nothing reported that it had happened.
 *   #953  a new image was published and nothing told the deployment. The
 *         Portainer stack does not poll, so a security fix could sit published
 *         and undeployed because nothing announced it.
 *
 * These assert the reporting, not the guarantee. The guarantee is still the
 * cache hit; what is now testable is that a breach of it is loud.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const ci = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));

const jobs = ci.jobs;
const stepsOf = job => jobs[job].steps || [];
const runScript = job => stepsOf(job).map(s => s.run || '').join('\n');

// Found by what the job does rather than by its name, the same way the
// supply-chain gates find theirs — renaming a job must not turn these into
// assertions about a job that no longer exists.
const jobWhoseBuild = pushes => Object.keys(jobs).find(name => stepsOf(name).some(
    step => /build-push-action/.test(step.uses || '') && step.with && step.with.push === pushes));

const publishJob = jobWhoseBuild(true);

/** Every job that records the layers it scanned, by its output. */
const recordingJobs = Object.keys(jobs).filter(name => jobs[name].outputs
    && Object.prototype.hasOwnProperty.call(jobs[name].outputs, 'scanned-layers'));

describe('#952 — a publish that is not the scanned image is reported', () => {
    test('the jobs that scan an image record the layers they scanned', () => {
        // Both platforms or neither: publish assembles one manifest list out of
        // two cache scopes, and either can be evicted independently, so
        // checking one platform would report half the problem.
        expect(recordingJobs.length).toBeGreaterThanOrEqual(2);
    });

    test('every job that scans with Trivy also records its layers', () => {
        const scanning = Object.keys(jobs).filter(name => stepsOf(name).some(
            step => /trivy-action/.test(step.uses || '')));

        expect(scanning).not.toEqual([]);
        for (const job of scanning) {
            expect(recordingJobs).toContain(job);
        }
    });

    test('the record is taken after the scan, so only a passing image is recorded', () => {
        for (const job of recordingJobs) {
            const steps = stepsOf(job);
            const scan = steps.findIndex(s => /trivy-action/.test(s.uses || ''));
            const record = steps.findIndex(s => /docker image inspect/.test(s.run || ''));

            expect(scan).toBeGreaterThanOrEqual(0);
            expect(record).toBeGreaterThan(scan);
        }
    });

    test('it records diff IDs, not a digest', () => {
        // The digest cannot answer the question: publish adds OCI labels from
        // metadata-action, a label changes the image config, and so the config
        // and manifest digests differ from the scanned build's on every run —
        // cache hit or not. Diff IDs are the uncompressed layer hashes, which
        // is what "the same bytes" means and what labels do not touch.
        for (const job of recordingJobs) {
            expect(runScript(job)).toMatch(/RootFS\.Layers/);
        }
    });

    const checkStep = stepsOf(publishJob).find(s => /imagetools inspect/.test(s.run || ''));

    test('publish compares what it pushed against what was scanned', () => {
        expect(checkStep).toBeDefined();
        expect(checkStep.run).toMatch(/rootfs\.diff_ids/);
    });

    test('it compares the image it actually pushed, by digest', () => {
        // Not `:latest` and not the sha- tag: both are mutable, and by the time
        // this reads them a concurrent run could have repointed either.
        const env = checkStep.env || {};
        expect(JSON.stringify(env)).toMatch(/steps\.build\.outputs\.digest/);
    });

    test('it reads both platforms', () => {
        expect(checkStep.run).toMatch(/linux\/amd64/);
        expect(checkStep.run).toMatch(/linux\/arm64/);
    });

    test('it consumes the recording jobs rather than recomputing', () => {
        const env = JSON.stringify(checkStep.env || {});
        for (const job of recordingJobs) {
            expect(env).toContain(`needs.${job}.outputs.scanned-layers`);
        }
    });

    test('a mismatch warns rather than failing the job', () => {
        // The push has already happened, so failing here unpublishes nothing —
        // and a re-run would restore from the same evicted cache and fail
        // again, which is a red main branch that no action clears. What the
        // operator needs is to know, which is what the annotation is.
        expect(checkStep.run).toMatch(/::warning::/);
        expect(checkStep['continue-on-error']).toBeUndefined();
    });

    test('an unreadable manifest is reported as unchecked, not as a mismatch', () => {
        // Same rule the npm audit step follows: a registry blip read as a
        // security finding is the false alarm that teaches everyone to ignore
        // the real one.
        expect(checkStep.run).toMatch(/not checked/i);
    });

    test('the result reaches the run summary, not only the log', () => {
        expect(checkStep.run).toMatch(/GITHUB_STEP_SUMMARY/);
    });
});

describe('#953 — a published image announces itself', () => {
    const summaryStep = stepsOf(publishJob).find(s => /### Image/.test(s.run || ''));

    test('the summary carries the tag to deploy, not only the digest', () => {
        expect(summaryStep).toBeDefined();
        // The gap this closes: the digest was already there, so a rollback
        // target was recoverable, but nothing said what to move *forward* to.
        expect(summaryStep.run).toMatch(/CLAWDIA_IMAGE_TAG=sha-/);
    });

    test('the summary still carries the immutable digest pin', () => {
        expect(summaryStep.run).toMatch(/CLAWDIA_IMAGE_TAG=latest@/);
        expect(summaryStep.run).toMatch(/steps\.build\.outputs\.digest/);
    });

    test('the sha- tag in the summary is the one metadata-action publishes', () => {
        // `type=sha,format=long` produces `sha-<full commit sha>`. A summary
        // naming a tag that was not published is worse than no summary.
        const meta = stepsOf(publishJob).find(s => /metadata-action/.test(s.uses || ''));
        expect(meta.with.tags).toMatch(/type=sha,format=long/);
        expect(summaryStep.run).toMatch(/sha-\$\{\{\s*github\.sha\s*\}\}/);
    });

    const hookStep = stepsOf(publishJob).find(s => /PORTAINER_WEBHOOK_URL/.test(
        (s.run || '') + JSON.stringify(s.if || '')));

    test('there is an opt-in Portainer webhook', () => {
        expect(hookStep).toBeDefined();
    });

    test('it is off unless an operator configured one', () => {
        // Every fork, and this repo by default, has no such secret. A workflow
        // that assumed a Portainer would be wrong for all of them.
        expect(hookStep.if).toMatch(/env\.PORTAINER_WEBHOOK_URL\s*!=\s*''/);
    });

    test('the secret is lifted to job env, because a step `if` cannot read secrets', () => {
        expect(jobs[publishJob].env.PORTAINER_WEBHOOK_URL).toMatch(/secrets\.PORTAINER_WEBHOOK_URL/);
    });

    test('it fires on the default branch only', () => {
        // A v* tag push publishes a version tag nothing is pointed at until an
        // operator chooses to be; redeploying on one would deploy something
        // they did not ask for. `:latest` — what the stack pulls by default —
        // only moves on the default branch anyway.
        expect(hookStep.if).toMatch(/default_branch/);
    });

    test('it never echoes the URL, which is a deploy credential', () => {
        expect(hookStep.run).not.toMatch(/echo[^\n]*\$PORTAINER_WEBHOOK_URL/);
        expect(hookStep.run).not.toMatch(/echo[^\n]*\$\{PORTAINER_WEBHOOK_URL\}/);
        // And the response body stays out of the log too: Portainer answers a
        // webhook with the stack definition.
        expect(hookStep.run).toMatch(/-o \/dev\/null/);
    });

    test('a webhook failure warns rather than failing the publish', () => {
        // The image is published and scanned either way, which is what this job
        // is for. A Portainer that was unreachable for thirty seconds is not a
        // reason to re-publish an image already in the registry.
        expect(hookStep.run).toMatch(/::warning::/);
        expect(hookStep['continue-on-error']).toBeUndefined();
    });

    test('the webhook runs after the image is pushed', () => {
        const steps = stepsOf(publishJob);
        const build = steps.findIndex(s => /build-push-action/.test(s.uses || ''));
        expect(steps.indexOf(hookStep)).toBeGreaterThan(build);
    });
});
