'use strict';

// /season leaderboard and /syndicate leaderboard: the text board as it always
// read, and the picture card's rows from the same documents.

jest.mock('../src/models/User', () => ({ find: jest.fn() }));
jest.mock('../src/models/Syndicate', () => ({ find: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));

const User = require('../src/models/User');
const Syndicate = require('../src/models/Syndicate');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { buildSeasonBoard, buildSyndicateBoard } = require('../src/utils/economyLeaderboards');

function makeInteraction() {
    return {
        guild: { id: 'g1', name: 'Test Guild' },
        user: { id: 'u1' },
        client: {
            users: {
                fetch: jest.fn(async id => {
                    if (id === 'gone') throw new Error('Unknown User');
                    return { id, globalName: `G-${id}`, displayAvatarURL: () => `https://cdn/${id}.png` };
                }),
            },
        },
    };
}

function mockSeasonRows(rows) {
    const chain = { sort: () => chain, limit: () => chain, select: async () => rows };
    User.find.mockReturnValue(chain);
}
function mockSyndicates(rows) {
    const chain = { sort: () => chain, limit: () => chain, lean: async () => rows };
    Syndicate.find.mockReturnValue(chain);
}

beforeEach(() => jest.clearAllMocks());

describe('buildSeasonBoard', () => {
    test('no season running is a private note', async () => {
        getGuildSettings.mockResolvedValue({});
        const board = await buildSeasonBoard(makeInteraction());
        expect(board).toMatchObject({ content: 'No active economy season on this server.', flags: 64 });
    });

    test('a season with no coins yet is a private note', async () => {
        getGuildSettings.mockResolvedValue({ currentSeason: { id: 's1', name: 'Spring' } });
        mockSeasonRows([]);
        const board = await buildSeasonBoard(makeInteraction());
        expect(board).toMatchObject({ content: 'No season data yet.', flags: 64 });
    });

    test('the text and the card read the same rows', async () => {
        getGuildSettings.mockResolvedValue({
            currentSeason: { id: 's1', name: 'Spring', endsAt: new Date('2026-10-01T00:00:00Z') },
            economy: { currency: '🪙' },
        });
        mockSeasonRows([{ userId: 'u0', seasonCoins: 5000 }, { userId: 'u1', seasonCoins: 20 }, { userId: 'gone' }]);

        const board = await buildSeasonBoard(makeInteraction());

        const text = board.embeds[0].data;
        expect(text.description).toContain('🥇 <@u0> — **5,000** 🪙');
        expect(text.fields[0].value).toBe('<t:1790812800:R>');
        expect(board.card).toMatchObject({ theme: 'board', title: 'Season Leaderboard', kicker: 'Test Guild' });
        expect(board.card.entries[0]).toMatchObject({ rank: 1, name: 'G-u0', avatarUrl: 'https://cdn/u0.png', value: '5,000 season coins', score: 5000 });
        expect(board.card.entries[1]).toMatchObject({ you: true });
        expect(board.card.entries[2]).toMatchObject({ name: 'Unknown member', avatarUrl: null, value: '0 season coins' });
    });
});

describe('buildSyndicateBoard', () => {
    test('no syndicates is a private note', async () => {
        mockSyndicates([]);
        const board = await buildSyndicateBoard(makeInteraction(), {});
        expect(board).toMatchObject({ content: 'No syndicates have been founded on this server yet.', flags: 64 });
    });

    test('each syndicate under its leader, the caller\'s own outlined', async () => {
        mockSyndicates([
            { name: 'Night Owls', tag: 'OWL', leaderId: 'u0', memberIds: ['u0', 'u1'], lifetimeEarnings: 90000, heat: 3 },
            { name: 'Loners', leaderId: 'gone', memberIds: ['x'] },
        ]);

        const board = await buildSyndicateBoard(makeInteraction(), { economy: { currency: '$' } });

        expect(board.embeds[0].data.description).toContain('🥇 **Night Owls** [OWL] — $90,000 · 2 members · Heat 3');
        expect(board.card.entries[0]).toMatchObject({
            name: 'Night Owls [OWL]', avatarUrl: 'https://cdn/u0.png', value: '90,000 coins',
            detail: '2 members · Heat 3 · led by G-u0', score: 90000, you: true,
        });
        expect(board.card.entries[1]).toMatchObject({
            name: 'Loners', avatarUrl: null, value: '0 coins', detail: '1 member · Heat 0', you: false,
        });
    });
});
