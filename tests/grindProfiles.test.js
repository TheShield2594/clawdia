'use strict';

/**
 * /hunt profile, /fish profile and /explore profile share one shape
 * (utils/grindProfileView.js): a short overview embed with a drawn card, a
 * collection tab, and a progress tab. These drive the real commands and read
 * what a player is sent. The canvas renders are mocked — what they draw is
 * utils/grindProfileCard.js's business; what they are *given* is checked here.
 */

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async user => user) }));
jest.mock('../src/utils/grindProfileCard', () => ({
    createGrindProfileCard:    jest.fn(async () => Buffer.from('profile-card')),
    createGrindCollectionCard: jest.fn(async () => Buffer.from('collection-card')),
}));

const User = require('../src/models/User');
const cards = require('../src/utils/grindProfileCard');
const { makeInteraction } = require('./helpers/fakeInteraction');
const { executeProfile, readTrophies } = require('../src/commands/economy/hunt/profile');
const { handleProfile: fishProfile } = require('../src/commands/economy/fish/profile');
const { readCatalog } = require('../src/commands/economy/fish/profilePages');
const { handleProfile: exploreProfile } = require('../src/commands/economy/explore/profile');
const { levelProgress, buildTodayField, joinWithin } = require('../src/utils/grindProfileView');
const { recordCatalogCatch, snapshotCastRewards, revertEscapedCast } = require('../src/services/fishService');
const huntData = require('../src/data/huntData');
const fishData = require('../src/data/fishData');
const { RELIC_LIST } = require('../src/data/exploreData');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

function withUser(user) {
    User.findOne.mockResolvedValue({ userId: USER_ID, guildId: GUILD_ID, balance: 97_044, inventory: [], markModified() {}, ...user });
}

const huntUser = (hunt = {}) => ({
    hunt: {
        level: 24, xp: 12_558, stamina: 10, totalHunts: 239, successfulHunts: 179,
        totalEarned: 40_224, bestPayout: 4_437, legendaryKills: 5, eventKills: 1,
        activeZone: 'arctic_tundra', unlockedZones: ['beginner_forest', 'desert_wastes', 'arctic_tundra'],
        dailyHunts: 10, dailyCoins: 3_313, dailyWindowStart: new Date(),
        trophies: [
            '🟣 Mythic Jackrabbit', '🔷 Pristine Jackrabbit', '🟢 Good Jackrabbit',
            '🔷 Pristine Snow Leopard', '🟢 Good Wolf', '🥉 Bronze Prestige',
        ],
        ...hunt,
    },
});

const fieldNames = payload => payload.embeds[0].data.fields.map(f => f.name);
const flatten = payload => JSON.stringify(payload.embeds[0].data);

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('/hunt profile', () => {
    test('the overview is short, carded, and still carries its numbers in text', async () => {
        withUser(huntUser());
        const interaction = makeInteraction({ guildId: GUILD_ID, userId: USER_ID });
        await executeProfile(interaction);

        const [first] = interaction.replies;
        expect(fieldNames(first)).toEqual(['📊 Record', '🏆 Trophy Cabinet', '📅 Today']);
        const text = flatten(first);
        // What the old profile spent whole fields on is gone…
        expect(text).not.toContain('Balance');
        expect(text).not.toContain('Active Buffs');
        expect(text).not.toContain('Unlocked Zones');
        // …and what it reported is still reachable without the picture.
        expect(text).toContain('Level 24');
        expect(text).toContain('239 hunts');
        expect(text).toContain('75% success');
        expect(text).toContain('10/10 stamina');
        expect(text).toContain('3/62 species · 5 trophies');

        expect(first.files).toHaveLength(1);
        expect(first.embeds[0].data.image.url).toBe('attachment://hunt-profile.png');
        expect(first.files[0].description).toContain('Marksman');
        expect(first.files[0].description.length).toBeLessThanOrEqual(1024);
        expect(first.components[0].components.map(b => b.data.label)).toEqual(['Overview', 'Trophies', 'Progress']);
    });

    test('the XP bar measures the current level, not the running total', async () => {
        withUser(huntUser());
        await executeProfile(makeInteraction({ guildId: GUILD_ID, userId: USER_ID }));
        const { xp } = cards.createGrindProfileCard.mock.calls[0][0];
        const expected = levelProgress(huntData.HUNTER_LEVELS, 24, 12_558);
        expect(xp).toEqual({ total: 12_558, into: expected.into, span: expected.span });
        expect(expected.frac).toBeLessThan(0.9); // the old fish/explore maths said 96%
    });

    test('the shelf leads with the best grade, one slot per species', async () => {
        withUser(huntUser());
        await executeProfile(makeInteraction({ guildId: GUILD_ID, userId: USER_ID }));
        const { shelf } = cards.createGrindProfileCard.mock.calls[0][0];
        expect(shelf.map(s => [s.iconId, s.badge])).toEqual([
            ['animal:jackrabbit', 'M'],
            ['animal:snow_leopard', 'P'],
            ['animal:wolf', 'G'],
        ]);
    });

    test('the Trophies tab draws every species and names the gaps in reach', async () => {
        withUser(huntUser());
        const interaction = makeInteraction({
            guildId: GUILD_ID, userId: USER_ID,
            components: [{ customId: 'gptab_trophies_interaction-1' }],
        });
        await executeProfile(interaction);
        await new Promise(r => setTimeout(r, 5));

        const trophyPage = interaction.replies.find(p => p.embeds && flatten(p).includes('Trophy Cabinet') && p.attachments);
        expect(trophyPage).toBeDefined();
        expect(trophyPage.attachments).toEqual([]);
        expect(trophyPage.files[0].name).toBe('hunt-trophies.png');
        expect(flatten(trophyPage)).toContain('3 of 62 species');
        expect(flatten(trophyPage)).toContain('Ribbons');

        const { sections } = cards.createGrindCollectionCard.mock.calls[0][0];
        const entries = sections.flatMap(s => s.entries);
        expect(entries).toHaveLength(Object.keys(huntData.ANIMALS).length);
        expect(entries.filter(e => e.owned)).toHaveLength(3);
    });

    test('someone else\'s press does not flip the tabs', async () => {
        withUser(huntUser());
        const interaction = makeInteraction({
            guildId: GUILD_ID, userId: USER_ID,
            components: [{ customId: 'gptab_trophies_interaction-1', user: 'someone-else' }],
        });
        await executeProfile(interaction);
        await new Promise(r => setTimeout(r, 5));
        expect(cards.createGrindCollectionCard).not.toHaveBeenCalled();
    });

    test('a failed render still sends the embed', async () => {
        cards.createGrindProfileCard.mockRejectedValueOnce(new Error('no canvas'));
        withUser(huntUser());
        const interaction = makeInteraction({ guildId: GUILD_ID, userId: USER_ID });
        await executeProfile(interaction);
        const [first] = interaction.replies;
        expect(first.files).toEqual([]);
        expect(first.embeds[0].data.image).toBeUndefined();
        expect(flatten(first)).toContain('239 hunts');
    });

    test('another player\'s profile leaves Today out', async () => {
        withUser(huntUser());
        const other = { id: 'other', username: 'munge', displayAvatarURL: () => 'x' };
        const interaction = makeInteraction({ guildId: GUILD_ID, userId: USER_ID, options: { user: other } });
        await executeProfile(interaction);
        expect(fieldNames(interaction.replies[0])).not.toContain('📅 Today');
    });
});

describe('reading the trophy strings', () => {
    test('keeps the best grade per species and sets ribbons apart', () => {
        const cabinet = readTrophies(huntUser().hunt.trophies);
        expect(cabinet.bySpecies.get('jackrabbit').grade.id).toBe('mythic');
        expect(cabinet.bySpecies.size).toBe(3);
        expect(cabinet.total).toBe(5);
        expect(cabinet.gradeCounts).toEqual({ mythic: 1, pristine: 2, good: 2 });
        expect(cabinet.other).toEqual(['🥉 Bronze Prestige']);
    });
});

describe('/fish profile', () => {
    const fishUser = (fishing = {}) => ({
        fishing: {
            level: 12, xp: 2_000, stamina: 4, totalCasts: 100, successfulCasts: 80,
            totalEarned: 9_000, bestPayout: 900, legendaryCatches: 1, eventCatches: 0,
            activeLocation: 'pond', unlockedLocations: ['pond', 'river'],
            dailyCasts: 3, dailyCoins: 400, dailyWindowStart: new Date(),
            catalog: { minnow: { count: 40, heaviest: 0.4 }, marlin: { count: 1, heaviest: 412.3 } },
            ...fishing,
        },
    });

    test('shares the overview shape and logs the catalog', async () => {
        withUser(fishUser());
        const interaction = makeInteraction({ guildId: GUILD_ID, userId: USER_ID });
        await fishProfile(interaction);
        const [first] = interaction.replies;
        expect(fieldNames(first)).toEqual(['📊 Record', '📖 Catalog', '📅 Today']);
        expect(flatten(first)).toContain(`2/${Object.keys(fishData.FISH).length} species`);
        expect(flatten(first)).not.toContain('Balance');
        expect(first.components[0].components.map(b => b.data.label)).toEqual(['Overview', 'Catalog', 'Progress']);

        const { shelf } = cards.createGrindProfileCard.mock.calls[0][0];
        expect(shelf[0].iconId).toBe('fishcatch:marlin'); // rarest first
        expect(shelf[1]).toMatchObject({ iconId: 'fishcatch:minnow', badge: '40' });
    });

    test('readCatalog ignores ids that are no longer fish', () => {
        const cat = readCatalog({ catalog: { minnow: { count: 2 }, not_a_fish: { count: 9 } } });
        expect(cat.caught.map(f => f.id)).toEqual(['minnow']);
        expect(cat.total).toBe(2);
    });

    test('a landed fish joins the log; an escaped one does not', () => {
        const fish = fishData.FISH.bass ?? Object.values(fishData.FISH)[0];
        const user = { balance: 0, markModified() {}, fishing: { catalog: {}, materials: {}, xp: 0, level: 1 } };
        const snap = snapshotCastRewards(user);
        recordCatalogCatch(user.fishing, fish, 3.5);
        recordCatalogCatch(user.fishing, fish, 2);
        expect(user.fishing.catalog[fish.id]).toEqual({ count: 2, heaviest: 3.5 });
        revertEscapedCast(user, snap, {});
        expect(user.fishing.catalog).toEqual({});
    });
});

describe('/explore profile', () => {
    test('shares the overview shape and shelves the relics', async () => {
        const relic = RELIC_LIST[0];
        withUser({
            inventory: [{ itemId: relic.itemId, quantity: 1 }],
            exploration: {
                level: 8, xp: 1_500, stamina: 6, totalExpeditions: 50, totalEarned: 12_000, bestHaul: 800,
                secretsFound: 2, relicsRecovered: 1, trapsSprung: 3,
                activeRegion: 'whispering_forest', unlockedRegions: ['whispering_forest'],
                dailyExpeditions: 5, dailyCoins: 1_000, dailyWindowStart: new Date(),
            },
        });
        const interaction = makeInteraction({ guildId: GUILD_ID, userId: USER_ID });
        await exploreProfile(interaction);
        const [first] = interaction.replies;
        expect(fieldNames(first)).toEqual(['📊 Field Record', '🏺 Relic Case', '📅 Today']);
        expect(flatten(first)).toContain(`1/${RELIC_LIST.length} relics`);
        expect(flatten(first)).not.toContain('Balance');
        expect(first.components[0].components.map(b => b.data.label)).toEqual(['Overview', 'Relics', 'Progress']);
        expect(cards.createGrindProfileCard.mock.calls[0][0].shelf).toHaveLength(1);
    });
});

describe('the shared pieces', () => {
    test('levelProgress reads the rung, and is null-spanned at the top', () => {
        const levels = [{ xpRequired: 0 }, { xpRequired: 100 }, { xpRequired: 300 }];
        expect(levelProgress(levels, 2, 200)).toEqual({ into: 100, span: 200, toNext: 100, frac: 0.5 });
        expect(levelProgress(levels, 3, 999)).toMatchObject({ span: null, toNext: null, frac: 1 });
    });

    test('Today measures the soft cap and names the next payout band', () => {
        const f = buildTodayField({
            coins: 3_313, actions: 10, noun: 'hunts', limits: huntData.LIMITS,
            resetMs: 1000, currency: '💰', formatMs: () => '6h 53m',
        });
        expect(f.value).toContain(`💰${huntData.LIMITS.DAILY_SOFT_CAP.toLocaleString()} at full rate`);
        expect(f.value).toContain(`×0.85 from ${huntData.LIMITS.DIM_RETURNS_THRESHOLD_1} hunts`);
        expect(f.value).toContain('Resets in 6h 53m');
    });

    test('Today says so past each cap, and skips bands an activity has none of', () => {
        const hard = buildTodayField({
            coins: huntData.LIMITS.DAILY_HARD_CAP, actions: 500, noun: 'hunts', limits: huntData.LIMITS,
            resetMs: null, currency: '💰', formatMs: String,
        });
        expect(hard.value).toContain('daily cap reached');
        expect(hard.value).toContain('×0.55');
        const explore = buildTodayField({
            coins: 0, actions: 2, noun: 'expeditions', limits: { DAILY_SOFT_CAP: 10, DAILY_HARD_CAP: 20 },
            resetMs: 5, currency: '💰', formatMs: String,
        });
        expect(explore.value).not.toContain('payout ×');
    });

    test('joinWithin stays inside a field and counts what it dropped', () => {
        const items = Array.from({ length: 200 }, (_, i) => `item-${i}`);
        const out = joinWithin(items, ' · ', 1024);
        expect(out.length).toBeLessThanOrEqual(1024);
        expect(out).toMatch(/\+\d+ more$/);
        expect(joinWithin(['a', 'b'], ', ', 1024)).toBe('a, b');
    });
});
