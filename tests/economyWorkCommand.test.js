'use strict';

/**
 * #786. `/work` is 190 lines at 13.2% lines and 0% branches — the streak-based
 * cooldown reduction, the tier gate on which jobs a player is offered, the
 * performance roll and the special events had none of them ever run.
 *
 * The harness is tests/helpers/fakeInteraction.js and
 * tests/helpers/fakeCollection.js; the rolls are pinned with a fixed
 * Math.random and a one-job guild, so a payout is a number rather than a range.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, shiftsWorked: 0, inventory: [], activeEffects: [], pets: [] });
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async user => user) }));
jest.mock('../src/utils/inventoryGrant', () => ({
    grantInventoryItem: jest.fn(async () => true),
    inventoryAddExpr: jest.fn(() => ({})),
}));
jest.mock('../src/services/petService', () => ({ getTotalBonus: jest.fn(() => 0) }));
jest.mock('../src/services/synergyService', () => ({ getMerchantCoinBonus: jest.fn(() => 0) }));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn(async () => {}),
    onEconomyEarn: jest.fn(async () => ({ completed: [], nearComplete: [] })),
    notifyQuestComplete: jest.fn(async () => {}),
    notifyQuestNearComplete: jest.fn(async () => {}),
}));
jest.mock('../src/services/seasonMissionService', () => ({ recordMissionProgress: jest.fn() }));
jest.mock('../src/utils/balanceDelta', () => ({ saveWithBalanceDelta: jest.fn(async () => {}) }));

const work = require('../src/commands/economy/work');
const { logTransaction } = require('../src/utils/logTransaction');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const HOUR_MS = 3_600_000;

// One job with a fixed pay band, so basePay is 100 whatever the roll is.
const ONE_JOB = [{ name: 'Tester', emoji: '🧪', tier: 1, minPay: 100, maxPay: 100 }];

const seedUser = (fields = {}) => mockUsers.seed({
    userId: USER_ID, guildId: GUILD_ID, lastWork: null,
    streak: { current: 0 }, onboarding: { firstWorkDone: true },
    ...fields,
});

const seedGuild = (settings = {}) => mockGuilds.seed({
    guildId: GUILD_ID,
    jobs: ONE_JOB,
    economy: { currency: '💰' },
    ...settings,
});

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    jest.clearAllMocks();
    // 0.5 lands on the average performance tier (×1.00) and past every special
    // event threshold (the last is 0.14), so the shift pays exactly base.
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => { Math.random.mockRestore(); });

describe('the shift', () => {
    it('pays the job band and counts the shift', async () => {
        seedUser();
        seedGuild();

        await work.execute(makeInteraction());

        const stored = mockUsers.get(USER_ID);
        expect(stored.balance).toBe(100);
        expect(stored.shiftsWorked).toBe(1);
        expect(stored.lastWork).toBeInstanceOf(Date);
        expectNonNegativeBalance(stored, 'work shift');
    });

    it('pays with $inc and guards the write with the cooldown', async () => {
        seedUser({ balance: 900 });
        seedGuild();

        await work.execute(makeInteraction());

        const credit = mockUsers.writes.find(w => w.update?.$inc?.balance);
        expect(credit.update.$set).not.toHaveProperty('balance');
        expect(credit.update.$inc.shiftsWorked).toBe(1);
        expect(credit.query.$or).toEqual([
            { lastWork: null },
            { lastWork: { $lt: expect.any(Date) } },
        ]);
        expect(mockUsers.get(USER_ID).balance).toBe(1000);
    });

    it('logs the shift with the job and the resulting balance', async () => {
        seedUser();
        seedGuild();

        await work.execute(makeInteraction());

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'work', amount: 100, balance: 100,
        }));
    });

    it('falls back to the default jobs when the guild has configured none', async () => {
        seedUser();
        seedGuild({ jobs: [] });

        await work.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBeGreaterThan(0);
    });
});

describe('the tier gate', () => {
    it('offers a new worker only the tier-1 job', async () => {
        seedUser({ shiftsWorked: 0 });
        seedGuild({ jobs: [
            { name: 'Intern task', emoji: '📋', tier: 1, minPay: 100, maxPay: 100 },
            { name: 'Executive task', emoji: '💼', tier: 4, minPay: 9000, maxPay: 9000 },
        ] });

        await work.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBe(100);
    });

    it('opens the top tier once the shift count reaches it', async () => {
        seedUser({ shiftsWorked: 50 });
        seedGuild({ jobs: [{ name: 'Executive task', emoji: '💼', tier: 4, minPay: 9000, maxPay: 9000 }] });

        await work.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBe(9000);
    });

    it('falls back to the whole list when the tier filter leaves nothing', async () => {
        // Every job above the player's tier: the pool must not come out empty,
        // which would pick `undefined` and throw on job.minPay.
        seedUser({ shiftsWorked: 0 });
        seedGuild({ jobs: [{ name: 'Executive task', emoji: '💼', tier: 4, minPay: 9000, maxPay: 9000 }] });

        await work.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBe(9000);
    });
});

describe('the special events', () => {
    it('doubles the payout on a promotion', async () => {
        Math.random.mockReturnValue(0.005);   // < 0.01
        seedUser();
        seedGuild();

        const interaction = makeInteraction();
        await work.execute(interaction);

        // The performance roll takes the same value, so the base is the rough
        // tier (×0.75) — and the promotion doubles whatever that came to.
        const stored = mockUsers.get(USER_ID);
        expect(stored.balance).toBe(150);
        expect(repliedText(interaction)).toContain('Double Payout');
    });

    it('grants an item on a lucky find, through the atomic inventory credit', async () => {
        Math.random.mockReturnValue(0.02);    // 0.01 <= roll < 0.04
        seedUser();
        seedGuild();

        await work.execute(makeInteraction());

        expect(grantInventoryItem).toHaveBeenCalledWith(USER_ID, GUILD_ID, expect.any(String), 1);
    });

    it('adds a tip on a bonus', async () => {
        Math.random.mockReturnValue(0.10);    // 0.04 <= roll < 0.14
        seedUser();
        seedGuild();

        await work.execute(makeInteraction());

        // Base is the rough tier at this roll (75), plus a tip of 25–50% of the
        // 100 pay band.
        expect(mockUsers.get(USER_ID).balance).toBeGreaterThan(75);
    });

    it('grants nothing on an ordinary shift', async () => {
        seedUser();
        seedGuild();

        await work.execute(makeInteraction());

        expect(grantInventoryItem).not.toHaveBeenCalled();
        expect(mockUsers.get(USER_ID).balance).toBe(100);
    });
});

describe('the cooldown refuses', () => {
    it('turns a second shift inside the hour away, writing nothing', async () => {
        seedUser({ balance: 500, lastWork: new Date(Date.now() - 10 * 60_000) });
        seedGuild();

        const interaction = makeInteraction();
        await work.execute(interaction);

        expect(repliedText(interaction)).toContain('Still Clocked Out');
        expect(mockUsers.writes.filter(w => w.update?.$inc?.balance)).toEqual([]);
        expect(mockUsers.get(USER_ID).balance).toBe(500);
    });

    it('lets the shift through once the hour has passed', async () => {
        seedUser({ lastWork: new Date(Date.now() - HOUR_MS - 1000) });
        seedGuild();

        await work.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBe(100);
    });

    it('shortens the wait to 50 minutes on a seven-day streak', async () => {
        seedUser({ streak: { current: 7 }, lastWork: new Date(Date.now() - 52 * 60_000) });
        seedGuild();

        const interaction = makeInteraction();
        await work.execute(interaction);

        // An hour has not passed, but 50 minutes has.
        expect(mockUsers.get(USER_ID).balance).toBeGreaterThan(0);
        expect(repliedText(interaction)).not.toContain('Still Clocked Out');
    });

    it('shortens it to 45 minutes at thirty days', async () => {
        seedUser({ streak: { current: 30 }, lastWork: new Date(Date.now() - 46 * 60_000) });
        seedGuild();

        await work.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBeGreaterThan(0);
    });

    it('still refuses a streak holder inside the shortened window, and says why', async () => {
        seedUser({ balance: 500, streak: { current: 30 }, lastWork: new Date(Date.now() - 10 * 60_000) });
        seedGuild();

        const interaction = makeInteraction();
        await work.execute(interaction);

        expect(repliedText(interaction)).toContain('45min cooldown');
        expect(mockUsers.get(USER_ID).balance).toBe(500);
    });
});

describe('the account-age gate', () => {
    it('refuses a young account without touching the database', async () => {
        seedUser();
        seedGuild();

        const interaction = makeInteraction({ user: { createdTimestamp: Date.now() - 2 * 86_400_000 } });
        await work.execute(interaction);

        expect(repliedText(interaction)).toContain('at least 7 days old');
        expect(mockUsers.writes).toEqual([]);
    });
});
