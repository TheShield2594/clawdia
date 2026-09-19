'use strict';

/**
 * #873, pass 7 — the progression and group/PvP payouts are keyed.
 *
 * Season-pass claims, a syndicate's founding refund and a fishing tournament's
 * prize were the reward payouts the money-moving passes had not reached. Each
 * credited or granted without a payout key, so the shared helpers' three
 * failures lived on every one of them: a retry or replay could pay twice, a
 * write against a pruned document read as success, and a payout that failed was
 * lost rather than recorded where `payouts:replay` could settle it — while the
 * embed announced the reward regardless. The season claims compounded it by
 * marking the tier or mission claimed in the save *before* the credit, so a
 * failure locked the reward out behind a permanent flag with nothing to replay.
 *
 * The behavioural half drives the real command handlers against a store that
 * evaluates the payout-key guard for real, because a mock that waved it through
 * would report the retry as safe when the key is the only reason it is. The
 * static half holds the call sites — the mission credit and the tournament
 * prize — to the keyed path, and pins the war hot path no longer resolving an
 * expired war inline (the double-grant this pass removed).
 */

const fs   = require('fs');
const path = require('path');
const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction } = require('./helpers/fakeInteraction');

const mockUsers  = fakeCollection('User', { balance: 0, bank: 0, inventory: [], paidPayouts: [], season: {}, seasonMissions: [] });
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/Syndicate', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/services/questService', () => ({ awardSeasonXp: jest.fn(async () => 0) }));

const season = require('../src/commands/economy/season');
const Syndicate = require('../src/models/Syndicate');
const { executeCreate } = require('../src/commands/economy/syndicate').__test__;
const { grantWarPoints } = require('../src/commands/economy/war');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { TIER_TABLE } = require('../src/data/seasonPass');

const GUILD = 'guild-1';
const USER  = 'user-1';

const seedSeasonGuild = () => mockGuilds.seed({
    guildId: GUILD, economy: { currency: '💰' },
    season: { enabled: true, seasonId: 's1', premiumCost: 100_000 },
});

const seedPlayer = (fields = {}) => mockUsers.seed({
    userId: USER, guildId: GUILD, balance: 0, inventory: [], paidPayouts: [],
    season: { seasonId: 's1', xp: 5000, tier: 0, claimedTiers: [], claimedPremiumTiers: [], premium: false, weekXp: 0, weekStart: new Date() },
    ...fields,
});

const keys = () => (mockUsers.get(USER)?.paidPayouts ?? []).map(p => p.key);

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockGuilds.reset();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('/season claim keys its coins and its item', () => {
    test('a tier of coins is credited under its own key, recorded on the document', async () => {
        seedSeasonGuild();
        seedPlayer({ balance: 100 });
        const coins = TIER_TABLE[0].free.coins; // tier 1 free

        await season.execute(makeInteraction({ subcommand: 'claim', options: { tier: 1, premium: false } }));

        expect(mockUsers.get(USER).balance).toBe(100 + coins);
        expect(keys()).toContain('season:s1:user-1:tier:1:free:coins');
        expect(mockUsers.get(USER).season.claimedTiers).toContain(1);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a tier reward item is granted under its own key, not a bare grant', async () => {
        seedSeasonGuild();
        seedPlayer();
        const { itemId } = TIER_TABLE[9].free; // tier 10 free — an item, no coins

        await season.execute(makeInteraction({ subcommand: 'claim', options: { tier: 10, premium: false } }));

        expect(mockUsers.get(USER).inventory).toEqual([{ itemId, quantity: 1 }]);
        expect(keys()).toContain('season:s1:user-1:tier:10:free:item');
    });

    test('a coin credit whose key is already recorded moves no coins', async () => {
        // The write committed and lost its response on an earlier attempt; the
        // guard makes the retry a no-op rather than a second 360 coins. The tier
        // is not yet in claimedTiers, so the claim still runs.
        seedSeasonGuild();
        seedPlayer({ balance: 500, paidPayouts: [{ key: 'season:s1:user-1:tier:1:free:coins', at: new Date() }] });

        await season.execute(makeInteraction({ subcommand: 'claim', options: { tier: 1, premium: false } }));

        expect(mockUsers.get(USER).balance).toBe(500); // unchanged — duplicate is success
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('/season claim-all keys the batch coins and each item', () => {
    test('the summed coins carry a batch key and each item its per-tier key', async () => {
        seedSeasonGuild();
        seedPlayer({ balance: 0, season: { seasonId: 's1', xp: 500, tier: 0, claimedTiers: [], claimedPremiumTiers: [], premium: false, weekXp: 0, weekStart: new Date() } });
        // xp 500 unlocks tiers 1–5; tiers 1–4 carry coins, tier 5 carries an item.
        const sumCoins = [1, 2, 3, 4, 5].reduce((s, n) => s + TIER_TABLE[n - 1].free.coins, 0);
        const tier5Item = TIER_TABLE[4].free.itemId;

        await season.execute(makeInteraction({ subcommand: 'claim-all', options: { premium: false } }));

        expect(mockUsers.get(USER).balance).toBe(sumCoins);
        expect(keys()).toContain('season:s1:user-1:claimall:free:1.2.3.4.5:coins');
        // The item rides the same per-tier key a single claim of tier 5 would use.
        expect(keys()).toContain('season:s1:user-1:tier:5:free:item');
        expect(mockUsers.get(USER).inventory).toEqual([{ itemId: tier5Item, quantity: 1 }]);
    });
});

describe('/season claim-mission credits under a per-mission key', () => {
    // Midnight UTC of the day the missions were dealt — the same value the key
    // is built from, and recent enough that `ensureMissions` does not re-deal.
    const today = new Date();
    const missionDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    test('the mission reward lands under seasonMissionCoinPayoutKey', async () => {
        seedSeasonGuild();
        seedPlayer({
            balance: 100,
            seasonMissionsDate: new Date(missionDay),
            seasonMissions: [{ event: 'hunt', description: 'Hunt 3 times', target: 3, progress: 3, completed: true, claimed: false, seasonXp: 50, coinReward: 250 }],
        });

        await season.execute(makeInteraction({ subcommand: 'claim-mission', options: { mission: 1 } }));

        // The credit reached the write under the mission's own key — a stronger
        // claim than the source containing the constructor, since an unkeyed
        // credit would leave `paidPayouts` empty here.
        expect(mockUsers.get(USER).balance).toBe(100 + 250);
        expect(keys()).toContain(`season:s1:user-1:mission:${missionDay}:0`);
        expect(mockUsers.get(USER).seasonMissions[0].claimed).toBe(true);
    });
});

describe('a syndicate founding refund goes through the keyed helper', () => {
    test('a create that throws refunds the founder under a keyed payout and clears the enrollment', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 50_000, paidPayouts: [], syndicateId: null });
        Syndicate.findOne.mockReturnValue({ lean: async () => null });
        Syndicate.create.mockRejectedValue(new Error('mongo down'));

        const interaction = makeInteraction({ subcommand: 'create', options: { name: 'TestSynd', tag: null, open: false } });

        await expect(executeCreate(interaction, { economy: { currency: '💰' } })).rejects.toThrow('mongo down');

        // The 50k charged by the debit is back, keyed so a replay cannot refund
        // it twice, and the founder is no longer stuck in a syndicate that was
        // never created.
        expect(mockUsers.get(USER).balance).toBe(50_000);
        expect(mockUsers.get(USER).syndicateId).toBeNull();
        expect(keys()).toContain('syndicate:interaction-1:refund');
    });
});

describe('the war hot path no longer resolves an expired war inline', () => {
    test('grantWarPoints on an expired war neither scores nor flips status', async () => {
        mockGuilds.seed({
            guildId: GUILD,
            activeWar: { status: 'active', myScore: 5, opponentScore: 1, opponentGuildId: 'g2', endsAt: new Date(Date.now() - 60_000) },
        });

        await grantWarPoints(GUILD, 'daily');

        // The buggy inline resolver flipped status and pushed a booster with an
        // unguarded write; the scheduler's audited resolver owns that now, so the
        // hot path makes no write at all against an expired war.
        expect(mockGuilds.model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('grantWarPoints on a live war still scores it', async () => {
        mockGuilds.seed({
            guildId: GUILD,
            activeWar: { status: 'active', myScore: 5, opponentScore: 1, opponentGuildId: null, endsAt: new Date(Date.now() + 3_600_000) },
        });

        await grantWarPoints(GUILD, 'daily');

        expect(mockGuilds.model.findOneAndUpdate).toHaveBeenCalled();
        expect(mockGuilds.get(GUILD).activeWar.myScore).toBe(6); // WAR_POINTS.daily === 1
    });
});

// ─── The call sites the behavioural half does not drive ──────────────────────

describe('the progression and group/PvP call sites key their payouts', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

    test('the tier-skip token prunes with a $pull rather than saving the whole document', () => {
        const src = read('commands/economy/season.js');
        expect(src).toMatch(/\$pull:\s*\{\s*inventory:\s*\{\s*quantity:\s*\{\s*\$lte:\s*0\s*\}\s*\}\s*\}/);
    });

    test('the tournament prize credits through creditCoinsOrOwe under a place key', () => {
        const src = read('services/tournamentService.js');
        expect(src).toMatch(/creditCoinsOrOwe/);
        expect(src).toMatch(/tournamentPrizePayoutKey\(tournament\._id, prize\.place\)/);
    });

    test('war.js no longer carries the inline resolver or its unguarded booster grant', () => {
        const src = read('commands/economy/war.js');
        expect(src).not.toMatch(/async function resolveExpiredWar\b/);
        expect(src).not.toMatch(/coin_booster_2x/); // the booster grant moved to the scheduler
        expect(src).not.toMatch(/User\.updateMany/);
    });
});
