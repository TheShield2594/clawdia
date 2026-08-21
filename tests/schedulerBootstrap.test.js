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
