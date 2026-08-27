'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const { JOBS, STARTERS } = require('../src/services/scheduler');

// #611: runJob gives a scheduled callback three things — an overlap guard, a
// dead-letter entry when it throws, and a run recorded on the /health payload.
// It was applied to three of roughly eight scheduling sites. The rest failed
// invisibly: RSS, raid, temp-ban and Bible could all be dead while /health
// reported healthy, because a service that never records a run looks exactly
// like a service that has nothing to do.
//
// The fix is structural — the job table in services/scheduler is the only way
// to register recurring work, and it applies runJob for you — but a table only
// holds if nothing quietly schedules beside it. That is what this suite is for.

const SRC = path.join(__dirname, '../src');

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

const sourceFiles = walk(SRC).map(full => ({
    rel: path.relative(SRC, full).split(path.sep).join('/'),
    text: fs.readFileSync(full, 'utf8'),
}));

// Timers that are not background jobs and have no business in the job table:
// in-memory rate-limiter and cache sweeps that touch nothing outside the
// process, and per-interaction UI timers that live and die with one message.
// Each is listed rather than pattern-matched, so a new setInterval has to be
// argued for here before it can hide among them.
const NON_JOB_TIMERS = new Set([
    'services/scheduler/index.js',      // the presence rotation, and the job table itself
    'services/ai/discordChat.js',       // typing indicator refresh for one reply
    'services/ai/rateLimit.js',         // in-memory rate-limit bucket sweep
    'events/messageCreate.js',          // in-memory reminder-cooldown sweep
    'dashboard/lib/middleware.js',      // in-memory HTTP rate-limit sweep
    'utils/imageRateLimit.js',          // in-memory rate-limit bucket sweep
    'utils/cardRenderQueue.js',         // in-memory welcome-card budget sweep (#592)
    'utils/commandCooldowns.js',        // in-memory cooldown map sweep (#621)
    'services/pollService.js',          // one poll's expiry, re-armed in 24-day hops
    'games/casino/crash.js',            // per-lobby round tick
    'commands/fun/meme.js',             // in-memory meme cache sweep
    'services/heistService.js',         // per-heist lobby countdown
    'commands/economy/syndicate.js',    // per-raid lobby countdown
    'commands/economy/quiz.js',         // per-question countdown
]);

// A setTimeout that re-arms itself is an interval wearing a different hat, and
// it would walk straight past a scan that only looks for setInterval. This
// finds the shape that matters — `setTimeout(f, ...)` where `f` is a function
// in the same file that schedules a setTimeout of its own — while leaving the
// ordinary one-shot setTimeout (a `wait(ms)` promise, a deferred reply) alone.
function selfReschedulingTimers(text) {
    let ast;
    try {
        ast = parse(text, { sourceType: 'script', allowReturnOutsideFunction: true });
    } catch {
        return [];
    }

    const schedulers = new Map();   // function name -> does its body arm a setTimeout
    const rearmed = new Set();      // names passed directly to setTimeout

    const bodyOf = node => text.slice(node.start, node.end);

    const walk = node => {
        if (!node || typeof node.type !== 'string') return;

        if (node.type === 'FunctionDeclaration' && node.id) {
            schedulers.set(node.id.name, /setTimeout\(/.test(bodyOf(node)));
        }
        if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init
            && (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')) {
            schedulers.set(node.id.name, /setTimeout\(/.test(bodyOf(node.init)));
        }
        if (node.type === 'CallExpression' && node.callee?.name === 'setTimeout') {
            const callback = node.arguments[0];
            if (callback?.type === 'Identifier') {
                // setTimeout(tick, ms)
                rearmed.add(callback.name);
            } else if (callback?.type === 'FunctionExpression' || callback?.type === 'ArrowFunctionExpression') {
                // setTimeout(() => tick(), ms) — the wrapper hides the name
                // from a first-argument check, so look at what it calls. Names
                // that are not file-level schedulers fall out at the filter
                // below, which is what keeps `setTimeout(() => resolve(x), ms)`
                // from reading as a re-arming timer.
                const collectCalls = inner => {
                    if (!inner || typeof inner.type !== 'string') return;
                    if (inner.type === 'CallExpression' && inner.callee?.type === 'Identifier') {
                        rearmed.add(inner.callee.name);
                    }
                    for (const key of Object.keys(inner)) {
                        if (key === 'loc') continue;
                        const child = inner[key];
                        if (Array.isArray(child)) child.forEach(collectCalls);
                        else if (child && typeof child.type === 'string') collectCalls(child);
                    }
                };
                collectCalls(callback.body);
            }
        }

        for (const key of Object.keys(node)) {
            if (key === 'loc') continue;
            const child = node[key];
            if (Array.isArray(child)) child.forEach(walk);
            else if (child && typeof child.type === 'string') walk(child);
        }
    };

    walk(ast.program);
    return [...rearmed].filter(name => schedulers.get(name) === true);
}

describe('the scheduler owns recurring work', () => {
    test('nothing schedules a background timer outside the job table', () => {
        const offenders = sourceFiles
            .filter(f => /setInterval\(/.test(f.text) || selfReschedulingTimers(f.text).length)
            .map(f => f.rel)
            .filter(rel => !NON_JOB_TIMERS.has(rel));

        expect(offenders).toEqual([]);
    });

    // If the self-rescheduling detector stops matching its own shape, the scan
    // above quietly narrows to setInterval again.
    test('the self-rescheduling detector recognises a re-arming timer', () => {
        const reArming = `function tick() { doWork(); setTimeout(tick, 60_000); }\ntick();`;
        const oneShot = `function wait(ms) { return new Promise(r => setTimeout(r, ms)); }`;

        expect(selfReschedulingTimers(reArming)).toEqual(['tick']);
        expect(selfReschedulingTimers(oneShot)).toEqual([]);
    });

    // The wrapper form is the one a first-argument check walks straight past.
    test('the detector sees a re-arming timer behind a callback wrapper', () => {
        const wrapped = `function tick() { doWork(); setTimeout(() => tick(), 60_000); }`;
        const wrappedAsync = `const loop = async () => { await work(); setTimeout(() => { loop(); }, 1000); };`;
        // A callback that calls something which is not a scheduler is ordinary
        // one-shot work and must stay off the list.
        const innocuous = `function wait(ms) { return new Promise(resolve => setTimeout(() => resolve(), ms)); }`;

        expect(selfReschedulingTimers(wrapped)).toEqual(['tick']);
        expect(selfReschedulingTimers(wrappedAsync)).toEqual(['loop']);
        expect(selfReschedulingTimers(innocuous)).toEqual([]);
    });

    // cron.schedule outside the table is legitimate only where the schedule is
    // per-guild and chosen by the guild — a daily verse at the hour they set,
    // a news digest at theirs. Those still have to route through runJob, and
    // each one here is checked for it rather than trusted.
    test('every cron.schedule outside the table wraps its callback in runJob', () => {
        const withCron = sourceFiles.filter(f => /cron\.schedule\(/.test(f.text));

        // If this drops to nothing, the regex stopped matching and the rest of
        // the test is vacuously green.
        expect(withCron.length).toBeGreaterThan(0);

        for (const { rel, text } of withCron) {
            if (rel === 'services/scheduler/index.js') continue;

            const callbacks = text.split('cron.schedule(').slice(1);
            for (const callback of callbacks) {
                expect(`${rel}: ${callback.slice(0, 300)}`).toMatch(/runJob\(/);
            }
            expect(text).toMatch(/require\(['"][^'"]*jobRunner['"]\)/);
        }
    });

    // A starter is in the list because its schedule cannot be a fixed cron
    // line. That is the only thing it buys — it does not buy an exemption from
    // runJob, so any starter module that registers a timer has to import it.
    test('every start-once service that registers a timer imports runJob', () => {
        const starterSources = {
            summaryService: 'services/summaryService.js',
            'caseService.slaMonitor': 'services/caseService.js',
            questService: 'services/questService.js',
            'poll.expirations': 'services/pollService.js',
            dailyBibleService: 'services/dailyBibleService.js',
            'rssService.dailyNews': 'services/rssService.js',
        };

        // The map above is the assertion: a starter added to the scheduler
        // without a line here is a starter nothing has checked.
        expect(Object.keys(starterSources).sort()).toEqual(STARTERS.map(s => s.name).sort());

        const missing = Object.entries(starterSources).filter(([, rel]) => {
            const text = sourceFiles.find(f => f.rel === rel).text;
            if (!/setInterval\(|setTimeout\(|cron\.schedule\(/.test(text)) return false;
            return !/require\(['"][^'"]*jobRunner['"]\)/.test(text);
        }).map(([name]) => name);

        expect(missing).toEqual([]);
    });

    test('the raid and temp-ban sweeps are registered as jobs', () => {
        const byName = new Map(JOBS.map(j => [j.name, j]));

        expect(byName.get('sweepRaidModes')).toMatchObject({ service: 'raidService' });
        expect(byName.get('processExpiredBans')).toMatchObject({ service: 'tempBanService' });
    });

    test('every job in the table names a service and a real callback', () => {
        for (const job of JOBS) {
            expect(typeof job.name).toBe('string');
            expect(typeof job.service).toBe('string');
            expect(typeof job.fn).toBe('function');
            expect(job.schedule).toMatch(/^[\d*,/ -]+$/);
            // Five fields, not six: node-cron accepts a seconds field, and a
            // five-field expression read as six shifts every field one place —
            // a nightly job silently becomes an every-minute one.
            expect(job.schedule.trim().split(/\s+/)).toHaveLength(5);
        }
        expect(new Set(JOBS.map(j => j.name)).size).toBe(JOBS.length);
    });
});
