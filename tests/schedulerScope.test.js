'use strict';

// Where each scheduled job runs, and why (#889).
//
// Everything used to be pinned to shard 0. For work that must happen once per
// deployment that is right — jobRunner's overlap guard is a process-local Set,
// so N processes each see an empty one and the job runs N times. For work that
// reaches a guild it is wrong in a way that produces no error at all: shard 0's
// client only holds the guilds Discord routed to shard 0, so an announcement
// for a guild on shard 3 was dropped in silence. The old comment said so and
// deferred the classification. This is the classification, and these are the
// two properties that make it real rather than a label:
//
//   1. A 'deployment' job is scheduled only on the primary shard.
//   2. A 'guild' job is scheduled everywhere AND actually partitions its own
//      work list — a scope declared and not enforced is worse than the pin it
//      replaced, because it duplicates the work the pin was protecting.

const cronSchedules = [];
jest.mock('node-cron', () => ({
    schedule: jest.fn((expression, fn, options) => {
        cronSchedules.push({ expression, options });
        return { stop: jest.fn() };
    }),
    validate: jest.requireActual('node-cron').validate,
}));

// runOnStart jobs fire during bootstrap, and this suite is about what gets
// scheduled rather than what the jobs do — a real run would reach Mongo.
jest.mock('../src/utils/jobRunner', () => ({ runJob: jest.fn() }));

const startedStarters = [];
jest.mock('../src/services/ai/mcp/prewarm', () => ({
    startMcpPrewarm: jest.fn(() => startedStarters.push('mcpPrewarm')),
}));
for (const [module, fn, label] of [
    ['../src/services/summaryService', 'startSummaryService', 'summaryService'],
    ['../src/services/caseService', 'startSlaMonitor', 'caseService.slaMonitor'],
    ['../src/services/questService', 'startQuestService', 'questService'],
    ['../src/services/pollService', 'scheduleActivePollExpirations', 'poll.expirations'],
    ['../src/services/dailyBibleService', 'startDailyBibleService', 'dailyBibleService'],
]) {
    jest.doMock(module, () => ({
        ...jest.requireActual(module),
        [fn]: jest.fn(() => startedStarters.push(label)),
    }));
}
// Only the starter is stubbed: scheduleDailyNews registers a cron of its own,
// which would land in cronSchedules and be counted as a job. checkRssFeeds stays
// real, because the enforcement tests below read its source.
jest.doMock('../src/services/rssService', () => ({
    ...jest.requireActual('../src/services/rssService'),
    scheduleDailyNews: jest.fn(() => startedStarters.push('rssService.dailyNews')),
}));

const scheduler = require('../src/services/scheduler');
const { JOBS, STARTERS, SCOPE, startScheduler, stopScheduler } = scheduler;

/** A client that reports itself as shard `id` of `count`. */
function shardedClient(id, count) {
    return {
        shard: { ids: [id], count },
        user: { setPresence: jest.fn().mockResolvedValue(undefined) },
    };
}

function unshardedClient() {
    return { user: { setPresence: jest.fn().mockResolvedValue(undefined) } };
}

/** Runs startScheduler against `client` and reports what it scheduled. */
function bootstrap(client) {
    cronSchedules.length = 0;
    startedStarters.length = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        startScheduler(client);
    } finally {
        console.log.mockRestore();
    }
    const result = {
        expressions: cronSchedules.map(c => c.expression),
        starters: [...startedStarters],
    };
    stopScheduler();
    return result;
}

const guildJobs = () => JOBS.filter(j => j.scope === SCOPE.GUILD);
const deploymentJobs = () => JOBS.filter(j => j.scope === SCOPE.DEPLOYMENT);

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('every job declares where it runs', () => {
    test('each job carries one of the two scopes', () => {
        for (const job of JOBS) {
            expect(Object.values(SCOPE)).toContain(job.scope);
        }
    });

    test('the classification is not vacuous — both scopes are used', () => {
        expect(guildJobs().length).toBeGreaterThan(0);
        expect(deploymentJobs().length).toBeGreaterThan(0);
    });

    test('returnExpiredMarketListings is deployment-wide: no client, nothing announced', () => {
        // It takes no client at all, so there is nothing for a second shard to
        // reach — running it everywhere would only race the listing claim.
        const job = JOBS.find(j => j.name === 'returnExpiredMarketListings');
        expect(job.scope).toBe(SCOPE.DEPLOYMENT);
        expect(job.fn.toString()).not.toContain('client');
    });

    test('applyBankInterest is per-guild, though it is the usual deployment-wide example', () => {
        // Its claim (bankInterestLastRunAt) and its credits are both scoped to
        // one guild, and it finishes by posting the interest summary to that
        // guild's announcement channel. On shard 0 alone it pays correctly and
        // tells nobody on every other shard.
        expect(JOBS.find(j => j.name === 'applyBankInterest').scope).toBe(SCOPE.GUILD);
    });
});

// ---------------------------------------------------------------------------
// The enforcement — a scope is a claim about the service, not just a label
// ---------------------------------------------------------------------------

describe('a per-guild job partitions its own work', () => {
    /** The function a job's `fn` actually calls, resolved through the require. */
    function targetOf(job) {
        const match = /require\('([^']+)'\)\.(\w+)/.exec(job.fn.toString());
        expect(match).not.toBeNull();
        const [, modulePath, name] = match;
        // The job table lives in src/services/scheduler/, so its relative
        // requires resolve from there.
        const resolved = require(require('path').join(__dirname, '../src/services/scheduler', modulePath));
        return resolved[name];
    }

    test.each(guildJobs().map(j => [j.name, j]))(
        '%s filters its work list with handlesGuild',
        (_name, job) => {
            // Resolved through the export rather than read off the file, so a
            // job re-exported from another module (postScheduledNewspapers)
            // cannot pass on a sibling function's guard.
            expect(targetOf(job).toString()).toContain('handlesGuild(');
        },
    );

    test.each(deploymentJobs().map(j => [j.name, j]))(
        '%s does not filter — it is meant to run once, not once per shard',
        (_name, job) => {
            expect(targetOf(job).toString()).not.toContain('handlesGuild(');
        },
    );
});

// ---------------------------------------------------------------------------
// The bootstrap
// ---------------------------------------------------------------------------

describe('startScheduler schedules by scope', () => {
    afterEach(() => stopScheduler());

    test('unsharded: every job and every service, exactly as before', () => {
        const { expressions, starters } = bootstrap(unshardedClient());
        expect(expressions).toHaveLength(JOBS.length);
        expect(starters).toEqual(expect.arrayContaining(STARTERS.map(s => s.name)));
        expect(starters).toContain('mcpPrewarm');
    });

    test('the primary shard runs everything, including the deployment-wide jobs', () => {
        const { expressions, starters } = bootstrap(shardedClient(0, 4));
        expect(expressions).toHaveLength(JOBS.length);
        expect(starters).toEqual(expect.arrayContaining(STARTERS.map(s => s.name)));
    });

    test('a non-primary shard runs the per-guild jobs and only those', () => {
        const { expressions, starters } = bootstrap(shardedClient(2, 4));
        expect(expressions).toHaveLength(guildJobs().length);
        expect(expressions).toHaveLength(JOBS.length - deploymentJobs().length);

        // The start-once services keep their own schedules rather than
        // declaring one here, so none of them can be classified from the job
        // table. They stay singleton work until they can be.
        for (const starter of STARTERS) {
            expect(starters).not.toContain(starter.name);
        }
    });

    test('a non-primary shard still warms its own caches and sets its own presence', () => {
        // Both are properties of this process rather than of the deployment: a
        // shard that skipped them would show no activity to the guilds it
        // serves and answer their first message from a cold cache.
        const client = shardedClient(3, 4);
        const { starters } = bootstrap(client);
        expect(starters).toContain('mcpPrewarm');
        expect(client.user.setPresence).toHaveBeenCalled();
    });

    test('runOnStart still fires, on the shards that schedule the job', () => {
        const runOnStart = JOBS.filter(j => j.runOnStart);
        expect(runOnStart.length).toBeGreaterThan(0);
        // Every runOnStart job is per-guild, so every shard runs it at boot.
        for (const job of runOnStart) {
            expect(job.scope).toBe(SCOPE.GUILD);
        }
    });
});
