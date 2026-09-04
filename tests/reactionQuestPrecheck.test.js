'use strict';

/**
 * #929 — what a single reaction used to cost.
 *
 * `handleReactionQuests` ran an upsert, a full `User` hydrate, a save and a
 * `guild.members.fetch` for every reaction the bot saw, for a set of four quest
 * ids that a given member has usually either finished for the day or never been
 * assigned. Reaction bursts are what made that expensive: a message that
 * catches on, or a starboard-active channel, lands dozens of these in seconds
 * and each one paid in full.
 *
 * A projected quest list is read first now, and the rest of the work happens
 * only when it says something could move. The member fetch waits until there is
 * actually a notification to address.
 */

const mockUser = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
};

jest.mock('../src/models/User', () => mockUser);
jest.mock('../src/models/Guild', () => ({ updateOne: jest.fn(async () => ({ modifiedCount: 0 })) }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/utils/balanceDelta', () => ({
    saveWithBalanceDelta: jest.fn(async () => ({ credited: true, balance: 0 })),
}));
jest.mock('../src/services/questService', () => {
    const actual = jest.requireActual('../src/services/questService');
    return {
        // The predicates are the real ones — they are what decides whether the
        // document is touched at all, so stubbing them would test nothing.
        questEventCanProgress: actual.questEventCanProgress,
        questAssignmentNeeded: actual.questAssignmentNeeded,
        ensureQuests: jest.fn(async () => ({ assignedNewDaily: false })),
        onReaction: jest.fn(async () => ({ completed: [], nearComplete: [] })),
        notifyQuestComplete: jest.fn(async () => {}),
        notifyQuestNearComplete: jest.fn(async () => {}),
    };
});

const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { saveWithBalanceDelta } = require('../src/utils/balanceDelta');
const {
    ensureQuests, onReaction, notifyQuestComplete, notifyQuestNearComplete,
} = require('../src/services/questService');
const messageReactionAdd = require('../src/events/messageReactionAdd');

const QUESTS_PER_DAY = 3;
const QUESTS_PER_WEEK = 2;

// The real expiry boundaries, minted by `ensureQuests` rather than written down
// here. The pre-check classifies a quest into the daily or the weekly bucket by
// *exact* expiry match, so an invented date lands in neither and every set reads
// as empty — which would make the "nothing to do" cases pass for the wrong
// reason. `ensureQuests` mutates synchronously despite being declared async.
const EXPIRIES = (() => {
    const seed = { level: 1, quests: [] };
    jest.requireActual('../src/services/questService')
        .ensureQuests(seed, { quests: { enabled: true, questsPerDay: QUESTS_PER_DAY, questsPerWeek: QUESTS_PER_WEEK } });
    // One value on the day the two windows coincide (a Saturday), two otherwise.
    const distinct = [...new Set(seed.quests.map(q => q.expiresAt.getTime()))].sort((a, b) => a - b);
    return { daily: new Date(distinct[0]), weekly: new Date(distinct[distinct.length - 1]) };
})();

const entry = (questId, expiresAt, progress = 0) => ({ questId, progress, completedAt: null, expiresAt });

// A full, live quest set of the *wrong* kind: nothing a reaction can advance,
// and nothing `ensureQuests` would need to top up. The steady state.
function settledQuests() {
    return [
        entry('daily_messages_5',  EXPIRIES.daily),
        entry('daily_messages_10', EXPIRIES.daily),
        entry('daily_messages_25', EXPIRIES.daily),
        entry('weekly_messages_50',  EXPIRIES.weekly),
        entry('weekly_messages_150', EXPIRIES.weekly),
    ];
}

function makeSettings() {
    return {
        quests: { enabled: true, questsPerDay: QUESTS_PER_DAY, questsPerWeek: QUESTS_PER_WEEK },
        reactionRoles: [],
        starboard: { enabled: false },
    };
}

function makeGuild(members) {
    return {
        id: 'guild-1',
        members,
        channels: { cache: { get: () => null } },
    };
}

function makeReaction(guild) {
    return {
        partial: false,
        emoji: { name: '⭐' },
        message: {
            id: 'm1', partial: false, guild, channel: { id: 'c1' },
            author: { id: 'someone-else' },
            reactions: { cache: { find: () => null } },
        },
    };
}

function stubFindOne(doc) {
    mockUser.findOne.mockImplementation(() => {
        const query = Promise.resolve(doc);
        query.lean = async () => doc;
        return query;
    });
}

let membersFetch;
let guild;

beforeEach(() => {
    jest.clearAllMocks();
    membersFetch = jest.fn(async () => ({ id: 'u1' }));
    guild = makeGuild({ fetch: membersFetch });
    mockUser.findOneAndUpdate.mockResolvedValue({
        userId: 'u1', guildId: 'guild-1', balance: 0, quests: [],
        save: jest.fn(async () => {}),
    });
});

const react = () => messageReactionAdd.execute(makeReaction(guild), { bot: false, id: 'u1' }, { user: { id: 'bot' } });

// ---------------------------------------------------------------------------

describe('a reaction that cannot move a quest', () => {
    beforeEach(() => {
        stubFindOne({ userId: 'u1', guildId: 'guild-1', quests: settledQuests() });
        getGuildSettings.mockResolvedValue(makeSettings());
    });

    test('costs one projected read and nothing else', async () => {
        await react();

        expect(mockUser.findOne).toHaveBeenCalledTimes(1);
        expect(mockUser.findOne.mock.calls[0][1]).toEqual({ quests: 1 });
        expect(mockUser.findOneAndUpdate).not.toHaveBeenCalled();
        expect(saveWithBalanceDelta).not.toHaveBeenCalled();
    });

    test('does not fetch the member', async () => {
        await react();

        expect(membersFetch).not.toHaveBeenCalled();
    });

    test('does not run the quest hooks either', async () => {
        await react();

        expect(ensureQuests).not.toHaveBeenCalled();
        expect(onReaction).not.toHaveBeenCalled();
    });
});

describe('a reaction that can move a quest', () => {
    beforeEach(() => {
        stubFindOne({
            userId: 'u1', guildId: 'guild-1',
            quests: [...settledQuests(), entry('daily_reactions_5', EXPIRIES.daily, 1)],
        });
        getGuildSettings.mockResolvedValue(makeSettings());
    });

    test('still hydrates and saves', async () => {
        await react();

        expect(mockUser.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(saveWithBalanceDelta).toHaveBeenCalledTimes(1);
    });

    test('but fetches no member while there is nothing to say', async () => {
        await react();

        expect(membersFetch).not.toHaveBeenCalled();
        expect(notifyQuestComplete).not.toHaveBeenCalled();
    });

    test('fetches the member once a quest actually completes', async () => {
        onReaction.mockResolvedValueOnce({ completed: [{ questId: 'daily_reactions_5' }], nearComplete: [] });

        await react();

        expect(membersFetch).toHaveBeenCalledWith('u1');
        expect(notifyQuestComplete).toHaveBeenCalledTimes(1);
        expect(notifyQuestNearComplete).toHaveBeenCalledTimes(1);
    });

    test('and once one is nearly there', async () => {
        onReaction.mockResolvedValueOnce({ completed: [], nearComplete: [{ questId: 'daily_reactions_5' }] });

        await react();

        expect(membersFetch).toHaveBeenCalledWith('u1');
    });
});

describe('a member with no document yet', () => {
    test('is upserted, not skipped — quests still have to be assigned', async () => {
        stubFindOne(null);
        getGuildSettings.mockResolvedValue(makeSettings());

        await react();

        expect(mockUser.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(ensureQuests).toHaveBeenCalledTimes(1);
    });
});
