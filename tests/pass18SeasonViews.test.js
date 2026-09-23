'use strict';

/**
 * #873, pass 18 — the season pass's non-reward surface: `/season view`,
 * `missions`, `leaderboard`, `me`, `history`, and the admin `start` / `end`.
 *
 * Pass 7 audited the reward payouts. What this pass found is that the "views"
 * were not all reads:
 *
 *   - `view` and `missions` dealt a stale mission hand in memory and `save()`d
 *     it, with none of the guard `advanceMissions` puts on the same deal — so at
 *     the day boundary a view could replace a hand `/crime` had just dealt, and
 *     the progress on it. `view` also reset a stale season sub-document and
 *     saved that, a whole-object `$set`.
 *   - `/season start` checked for a running season with a read, then wrote with
 *     an unguarded `$set`.
 *   - `/season end` carried its own copy of the ending the scheduler's resolver
 *     already does, without the resolver's atomic claim.
 *   - a season name had no length cap and is echoed into titles and field names
 *     Discord rejects past 256 characters.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', { balance: 0, seasonCoins: 0 });
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });
const mockRecords = fakeCollection('SeasonRecord', {}, { unique: ['guildId', 'seasonId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/SeasonRecord', () => mockRecords.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/services/economySeasonService', () => ({ resolveOneSeason: jest.fn() }));

const season = require('../src/commands/economy/season');
const { resolveOneSeason } = require('../src/services/economySeasonService');
const { missionDayStart } = require('../src/services/seasonMissionService');
const { seasonLabel, SEASON_NAME_MAX } = require('../src/utils/seasonLabel');

const GUILD = 'guild-1';
const USER = 'user-1';
const SEASON_ID = 'pass-7';
const stored = () => mockUsers.get(USER);

const hand = (tag) => [0, 1, 2].map(i => ({
    id: `${tag}-${i}`, event: 'crime', description: `${tag} mission ${i}`,
    target: 3, progress: 0, completed: false, claimed: false, seasonXp: 10, coinReward: 50,
}));

function seedPass(user = {}) {
    mockGuilds.seed({
        guildId: GUILD,
        economy: { currency: '💰' },
        season: { enabled: true, seasonId: SEASON_ID, name: 'Pass Seven' },
    });
    mockUsers.seed({ userId: USER, guildId: GUILD, ...user });
}

async function run(subcommand, { options = {}, admin = false } = {}) {
    const interaction = makeInteraction({ subcommand, options });
    if (admin) interaction.member = { ...interaction.member, permissions: { has: () => true } };
    await season.execute(interaction);
    return interaction;
}

const shown = interaction => JSON.stringify(interaction.replies);

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockGuilds.reset();
    mockRecords.reset();
});

afterEach(() => jest.restoreAllMocks());

// ── The views write nothing of their own ─────────────────────────────────────

describe.each(['view', 'missions'])('/season %s', (sub) => {
    test("with today's hand already dealt, writes nothing at all", async () => {
        seedPass({ seasonMissions: hand('today'), seasonMissionsDate: missionDayStart() });

        await run(sub);

        expect(mockUsers.writes.filter(w => w.doc === USER && w.op !== 'findOneAndUpdate')).toEqual([]);
        expect(mockUsers.writes.some(w => w.op === 'save')).toBe(false);
    });

    test('deals a stale hand through the guarded write, not a save()', async () => {
        seedPass({ seasonMissions: hand('yesterday'), seasonMissionsDate: new Date(missionDayStart().getTime() - 86_400_000) });

        const interaction = await run(sub);

        const deal = mockUsers.writes.find(w => w.update?.$set?.seasonMissions);
        expect(deal.query.$or).toEqual(expect.arrayContaining([{ seasonMissionsDate: { $lt: missionDayStart() } }]));
        expect(mockUsers.writes.some(w => w.op === 'save')).toBe(false);
        expect(shown(interaction)).not.toContain('yesterday mission');
    });

    test('keeps a hand another command dealt after the view read the old one', async () => {
        // The view loads yesterday's hand; before it deals, /crime's guarded
        // rollover lands today's and advances it. The old in-memory deal + save
        // replaced that hand and its progress.
        seedPass({ seasonMissions: hand('yesterday'), seasonMissionsDate: new Date(missionDayStart().getTime() - 86_400_000) });
        const realFind = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate.mockImplementationOnce(async (...args) => {
            const loaded = await realFind(...args);
            const crimeHand = hand('crime-dealt');
            crimeHand[0].progress = 2;
            Object.assign(stored(), { seasonMissions: crimeHand, seasonMissionsDate: missionDayStart() });
            return loaded;
        });

        const interaction = await run(sub);

        expect(stored().seasonMissions[0]).toMatchObject({ id: 'crime-dealt-0', progress: 2 });
        expect(shown(interaction)).toContain('crime-dealt mission 0');
        mockUsers.model.findOneAndUpdate.mockImplementation(realFind);
    });
});

test('/season view renders an earlier season\'s progress as a fresh pass, and writes none of it', async () => {
    seedPass({
        seasonMissions: hand('today'), seasonMissionsDate: missionDayStart(),
        season: { seasonId: 'old-pass', xp: 4200, tier: 42, premium: true, claimedTiers: [1, 2], claimedPremiumTiers: [] },
    });

    const interaction = await run('view');

    expect(shown(interaction)).toContain('Tier 0 /');
    expect(shown(interaction)).toContain('Premium locked');
    // The stored sub-document is left for the reward paths to normalise.
    expect(stored().season).toMatchObject({ seasonId: 'old-pass', xp: 4200 });
});

// ── /season start ────────────────────────────────────────────────────────────

describe('/season start', () => {
    test('starts a season when none is running', async () => {
        mockGuilds.seed({ guildId: GUILD, currentSeason: { id: null } });

        const interaction = await run('start', { admin: true, options: { name: 'Spring' } });

        expect(mockGuilds.get(GUILD).currentSeason).toMatchObject({ name: 'Spring' });
        expect(repliedText(interaction)).toContain('Spring');
    });

    test('a season started after the check is not overwritten', async () => {
        mockGuilds.seed({ guildId: GUILD, currentSeason: { id: 'first', name: 'First' } });
        // The pre-check reads before the other admin's start lands.
        const realFindOne = mockGuilds.model.findOne.getMockImplementation();
        mockGuilds.model.findOne.mockImplementationOnce(() => ({ lean: async () => ({ guildId: GUILD, currentSeason: { id: null } }) }));

        const interaction = await run('start', { admin: true, options: { name: 'Second' } });

        expect(mockGuilds.get(GUILD).currentSeason).toMatchObject({ id: 'first', name: 'First' });
        expect(repliedText(interaction)).toContain('already active');
        mockGuilds.model.findOne.mockImplementation(realFindOne);
    });

    test('caps the season name at input', () => {
        const start = season.data.toJSON().options.find(o => o.name === 'start');
        expect(start.options.find(o => o.name === 'name').max_length).toBe(SEASON_NAME_MAX);
    });
});

// ── /season end ──────────────────────────────────────────────────────────────

describe('/season end', () => {
    const current = { id: 'econ-1', name: 'Econ One', startedAt: new Date(), endsAt: new Date() };

    test('ends the season through the shared resolver, and writes nothing itself', async () => {
        mockGuilds.seed({ guildId: GUILD, economy: { currency: '💰' }, currentSeason: current });
        resolveOneSeason.mockResolvedValue({ season: current, topUsers: [{ userId: 'u9', seasonCoins: 900 }] });

        const interaction = await run('end', { admin: true });

        expect(resolveOneSeason).toHaveBeenCalledWith(interaction.client, expect.objectContaining({ guildId: GUILD, currentSeason: expect.objectContaining({ id: 'econ-1' }) }));
        expect(mockGuilds.writes).toEqual([]);
        expect(mockUsers.writes).toEqual([]);
        expect(mockRecords.writes).toEqual([]);
        expect(shown(interaction)).toContain('Season Ended: Econ One');
        expect(shown(interaction)).toContain('<@u9>');
    });

    test('a season the sweep claimed first is reported, not ended twice', async () => {
        mockGuilds.seed({ guildId: GUILD, currentSeason: current });
        resolveOneSeason.mockResolvedValue(false);

        const interaction = await run('end', { admin: true });

        expect(shown(interaction)).toContain('just been ended already');
    });

    test('no running season is reported without calling the resolver', async () => {
        mockGuilds.seed({ guildId: GUILD, currentSeason: { id: null } });

        const interaction = await run('end', { admin: true });

        expect(resolveOneSeason).not.toHaveBeenCalled();
        expect(shown(interaction)).toContain('No active economy season');
    });
});

// ── Season names in titles and fields ────────────────────────────────────────

describe('season names', () => {
    const long = 'N'.repeat(400);

    test('seasonLabel cuts an over-long name and falls back to the id', () => {
        expect(seasonLabel({ name: long }).length).toBe(SEASON_NAME_MAX);
        expect(seasonLabel({ id: 'econ-7' })).toBe('econ-7');
    });

    test('/season history renders a stored over-long name and a record with no top10', async () => {
        mockGuilds.seed({ guildId: GUILD });
        mockRecords.seed({ guildId: GUILD, seasonId: 's1', seasonName: long, endedAt: new Date(), top10: [{ userId: 'u1', coins: 5 }] });
        mockRecords.seed({ guildId: GUILD, seasonId: 's2', seasonName: 'Plain', endedAt: new Date(Date.now() - 1000) });

        const interaction = await run('history');

        const [embed] = interaction.replies.at(-1).embeds;
        const fields = embed.toJSON().fields;
        expect(fields.every(f => f.name.length <= 256)).toBe(true);
        expect(fields.find(f => f.name.startsWith('Plain')).value).toBe('No data');
    });
});
