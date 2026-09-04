'use strict';

/**
 * #898 — the second user round trip every command used to pay.
 *
 * `trackQuestCommandUse` runs after every successful command, on top of
 * whatever the command handler itself already loaded and saved for the same
 * member. It hydrated the whole `User` document and saved it back, for five
 * quest ids that most members have either finished for the day or are not
 * holding at all — so every slash command cost two full document round trips
 * where one would do.
 *
 * A projected quest list is read first now. When it says nothing can move, the
 * command pays that one small read and stops.
 */

const mockUser = {
    findOne: jest.fn(),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
};

jest.mock('../src/models/User', () => mockUser);
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/utils/balanceDelta', () => ({
    saveWithBalanceDelta: jest.fn(async () => ({ credited: true, balance: 0 })),
    detachBalanceDelta: jest.fn(),
    applyBalanceDelta: jest.fn(),
    commitBalanceDelta: jest.fn(),
}));
jest.mock('../src/services/questService', () => {
    const actual = jest.requireActual('../src/services/questService');
    return {
        // Real predicates: they are the whole decision under test.
        questEventCanProgress: actual.questEventCanProgress,
        questAssignmentNeeded: actual.questAssignmentNeeded,
        ensureQuests: jest.fn(async () => ({ assignedNewDaily: false })),
        onCommandUse: jest.fn(async () => ({ completed: [], nearComplete: [] })),
        notifyQuestComplete: jest.fn(async () => {}),
        notifyQuestNearComplete: jest.fn(async () => {}),
    };
});

const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { saveWithBalanceDelta } = require('../src/utils/balanceDelta');
const { ensureQuests, onCommandUse } = require('../src/services/questService');
const { trackQuestCommandUse } = require('../src/events/interactionCreate');

const QUESTS_PER_DAY = 3;
const QUESTS_PER_WEEK = 2;

// Real expiry boundaries, minted by `ensureQuests` rather than written down
// here: the pre-check buckets a quest by exact expiry match, so an invented
// date lands in neither bucket and the set reads as empty — which would make
// the "nothing to do" cases pass for the wrong reason. `ensureQuests` mutates
// synchronously despite being declared async.
const EXPIRIES = (() => {
    const seed = { level: 1, quests: [] };
    jest.requireActual('../src/services/questService')
        .ensureQuests(seed, { quests: { enabled: true, questsPerDay: QUESTS_PER_DAY, questsPerWeek: QUESTS_PER_WEEK } });
    const distinct = [...new Set(seed.quests.map(q => q.expiresAt.getTime()))].sort((a, b) => a - b);
    return { daily: new Date(distinct[0]), weekly: new Date(distinct[distinct.length - 1]) };
})();

const entry = (questId, expiresAt, extra = {}) =>
    ({ questId, progress: 0, completedAt: null, expiresAt, ...extra });

// A full, live set with nothing a command can advance.
const settledQuests = () => [
    entry('daily_messages_5',  EXPIRIES.daily),
    entry('daily_messages_10', EXPIRIES.daily),
    entry('daily_messages_25', EXPIRIES.daily),
    entry('weekly_messages_50',  EXPIRIES.weekly),
    entry('weekly_messages_150', EXPIRIES.weekly),
];

function stubFindOne(doc) {
    mockUser.findOne.mockImplementation(() => {
        const query = Promise.resolve(doc);
        query.lean = async () => doc;
        return query;
    });
}

const interaction = {
    guild: { id: 'guild-1' },
    user: { id: 'player-1' },
    member: {},
    channel: {},
};

beforeEach(() => {
    jest.clearAllMocks();
    getGuildSettings.mockResolvedValue({
        quests: { enabled: true, questsPerDay: QUESTS_PER_DAY, questsPerWeek: QUESTS_PER_WEEK },
    });
});

// ---------------------------------------------------------------------------

describe('a command with no command quest to move', () => {
    beforeEach(() => stubFindOne({ userId: 'player-1', guildId: 'guild-1', quests: settledQuests() }));

    test('costs one projected read and no hydrate', async () => {
        await trackQuestCommandUse(interaction);

        expect(mockUser.findOne).toHaveBeenCalledTimes(1);
        expect(mockUser.findOne.mock.calls[0][1]).toEqual({ quests: 1, economyFrozen: 1 });
    });

    test('writes nothing', async () => {
        await trackQuestCommandUse(interaction);

        expect(saveWithBalanceDelta).not.toHaveBeenCalled();
        expect(onCommandUse).not.toHaveBeenCalled();
        expect(ensureQuests).not.toHaveBeenCalled();
    });

    test('a finished command quest is not a reason to hydrate', async () => {
        stubFindOne({
            userId: 'player-1', guildId: 'guild-1',
            quests: [...settledQuests(), entry('daily_commands_5', EXPIRIES.daily, { completedAt: new Date() })],
        });

        await trackQuestCommandUse(interaction);

        expect(saveWithBalanceDelta).not.toHaveBeenCalled();
    });
});

describe('a command that can move something', () => {
    test('a live command quest hydrates and saves as before', async () => {
        stubFindOne({
            userId: 'player-1', guildId: 'guild-1', balance: 100,
            quests: [...settledQuests(), entry('daily_commands_5', EXPIRIES.daily)],
        });

        await trackQuestCommandUse(interaction);

        expect(mockUser.findOne).toHaveBeenCalledTimes(2);
        expect(onCommandUse).toHaveBeenCalled();
        expect(saveWithBalanceDelta).toHaveBeenCalled();
    });

    test('a live AI quest hydrates too, since its mechanic is not knowable from here', async () => {
        stubFindOne({
            userId: 'player-1', guildId: 'guild-1', balance: 100,
            quests: [...settledQuests(), entry('ai_legendary_7', EXPIRIES.weekly)],
        });

        await trackQuestCommandUse(interaction);

        expect(onCommandUse).toHaveBeenCalled();
    });

    test('a set due for a rollover hydrates, so the quests still get assigned', async () => {
        // Nothing live to advance, but nothing live at all — skipping here is
        // how a member stops being given quests altogether.
        stubFindOne({ userId: 'player-1', guildId: 'guild-1', balance: 0, quests: [] });

        await trackQuestCommandUse(interaction);

        expect(ensureQuests).toHaveBeenCalled();
    });
});
