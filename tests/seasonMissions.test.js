'use strict';

// Season pass daily missions were generated, rendered with a progress bar, and
// offered a claim button — and nothing in the codebase ever wrote to `progress`.
// Every mission sat at 0/target until midnight dealt three more that also never
// moved, and /season claim-mission refused all of them for being unfinished.
// These tests hold the missing half in place.

const fs = require('fs');
const path = require('path');

const { MISSION_TEMPLATES, generateDailyMissions } = require('../src/data/seasonMissions');
const {
    ensureMissions,
    recordMissionProgress,
    advanceMissions,
    missionDayStart,
} = require('../src/services/seasonMissionService');

function makeUser(overrides = {}) {
    return {
        balance: 1_000,
        seasonMissions: null,
        seasonMissionsDate: null,
        markModified: jest.fn(),
        ...overrides,
    };
}

// A user holding exactly one mission for `event`, at zero progress.
function userWithMission(event, target = 3) {
    const user = makeUser({
        seasonMissions: [{ id: `${event}_x`, event, target, progress: 0, completed: false, claimed: false }],
        seasonMissionsDate: missionDayStart(),
    });
    return user;
}

const settings = (enabled = true) => ({ season: { enabled } });

describe('mission progress actually moves', () => {
    test('a matching event advances the mission', () => {
        const user = userWithMission('hunt');
        recordMissionProgress(user, 'hunt');
        expect(user.seasonMissions[0].progress).toBe(1);
        expect(user.seasonMissions[0].completed).toBe(false);
    });

    test('a different event leaves it alone', () => {
        const user = userWithMission('hunt');
        recordMissionProgress(user, 'fish');
        expect(user.seasonMissions[0].progress).toBe(0);
    });

    test('reaching the target completes it and reports it back', () => {
        const user = userWithMission('explore', 3);
        expect(recordMissionProgress(user, 'explore')).toEqual([]);
        expect(recordMissionProgress(user, 'explore')).toEqual([]);
        const finished = recordMissionProgress(user, 'explore');
        expect(finished).toHaveLength(1);
        expect(finished[0].id).toBe('explore_x');
        expect(user.seasonMissions[0].completed).toBe(true);
    });

    test('progress never overshoots the target', () => {
        const user = userWithMission('mine', 2);
        for (let i = 0; i < 20; i++) recordMissionProgress(user, 'mine');
        expect(user.seasonMissions[0].progress).toBe(2);
    });

    test('a completed mission only reports itself once', () => {
        const user = userWithMission('work', 1);
        expect(recordMissionProgress(user, 'work')).toHaveLength(1);
        expect(recordMissionProgress(user, 'work')).toHaveLength(0);
    });

    test('an amount larger than one advances by that much', () => {
        const user = userWithMission('quiz', 5);
        recordMissionProgress(user, 'quiz', 3);
        expect(user.seasonMissions[0].progress).toBe(3);
    });

    test('zero or negative progress is ignored rather than rewinding', () => {
        const user = userWithMission('quiz', 5);
        recordMissionProgress(user, 'quiz', 2);
        recordMissionProgress(user, 'quiz', 0);
        recordMissionProgress(user, 'quiz', -5);
        expect(user.seasonMissions[0].progress).toBe(2);
    });

    test('progress is withheld while the season pass is switched off', () => {
        const user = userWithMission('hunt');
        recordMissionProgress(user, 'hunt', 1, settings(false));
        expect(user.seasonMissions[0].progress).toBe(0);
        recordMissionProgress(user, 'hunt', 1, settings(true));
        expect(user.seasonMissions[0].progress).toBe(1);
    });
});

describe('the daily deal', () => {
    test('a player who never opened /season still gets dealt a hand on their first action', () => {
        // The rollover used to live only in /season, so acting before looking
        // meant there were no missions to credit and the progress was lost.
        const user = makeUser();
        recordMissionProgress(user, 'hunt');
        expect(Array.isArray(user.seasonMissions)).toBe(true);
        expect(user.seasonMissions).toHaveLength(3);
    });

    test('missions dealt today are left alone', () => {
        const user = makeUser({ seasonMissions: generateDailyMissions(), seasonMissionsDate: missionDayStart() });
        const before = user.seasonMissions;
        expect(ensureMissions(user)).toBe(false);
        expect(user.seasonMissions).toBe(before);
    });

    test('yesterday\'s missions are replaced', () => {
        const yesterday = new Date(missionDayStart().getTime() - 24 * 3_600_000);
        const user = makeUser({ seasonMissions: generateDailyMissions(), seasonMissionsDate: yesterday });
        user.seasonMissions[0].progress = 99;
        expect(ensureMissions(user)).toBe(true);
        expect(user.seasonMissions.every(m => m.progress === 0)).toBe(true);
        expect(new Date(user.seasonMissionsDate).getTime()).toBe(missionDayStart().getTime());
    });

    test('every dealt mission is a real template', () => {
        const ids = new Set(MISSION_TEMPLATES.map(t => t.id));
        for (const mission of generateDailyMissions()) expect(ids.has(mission.id)).toBe(true);
    });
});

describe('advanceMissions advances server-side and touches nothing else', () => {
    const { applyPipelineUpdate } = require('./helpers/pipelineUpdate');

    // A model that applies pipeline updates the way Mongo would, so the test
    // exercises the real expression rather than a paraphrase of it.
    function fakeModel(doc) {
        return {
            writes: [],
            updates: [],
            updateOne(filter, update) {
                this.writes.push({ filter, update });
                return Promise.resolve({ matchedCount: 1 });
            },
            findOneAndUpdate(filter, update) {
                const before = JSON.parse(JSON.stringify(doc));
                this.updates.push(update);
                applyPipelineUpdate(doc, update);
                return Promise.resolve(before);
            },
        };
    }

    const missions = () => [
        { id: 'crime_1',  event: 'crime',  target: 2, progress: 0, completed: false, claimed: false },
        { id: 'quiz_1',   event: 'quiz',   target: 1, progress: 0, completed: false, claimed: false },
    ];
    const doc = (over = {}) => ({ seasonMissions: missions(), seasonMissionsDate: missionDayStart(), ...over });

    test('it advances only the missions listening for the event', async () => {
        const d = doc();
        const Model = fakeModel(d);
        await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings());
        expect(d.seasonMissions[0].progress).toBe(1);
        expect(d.seasonMissions[1].progress).toBe(0);
    });

    test('it reports the mission it was the one to finish, once', async () => {
        const d = doc();
        const Model = fakeModel(d);
        expect(await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings())).toEqual([]);
        const finished = await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings());
        expect(finished.map(m => m.id)).toEqual(['crime_1']);
        expect(d.seasonMissions[0].completed).toBe(true);
        // Already finished — a later call must not claim the completion again.
        expect(await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings())).toEqual([]);
    });

    test('progress never overshoots the target', async () => {
        const d = doc();
        const Model = fakeModel(d);
        await advanceMissions(Model, { userId: 'u' }, 'crime', 99, settings());
        expect(d.seasonMissions[0].progress).toBe(2);
        expect(d.seasonMissions[0].completed).toBe(true);
    });

    test('a claim landing mid-flight survives — the update never rewrites the array', async () => {
        // The whole reason this is a pipeline. A read-modify-write would carry a
        // snapshot taken before the claim and hand the mission back unclaimed,
        // letting it be claimed a second time for another payout.
        const d = doc();
        const Model = fakeModel(d);
        const original = Model.findOneAndUpdate.bind(Model);
        Model.findOneAndUpdate = (filter, update) => {
            d.seasonMissions[0].claimed = true;   // /season claim-mission, mid-flight
            return original(filter, update);
        };
        await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings());
        expect(d.seasonMissions[0].claimed).toBe(true);
        expect(d.seasonMissions[0].progress).toBe(1);
    });

    test('it writes no field other than the missions and their date', async () => {
        const d = doc({ balance: 5_000 });
        const Model = fakeModel(d);
        await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings());
        expect(d.balance).toBe(5_000);
        for (const update of Model.updates) {
            expect(JSON.stringify(update)).not.toContain('balance');
            expect(Object.keys(update[0].$set)).toEqual(['seasonMissions']);
        }
    });

    test('a stale hand is redealt under a guard, not blindly overwritten', async () => {
        const yesterday = new Date(missionDayStart().getTime() - 24 * 3_600_000);
        const Model = fakeModel(doc({ seasonMissionsDate: yesterday }));
        await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings());
        expect(Model.writes).toHaveLength(1);
        // The guard is what stops two concurrent callers each dealing a hand.
        expect(JSON.stringify(Model.writes[0].filter)).toContain('seasonMissionsDate');
    });

    test('a missing user is a no-op rather than a throw', async () => {
        const Model = fakeModel(null);
        Model.findOneAndUpdate = () => Promise.resolve(null);
        await expect(advanceMissions(Model, { userId: 'nobody' }, 'crime', 1, settings())).resolves.toEqual([]);
    });

    test('a switched-off season never writes at all', async () => {
        const d = doc();
        const Model = fakeModel(d);
        await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings(false));
        expect(Model.writes).toHaveLength(0);
        expect(Model.updates).toHaveLength(0);
        expect(d.seasonMissions[0].progress).toBe(0);
    });
});

describe('every mission the pool can deal is one the game can advance', () => {
    test('no mission event is dealt without something producing it', () => {
        // The original defect in one assertion: a template whose event nothing
        // ever fires is a mission that can never be finished or claimed.
        const srcRoot = path.join(__dirname, '..', 'src');
        const files = (function walk(dir) {
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) return walk(full);
                return entry.name.endsWith('.js') ? [full] : [];
            });
        })(srcRoot).filter(f => !f.endsWith(path.join('services', 'seasonMissionService.js')));

        const source = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
        const produced = new Set(
            [...source.matchAll(/(?:recordMissionProgress|advanceMissions)\s*\([\s\S]{0,200}?'([a-z_]+)'\s*,/g)]
                .map(m => m[1])
        );

        const events = [...new Set(MISSION_TEMPLATES.map(t => t.event))];
        const orphaned = events.filter(e => !produced.has(e));
        expect(orphaned).toEqual([]);
    });
});
