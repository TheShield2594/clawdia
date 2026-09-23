'use strict';

/**
 * #873, pass 20 — the gathering commands' remaining surface: the profiles,
 * inventories and prestige flows of /hunt, /fish and /mine.
 *
 * Two findings, both in prestige:
 *
 *   - `/hunt prestige` and `/fish prestige` reset level and XP on a re-read copy
 *     of the profile and `save()`d it, writing the whole grind profile back.
 *     The confirm runs in a button collector after `execute` has released the
 *     economy lock, so a run in progress could save over the prestige, or the
 *     prestige over the run. `/mine prestige` already ascended with one
 *     conditional update; the other two now do the same (utils/grindPrestige).
 *   - Grand Master (Diamond in all three tracks) was checked from /hunt and
 *     /fish only, off the document in hand, with an unguarded `$set`. A player
 *     who finished on /mine could never earn it, and two prestiges finishing
 *     together could both announce it (services/grandPrestigeService).
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', { balance: 0 });
const mockProfiles = fakeCollection('GrindProfile', {}, { unique: ['userId', 'guildId', 'system'] });
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/GrindProfile', () => mockProfiles.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

const { ascendGrind } = require('../src/utils/grindPrestige');
const { checkGrandPrestige, GRAND_PRESTIGE_DIAMOND } = require('../src/services/grandPrestigeService');

const GUILD = 'guild-1';
const USER = 'user-1';
const WHO = { userId: USER, guildId: GUILD };

async function profileData(system) {
    const doc = await mockProfiles.model.findOne({ ...WHO, system }).lean();
    return doc?.data;
}

function seedProfile(system, data) {
    mockProfiles.seed({ ...WHO, system, data });
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockProfiles.reset();
    mockGuilds.reset();
});

afterEach(() => jest.restoreAllMocks());

// ── ascendGrind ──────────────────────────────────────────────────────────────

describe('ascendGrind', () => {
    test('resets level and XP, raises the rank and adds the trophy, touching nothing else', async () => {
        seedProfile('hunt', { level: 50, xp: 9000, prestige: 1, trophies: ['old'], materials: { hide: 12 } });

        const after = await ascendGrind({ ...WHO, system: 'hunt', minLevel: 50, fromRank: 1, trophy: 'P2 Trophy' });

        expect(after).not.toBeNull();
        expect(await profileData('hunt')).toEqual({
            level: 1, xp: 0, prestige: 2, trophies: ['old', 'P2 Trophy'], materials: { hide: 12 },
        });
    });

    test('keeps what a run wrote after the confirm read the profile', async () => {
        // The run added materials between the prestige re-read and its write;
        // a save() of the re-read copy put them back to what it had read.
        seedProfile('fishing', { level: 50, xp: 100, prestige: 0, materials: { scale: 3 } });
        // The run lands after the confirm's read.
        await mockProfiles.model.updateOne({ ...WHO, system: 'fishing' }, { $set: { 'data.materials': { scale: 9 } } });

        await ascendGrind({ ...WHO, system: 'fishing', minLevel: 50, fromRank: 0, trophy: 'P1' });

        expect(await profileData('fishing')).toMatchObject({ prestige: 1, level: 1, materials: { scale: 9 } });
    });

    test('two confirmations open at once ascend once', async () => {
        seedProfile('hunt', { level: 50, xp: 0, prestige: 0 });

        const [a, b] = await Promise.all([
            ascendGrind({ ...WHO, system: 'hunt', minLevel: 50, fromRank: 0 }),
            ascendGrind({ ...WHO, system: 'hunt', minLevel: 50, fromRank: 0 }),
        ]);

        expect([a, b].filter(Boolean)).toHaveLength(1);
        expect(await profileData('hunt')).toMatchObject({ prestige: 1, level: 1 });
    });

    test('refuses a profile below the level, and a first ascension matches a profile with no rank field', async () => {
        seedProfile('hunt', { level: 49, xp: 0 });
        expect(await ascendGrind({ ...WHO, system: 'hunt', minLevel: 50, fromRank: 0 })).toBeNull();

        mockProfiles.reset();
        seedProfile('hunt', { level: 50, xp: 0 });
        expect(await ascendGrind({ ...WHO, system: 'hunt', minLevel: 50, fromRank: 0 })).not.toBeNull();
    });
});

// ── checkGrandPrestige ───────────────────────────────────────────────────────

describe('checkGrandPrestige', () => {
    const send = jest.fn(async () => {});
    const guild = { channels: { cache: new Map([['announce-1', { isTextBased: () => true, send }]]) } };
    const client = { guilds: { fetch: jest.fn(async () => guild) } };

    function seedAll(ranks) {
        mockGuilds.seed({ guildId: GUILD, economy: { announcementChannelId: 'announce-1' } });
        mockUsers.seed({ ...WHO });
        for (const [system, prestige] of Object.entries(ranks)) seedProfile(system, { prestige });
    }

    test('awards it when /mine is the last track to reach Diamond', async () => {
        seedAll({ hunt: 5, fishing: 5, mining: 5 });

        expect(await checkGrandPrestige(client, USER, GUILD, guild)).toBe(true);
        expect(mockUsers.get(USER).grandPrestige).toMatchObject({ level: 1 });
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('does not award it one track short', async () => {
        seedAll({ hunt: 5, fishing: 5, mining: 4 });

        expect(await checkGrandPrestige(client, USER, GUILD, guild)).toBe(false);
        expect(mockUsers.get(USER).grandPrestige).toBeUndefined();
    });

    test('two prestiges finishing together announce it once', async () => {
        seedAll({ hunt: 5, fishing: 5, mining: 5 });

        const results = await Promise.all([
            checkGrandPrestige(client, USER, GUILD, guild),
            checkGrandPrestige(client, USER, GUILD, guild),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('is Diamond at rank 5, and never throws', async () => {
        expect(GRAND_PRESTIGE_DIAMOND).toBe(5);
        mockProfiles.model.find.mockImplementationOnce(() => { throw new Error('down'); });
        await expect(checkGrandPrestige(client, USER, GUILD, guild)).resolves.toBe(false);
    });
});

// ── The call sites ───────────────────────────────────────────────────────────

describe('the prestige commands', () => {
    const fs = require('fs');
    const read = rel => fs.readFileSync(require.resolve(`../src/commands/economy/${rel}`), 'utf8');

    test.each(['hunt/profile', 'fish/profile'])('%s ascends with the conditional update, not a save()', (rel) => {
        const src = read(rel);
        const handler = src.slice(src.indexOf("collector.on('collect'"));
        expect(handler).toMatch(/ascendGrind\(/);
        expect(handler.slice(0, handler.indexOf('resultEmbed'))).not.toMatch(/\.save\(\)/);
        // The local copies of the grand-prestige check are gone.
        expect(src).not.toMatch(/async function checkGrandPrestige/);
    });

    test.each(['hunt/profile', 'fish/profile', 'mine/profile'])('%s checks Grand Master through the shared service', (rel) => {
        expect(read(rel)).toMatch(/require\('..\/..\/..\/services\/grandPrestigeService'\)/);
        expect(read(rel)).toMatch(/checkGrandPrestige\(/);
    });
});

// ── /hunt prestige end to end ────────────────────────────────────────────────

describe('/hunt prestige', () => {
    test("ascends on confirm and keeps a run's materials written in between", async () => {
        mockGuilds.seed({ guildId: GUILD, economy: { enabled: true } });
        mockUsers.seed({ ...WHO });
        seedProfile('hunt', { level: 50, xp: 5000, prestige: 0, materials: { hide: 1 } });
        // The other tracks exist, so attaching the profiles constructs none.
        for (const system of ['fishing', 'mining', 'exploration']) seedProfile(system, {});
        const { executePrestige } = require('../src/commands/economy/hunt/profile');

        const interaction = makeInteraction({ components: [{ customId: 'prestige_confirm' }] });
        // A hunt lands its materials while the confirmation is open.
        await mockProfiles.model.updateOne({ ...WHO, system: 'hunt' }, { $set: { 'data.materials': { hide: 7 } } });
        await executePrestige(interaction);
        await new Promise(r => setTimeout(r, 20));

        expect(await profileData('hunt')).toMatchObject({ prestige: 1, level: 1, xp: 0, materials: { hide: 7 } });
        expect(mockProfiles.writes.some(w => w.op === 'save')).toBe(false);
        expect(JSON.stringify(interaction.replies)).toContain('Prestige 1 Achieved');
    });
});
