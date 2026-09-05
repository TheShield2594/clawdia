const cron = require('node-cron');
const { ActivityType } = require('discord.js');
const { runJob } = require('../../utils/jobRunner');
const { isPrimaryShard, shardTag } = require('../../utils/sharding');

// Single owner of all recurring background work. Every scheduled job goes
// through runJob (overlap protection, DLQ, health tracking), and every
// start-once service is listed here — nothing else in the codebase should
// call cron.schedule at bootstrap or hang jobs off a clientReady handler.
//
// A registry and nothing else (#931). Ten of the entries below used to point at
// one `schedulerService.js` — 1,543 lines holding wars, ranked seasons, bank
// interest, pet-of-the-week, shop prices, market sweeps and weekly champions
// side by side, directly next to this file and its stated intent. Each job's
// body now lives in the service that owns its domain, so `service` names a real
// module: a war change is in warService.js and nowhere near bank interest.
// Adding a job here means writing it in its domain's service and pointing at
// it, never growing a module that exists to be scheduled.

// ── Scope: which processes run a job (#889) ─────────────────────────────────
//
// Every job used to run on shard 0 and nowhere else, which is correct for work
// that must happen once per deployment and wrong for work that reaches a guild:
// shard 0's client only holds the guilds Discord routed to shard 0, so an
// announcement for a guild on shard 3 was silently dropped. The trade was
// deliberate — a missed announcement beats a duplicated payout — but the
// classification it was standing in for is the actual fix, and this is it.
//
//   'deployment'  Runs on the primary shard only. The job's unit of work is not
//                 a guild it can partition on, or it never reaches Discord at
//                 all, so a second runner would only duplicate it.
//
//   'guild'       Runs on every shard, each one filtering its work list down to
//                 the guilds Discord routes to it. The filter is `handlesGuild`
//                 (src/utils/sharding.js), applied inside the service at the top
//                 of its per-guild loop — before any claim, so a shard that
//                 cannot announce for a guild does not take that guild's lease
//                 and leave the shard that can with nothing to do.
//
// A job is 'guild' when both hold: every write it makes is scoped to one
// guild's documents, and it reaches Discord for that guild. `applyBankInterest`
// is 'guild' for that reason, though it is the job usually named as the
// deployment-wide example — it claims per guild (`bankInterestLastRunAt`) and
// then posts the interest summary to that guild's announcement channel, so
// pinning it to shard 0 loses the summary for every other shard's guilds while
// gaining nothing. `returnExpiredMarketListings` is the genuine article: it
// takes no client, announces nothing, and returns items to sellers straight in
// the database.
//
// What this costs: a 'guild' job's initial query runs once per shard rather than
// once per deployment, because Mongo cannot evaluate Discord's `(id >> 22) % N`
// routing rule and the partition therefore has to happen in the process. For the
// per-minute jobs the query is already narrow (rows that are due). For the
// weekly full-collection scans it is a lean projection over the guild list, N
// times an hour at worst. That is the price of announcements that arrive.
//
// Unsharded — every deployment today — `handlesGuild` is constantly true and
// every job runs exactly where it ran before.
const SCOPE = { DEPLOYMENT: 'deployment', GUILD: 'guild' };

// Recurring jobs. `fn` receives the Discord client. Schedules without a
// timezone run in server-local time, matching their previous behavior.
const JOBS = [
    {
        name: 'checkRssFeeds',
        scope: SCOPE.GUILD,
        service: 'rssService',
        schedule: '*/5 * * * *',
        fn: client => require('../rssService').checkRssFeeds(client),
    },
    {
        name: 'checkReminders',
        scope: SCOPE.GUILD,
        service: 'reminderService',
        schedule: '* * * * *',
        fn: client => require('../reminderService').checkReminders(client),
    },
    {
        name: 'checkGiveaways',
        scope: SCOPE.GUILD,
        service: 'giveawayService',
        schedule: '* * * * *',
        fn: client => require('../giveawayService').checkGiveaways(client),
    },
    {
        // Previously scheduled twice (a 5-minute interval in index.js and a
        // 2-minute cron in ready.js); the more frequent schedule wins.
        name: 'checkTempVoice',
        scope: SCOPE.GUILD,
        service: 'tempVoiceService',
        schedule: '*/2 * * * *',
        runOnStart: true,
        fn: client => require('../tempVoiceService').checkTempVoice(client),
    },
    {
        name: 'checkBirthdays',
        scope: SCOPE.GUILD,
        service: 'birthdayService',
        schedule: '0 * * * *',
        fn: client => require('../birthdayService').checkBirthdays(client),
    },
    {
        name: 'checkSeasonalEvents',
        scope: SCOPE.GUILD,
        service: 'seasonalEventService',
        schedule: '0 * * * *',
        fn: client => require('../seasonalEventService').checkSeasonalEvents(client),
    },
    {
        name: 'resolveExpiredWars',
        scope: SCOPE.GUILD,
        service: 'warService',
        schedule: '*/5 * * * *',
        fn: client => require('../warService').resolveExpiredWars(client),
    },
    {
        name: 'resolveExpiredSeasons',
        scope: SCOPE.GUILD,
        service: 'economySeasonService',
        schedule: '*/5 * * * *',
        fn: client => require('../economySeasonService').resolveExpiredSeasons(client),
    },
    {
        name: 'awardWeeklyLeaderboardBadges',
        scope: SCOPE.GUILD,
        service: 'leaderboardBadgeService',
        schedule: '59 23 * * 0',
        timezone: 'Etc/UTC',
        fn: client => require('../leaderboardBadgeService').awardWeeklyLeaderboardBadges(client),
    },
    {
        name: 'selectPetOfTheWeek',
        scope: SCOPE.GUILD,
        service: 'petService',
        schedule: '0 0 * * 1',
        timezone: 'Etc/UTC',
        fn: client => require('../petService').selectPetOfTheWeek(client),
    },
    {
        name: 'applyBankInterest',
        scope: SCOPE.GUILD,
        service: 'bankService',
        schedule: '1 0 * * 1',
        timezone: 'Etc/UTC',
        fn: client => require('../bankService').applyBankInterest(client),
    },
    {
        // Monday 00:05 UTC — five minutes into the new week, so the sweep is
        // reading a week that has certainly closed rather than racing the
        // boundary it is keyed on.
        name: 'announceWeeklyChampions',
        scope: SCOPE.GUILD,
        service: 'weeklyChampionService',
        schedule: '5 0 * * 1',
        timezone: 'Etc/UTC',
        fn: client => require('../weeklyChampionService').announceWeeklyChampions(client),
    },
    {
        name: 'recalcShopPrices',
        scope: SCOPE.GUILD,
        service: 'shopPricingService',
        schedule: '*/15 * * * *',
        fn: client => require('../shopPricingService').recalcShopPrices(client),
    },
    {
        name: 'resolveRankedSeasons',
        scope: SCOPE.GUILD,
        service: 'rankedSeasonService',
        schedule: '*/10 * * * *',
        fn: client => require('../rankedSeasonService').resolveRankedSeasons(client),
    },
    {
        name: 'returnExpiredMarketListings',
        scope: SCOPE.DEPLOYMENT,
        service: 'marketService',
        schedule: '*/10 * * * *',
        fn: () => require('../marketService').returnExpiredMarketListings(),
    },
    {
        // Both of these used to be a bare setInterval inside their own service,
        // outside runJob: a throw recorded nothing, /health kept reporting
        // healthy, and the service was silently dead until someone noticed
        // bans not lifting or raid mode stuck on (#611).
        name: 'sweepRaidModes',
        scope: SCOPE.GUILD,
        service: 'raidService',
        schedule: '* * * * *',
        fn: client => require('../raidService').sweepRaidModes(client),
    },
    {
        name: 'processExpiredBans',
        scope: SCOPE.GUILD,
        service: 'tempBanService',
        schedule: '* * * * *',
        runOnStart: true,
        fn: client => require('../tempBanService').processExpiredBans(client),
    },
    {
        // The generic schedule (#834): one tick over persisted `fireAt`, the
        // way reminders work, so anything hung off it is restart-proof and
        // catches up after downtime without its own catch-up code.
        name: 'runDueTasks',
        scope: SCOPE.GUILD,
        service: 'scheduledTaskService',
        schedule: '* * * * *',
        fn: client => require('../scheduledTaskService').runDueTasks(client),
    },
    {
        name: 'postScheduledNewspapers',
        scope: SCOPE.GUILD,
        service: 'newspaperService',
        schedule: '0 * * * *',
        timezone: 'Etc/UTC',
        fn: client => require('../newspaperService').postScheduledNewspapers(client),
    },
];

// Start-once services. A service belongs here only when its schedule cannot be
// written as a fixed cron line — a per-guild time the guild picks, a per-poll
// expiry, a lazily-evaluated window. Everything on a fixed schedule belongs in
// JOBS above, where runJob is applied for it and cannot be forgotten.
//
// A starter is responsible for wrapping its own callbacks in runJob, since the
// schedule is its own. tests/schedulerOwnsJobs.test.js enforces that: a starter
// module that registers a timer without runJob fails the suite rather than
// failing invisibly in production.
const STARTERS = [
    { name: 'summaryService', start: client => require('../summaryService').startSummaryService(client) },
    { name: 'caseService.slaMonitor', start: client => require('../caseService').startSlaMonitor(client) },
    { name: 'questService', start: () => require('../questService').startQuestService() },
    { name: 'poll.expirations', start: client => require('../pollService').scheduleActivePollExpirations(client) },
    { name: 'dailyBibleService', start: client => require('../dailyBibleService').startDailyBibleService(client) },
    { name: 'rssService.dailyNews', start: client => require('../rssService').scheduleDailyNews(client) },
];

// Per-shard start-once work, run before the primary-shard gate below.
//
// Same reasoning as presence: the MCP connection pool is a property of *this
// process*, not of the deployment, so a shard that skipped this would serve
// every one of its own guilds a cold cache. Nothing here writes to the
// database, so running it on every shard duplicates no work.
const SHARD_STARTERS = [
    { name: 'mcpPrewarm', start: client => require('../ai/mcp/prewarm').startMcpPrewarm(client) },
];

function runStarters(starters, client) {
    for (const starter of starters) {
        try {
            const result = starter.start(client);
            if (result && typeof result.catch === 'function') {
                result.catch(err => console.error(`[SCHEDULER] Starter ${starter.name} failed:`, err));
            }
        } catch (err) {
            console.error(`[SCHEDULER] Starter ${starter.name} failed:`, err);
        }
    }
}

// Rotating rich presence — Clawdia's ancient, mysterious personality
const PRESENCE_ACTIVITIES = [
    { type: ActivityType.Watching, name: 'over the server' },
    { type: ActivityType.Playing, name: 'with ancient secrets' },
    { type: ActivityType.Listening, name: 'to the void' },
    { type: ActivityType.Watching, name: 'mortals struggle' },
    { type: ActivityType.Watching, name: 'for worthy souls' },
    { type: ActivityType.Playing, name: 'a very long game' },
];
const PRESENCE_ROTATE_MS = 5 * 60_000;

const scheduledTasks = [];
let presenceInterval = null;
let started = false;

function setPresence(client) {
    const activity = PRESENCE_ACTIVITIES[Math.floor(Math.random() * PRESENCE_ACTIVITIES.length)];
    Promise.resolve(client.user.setPresence({
        status: 'online',
        activities: [{ type: activity.type, name: activity.name }],
    })).catch(err => {
        console.error(`[PRESENCE] Failed to set presence (${activity.type} ${activity.name}):`, err);
    });
}

/**
 * Start all background work: recurring jobs, start-once services, and
 * presence rotation. Idempotent — a second call is a no-op, so there is no
 * way to end up with duplicate schedules again.
 */
function startScheduler(client) {
    if (started) {
        console.warn('[SCHEDULER] startScheduler called twice — ignoring second call.');
        return;
    }

    started = true;

    // Presence is a property of a gateway connection, so it is set per shard
    // rather than per deployment — a shard that skipped this would show no
    // activity to every guild it serves. It runs before the primary-shard gate
    // for exactly that reason.
    setPresence(client);
    presenceInterval = setInterval(() => setPresence(client), PRESENCE_ROTATE_MS);

    runStarters(SHARD_STARTERS, client);

    // ── Where each job runs (#732, #889) ────────────────────────────────────
    //
    // Under sharding each shard is its own process, so an ungated scheduler
    // fires every job once per shard, and jobRunner's overlap guard would not
    // notice: `inFlight` is a process-local Set, so N processes each see an
    // empty one. That is why everything was pinned to shard 0 — applyBankInterest
    // paying every account N times is the shape of the mistake, and it is the
    // expensive shape.
    //
    // The `scope` on each job is what replaces that blanket pin. A 'guild' job
    // runs everywhere and partitions its own work list; a 'deployment' job still
    // runs only on the primary shard. See the table above for the rule.
    //
    // Unsharded, `isPrimaryShard` is true and every job is scheduled here just as
    // it was before.
    const primary = isPrimaryShard(client);
    const scheduled = JOBS.filter(job => primary || job.scope === SCOPE.GUILD);

    for (const job of scheduled) {
        const run = () => runJob(job.service, job.name, () => job.fn(client));
        const task = cron.schedule(job.schedule, run, job.timezone ? { timezone: job.timezone } : undefined);
        scheduledTasks.push(task);
        if (job.runOnStart) run();
    }

    if (!primary) {
        // The start-once services are still singleton work and stay on the
        // primary shard: each keeps its own schedule rather than declaring one
        // here, so none of them can be classified from this table. They are the
        // remaining half of #889 and are called out in tests/schedulerScope.
        console.log(
            `${shardTag(client)}[SCHEDULER] Started ${scheduled.length} per-guild jobs; ` +
            `${JOBS.length - scheduled.length} deployment-wide job(s) and ${STARTERS.length} services run on shard 0.`
        );
        return;
    }

    runStarters(STARTERS, client);

    console.log(`${shardTag(client)}[SCHEDULER] Started ${JOBS.length} scheduled jobs and ${STARTERS.length} services`);
}

/** Stop presence rotation and all cron tasks (used on graceful shutdown). */
function stopScheduler() {
    if (presenceInterval) {
        clearInterval(presenceInterval);
        presenceInterval = null;
    }
    for (const task of scheduledTasks) {
        try { task.stop(); } catch { /* already stopped */ }
    }
    scheduledTasks.length = 0;
    started = false;
}

module.exports = { startScheduler, stopScheduler, JOBS, STARTERS, SHARD_STARTERS, SCOPE };
