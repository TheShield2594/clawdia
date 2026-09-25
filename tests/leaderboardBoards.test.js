'use strict';

// /leaderboard's own boards beyond Levels (which leaderboardUserFetch covers):
// each hands the picture card the same rows and the same "you" standing its
// text prints, and the grind boards and the Hall go out through replyBoard.

jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/utils/netWorth', () => ({
    netWorthOf: u => (u.balance ?? 0) + (u.bank ?? 0),
    topByNetWorth: jest.fn(),
    netWorthRank: jest.fn(),
}));
jest.mock('../src/utils/grindLeaderboard', () => ({
    GRIND_TRACKS: { hunting: { category: 'hunt' } },
    buildGrindBoard: jest.fn(),
    buildChampionsHall: jest.fn(),
}));
jest.mock('../src/utils/leaderboardCard', () => {
    const actual = jest.requireActual('../src/utils/leaderboardCard');
    return { ...actual, sendBoard: jest.fn(), replyBoard: jest.fn() };
});

const User = require('../src/models/User');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { topByNetWorth, netWorthRank } = require('../src/utils/netWorth');
const { buildGrindBoard, buildChampionsHall } = require('../src/utils/grindLeaderboard');
const { sendBoard, replyBoard } = require('../src/utils/leaderboardCard');
const leaderboard = require('../src/commands/leveling/leaderboard');

function mockRows(rows) {
    const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => rows };
    User.find.mockReturnValue(chain);
}
function mockCaller(doc) {
    User.findOne.mockReturnValue({ select: () => ({ lean: async () => doc }) });
}

function makeInteraction(type, { period = null } = {}) {
    return {
        options: { getString: name => (name === 'type' ? type : period) },
        guild: { id: 'g1', name: 'Test Guild' },
        user: { id: 'caller', username: 'caller', displayAvatarURL: () => 'https://cdn/caller.png' },
        member: { displayName: 'Caller' },
        client: { users: { fetch: jest.fn(async id => ({ id, tag: `${id}#0`, globalName: `G-${id}` })) } },
        deferred: false,
        replied: false,
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
    };
}

/** The picture card's options sendBoard was handed. */
const cardOf = () => sendBoard.mock.calls[0][2];

beforeEach(() => {
    jest.clearAllMocks();
    User.countDocuments.mockResolvedValue(11);
    mockCaller(null);
});

describe('/leaderboard boards', () => {
    test('economy: net worth rows and the caller\'s rank off the board', async () => {
        topByNetWorth.mockResolvedValue([{ userId: 'u0', netWorth: 5000 }, { userId: 'u1', netWorth: 1200 }]);
        mockCaller({ userId: 'caller', balance: 40, bank: 60 });
        netWorthRank.mockResolvedValue(14);

        await leaderboard.execute(makeInteraction('economy'));

        const card = cardOf();
        expect(card).toMatchObject({ theme: 'board', title: 'Richest Members', kicker: 'Test Guild' });
        expect(card.entries[0]).toMatchObject({ rank: 1, name: 'G-u0', value: '5,000 coins', score: 5000 });
        expect(card.you).toMatchObject({ rank: 14, name: 'Caller', value: '100 coins', avatarUrl: 'https://cdn/caller.png' });
        expect(sendBoard.mock.calls[0][1].data.description).toContain('📍 You: **#14** — 100 coins');
    });

    test('streaks: milestone, freezes and revival token read as words on the card', async () => {
        mockRows([
            { userId: 'u0', streak: { current: 31, freezes: 2, revivalToken: true } },
            { userId: 'u1', streak: { current: 1 } },
        ]);
        mockCaller({ userId: 'caller', streak: { current: 3 } });

        await leaderboard.execute(makeInteraction('streaks'));

        const card = cardOf();
        expect(card.theme).toBe('streak');
        expect(card.entries[0]).toMatchObject({ value: '31 days', detail: '30-day milestone · 2 freezes banked · Revival Token', score: 31 });
        expect(card.entries[1]).toMatchObject({ value: '1 day', detail: null });
        expect(card.you).toMatchObject({ rank: 12, value: '3 days' });
    });

    test('longest streaks, and a caller already on the board gets no second row', async () => {
        mockRows([{ userId: 'caller', streak: { longest: 90 } }]);
        mockCaller({ userId: 'caller', streak: { longest: 90 } });
        User.countDocuments.mockResolvedValue(0);

        await leaderboard.execute(makeInteraction('streaks_longest'));

        const card = cardOf();
        expect(card.title).toBe('All-Time Streak Records');
        expect(card.entries[0]).toMatchObject({ value: '90 days', you: true });
        expect(card.you).toBeNull();
    });

    test('duels: wins and losses, ranked by wins', async () => {
        mockRows([{ userId: 'u0', duelWins: 7, duelLosses: 2 }]);
        mockCaller({ userId: 'caller', duelWins: 1, duelLosses: 4 });

        await leaderboard.execute(makeInteraction('duels'));

        expect(cardOf().entries[0]).toMatchObject({ value: '7W / 2L', score: 7 });
        expect(cardOf().you).toMatchObject({ rank: 12, value: '1W / 4L', score: 1 });
    });

    test('achievements: refused while achievements are off', async () => {
        getGuildSettings.mockResolvedValue({ achievements: { enabled: false } });
        const interaction = makeInteraction('achievements');

        await leaderboard.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Achievements are not enabled on this server.' }));
        expect(sendBoard).not.toHaveBeenCalled();
    });

    test('achievements: counts on the card, the caller\'s below', async () => {
        getGuildSettings.mockResolvedValue({ achievements: { enabled: true } });
        mockRows([{ userId: 'u0', achievementsCount: 12 }, { userId: 'u1', achievementsCount: 1 }]);
        mockCaller({ userId: 'caller', achievementsCount: 0 });

        await leaderboard.execute(makeInteraction('achievements'));

        const card = cardOf();
        expect(card).toMatchObject({ theme: 'achievements', title: 'Achievements' });
        expect(card.entries.map(e => e.value)).toEqual(['12 achievements', '1 achievement']);
        expect(card.you).toMatchObject({ value: '0 achievements' });
    });

    test('levels: the caller\'s level and XP below the board', async () => {
        mockRows([{ userId: 'u0', level: 9, xp: 1500 }]);
        mockCaller({ userId: 'caller', level: 2, xp: 40 });

        await leaderboard.execute(makeInteraction(null));

        expect(cardOf().entries[0]).toMatchObject({ value: 'Level 9', detail: '1,500 XP', score: 9 });
        expect(cardOf().you).toMatchObject({ rank: 12, value: 'Level 2', detail: '40 XP' });
    });

    test('an empty board says so without drawing', async () => {
        mockRows([]);
        const interaction = makeInteraction('duels');

        await leaderboard.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'No users found on the leaderboard!' }));
        expect(sendBoard).not.toHaveBeenCalled();
    });

    test('grind boards and the Hall of Champions go out through replyBoard', async () => {
        buildGrindBoard.mockResolvedValue({ embeds: ['grind'] });
        buildChampionsHall.mockResolvedValue({ embeds: ['hall'] });

        const week = makeInteraction('hunting', { period: 'week' });
        await leaderboard.execute(week);
        expect(buildGrindBoard).toHaveBeenCalledWith(week, 'hunting', 'week');
        await leaderboard.execute(makeInteraction('hunting'));
        expect(buildGrindBoard.mock.calls[1][2]).toBe('all-time');
        await leaderboard.execute(makeInteraction('champions'));

        expect(replyBoard.mock.calls.map(c => c[1].embeds[0])).toEqual(['grind', 'grind', 'hall']);
    });

    test('a failure answers privately rather than throwing', async () => {
        User.find.mockImplementation(() => { throw new Error('db down'); });
        const interaction = makeInteraction('duels');
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await leaderboard.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Failed to fetch leaderboard.', flags: 64 }));
        console.error.mockRestore();
    });
});
