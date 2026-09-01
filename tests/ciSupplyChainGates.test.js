'use strict';

/**
 * The gates on the way to the registry — #645, #646 and #651.
 *
 * CI used to run `npm test` and nothing else, and the only thing that ever
 * built the Dockerfile was the publish job, on `main`, after the merge. So the
 * three ways a bad build reached production each had nothing in the way:
 *
 *   #645  a dependency with a published advisory, or a CVE in the base image or
 *         an installed apk, was found by whoever happened to scan production.
 *   #646  a Dockerfile regression was found by the deploy rather than by the
 *         pull request that caused it — and this image compiles `canvas` from
 *         source, which is the shape of thing a base-image bump breaks without
 *         touching a line of JavaScript.
 *   #651  two pushes to `main` a minute apart published `:latest` in whichever
 *         order they happened to finish, so a slow build of the older commit
 *         could overwrite a fast build of the newer one and leave production
 *         running superseded code.
 *
 * Each fix is a few lines of YAML that nothing else refers to, which is exactly
 * the kind of thing that gets dropped in a rewrite of the workflow and noticed
 * a release later. This is what notices.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const ci = yaml.load(source);

const jobs = ci.jobs;
const stepsOf = job => jobs[job].steps || [];
const runScript = job => stepsOf(job).map(s => s.run || '').join('\n');

// Found by what the job does rather than by its name, so renaming a job does
// not quietly turn these assertions into no-ops against a job that no longer
// exists.
const jobWhoseBuild = pushes => Object.keys(jobs).find(name => stepsOf(name).some(
    step => /build-push-action/.test(step.uses || '') && step.with && step.with.push === pushes));

/** The job that pushes to the registry. */
const publishJob = jobWhoseBuild(true);

/** The job that builds the image and does not push it. */
const buildJob = jobWhoseBuild(false);

describe('#645 — the dependency tree is audited', () => {
    test('some job runs npm audit', () => {
        const audited = Object.keys(jobs).filter(name => /npm audit/.test(runScript(name)));
        expect(audited).not.toEqual([]);
    });

    test('at --audit-level=high, so it fails rather than just printing', () => {
        // `npm audit` without a level exits 0 on anything below critical in
        // some npm versions and non-zero on everything in others; naming the
        // level is what makes the gate mean one thing.
        expect(source).toMatch(/npm audit[^\n]*--audit-level=high\b/);
    });

    test('and reports even when the suite failed', () => {
        const step = stepsOf('test').find(s => /npm audit/.test(s.run || ''));
        expect(step).toBeDefined();
        expect(step.if).toBe('always()');
    });
});

describe('#645 — the image is scanned', () => {
    const scan = buildJob && stepsOf(buildJob).find(s => /trivy|grype|snyk/i.test(s.uses || ''));

    test('a scanner runs over the built image', () => {
        expect(scan).toBeDefined();
    });

    test('a finding fails the job rather than being printed and ignored', () => {
        // Without exit-code the action reports and returns 0, which is a report
        // nobody reads rather than a gate.
        expect(String(scan.with['exit-code'])).toBe('1');
    });

    test('it gates at the same bar as the npm side', () => {
        expect(scan.with.severity).toBe('HIGH,CRITICAL');
        // Findings with no fixed version have no action attached to them and
        // are most of an Alpine report; leaving them in makes the scan
        // permanently red, which is the failure mode that gets a gate deleted.
        expect(scan.with['ignore-unfixed']).toBe(true);
    });

    test('it runs before anything is pushed', () => {
        expect(buildJob).not.toBe(publishJob);
        expect(jobs[publishJob].needs).toContain(buildJob);
    });
});

describe('#646 — the Dockerfile is built on pull requests', () => {
    test('a job builds the image without pushing it', () => {
        expect(buildJob).toBeDefined();
    });

    test('nothing excludes pull requests from it', () => {
        // The publish job is `if: github.event_name != 'pull_request'`, which
        // is right for a job holding `packages: write` and wrong for this one:
        // a build that only runs after the merge is the whole of #646.
        expect(jobs[buildJob].if).toBeUndefined();

        const on = ci.on || ci[true];   // YAML 1.1 reads a bare `on:` as `true`
        expect(Object.keys(on)).toContain('pull_request');
    });

    test('it loads the result, so the steps after it have something to run', () => {
        const build = stepsOf(buildJob).find(s => /build-push-action/.test(s.uses || ''));
        expect(build.with.load).toBe(true);
        expect(build.with.tags).toBeTruthy();
    });

    test('it boots the image rather than only building it', () => {
        // A build proves the layers resolve. It says nothing about whether the
        // native canvas binding links, whether the fonts are where
        // utils/registerFonts.js looks, or whether src/index.js can be required
        // at all — which is the half that actually breaks.
        const script = runScript(buildJob);
        expect(script).toMatch(/docker run\b/);
        expect(script).toContain('scripts/image-smoke.js');
        expect(script).toContain('Missing required environment variables');
    });

    test('the smoke script it runs is in the image', () => {
        expect(fs.existsSync(path.join(ROOT, 'scripts', 'image-smoke.js'))).toBe(true);

        // .dockerignore decides what `COPY . .` actually carries. `tests` and
        // `*.md` are excluded, so a smoke test placed there would be missing
        // from the image with no build-time error.
        const ignored = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
            .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        expect(ignored).not.toContain('scripts');
    });

    test('the publish job cannot run without it', () => {
        expect(jobs[publishJob].needs).toEqual(expect.arrayContaining([buildJob, 'test']));
    });
});

describe('#961 — the apk upgrade layer is not frozen by the cache', () => {
    // The runtime stage runs `apk upgrade` so the image carries Alpine's
    // published fixes without waiting for a node:24-alpine rebuild. With
    // `cache-from: type=gha` and a digest-pinned base, that RUN is restored
    // rather than executed until someone edits the Dockerfile — so the upgrade
    // was pinned to whatever Alpine served the day the layer was first built,
    // and the scan above eventually failed on a libexpat that had a fix. The
    // ARG is the cache key that unfreezes it, and it is worth nothing unless
    // both builds actually pass it.
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const buildArgsOf = job => {
        const step = stepsOf(job).find(s => /build-push-action/.test(s.uses || ''));
        return String((step.with || {})['build-args'] || '');
    };

    test('the Dockerfile declares the refresh argument', () => {
        expect(dockerfile).toMatch(/^ARG APK_REFRESH=/m);
    });

    test('it sits above the upgrade, which is the layer it is there to bust', () => {
        const arg = dockerfile.search(/^ARG APK_REFRESH=/m);
        const upgrade = dockerfile.search(/^RUN apk upgrade\b/m);
        expect(arg).toBeGreaterThan(-1);
        expect(upgrade).toBeGreaterThan(arg);
    });

    test('and inside the runtime stage, so a new day is not a fresh canvas compile', () => {
        // Declared before the first FROM it would be a global argument, which
        // invalidates the build stage too — and that stage compiles the native
        // canvas binding from source. Minutes a day, for an upgrade that only
        // affects the runtime stage's packages.
        const lastFrom = dockerfile.lastIndexOf('\nFROM ');
        expect(dockerfile.search(/^ARG APK_REFRESH=/m)).toBeGreaterThan(lastFrom);
    });

    test('the build job passes it, and not as a constant', () => {
        // A literal would be a key that never moves, which is the bug with an
        // ARG in front of it.
        expect(buildArgsOf(buildJob)).toMatch(/APK_REFRESH=\$\{\{\s*steps\./);
    });

    test('from a UTC date, so two jobs in one run agree on the day', () => {
        expect(runScript(buildJob)).toMatch(/date -u\b/);
    });

    test('the publish build takes the build job\'s value rather than its own', () => {
        // Recomputing it here would publish an image built from different
        // inputs than the one the scan passed — and miss the cache to do it.
        const outputs = jobs[buildJob].outputs || {};
        const names = Object.keys(outputs);
        expect(names).not.toEqual([]);

        const published = buildArgsOf(publishJob);
        expect(published).toMatch(/APK_REFRESH=/);
        expect(names.some(name => published.includes(`needs.${buildJob}.outputs.${name}`))).toBe(true);
    });
});

describe('#651 — publishing is serialized', () => {
    test('the workflow that publishes declares a concurrency group', () => {
        // The publish job lives in this workflow, so the workflow-level group
        // is what orders it. If publishing ever moves back out to a file of its
        // own, that file needs its own group and this test needs to follow it.
        expect(publishJob).toBeDefined();
        expect(ci.concurrency).toBeDefined();
    });

    test('keyed on the ref, so two pushes to main cannot both be in flight', () => {
        expect(ci.concurrency.group).toContain('github.ref');
    });

    test('newest wins — the older run is cancelled, not left to finish', () => {
        // Without this the older run completes and repoints `:latest` after the
        // newer one already did, which is #651 exactly.
        expect(ci.concurrency['cancel-in-progress']).toBe(true);
    });
});
