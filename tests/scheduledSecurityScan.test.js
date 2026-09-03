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
const path = require('path');
const yaml = require('js-yaml');

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
