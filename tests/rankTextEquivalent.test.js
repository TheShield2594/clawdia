'use strict';

/**
 * #672. `/rank` reported level, XP and server position by drawing them onto a
 * PNG. In the common branch — no active boosters, no prestige or ranked
 * history, no XP-excluded channels — it replied with that PNG and no embed at
 * all, so the three numbers the command exists to report were nowhere a screen
 * reader, a failed image fetch, or a channel search could reach them.
 *
 * The card is now an illustration of an embed that carries the numbers, and it
 * ships with alt text of its own. These drive the command through
 * tests/helpers/fakeInteraction.js and read what a player is actually sent.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', { level: 0, xp: 0, activeEffects: [] });
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async user => user) }));
// The canvas render is the one part of this that needs fonts and a GPU-free
// encode; what it draws is cardGenerator's business, not this file's.
jest.mock('../src/utils/cardGenerator', () => ({
    createRankCard: jest.fn(async () => Buffer.from('rank-card-png')),
}));

const rank = require('../src/commands/leveling/rank');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

const seedUser = (fields = {}) => mockUsers.seed({
    userId: USER_ID, guildId: GUILD_ID, level: 7, xp: 250,
    activeEffects: [], streak: { current: 3 },
    ...fields,
});

/** Runs the command and returns the single payload it replied with. */
async function run(interaction = makeInteraction({ guildId: GUILD_ID, userId: USER_ID })) {
    await rank.execute(interaction);
    expect(interaction.replies).toHaveLength(1);
    return interaction.replies[0];
}

const fieldsOf = payload => payload.embeds[0].data.fields.map(f => [f.name, f.value]);
const flatten = payload => JSON.stringify(payload.embeds[0].data);

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGuilds.seed({ guildId: GUILD_ID });
});

afterEach(() => jest.restoreAllMocks());

describe('the numbers exist in text', () => {
    it('sends an embed alongside the card even with nothing else to report', async () => {
        seedUser();
        const payload = await run();

        expect(payload.files).toHaveLength(1);
        expect(payload.embeds).toHaveLength(1);
    });

    it('carries level, XP and rank position as fields', async () => {
        seedUser({ level: 7, xp: 250 });
        const payload = await run();

        // requiredXp is level * 100 + 100, and the only seeded user is rank 1.
        expect(fieldsOf(payload)).toEqual([
            ['📊 Level', '7'],
            ['⭐ XP', '250 / 800'],
            ['🏆 Server rank', '#1'],
        ]);
    });

    it('names the player and their position in the embed author line', async () => {
        seedUser();
        const payload = await run();
        expect(payload.embeds[0].data.author.name).toBe('player — rank #1');
    });

    it('counts the players ahead, so the reported rank is the real one', async () => {
        seedUser({ level: 7, xp: 250 });
        mockUsers.seed({ userId: 'ahead-1', guildId: GUILD_ID, level: 9, xp: 0, activeEffects: [] });
        mockUsers.seed({ userId: 'ahead-2', guildId: GUILD_ID, level: 7, xp: 900, activeEffects: [] });
        mockUsers.seed({ userId: 'behind', guildId: GUILD_ID, level: 2, xp: 0, activeEffects: [] });

        const payload = await run();
        expect(fieldsOf(payload)).toContainEqual(['🏆 Server rank', '#3']);
    });
});

describe('the card describes itself', () => {
    it('gives the attachment alt text with the same numbers on it', async () => {
        seedUser({ level: 7, xp: 250 });
        const { description } = (await run()).files[0];

        expect(description).toContain('player');
        expect(description).toContain('level 7');
        expect(description).toContain('250 of 800 XP');
        expect(description).toContain('#1');
    });

    it('stays inside Discord\'s 1024-character cap on alt text', async () => {
        seedUser({ level: 999, xp: 99_999 });
        expect((await run()).files[0].description.length).toBeLessThanOrEqual(1024);
    });
});

describe('what used to need a branch of its own', () => {
    it('still reports active boosters, now on the one embed', async () => {
        seedUser({
            activeEffects: [{ type: 'xp_booster_2x', expiresAt: new Date(Date.now() + 3_600_000), charges: -1 }],
        });
        const payload = await run();

        expect(flatten(payload)).toContain('Active Boosters');
        // And the numbers are still there, which is the regression the old
        // four-branch reply invited: each branch built a different embed.
        expect(fieldsOf(payload)).toContainEqual(['📊 Level', '7']);
    });

    it('still reports prestige, and still keeps the numbers', async () => {
        seedUser({ accountPrestige: { rank: 2 } });
        const payload = await run();

        expect(flatten(payload)).toContain('Identity');
        expect(fieldsOf(payload)).toContainEqual(['📊 Level', '7']);
    });

    it('still footnotes XP exclusions', async () => {
        seedUser();
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD_ID, leveling: { noXpChannelIds: ['c1'], noXpRoleIds: [] } });

        const payload = await run();
        expect(payload.embeds[0].data.footer.text).toMatch(/xpinfo/);
        expect(fieldsOf(payload)).toContainEqual(['📊 Level', '7']);
    });

    it('says so in text when the player has no XP yet', async () => {
        const interaction = makeInteraction({ guildId: GUILD_ID, userId: USER_ID });
        await rank.execute(interaction);
        expect(interaction.replies[0].content).toMatch(/hasn't earned any XP/);
    });
});
