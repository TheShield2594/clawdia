'use strict';

/**
 * #873, pass 17 — `/explore`'s remaining views, and the one of them that takes
 * coins.
 *
 * `/explore travel` charges a toll to open a route, then saves the unlock. When
 * that save fails the toll is handed back. Pass 6 found the refund honest — it
 * read `matchedCount` and only promised a refund that landed — but it was a bare
 * `$inc` with no key and no owed record, so a refund that failed told the player
 * "tell an admin — it is recoverable" over nothing an admin or `payouts:replay`
 * could act on. That is the pass-9 `/forge` finding; this holds the fix.
 *
 * The store evaluates the payout-key guard for real, so "exactly once" and
 * "recorded as owed" are the helper's actual answers, not a mock's.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/itemImageHelper', () => ({ attachItemThumbnail: jest.fn(async () => []) }));

// The exploration profile lives on a GrindProfile document; the handler reads it
// off `user.exploration`. `mockSave` stands in for the wrapped save that writes
// the User and then the profile — the thing whose failure this suite is about.
let mockSave;
jest.mock('../src/utils/grindProfile', () => ({
    attachGrind: jest.fn(async user => {
        if (!user) return user;
        user.exploration = mockExploration;
        user.save = (...args) => mockSave(...args);
        return user;
    }),
}));
let mockExploration;

const { handleTravel } = require('../src/commands/economy/explore/travel');
const { REGION_LIST } = require('../src/data/exploreData');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { logTransaction } = require('../src/utils/logTransaction');

const GUILD = 'guild-1';
const USER = 'user-1';
// A core region with a toll, so the unlock path runs.
const REGION = REGION_LIST.find(r => !r.seasonalEventId && r.unlockCost > 0);
const stored = () => mockUsers.get(USER);

function seed({ balance = REGION.unlockCost + 1000 } = {}) {
    mockGuilds.seed({ guildId: GUILD, economy: { currency: '💰', enabled: true } });
    mockUsers.seed({ userId: USER, guildId: GUILD, balance });
    mockExploration = { level: 99, unlockedRegions: [], regions: [], activeRegion: null };
}

async function travel() {
    const interaction = makeInteraction({ options: { region: REGION.id } });
    await handleTravel(interaction);
    return interaction;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockGuilds.reset();
    recordOwedPayout.mockResolvedValue(true);
    mockSave = jest.fn(async () => {});
});

afterEach(() => jest.restoreAllMocks());

describe('/explore travel', () => {
    test('opens the route, charging the toll once', async () => {
        seed();

        const interaction = await travel();

        expect(stored().balance).toBe(1000);
        expect(mockExploration.unlockedRegions).toContain(REGION.id);
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'explore_unlock', amount: -REGION.unlockCost }));
        expect(JSON.stringify(interaction.replies)).toContain(`Now Exploring: ${REGION.name}`);
    });

    test('a save that fails hands the toll back under its key', async () => {
        seed();
        mockSave = jest.fn(async () => { throw new Error('VersionError'); });

        const interaction = await travel();

        expect(stored().balance).toBe(REGION.unlockCost + 1000);
        expect(stored().paidPayouts.some(p => p.key === `explore:unlock:${interaction.id}:refund`)).toBe(true);
        expect(repliedText(interaction)).toContain('your toll was refunded');
        expect(logTransaction).not.toHaveBeenCalled();
    });

    test('a refund that will not land is recorded as owed, and says so', async () => {
        seed();
        // The document is gone by the time the refund runs.
        mockSave = jest.fn(async () => { mockUsers.reset(); throw new Error('write failed'); });

        const interaction = await travel();

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                kind: 'coins', amount: REGION.unlockCost, payoutKey: `explore:unlock:${interaction.id}:refund`,
            }),
        }));
        expect(repliedText(interaction)).toContain('recorded as owed');
    });

    test('a refund that can be neither returned nor recorded says to contact an admin', async () => {
        seed();
        recordOwedPayout.mockResolvedValue(false);
        mockSave = jest.fn(async () => { mockUsers.reset(); throw new Error('write failed'); });

        const interaction = await travel();

        expect(repliedText(interaction)).toContain('could not be returned or recorded');
        expect(repliedText(interaction)).not.toContain('refunded');
    });

    test('a failed save on a route already open refunds nothing, because nothing was charged', async () => {
        seed();
        mockExploration.unlockedRegions = [REGION.id];
        mockSave = jest.fn(async () => { throw new Error('write failed'); });

        const interaction = await travel();

        expect(stored().balance).toBe(REGION.unlockCost + 1000);
        expect(stored().paidPayouts).toEqual([]);
        expect(repliedText(interaction)).toContain('Something went wrong opening the route. Please try again.');
    });
});
