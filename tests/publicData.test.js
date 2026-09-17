'use strict';

// #1018. The read model behind the public pages, tested with the models and the
// gateway stubbed so this is the withholding logic under test, not a database.
// The load-bearing assertion is the last group: a leaderboard row for a member
// who has not opted in carries their display name and their stat and no id.

// A chainable stand-in for `User.find(q).sort().limit().select().lean()`.
function findChain(result) {
    const chain = {
        sort: () => chain,
        limit: () => chain,
        select: () => chain,
        lean: () => Promise.resolve(result),
    };
    return chain;
}

// `Guild.findOne(q).lean()` resolves to `value`.
const leanOnce = (value) => ({ lean: () => Promise.resolve(value) });

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/utils/netWorth', () => ({
    topByNetWorth: jest.fn(),
    netWorthOf: (u) => (u?.balance ?? 0) + (u?.bank ?? 0),
}));
jest.mock('../src/utils/weeklyChampion', () => ({
    getWeeklyChampionLeader: jest.fn(async () => null),
    WEEKLY_CATEGORY_ORDER: ['hunt', 'mine', 'fish', 'explore'],
    WEEKLY_CATEGORY_LABELS: { hunt: { title: 'Hunter', unit: 'coins' } },
}));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async (u) => u) }));

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { topByNetWorth } = require('../src/utils/netWorth');
const { getWeeklyChampionLeader } = require('../src/utils/weeklyChampion');
const { attachGrind } = require('../src/utils/grindProfile');
const publicData = require('../src/dashboard/lib/publicData');
const { isValidSlug, resolvePublicGuild, buildServerPage, buildPlayerCard, _internals } = publicData;

const bot = {
    getGuild: jest.fn(async () => ({ id: '1', name: 'Test Server', icon: null })),
    resolveUsers: jest.fn(async (ids) => Object.fromEntries(ids.map(id => [id, { displayName: `User ${id}`, username: `u${id}`, avatarUrl: `https://cdn.discordapp.com/avatars/${id}/x.webp` }]))),
};

beforeEach(() => jest.clearAllMocks());

describe('isValidSlug', () => {
    test.each(['my-server', 'abc', 'a1b2', 'x'.repeat(32)])('accepts %s', (s) => {
        expect(isValidSlug(s)).toBe(true);
    });
    test.each(['ab', '', 'x'.repeat(33), 'UPPER', 'has space', '-lead', 'trail-', '12345', 'a--b', null, 42])('rejects %p', (s) => {
        expect(isValidSlug(s)).toBe(false);
    });
});

describe('resolvePublicGuild', () => {
    test('returns null when the guild has its page off', async () => {
        Guild.findOne.mockReturnValue(leanOnce({ guildId: '1', publicPage: { enabled: false } }));
        expect(await resolvePublicGuild('123456789012345678')).toBeNull();
    });

    test('returns the guild when the page is on', async () => {
        const doc = { guildId: '1', publicPage: { enabled: true } };
        Guild.findOne.mockReturnValue(leanOnce(doc));
        expect(await resolvePublicGuild('123456789012345678')).toBe(doc);
    });

    test('looks up a numeric id by guildId and a slug by publicPage.slug', async () => {
        Guild.findOne.mockReturnValue(leanOnce(null));
        await resolvePublicGuild('123456789012345678');
        expect(Guild.findOne.mock.calls[0][0]).toEqual({ $or: [{ guildId: '123456789012345678' }] });

        await resolvePublicGuild('my-server');
        expect(Guild.findOne.mock.calls[1][0]).toEqual({ $or: [{ 'publicPage.slug': 'my-server' }] });
    });

    test('refuses a value that is neither a snowflake nor a valid slug', async () => {
        expect(await resolvePublicGuild('Not A Slug!')).toBeNull();
        expect(Guild.findOne).not.toHaveBeenCalled();
    });
});

describe('buildServerPage withholds ids for members who have not opted in', () => {
    const guild = {
        guildId: '1',
        economy: { currency: '$' },
        publicPage: { enabled: true, leaderboards: { level: true }, showChampions: false, showEvent: false, showDistricts: false },
    };

    test('a linkable row for the opted-in member, name-only for the rest', async () => {
        User.find.mockReturnValue(findChain([
            { userId: '111', level: 9, xp: 0, publicProfile: { enabled: true } },
            { userId: '222', level: 8, xp: 0, publicProfile: { enabled: false } },
            { userId: '333', level: 7, xp: 0 },
        ]));

        const page = await buildServerPage(bot, guild);
        const rows = page.boards[0].rows;

        expect(rows[0]).toMatchObject({ rank: 1, name: 'User 111', userId: '111' });
        // Non-opted members: a name and a stat, and no id.
        expect(rows[1]).toMatchObject({ rank: 2, name: 'User 222', userId: null });
        expect(rows[2]).toMatchObject({ rank: 3, name: 'User 333', userId: null });

        // The serialized page carries only the opted-in member's id, never a
        // non-opted member's — the row's `userId` is the only place an id would
        // appear, and it is null for the rest.
        const json = JSON.stringify(page);
        expect(json).toContain('"userId":"111"');
        expect(json).not.toContain('"userId":"222"');
        expect(json).not.toContain('"userId":"333"');
    });

    test('is a 404 (null) when the bot has left the guild', async () => {
        bot.getGuild.mockResolvedValueOnce(null);
        expect(await buildServerPage(bot, guild)).toBeNull();
    });

    test('only assembles the boards the admin ticked', async () => {
        User.find.mockReturnValue(findChain([]));
        topByNetWorth.mockResolvedValue([]);
        await buildServerPage(bot, {
            ...guild,
            publicPage: { enabled: true, leaderboards: { level: true, wealth: true } },
        });
        // The wealth board went through topByNetWorth; an unticked board would not.
        expect(topByNetWorth).toHaveBeenCalledTimes(1);
    });

    test('assembles every board, the champions, districts and event together', async () => {
        // The level/streak/achievements boards all read through User.find; the
        // wealth board reads through topByNetWorth. Each row carries its own
        // opt-in flag so the withholding rule is applied per board.
        User.find.mockReturnValue(findChain([
            { userId: '111', level: 4, xp: 0, streak: { current: 9 }, achievementsCount: 3, publicProfile: { enabled: true } },
        ]));
        topByNetWorth.mockResolvedValue([
            { userId: '111', balance: 10, bank: 90, netWorth: 100, publicProfile: { enabled: true } },
            { userId: '999', balance: 0, bank: 0, netWorth: 0, publicProfile: { enabled: false } },
        ]);
        getWeeklyChampionLeader.mockImplementation(async (_g, cat) =>
            cat === 'hunt' ? { username: 'Hunter Joe', total: 4200 } : null);

        const page = await buildServerPage(bot, {
            guildId: '1', economy: { currency: '$' },
            publicPage: {
                enabled: true,
                leaderboards: { level: true, wealth: true, streak: true, achievements: true },
                showChampions: true, showEvent: true, showDistricts: true,
            },
            districts: [{ districtId: 'bank', pool: 500, goal: 1000, activeUntil: new Date(Date.now() + 1e6) }],
            activeEvent: { type: 'winter_hunt', name: 'Winter Hunt', emoji: '❄️', coinMultiplier: 2, xpMultiplier: 1.5, endsAt: new Date(Date.now() + 1e6) },
        });

        expect(page.boards.map(b => b.key)).toEqual(['level', 'wealth', 'streak', 'achievements']);
        // The wealth board drops the zero-net-worth member, keeping the funded one.
        expect(page.boards.find(b => b.key === 'wealth').rows).toHaveLength(1);
        expect(page.champions).toEqual([{ category: 'hunt', title: 'Hunter', name: 'Hunter Joe', value: '4,200 coins' }]);
        expect(page.districts[0]).toMatchObject({ districtId: 'bank', pct: 50 });
        expect(page.event).toMatchObject({ name: 'Winter Hunt', coinMultiplier: 2 });
    });

    test('an id Discord cannot resolve becomes a generic name, never blank', async () => {
        User.find.mockReturnValue(findChain([{ userId: '111', level: 1, xp: 0, publicProfile: { enabled: false } }]));
        bot.resolveUsers.mockResolvedValueOnce({ 111: null });

        const page = await buildServerPage(bot, guild);
        expect(page.boards[0].rows[0].name).toBe('Unknown member');
    });
});

describe('buildPlayerCard is gated on the member opt-in', () => {
    const guild = { guildId: '1', economy: { currency: '$' }, publicPage: {} };

    test('null for a member with no record', async () => {
        User.findOne.mockResolvedValue(null);
        expect(await buildPlayerCard(bot, guild, '111111111111111111')).toBeNull();
    });

    test('null for a member who has not opted in', async () => {
        User.findOne.mockResolvedValue({ userId: '111111111111111111', publicProfile: { enabled: false } });
        expect(await buildPlayerCard(bot, guild, '111111111111111111')).toBeNull();
    });

    test('null for a userId that is not a snowflake', async () => {
        expect(await buildPlayerCard(bot, guild, 'nope')).toBeNull();
        expect(User.findOne).not.toHaveBeenCalled();
    });

    test('a card for an opted-in member', async () => {
        User.findOne.mockResolvedValue({
            userId: '111111111111111111', guildId: '1', level: 5, xp: 40,
            balance: 100, bank: 900, streak: { current: 3, longest: 7 },
            achievementsCount: 4, achievements: [], accountPrestige: { rank: 0 },
            publicProfile: { enabled: true },
        });
        User.countDocuments.mockResolvedValue(2);

        const card = await buildPlayerCard(bot, guild, '111111111111111111');

        expect(card).toMatchObject({
            userId: '111111111111111111',
            level: 5, rank: 3, netWorth: 1000, streak: 3, achievementsCount: 4,
        });
        expect(card.prestigeTitle).toBeNull();
    });

    test('a fully populated card carries prestige, grind, achievements and materials', async () => {
        User.findOne.mockResolvedValue({
            userId: '111111111111111111', guildId: '1', level: 40, xp: 10, messages: 500,
            balance: 5000, bank: 5000, streak: { current: 12, longest: 30 },
            achievementsCount: 2, achievements: [{ id: 'first_steps' }, { id: 'unknown_id' }],
            accountPrestige: { rank: 6 }, publicProfile: { enabled: true },
        });
        User.countDocuments.mockResolvedValue(0);
        // attachGrind hydrates the legacy grind properties the card reads.
        attachGrind.mockImplementationOnce(async (u) => {
            u.hunt = { level: 7, materials: { rabbits_foot: 3 } };
            u.fishing = { level: 4, materials: {} };
            u.mining = { level: 2, materials: {} };
            u.exploration = { level: 1, materials: {} };
            return u;
        });

        const card = await buildPlayerCard(bot, guild, '111111111111111111');

        expect(card.rank).toBe(1);
        expect(card.prestigeTitle).toEqual(expect.any(String));
        expect(card.prestigeBadge).toEqual(expect.any(String));
        expect(card.grind).toEqual({ hunt: 7, fishing: 4, mining: 2, exploration: 1 });
        // Only the achievement with a known definition survives.
        expect(card.topAchievements).toHaveLength(1);
        expect(card.topAchievements[0].name).toBe('First Steps');
        expect(card.topMaterials[0]).toMatchObject({ label: "Rabbit's Foot" });
    });

    test('falls back to username, no avatar and a generic server name', async () => {
        User.findOne.mockResolvedValue({
            userId: '111111111111111111', guildId: '1',
            achievements: undefined, publicProfile: { enabled: true },
        });
        User.countDocuments.mockResolvedValue(0);
        bot.resolveUsers.mockResolvedValueOnce({ '111111111111111111': { username: 'onlyname' } });
        bot.getGuild.mockResolvedValueOnce(null);

        const card = await buildPlayerCard(bot, { guildId: '1' }, '111111111111111111');

        expect(card.name).toBe('onlyname');
        expect(card.avatarUrl).toBeNull();
        expect(card.guild.name).toBe('Server');
        expect(card.guild.slug).toBeNull();
        expect(card.achievementsCount).toBe(0);
    });
});

describe('the server-wide sections name no member id', () => {
    test('districts are a coin total and a goal, never a contributor id', () => {
        const out = _internals.buildDistricts({
            districts: [
                { districtId: 'bank', pool: 500, goal: 1000, activeUntil: new Date(Date.now() + 1e6), topContributors: [{ userId: '999', amount: 500 }] },
                { districtId: 'arena', pool: 0, goal: 1000 },
            ],
        });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ districtId: 'bank', pool: 500, goal: 1000, active: true, pct: 50 });
        expect(JSON.stringify(out)).not.toContain('999');
    });

    test('the active event is null when none is running', () => {
        expect(_internals.buildEvent({})).toBeNull();
        expect(_internals.buildEvent({ activeEvent: { type: 'x' } })).toBeNull(); // no name
        expect(_internals.buildEvent({ activeEvent: { type: 'x', name: 'Frost', endsAt: new Date(Date.now() - 1) } })).toBeNull();
        expect(_internals.buildEvent({ activeEvent: { type: 'x', name: 'Frost', emoji: '❄️', coinMultiplier: 2, xpMultiplier: 1 } }))
            .toMatchObject({ name: 'Frost', coinMultiplier: 2 });
        // No emoji, no multipliers, no endsAt: the defaults fill in and a
        // never-ending event still reads as active.
        expect(_internals.buildEvent({ activeEvent: { type: 'x', name: 'Endless' } }))
            .toMatchObject({ name: 'Endless', emoji: '✨', coinMultiplier: 1, xpMultiplier: 1, endsAt: null });
    });

    test('districts drop empty pools and clamp an already-met or goal-less pool', () => {
        const out = _internals.buildDistricts({
            districts: [
                null,
                { districtId: 'over', pool: 3000, goal: 1000 },   // no activeUntil → inactive, pct clamped to 100
                { districtId: 'nogoal', pool: 5, goal: 0 },        // goal 0 → pct 0
                { districtId: 'empty', pool: 0, goal: 100 },       // dropped
            ],
        });
        expect(out.map(d => d.districtId)).toEqual(['over', 'nogoal']);
        expect(out.find(d => d.districtId === 'over')).toMatchObject({ active: false, pct: 100 });
        expect(out.find(d => d.districtId === 'nogoal').pct).toBe(0);
    });

    test('a champion leader with no username or total reads with fallbacks', async () => {
        getWeeklyChampionLeader.mockImplementation(async (_g, cat) => (cat === 'mine' ? {} : null));
        const champions = await _internals.buildChampions('1');
        // 'mine' has no entry in the mocked labels, so title falls back to the key.
        expect(champions).toEqual([{ category: 'mine', title: 'mine', name: 'Unknown member', value: '0' }]);
    });

    test('resolveNames prefers displayName, then username, then a generic label', async () => {
        bot.resolveUsers.mockResolvedValueOnce({
            a: { displayName: 'Dee' },
            b: { username: 'bee' },
            c: null,
        });
        const names = await _internals.resolveNames(bot, ['a', 'b', 'c', 'a']);
        expect(names.get('a')).toBe('Dee');
        expect(names.get('b')).toBe('bee');
        expect(names.get('c')).toBe('Unknown member');
        // Deduped: one resolve call for the three unique ids.
        expect(bot.resolveUsers).toHaveBeenCalledWith(['a', 'b', 'c']);
    });

    test('resolveNames is empty for no ids, and survives a resolve failure', async () => {
        expect((await _internals.resolveNames(bot, [])).size).toBe(0);
        bot.resolveUsers.mockRejectedValueOnce(new Error('down'));
        expect((await _internals.resolveNames(bot, ['x'])).get('x')).toBe('Unknown member');
    });
});
