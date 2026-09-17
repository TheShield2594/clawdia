'use strict';

/**
 * #786. `/daily` is 258 lines at 7.4% lines and 0% branches — every cooldown
 * check, every multiplier and every drop branch in the command that hands out
 * more coins than any other had never executed. What its reported coverage
 * measured was the module-level constants evaluating at import.
 *
 * These drive `execute()` through the shared harness — tests/helpers/
 * fakeInteraction.js for the interaction, tests/helpers/fakeCollection.js for
 * the guarded writes — and assert the three things worth having per the issue:
 * the happy path writes the expected balance delta, the cooldown path refuses,
 * and a refusal writes nothing.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, inventory: [], activeEffects: [], pets: [] });
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);

jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/starterKit', () => ({ claimStarterKit: jest.fn(async () => null) }));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn(async () => {}),
    onEconomyEarn: jest.fn(async () => ({ completed: [], nearComplete: [] })),
    notifyQuestComplete: jest.fn(async () => {}),
    notifyQuestNearComplete: jest.fn(async () => {}),
}));
jest.mock('../src/services/seasonMissionService', () => ({ recordMissionProgress: jest.fn() }));
jest.mock('../src/utils/balanceDelta', () => ({
    saveWithBalanceDelta: jest.fn(async () => {}),
    detachBalanceDelta: jest.fn(() => 0),
    applyBalanceDelta: jest.fn(async user => user.balance ?? 0),
}));
// The challenge bonus goes through creditCoinsOrOwe now (#873); the base claim
// does not touch it, so mocking it lets the bonus tests choose whether the
// credit lands.
jest.mock('../src/utils/creditOrOwe', () => ({ creditCoinsOrOwe: jest.fn() }));

const daily = require('../src/commands/economy/daily');
const { logTransaction } = require('../src/utils/logTransaction');
const { claimStarterKit } = require('../src/utils/starterKit');
const { creditCoinsOrOwe } = require('../src/utils/creditOrOwe');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const DAY_MS = 86_400_000;

const seedUser = (fields = {}) => mockUsers.seed({
    userId: USER_ID, guildId: GUILD_ID, lastDaily: null,
    streak: { current: 0, freezes: 0 }, onboarding: { starterKitClaimed: true, firstDailyClaimed: true },
    ...fields,
});

const seedGuild = (economy = {}) => mockGuilds.seed({
    guildId: GUILD_ID,
    economy: { currency: '💰', dailyAmount: 1000, ...economy },
});

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    jest.clearAllMocks();
    // The reward roll: below every drop chance would fire a drop on some runs,
    // so pin it high and let the drop tests move it.
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
});

afterEach(() => { Math.random.mockRestore(); });

describe('the claim', () => {
    it('credits the configured amount and stamps the cooldown', async () => {
        seedUser();
        seedGuild({ dailyAmount: 1000 });

        await daily.execute(makeInteraction());

        const stored = mockUsers.get(USER_ID);
        expect(stored.balance).toBe(1000);
        expect(stored.lastDaily).toBeInstanceOf(Date);
        expectNonNegativeBalance(stored, 'daily claim');
    });

    it('credits with $inc rather than an absolute $set, so a concurrent payout survives', async () => {
        seedUser({ balance: 250 });
        seedGuild();

        await daily.execute(makeInteraction());

        const credit = mockUsers.writes.find(w => w.update?.$inc?.balance);
        expect(credit).toBeTruthy();
        expect(credit.update.$set).not.toHaveProperty('balance');
        expect(mockUsers.get(USER_ID).balance).toBe(1250);
    });

    it('carries the cooldown into the write itself, not just the read', async () => {
        // The claim's own filter has to refuse a second concurrent call; a check
        // made only against the document read a moment ago would double-credit.
        seedUser();
        seedGuild();

        await daily.execute(makeInteraction());

        const credit = mockUsers.writes.find(w => w.update?.$inc?.balance);
        expect(credit.query.$or).toEqual([
            { lastDaily: null },
            { lastDaily: { $lt: expect.any(Date) } },
        ]);
    });

    it('multiplies the base amount by the streak', async () => {
        seedUser({ streak: { current: 30, freezes: 0 } });
        seedGuild({ dailyAmount: 1000 });

        await daily.execute(makeInteraction());

        // Whatever the table says a 30-day streak is worth, it is more than 1x
        // and the write reflects it.
        expect(mockUsers.get(USER_ID).balance).toBeGreaterThan(1000);
    });

    it('falls back to a default amount when the guild has no economy settings', async () => {
        seedUser();
        // No Guild document at all — a fresh server that has never opened the
        // dashboard, which is the common case and the one with no row to read.
        await daily.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBeGreaterThan(0);
    });

    it('logs the claim with the amount and the resulting balance', async () => {
        seedUser({ balance: 40 });
        seedGuild({ dailyAmount: 1000 });

        await daily.execute(makeInteraction());

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER_ID, guildId: GUILD_ID, type: 'daily', amount: 1000, balance: 1040,
        }));
    });

    it('shows the player what they were paid', async () => {
        seedUser();
        seedGuild({ dailyAmount: 1000 });

        const interaction = makeInteraction();
        await daily.execute(interaction);

        expect(interaction.replies.length).toBeGreaterThan(0);
        expect(repliedText(interaction)).toMatch(/1,000/);
    });

    it('claims the starter kit on a first-ever economy command', async () => {
        claimStarterKit.mockResolvedValueOnce({ coins: 500 });
        seedUser({ onboarding: { starterKitClaimed: false, firstDailyClaimed: false } });
        seedGuild();

        const interaction = makeInteraction();
        await daily.execute(interaction);

        expect(claimStarterKit).toHaveBeenCalledWith(USER_ID, GUILD_ID);
        expect(repliedText(interaction)).toContain('Starter kit claimed');
    });

    it('does not claim it again once the flag is set', async () => {
        seedUser({ onboarding: { starterKitClaimed: true, firstDailyClaimed: true } });
        seedGuild();

        await daily.execute(makeInteraction());

        expect(claimStarterKit).not.toHaveBeenCalled();
    });
});

describe('the cooldown refuses', () => {
    it('turns a second claim inside the day away', async () => {
        seedUser({ balance: 1000, lastDaily: new Date(Date.now() - 3_600_000) });
        seedGuild();

        const interaction = makeInteraction();
        await daily.execute(interaction);

        expect(repliedText(interaction)).toContain('Come Back Tomorrow');
    });

    it('writes nothing at all when it refuses', async () => {
        seedUser({ balance: 1000, lastDaily: new Date(Date.now() - 3_600_000) });
        seedGuild();

        await daily.execute(makeInteraction());

        expect(mockUsers.writes.filter(w => w.update?.$inc?.balance)).toEqual([]);
        expect(mockUsers.get(USER_ID).balance).toBe(1000);
    });

    it('lets the claim through once the day has passed', async () => {
        seedUser({ balance: 1000, lastDaily: new Date(Date.now() - DAY_MS - 1000) });
        seedGuild({ dailyAmount: 1000 });

        await daily.execute(makeInteraction());

        expect(mockUsers.get(USER_ID).balance).toBe(2000);
    });

    it('refuses privately, so the channel is not spammed', async () => {
        seedUser({ lastDaily: new Date() });
        seedGuild();

        const interaction = makeInteraction();
        await daily.execute(interaction);

        expect(interaction.replies[0].flags).toBeDefined();
    });
});

describe('the account-age gate', () => {
    it('refuses an account younger than a week without touching the database', async () => {
        seedUser();
        seedGuild();

        const interaction = makeInteraction({
            user: { createdTimestamp: Date.now() - 2 * DAY_MS },
        });
        await daily.execute(interaction);

        expect(repliedText(interaction)).toContain('at least 7 days old');
        expect(mockUsers.writes).toEqual([]);
        expect(mockUsers.get(USER_ID).balance).toBe(0);
    });

    it('lets an account exactly a week and a moment old through', async () => {
        seedUser();
        seedGuild({ dailyAmount: 1000 });

        await daily.execute(makeInteraction({
            user: { createdTimestamp: Date.now() - 7 * DAY_MS - 1000 },
        }));

        expect(mockUsers.get(USER_ID).balance).toBe(1000);
    });
});

describe('the challenge bonus', () => {
    // The correct-answer button id is fixed across every challenge shape.
    const CORRECT = { customId: 'daily_challenge_correct' };

    it('announces the bonus and shows the new balance when the credit lands', async () => {
        creditCoinsOrOwe.mockResolvedValue({ credited: true, owed: false, doc: { balance: 1500 }, error: null });
        seedUser();
        seedGuild({ dailyAmount: 1000 });

        const interaction = makeInteraction({ components: [CORRECT] });
        await daily.execute(interaction);

        // The claim is 1000; the challenge pays 50% of it, credited through the helper.
        expect(creditCoinsOrOwe).toHaveBeenCalledWith(
            { userId: USER_ID, guildId: GUILD_ID },
            500,
            expect.objectContaining({ payoutKey: 'daily:interaction-1:challenge' }),
        );
        const text = repliedText(interaction);
        expect(text).toContain('You earned an extra **+500 coins**');
        expect(text).toContain('1,500');
    });

    it('does not announce the bonus as paid when the credit is only recorded', async () => {
        // The credit could not land and was filed as owed. The old bare `$inc`
        // showed "+500" regardless, and a throw aborted the whole claim to a
        // generic error after it had already been paid (#873).
        creditCoinsOrOwe.mockResolvedValue({ credited: false, owed: true, doc: null, error: null });
        seedUser();
        seedGuild({ dailyAmount: 1000 });

        const interaction = makeInteraction({ components: [CORRECT] });
        await daily.execute(interaction);

        const text = repliedText(interaction);
        expect(text).toContain("couldn't be paid right now");
        expect(text).not.toContain('You earned an extra **+500 coins**');
        expect(logTransaction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'daily_challenge_bonus' }));
    });
});
