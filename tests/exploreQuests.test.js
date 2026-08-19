'use strict';

// Exploration was the only grind system with no quests of its own. It counted
// toward "use N bot commands" and nothing else, while hunting, fishing and
// mining each had a daily and a weekly. These pin the new ones in place, and
// pin the wiring that makes them reachable.

const fs = require('fs');
const path = require('path');

const questService = require('../src/services/questService');
const DAILY_QUEST_POOL  = questService.getDailyPool();
const WEEKLY_QUEST_POOL = questService.getWeeklyPool();

const EXPLORE_QUEST_IDS = ['daily_explore_3', 'daily_explore_5', 'weekly_explore_20'];

describe('exploration has quests of its own', () => {
    const pools = [...(DAILY_QUEST_POOL ?? []), ...(WEEKLY_QUEST_POOL ?? [])];

    test('the pools are exported and non-empty', () => {
        expect(pools.length).toBeGreaterThan(0);
    });

    test('every exploration quest id exists in a pool', () => {
        const ids = new Set(pools.map(q => q.questId));
        for (const id of EXPLORE_QUEST_IDS) expect(ids.has(id)).toBe(true);
    });

    test('they are shaped like every other quest', () => {
        for (const id of EXPLORE_QUEST_IDS) {
            const quest = pools.find(q => q.questId === id);
            expect(quest.category).toBe('exploration');
            expect(quest.target).toBeGreaterThan(0);
            expect(quest.name).toBeTruthy();
            expect(quest.description).toBeTruthy();
            expect(['easy', 'medium', 'hard']).toContain(quest.difficulty);
        }
    });

    test('quest ids are unique across both pools', () => {
        const ids = pools.map(q => q.questId);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every quest category has an emoji to render with', () => {
        const emojis = questService.getCategoryEmojis();
        for (const category of [...new Set(pools.map(q => q.category))]) {
            expect(emojis[category]).toBeTruthy();
        }
    });
});

describe('the hook that advances them', () => {
    test('onExplore is exported', () => {
        expect(typeof questService.onExplore).toBe('function');
    });

    test('it stays silent while quests are switched off', async () => {
        await expect(questService.onExplore({}, { quests: { enabled: false } }))
            .resolves.toEqual({ completed: [], nearComplete: [] });
        await expect(questService.onExplore({}, {}))
            .resolves.toEqual({ completed: [], nearComplete: [] });
    });

    test('it advances exactly the exploration quests', () => {
        // Guards against a new quest being added to the pool and never wired.
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'questService.js'), 'utf8');
        const body = src.slice(src.indexOf('async function onExplore'));
        const listed = [...body.slice(0, body.indexOf('\n}')).matchAll(/'(daily|weekly)_explore_\w+'/g)].map(m => m[0].slice(1, -1));
        const pooled = [...(DAILY_QUEST_POOL ?? []), ...(WEEKLY_QUEST_POOL ?? [])]
            .filter(q => q.category === 'exploration').map(q => q.questId);
        expect(listed.sort()).toEqual(pooled.sort());
    });

    test('the expedition command calls it', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'economy', 'explore.js'), 'utf8');
        expect(src).toContain('onExplore');
        // The trip counts even when the walk turned up nothing — the coin quests
        // are the ones gated on a payout.
        const hookAt   = src.indexOf('await onExplore(user, guildSettings)');
        const payoutAt = src.indexOf('if (result.payout > 0)');
        expect(hookAt).toBeGreaterThan(-1);
        expect(hookAt).toBeLessThan(payoutAt);
    });
});

describe('exploration competes in the hourly micro-competition', () => {
    const fsx  = require('fs');
    const pathx = require('path');
    const read = (...p) => fsx.readFileSync(pathx.join(__dirname, '..', 'src', ...p), 'utf8');

    test('the scheduler can name an explore winner', () => {
        // A category with no label entry is skipped at announcement time — the
        // winner is paid and never mentioned, which reads as the reward being
        // broken. Every category something records must have a label.
        const scheduler = read('services', 'schedulerService.js');
        const labels = scheduler.slice(scheduler.indexOf('HOURLY_CATEGORY_LABELS'));
        const declared = new Set(
            [...labels.slice(0, labels.indexOf('};')).matchAll(/^\s+(\w+):\s*\{/gm)].map(m => m[1])
        );

        const commands = ['hunt.js', 'fish.js', 'mine.js', 'explore.js']
            .map(f => read('commands', 'economy', f)).join('\n');
        const recorded = new Set(
            [...commands.matchAll(/category:\s*'(\w+)'/g)].map(m => m[1])
        );

        expect(recorded.has('explore')).toBe(true);
        for (const category of recorded) expect(declared.has(category)).toBe(true);
    });

    test('only a paying expedition enters', () => {
        const src = read('commands', 'economy', 'explore.js');
        const guardAt  = src.indexOf('if (result.payout > 0) {\n            await tryUpdateHourlyWinner');
        expect(guardAt).toBeGreaterThan(-1);
    });
});

describe('exploration appears in the weekly newspaper', () => {
    const fsx  = require('fs');
    const pathx = require('path');

    test('the top explorer is queried, resolved to a name, and rendered', () => {
        const src = fsx.readFileSync(pathx.join(__dirname, '..', 'src', 'services', 'newspaperService.js'), 'utf8');
        // Queried from the grind profiles...
        expect(src).toContain("topBySystem('exploration')");
        // ...added to the id set the usernames are fetched for (without this it
        // renders as "Unknown")...
        expect(src).toContain('userIds.add(stats.gameStandouts.topExplorer.userId)');
        // ...and rendered in both the plain-text and embed builders.
        expect(src.match(/topExplorer\.exploration\?\.level/g) ?? []).toHaveLength(2);
    });
});
