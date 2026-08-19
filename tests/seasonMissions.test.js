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

    // Enough of a filter matcher for the rollover guard: null / missing / $lt on
    // seasonMissionsDate. Without it `updateOne` would accept every write and the
    // guard this service leans on would go untested.
    function guardMatches(filter, target) {
        const clauses = filter.$or;
        if (!clauses) return true;
        const stamped = target.seasonMissionsDate;
        return clauses.some(clause => {
            const cond = clause.seasonMissionsDate;
            if (cond === null) return stamped === null || stamped === undefined;
            if (cond?.$exists === false) return stamped === undefined;
            if (cond?.$lt !== undefined) {
                return stamped != null && new Date(stamped).getTime() < new Date(cond.$lt).getTime();
            }
            return false;
        });
    }

    // A model that evaluates the guard and applies pipeline updates the way Mongo
    // would, so the tests exercise the real expressions rather than a paraphrase.
    function fakeModel(doc) {
        return {
            writes: [],
            updates: [],
            updateOne(filter, update) {
                this.writes.push({ filter, update });
                if (!doc || !guardMatches(filter, doc)) return Promise.resolve({ matchedCount: 0 });
                Object.assign(doc, update.$set ?? {});
                return Promise.resolve({ matchedCount: 1 });
            },
            findOneAndUpdate(filter, update) {
                if (!doc) return Promise.resolve(null);
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

    test('a stale hand is redealt, and the new one is what gets advanced', async () => {
        const yesterday = new Date(missionDayStart().getTime() - 24 * 3_600_000);
        const stale = doc({ seasonMissionsDate: yesterday });
        stale.seasonMissions[0].progress = 99;   // yesterday's progress
        const Model = fakeModel(stale);

        await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings());

        expect(Model.writes).toHaveLength(1);
        expect(new Date(stale.seasonMissionsDate).getTime()).toBe(missionDayStart().getTime());
        // A real hand from the pool, not yesterday's carried over.
        expect(stale.seasonMissions).toHaveLength(3);
        const ids = new Set(MISSION_TEMPLATES.map(t => t.id));
        for (const m of stale.seasonMissions) expect(ids.has(m.id)).toBe(true);
        expect(stale.seasonMissions.some(m => m.progress === 99)).toBe(false);
    });

    test('a hand dealt today is left alone by the guard', async () => {
        const fresh = doc();
        const Model = fakeModel(fresh);
        const dealtAt = fresh.seasonMissionsDate;

        await advanceMissions(Model, { userId: 'u' }, 'crime', 1, settings());

        // The rollover write is still issued; the guard is what refuses it, which
        // is exactly what stops two concurrent callers dealing different hands.
        expect(Model.writes).toHaveLength(1);
        expect(fresh.seasonMissionsDate).toBe(dealtAt);
        expect(fresh.seasonMissions.map(m => m.id)).toEqual(['crime_1', 'quiz_1']);
        expect(fresh.seasonMissions[0].progress).toBe(1);
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
