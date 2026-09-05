// The scheduler is the single bootstrap site for background work (#610).
// These tests hold the properties that made the old dual-bootstrap a bug
// factory: duplicate schedules for the same job and invalid cron expressions.

jest.mock('discord.js', () => ({
    ActivityType: { Playing: 0, Listening: 2, Watching: 3 },
}));

const cron = require('node-cron');
const { JOBS, STARTERS } = require('../src/services/scheduler');

describe('scheduler job table', () => {
    test('every job has a valid cron expression', () => {
        for (const job of JOBS) {
            expect(cron.validate(job.schedule)).toBe(true);
        }
    });

    test('job names are unique — no job can be scheduled twice', () => {
        const names = JOBS.map(j => `${j.service}/${j.name}`);
        expect(new Set(names).size).toBe(names.length);
    });

    // #931. `service` is what runJob records a run under, what /health reports
    // and what a dead-letter entry is filed against, so a job whose service
    // name does not match the module it actually calls sends whoever reads the
    // failure to the wrong file. Ten of these named `schedulerService` and
    // pointed at it regardless of whether the function inside was about wars,
    // bank interest or shop prices; now each names the domain service that owns
    // the job, and this is what stops the two drifting apart again.
    test.each(JOBS.map(j => [j.name, j]))('%s: service names the module its fn requires', (_name, job) => {
        const match = /require\('([^']+)'\)/.exec(job.fn.toString());
        expect(match).not.toBeNull();
        expect(job.service).toBe(match[1].split('/').pop());
    });

    // The registry may point at a domain service; it may not become one. A job
    // whose body sits inside services/scheduler/ is the grab-bag returning
    // under a new name — every `fn` reaches out of this directory, not into it.
    test.each(JOBS.map(j => [j.name, j]))('%s lives outside the registry', (_name, job) => {
        expect(job.fn.toString()).toMatch(/require\('\.\.\/[^/']+'\)/);
    });

    test('starter names are unique', () => {
        const names = STARTERS.map(s => s.name);
        expect(new Set(names).size).toBe(names.length);
    });

    test('checkTempVoice is scheduled exactly once', () => {
        const matches = JOBS.filter(j => j.name === 'checkTempVoice');
        expect(matches).toHaveLength(1);
        expect(matches[0].schedule).toBe('*/2 * * * *');
    });

    test('index.js no longer owns a clientReady bootstrap block', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
        expect(src).not.toMatch(/client\.once\(\s*['"]clientReady['"]/);
        expect(src).not.toMatch(/checkTempVoice/);
        expect(src).not.toMatch(/setPresence/);
    });
});
