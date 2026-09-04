'use strict';

/**
 * The two questions the hot paths ask before they pay for a user document.
 *
 * `trackQuestCommandUse` (#898) and the reaction quest handler (#929) both ran
 * after every event, hydrating and saving the whole user for a counter that
 * usually had nothing to move; the per-message pipeline (#893) saved for the
 * same reason. All three now ask `questEventCanProgress` and
 * `questAssignmentNeeded` of a projected quest list first, and only hydrate
 * when one of them says yes.
 *
 * What makes that safe is that the predicates answer from the same id lists the
 * hooks tick. These tests pin both halves of that: the answers themselves, and
 * that the hooks and the predicates have not drifted apart — a predicate that
 * says "nothing to do" about a quest `onMessage` would have advanced is a quest
 * that silently stops progressing.
 */

const {
    ensureQuests, questEventCanProgress, questAssignmentNeeded,
    onMessage, onReaction, onCommandUse,
} = require('../src/services/questService');

const { useFixedClock } = require('./helpers/fixedClock');

// Same reason as the two pre-check suites: `fullSet()` mints its expiry
// boundaries from the wall clock and `questAssignmentNeeded` recomputes them a
// moment later, so a UTC midnight landing between the two would flip the
// answer. The window here is one test wide rather than a whole module load,
// but it is the same race, and the helper exists for it (#632).
useFixedClock();

const SETTINGS = { quests: { enabled: true, questsPerDay: 3, questsPerWeek: 2 } };

const HOUR = 3600_000;
const future = () => new Date(Date.now() + HOUR);
const past   = () => new Date(Date.now() - HOUR);

const live = (questId, extra = {}) => ({ questId, progress: 0, completedAt: null, expiresAt: future(), ...extra });

// ---------------------------------------------------------------------------
// questEventCanProgress
// ---------------------------------------------------------------------------

describe('questEventCanProgress', () => {
    test('a live quest of the event type is something to do', () => {
        expect(questEventCanProgress([live('daily_messages_10')], 'message')).toBe(true);
        expect(questEventCanProgress([live('daily_reactions_5')], 'reaction')).toBe(true);
        expect(questEventCanProgress([live('daily_commands_5')], 'command')).toBe(true);
    });

    test('a quest of another event type is not', () => {
        const quests = [live('daily_reactions_5'), live('daily_commands_5')];
        expect(questEventCanProgress(quests, 'message')).toBe(false);
    });

    test('a finished quest is not', () => {
        expect(questEventCanProgress([live('daily_messages_10', { completedAt: new Date() })], 'message')).toBe(false);
    });

    test('an expired quest is not', () => {
        expect(questEventCanProgress([live('daily_messages_10', { expiresAt: past() })], 'message')).toBe(false);
    });

    test('an empty or absent list is nothing to do', () => {
        expect(questEventCanProgress([], 'message')).toBe(false);
        expect(questEventCanProgress(undefined, 'message')).toBe(false);
    });

    test('a live AI quest counts for the events that carry a mechanic', () => {
        // The mechanic lives in another collection, so the prefix is as much as
        // this can know without the round trip it exists to avoid. Answering
        // yes is the direction that cannot lose progress.
        expect(questEventCanProgress([live('ai_legendary_1')], 'message')).toBe(true);
        expect(questEventCanProgress([live('ai_legendary_1')], 'command')).toBe(true);
        // Reactions advance no AI quest, so one is not a reason to hydrate.
        expect(questEventCanProgress([live('ai_legendary_1')], 'reaction')).toBe(false);
    });

    test('dates that arrived as strings from a lean read are still compared as dates', () => {
        const asRead = [{ questId: 'daily_messages_10', completedAt: null, expiresAt: future().toISOString() }];
        expect(questEventCanProgress(asRead, 'message')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// questAssignmentNeeded
// ---------------------------------------------------------------------------

describe('questAssignmentNeeded', () => {
    // Built by ensureQuests itself, so the expiries are the exact ones it
    // classifies on — the boundary the daily/weekly counting turns on.
    function fullSet() {
        const user = { level: 5, quests: [] };
        ensureQuests(user, SETTINGS);
        return user.quests;
    }

    test('a user holding a full set needs nothing', () => {
        expect(questAssignmentNeeded(fullSet(), SETTINGS)).toBe(false);
    });

    test('a user with no quests needs a set', () => {
        expect(questAssignmentNeeded([], SETTINGS)).toBe(true);
    });

    test('an expired entry is work, because pruning it drops the count', () => {
        expect(questAssignmentNeeded([...fullSet(), live('daily_messages_5', { expiresAt: past() })], SETTINGS))
            .toBe(true);
    });

    test('a short daily set is topped up', () => {
        const quests = fullSet();
        expect(questAssignmentNeeded(quests, { quests: { enabled: true, questsPerDay: 9, questsPerWeek: 2 } }))
            .toBe(true);
    });

    test('a completed-but-unexpired quest still counts toward the set', () => {
        // Finishing a daily does not earn a replacement — it holds its slot
        // until it expires, which is what stops a chatty user farming the pool.
        const quests = fullSet().map(q => ({ ...q, completedAt: new Date() }));
        expect(questAssignmentNeeded(quests, SETTINGS)).toBe(false);
    });

    test('quests turned off is never work', () => {
        expect(questAssignmentNeeded([], { quests: { enabled: false } })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The predicates and the hooks agree
// ---------------------------------------------------------------------------

describe('the pre-check and the hook it guards agree', () => {
    // A quest id the predicate does not recognise but the hook does would be
    // skipped forever. Driving both off one user is the cheapest way to catch
    // that: whatever the hook moved, the predicate must have said yes about.
    const cases = [
        ['message',  onMessage],
        ['reaction', onReaction],
        ['command',  onCommandUse],
    ];

    test.each(cases)('%s: every quest the hook advances is one the pre-check admits', async (event, hook) => {
        const user = { level: 1, xp: 0, balance: 0, quests: [] };
        ensureQuests(user, { quests: { enabled: true, questsPerDay: 99, questsPerWeek: 99 } });

        const before = user.quests.map(q => [q.questId, q.progress || 0]);
        await hook(user, SETTINGS);
        const moved = user.quests.filter((q, i) => (q.progress || 0) !== before[i][1]);

        // The pool is large enough that at least one quest of each type is
        // always assigned, so an empty `moved` means the hook stopped working
        // rather than that the case is vacuous.
        expect(moved.length).toBeGreaterThan(0);
        for (const quest of moved) {
            expect(questEventCanProgress([quest], event)).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// ensureQuests and the array it used to rebuild
// ---------------------------------------------------------------------------

describe('ensureQuests and the quest array', () => {
    test('leaves the array alone when nothing expired', () => {
        const user = { level: 5, quests: [] };
        ensureQuests(user, SETTINGS);
        const assigned = user.quests;

        ensureQuests(user, SETTINGS);

        // Reassigning re-casts every entry into a subdocument, on a handler
        // that runs per message (#893). Mongoose sees the two arrays are equal
        // and marks nothing modified, so this is not about the write — it is
        // the rebuild, and the array identity the callers below hold on to.
        expect(user.quests).toBe(assigned);
    });

    test('replaces the array when something did expire', () => {
        const user = { level: 5, quests: [live('daily_messages_5', { expiresAt: past() })] };
        const stale = user.quests;

        ensureQuests(user, SETTINGS);

        expect(user.quests).not.toBe(stale);
        expect(user.quests.some(q => q.expiresAt <= new Date())).toBe(false);
    });

    test('a user who has never held quests still gets an array', () => {
        const user = { level: 1 };

        expect(() => ensureQuests(user, SETTINGS)).not.toThrow();
        expect(Array.isArray(user.quests)).toBe(true);
        expect(user.quests.length).toBeGreaterThan(0);
    });
});
