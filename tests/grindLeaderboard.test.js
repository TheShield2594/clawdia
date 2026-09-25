'use strict';

// #1016: the four grind tracks (hunting/fishing/mining/exploring) get real
// boards on /leaderboard, plus a Hall of Champions. These assert the two things
// the issue turns on: the week board reads the SAME standings function the
// Monday sweep crowns from (so board and announcement agree by construction),
// and every board is a bounded, sorted query — never a full collection scan.

jest.mock('discord.js', () => ({
    EmbedBuilder: jest.fn().mockImplementation(() => {
        const self = {
            data: {},
            setColor: jest.fn().mockReturnThis(),
            setTitle: jest.fn().mockImplementation(t => { self.data.title = t; return self; }),
            setDescription: jest.fn().mockImplementation(d => { self.data.description = d; return self; }),
            setFooter: jest.fn().mockReturnThis(),
            setTimestamp: jest.fn().mockReturnThis(),
        };
        return self;
    }),
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/WeeklyChampion', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));

const mockGetStandings = jest.fn();
jest.mock('../src/utils/weeklyChampion', () => ({
    getCurrentWeekKey: () => '2026-W38',
    getWeeklyChampionStandings: (...args) => mockGetStandings(...args),
    WEEKLY_STANDINGS_SORT: { total: -1, runs: -1, createdAt: 1 },
    WEEKLY_CATEGORY_ORDER: ['hunt', 'mine', 'fish', 'explore'],
    WEEKLY_CATEGORY_LABELS: {
        hunt:    { title: '🏹 Hunter of the Week',   emoji: '🦌', unit: 'coins hunted' },
        mine:    { title: '⛏️ Miner of the Week',     emoji: '💎', unit: 'coins mined' },
        fish:    { title: '🎣 Angler of the Week',   emoji: '🐟', unit: 'rarity score' },
        explore: { title: '🧭 Explorer of the Week', emoji: '🗺️', unit: 'coins recovered' },
    },
}));

const GrindProfile = require('../src/models/GrindProfile');
const WeeklyChampion = require('../src/models/WeeklyChampion');
const { buildGrindBoard, buildChampionsHall, GRIND_TRACKS } = require('../src/utils/grindLeaderboard');

// find(...).sort(...).limit(...).maxTimeMS(...).lean() — records the sort.
function mockFindChain(model, rows) {
    const seen = {};
    const chain = {
        sort(s) { seen.sort = s; return chain; },
        limit(n) { seen.limit = n; return chain; },
        maxTimeMS() { return chain; },
        lean: async () => rows,
    };
    model.find.mockReturnValue(chain);
    return seen;
}

// findOne(...).maxTimeMS(...).lean()
function mockFindOne(model, doc) {
    model.findOne.mockReturnValue({ maxTimeMS: () => ({ lean: async () => doc }) });
}

// countDocuments(...).maxTimeMS(...) resolves to a number.
function mockCount(model, n) {
    model.countDocuments.mockReturnValue({ maxTimeMS: async () => n });
}

function makeInteraction({ getString } = {}) {
    return {
        options: { getString: getString ?? (() => null) },
        guild: { id: 'g1', name: 'Test Guild' },
        user: { id: 'caller' },
        client: { users: { fetch: jest.fn(async id => ({ id, tag: `${id}#0` })) } },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetStandings.mockReset();
});

describe('all-time grind board', () => {
    it('sorts by track level then lifetime coins, bounded to ten rows', async () => {
        const rows = [
            { userId: 'a', data: { level: 40, totalEarned: 9000, prestige: 1 } },
            { userId: 'b', data: { level: 22, totalEarned: 500 } },
        ];
        const seen = mockFindChain(GrindProfile, rows);
        mockFindOne(GrindProfile, { data: { level: 22, totalEarned: 500 } });
        mockCount(GrindProfile, 1);

        const payload = await buildGrindBoard(makeInteraction(), 'hunting', 'all-time');

        // The board is an index-scan sort, never a full collection sort.
        expect(seen.sort).toEqual({ 'data.level': -1, 'data.totalEarned': -1 });
        expect(seen.limit).toBe(10);
        // Queried the hunt *system* (GrindProfile's vocabulary), not 'hunting'.
        expect(GrindProfile.find.mock.calls[0][0]).toEqual({ guildId: 'g1', system: 'hunt' });
        const { description, title } = payload.embeds[0].data;
        expect(title).toContain('All-Time');
        expect(description).toContain('🥇 a#0 — Level 40 ✨P1 (9,000 coins earned)');
        expect(description).toContain('🥈 b#0 — Level 22 (500 coins earned)');
        expect(description).toContain('📍 You: **#2**');
    });

    it('is ephemeral with a nudge when the track has no profiles', async () => {
        mockFindChain(GrindProfile, []);
        const payload = await buildGrindBoard(makeInteraction(), 'mining', 'all-time');
        expect(payload.flags).toBe(64);
        expect(payload.content).toContain('/mine');
    });
});

describe('week grind board', () => {
    it('reads the shared standings function for the track category', async () => {
        mockGetStandings.mockResolvedValue([
            { userId: 'x', username: 'X', total: 5000, runs: 12 },
            { userId: 'caller', username: 'Me', total: 2000, runs: 4 },
        ]);
        mockFindOne(WeeklyChampion, { total: 2000 });
        mockCount(WeeklyChampion, 1);

        const payload = await buildGrindBoard(makeInteraction(), 'fishing', 'week');

        // The board and the Monday sweep read one function — this call proves it.
        expect(mockGetStandings).toHaveBeenCalledWith('g1', 'fish', { limit: 10 });
        const { description } = payload.embeds[0].data;
        expect(description).toContain('🥇 x#0 — **5,000 rarity score** over 12 runs');
        // Caller sits second, 3,000 behind the leader.
        expect(description).toContain('📍 You: **#2**');
        expect(description).toContain('3,000 rarity score behind first');
    });

    it('crowns the caller when they lead', async () => {
        mockGetStandings.mockResolvedValue([{ userId: 'caller', username: 'Me', total: 8000, runs: 20 }]);
        mockFindOne(WeeklyChampion, { total: 8000 });
        mockCount(WeeklyChampion, 0);

        const payload = await buildGrindBoard(makeInteraction(), 'exploring', 'week');
        expect(payload.embeds[0].data.description).toContain('👑 leading the race');
    });

    it('is ephemeral before the first run of the week', async () => {
        mockGetStandings.mockResolvedValue([]);
        const payload = await buildGrindBoard(makeInteraction(), 'hunting', 'week');
        expect(payload.flags).toBe(64);
        expect(payload.content).toContain('first');
    });
});

describe('Hall of Champions', () => {
    it('reads only rewarded rows, grouped by week, newest first', async () => {
        const seen = mockFindChain(WeeklyChampion, [
            { week: '2026-W37', category: 'hunt', userId: 'h', username: 'H', total: 4000, runs: 9 },
            { week: '2026-W37', category: 'mine', userId: 'm', username: 'M', total: 3000, runs: 5 },
            { week: '2026-W36', category: 'fish', userId: 'f', username: 'F', total: 12, runs: 3 },
        ]);

        const payload = await buildChampionsHall(makeInteraction());

        expect(WeeklyChampion.find.mock.calls[0][0]).toEqual({ guildId: 'g1', rewarded: true });
        expect(seen.sort).toEqual({ week: -1 });
        const { description } = payload.embeds[0].data;
        expect(description).toContain('__Week 2026-W37__');
        expect(description).toContain('🦌 **🏹 Hunter of the Week** — <@h> (H) · 4,000 coins hunted over 9 runs');
        expect(description).toContain('__Week 2026-W36__');
        // W37 (newer) is printed before W36.
        expect(description.indexOf('2026-W37')).toBeLessThan(description.indexOf('2026-W36'));
    });

    it('hands the picture card each week\'s champions, by track, with their avatars', async () => {
        mockFindChain(WeeklyChampion, [
            { week: '2026-W37', category: 'hunt', userId: 'h', username: 'H', total: 4000, runs: 9 },
            { week: '2026-W37', category: 'mine', userId: 'gone', username: 'Left', total: 3000, runs: 5 },
            { week: '2026-W36', category: 'hunt', userId: 'h', username: 'H', total: 12, runs: 3 },
        ]);
        const interaction = makeInteraction();
        interaction.client.users.fetch = jest.fn(async id => {
            if (id === 'gone') throw new Error('Unknown User');
            return { id, globalName: 'Hunter H', displayAvatarURL: () => `https://cdn/${id}.png` };
        });

        const { card } = await buildChampionsHall(interaction);

        // One fetch per champion, not per crown.
        expect(interaction.client.users.fetch).toHaveBeenCalledTimes(2);
        expect(card.weeks.map(w => w.week)).toEqual(['2026-W37', '2026-W36']);
        expect(card.weeks[0].champions.hunt).toMatchObject({
            role: 'HUNTER', name: 'Hunter H', avatarUrl: 'https://cdn/h.png', total: 4000, unit: 'coins hunted', runs: 9,
        });
        // A champion who has left keeps the name stored with the win.
        expect(card.weeks[0].champions.mine).toMatchObject({ role: 'MINER', name: 'Left', avatarUrl: null });
        expect(Object.keys(card.weeks[1].champions)).toEqual(['hunt']);
        expect(typeof card.draw).toBe('function');
    });

    it('is ephemeral before any champion is crowned', async () => {
        mockFindChain(WeeklyChampion, []);
        const payload = await buildChampionsHall(makeInteraction());
        expect(payload.flags).toBe(64);
    });
});

describe('track vocabulary', () => {
    it('maps each board choice to its champion category and grind system', () => {
        expect(GRIND_TRACKS.hunting).toMatchObject({ category: 'hunt', system: 'hunt' });
        expect(GRIND_TRACKS.fishing).toMatchObject({ category: 'fish', system: 'fishing' });
        expect(GRIND_TRACKS.mining).toMatchObject({ category: 'mine', system: 'mining' });
        expect(GRIND_TRACKS.exploring).toMatchObject({ category: 'explore', system: 'exploration' });
    });
});
