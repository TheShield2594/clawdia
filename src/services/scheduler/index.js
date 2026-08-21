const cron = require('node-cron');
const { ActivityType } = require('discord.js');
const { runJob } = require('../../utils/jobRunner');

// Single owner of all recurring background work. Every scheduled job goes
// through runJob (overlap protection, DLQ, health tracking), and every
// start-once service is listed here — nothing else in the codebase should
// call cron.schedule at bootstrap or hang jobs off a clientReady handler.

// Recurring jobs. `fn` receives the Discord client. Schedules without a
// timezone run in server-local time, matching their previous behavior.
const JOBS = [
    {
        name: 'checkRssFeeds',
        service: 'rssService',
        schedule: '*/5 * * * *',
        fn: client => require('../rssService').checkRssFeeds(client),
    },
    {
        name: 'checkReminders',
        service: 'reminderService',
        schedule: '* * * * *',
        fn: client => require('../reminderService').checkReminders(client),
    },
    {
        name: 'checkGiveaways',
        service: 'giveawayService',
        schedule: '* * * * *',
        fn: client => require('../giveawayService').checkGiveaways(client),
    },
    {
        // Previously scheduled twice (a 5-minute interval in index.js and a
        // 2-minute cron in ready.js); the more frequent schedule wins.
        name: 'checkTempVoice',
        service: 'tempVoiceService',
        schedule: '*/2 * * * *',
        runOnStart: true,
        fn: client => require('../tempVoiceService').checkTempVoice(client),
    },
    {
        name: 'checkBirthdays',
        service: 'birthdayService',
        schedule: '0 * * * *',
        fn: client => require('../birthdayService').checkBirthdays(client),
    },
    {
        name: 'checkSeasonalEvents',
        service: 'seasonalEventService',
        schedule: '0 * * * *',
        fn: client => require('../seasonalEventService').checkSeasonalEvents(client),
    },
    {
        name: 'resolveExpiredWars',
        service: 'schedulerService',
        schedule: '*/5 * * * *',
        fn: client => require('../schedulerService').resolveExpiredWars(client),
    },
    {
        name: 'resolveExpiredSeasons',
        service: 'schedulerService',
        schedule: '*/5 * * * *',
        fn: client => require('../schedulerService').resolveExpiredSeasons(client),
    },
    {
        name: 'awardWeeklyLeaderboardBadges',
        service: 'schedulerService',
        schedule: '59 23 * * 0',
        timezone: 'Etc/UTC',
        fn: client => require('../schedulerService').awardWeeklyLeaderboardBadges(client),
    },
    {
        name: 'selectPetOfTheWeek',
        service: 'schedulerService',
        schedule: '0 0 * * 1',
        timezone: 'Etc/UTC',
        fn: client => require('../schedulerService').selectPetOfTheWeek(client),
    },
    {
        name: 'applyBankInterest',
        service: 'schedulerService',
        schedule: '1 0 * * 1',
        timezone: 'Etc/UTC',
        fn: client => require('../schedulerService').applyBankInterest(client),
    },
    {
        name: 'announceHourlyWinners',
        service: 'schedulerService',
        schedule: '0 * * * *',
        fn: client => require('../schedulerService').announceHourlyWinners(client),
    },
    {
        name: 'recalcShopPrices',
        service: 'schedulerService',
        schedule: '*/15 * * * *',
        fn: client => require('../schedulerService').recalcShopPrices(client),
    },
    {
        name: 'resolveRankedSeasons',
        service: 'schedulerService',
        schedule: '*/10 * * * *',
        fn: client => require('../schedulerService').resolveRankedSeasons(client),
    },
    {
        name: 'returnExpiredMarketListings',
        service: 'schedulerService',
        schedule: '*/10 * * * *',
        fn: () => require('../schedulerService').returnExpiredMarketListings(),
    },
    {
        name: 'postScheduledNewspapers',
        service: 'schedulerService',
        schedule: '0 * * * *',
        timezone: 'Etc/UTC',
        fn: client => require('../schedulerService').postScheduledNewspapers(client),
    },
];

// Start-once services that own their own internal timers or per-guild
// schedules. Each is called exactly once at bootstrap.
const STARTERS = [
    { name: 'summaryService', start: client => require('../summaryService').startSummaryService(client) },
    { name: 'caseService.slaMonitor', start: client => require('../caseService').startSlaMonitor(client) },
    { name: 'questService', start: () => require('../questService').startQuestService() },
    { name: 'poll.expirations', start: client => require('../../commands/utility/poll').scheduleActivePollExpirations(client) },
    { name: 'dailyBibleService', start: client => require('../dailyBibleService').startDailyBibleService(client) },
    { name: 'tempBanService', start: client => require('../tempBanService').startTempBanService(client) },
    { name: 'rssService.dailyNews', start: client => require('../rssService').scheduleDailyNews(client) },
    { name: 'raidService.monitor', start: client => require('../raidService').startRaidMonitor(client) },
];

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

    for (const job of JOBS) {
        const run = () => runJob(job.service, job.name, () => job.fn(client));
        const task = cron.schedule(job.schedule, run, job.timezone ? { timezone: job.timezone } : undefined);
        scheduledTasks.push(task);
        if (job.runOnStart) run();
    }

    for (const starter of STARTERS) {
        try {
            const result = starter.start(client);
            if (result && typeof result.catch === 'function') {
                result.catch(err => console.error(`[SCHEDULER] Starter ${starter.name} failed:`, err));
            }
        } catch (err) {
            console.error(`[SCHEDULER] Starter ${starter.name} failed:`, err);
        }
    }

    setPresence(client);
    presenceInterval = setInterval(() => setPresence(client), PRESENCE_ROTATE_MS);

    console.log(`[SCHEDULER] Started ${JOBS.length} scheduled jobs and ${STARTERS.length} services`);
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

module.exports = { startScheduler, stopScheduler, JOBS, STARTERS };
