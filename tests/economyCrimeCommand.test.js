'use strict';

/**
 * #786. `/crime` is 180 lines at 15.6% lines and 0% branches. Every outcome it
 * has — a clean getaway, a fine, a critical failure that seizes a share of the
 * wallet, a Lifesaver absorbing one, and the wanted-heat window that follows a
 * loud method — had never executed under test, and all of them move coins.
 *
 * The command claims its cooldown slot up front with an atomic
 * findOneAndUpdate, so the harness has to evaluate that guard to tell a refusal
 * from a run; tests/helpers/fakeCollection.js is what does.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, inventory: [], activeEffects: [], pets: [] });
const mockGuilds = fakeCollection('Guild');
// The success payout goes through creditCoinsOrOwe now (#873); when its credit
// cannot land it files an owed FailedJob, so the owed-path test needs a place
// for that to go.
const mockFailed = fakeCollection('FailedJob');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/FailedJob', () => mockFailed.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async user => user) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/bigWinLogger', () => ({ logBigWin: jest.fn() }));
jest.mock('../src/services/petService', () => ({ getTotalBonus: jest.fn(() => 0) }));
jest.mock('../src/services/synergyService', () => ({ getMerchantCoinBonus: jest.fn(() => 0) }));
jest.mock('../src/services/seasonMissionService', () => ({ advanceMissions: jest.fn(async () => {}) }));
jest.mock('../src/services/districtService', () => ({ isDistrictActive: jest.fn(() => false) }));
// The featured crime rotates on the UTC date, and crime.js spends an *extra*
// `Math.random()` only when that crime is not already among the three it
// shuffled up ("if (!choices.some(...))"). Every roll this file pins by
// position therefore moved by one whenever the calendar turned over onto a day
// whose crime fell outside those three — a test that passes or fails by the
// date it runs on, and did: green on 30 Aug, red on the 31st, with no commit in
// between. Pinning the rotation takes the calendar out of it.
jest.mock('../src/data/featuredRotation', () => {
    const actual = jest.requireActual('../src/data/featuredRotation');
    return {
        ...actual,
        getDailyFeatured: jest.fn(guildId => ({
            ...actual.getDailyFeatured(guildId),
            // The crime these tests already select, so the branch above resolves
            // the same way on every run and the positions below mean what they say.
            crime: actual.FEATURED_CRIMES.find(c => c.name === 'pickpocketing'),
        })),
    };
});

const crime = require('../src/commands/economy/crime');
const { __setRandomSourceForTests } = require('../src/utils/secureRandom');
const { logTransaction } = require('../src/utils/logTransaction');
const { logBigWin } = require('../src/utils/bigWinLogger');
const { isDistrictActive } = require('../src/services/districtService');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const COOLDOWN_MS = 1.5 * 3_600_000;

// The quietest job and its safest method: fixed rates, no heat, and a payout
// band narrow enough to assert against.
const PICKPOCKET = 'pickpocketing';
const FEATHER_TOUCH = 'exec_feather_touch';   // 72% success, ×0.80 payout, no heat
const BOLD_GRAB = 'exec_bold_grab';           // 40% success, ×1.60 payout, 2h heat

// Crime's payout-steering rolls draw from src/utils/secureRandom.js, not
// Math.random (CodeQL js/insecure-randomness). Both are pointed at one shared
// impl so a run that mixes a secureRandom roll with a Math.random one (in a copy
// helper, say) still consumes a single sequence in call order.
function setRandom(impl) {
    jest.spyOn(Math, 'random').mockImplementation(impl);
    __setRandomSourceForTests(impl);
}

/** Math.random values in order, then `tail` for every roll after them. */
function rolls(sequence, tail = 0.5) {
    const queue = [...sequence];
    setRandom(() => (queue.length ? queue.shift() : tail));
}

/** `head` for the first `count` rolls of the run, `tail` for the rest. */
function rollsUntil(count, head, tail) {
    let seen = 0;
    setRandom(() => (++seen <= count ? head : tail));
}

const seedUser = (fields = {}) => mockUsers.seed({
    userId: USER_ID, guildId: GUILD_ID, lastCrime: null, wantedUntil: null,
    streak: { current: 0 }, crimeRecord: { totalCrimes: 0, successfulCrimes: 0 },
    ...fields,
});

const seedGuild = (economy = {}) => mockGuilds.seed({
    guildId: GUILD_ID, economy: { currency: '💰', ...economy },
});

const run = (components = [{ customId: PICKPOCKET }, { customId: FEATHER_TOUCH }]) => {
    const interaction = makeInteraction({ components });
    return crime.execute(interaction).then(() => interaction);
};

// The owed-path test replaces a model method to force one write to miss; like
// the invest suite, restore the pristine model afterwards so the stub is not
// inherited by later tests.
const pristineUserModel = { ...mockUsers.model };
afterEach(() => { Object.assign(mockUsers.model, pristineUserModel); });

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    mockFailed.reset();
    jest.clearAllMocks();
    // `clearAllMocks` clears calls, not implementations, so the
    // `mockReturnValue(true)` in the underground-district test below stayed true
    // for every test that ran after it.
    isDistrictActive.mockReturnValue(false);
    setRandom(() => 0.5);
});

afterEach(() => { Math.random.mockRestore(); __setRandomSourceForTests(null); });

describe('a clean getaway', () => {
    it('credits the payout and counts the crime', async () => {
        // 0.1 is under feather touch's 72%, so the job lands.
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        await run();

        const stored = mockUsers.get(USER_ID);
        expect(stored.balance).toBeGreaterThan(1000);
        expect(stored.crimeRecord.totalCrimes).toBe(1);
        expect(stored.crimeRecord.successfulCrimes).toBe(1);
        expectNonNegativeBalance(stored, 'crime success');
    });

    it('credits through the keyed, exactly-once helper — a relative $add, never an absolute set', async () => {
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        await run();

        // The payout goes through creditCoinsOrOwe now (#873): a pipeline update
        // whose $set moves balance by $add and appends a payout key, guarded so a
        // replay of a lost-response write cannot pay twice. The old bare `$inc`
        // read nothing back and, with the cooldown already claimed, lost the
        // payout outright when the write missed.
        const credit = mockUsers.writes.find(w =>
            Array.isArray(w.update) && w.update[0]?.$set?.balance?.$add);
        expect(credit).toBeTruthy();
        expect(credit.query['paidPayouts.key']).toEqual({ $ne: expect.any(String) });
        expect(credit.update[0].$set.paidPayouts).toBeDefined();
        // The counters ride the same write, so the count and the coins land together.
        expect(credit.update[0].$set['crimeRecord.totalCrimes']).toBeDefined();
        expect(credit.update[0].$set['crimeRecord.successfulCrimes']).toBeDefined();
    });

    it('pays the method multiplier — a bold grab beats a feather touch', async () => {
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();
        await run([{ customId: PICKPOCKET }, { customId: FEATHER_TOUCH }]);
        const timid = mockUsers.get(USER_ID).balance;

        mockUsers.reset();
        mockGuilds.reset();
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();
        await run([{ customId: PICKPOCKET }, { customId: BOLD_GRAB }]);
        const bold = mockUsers.get(USER_ID).balance;

        expect(bold).toBeGreaterThan(timid);
    });

    it('tells the big-win logger about a payout over the guild threshold', async () => {
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild({ bigWinThreshold: 1 });

        await run();

        expect(logBigWin).toHaveBeenCalledWith(expect.objectContaining({ source: 'crime' }));
    });

    it('leaves the logger alone under it', async () => {
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild({ bigWinThreshold: 1_000_000 });

        await run();

        expect(logBigWin).not.toHaveBeenCalled();
    });

    it('shows the getaway', async () => {
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        const interaction = await run();

        expect(repliedText(interaction)).toContain('Clean Getaway');
    });

    it('records the payout as owed and does not inflate the balance when the credit cannot land', async () => {
        // The cooldown slot was already claimed up front, so a payout that fails
        // here cannot be retried — the bare `$inc` this replaced lost it outright
        // and dereferenced its null result. Now the keyed credit is filed as owed
        // and the embed says so rather than announcing coins that never arrived.
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        // Make only the keyed pipeline credit miss; the claim and upsert are
        // operator-syntax updates and go through untouched.
        const realFindOneAndUpdate = mockUsers.model.findOneAndUpdate;
        mockUsers.model.findOneAndUpdate = jest.fn(async (query, update, options) => {
            if (Array.isArray(update)) throw new Error('credit write failed');
            return realFindOneAndUpdate(query, update, options);
        });

        const interaction = await run();

        expect(repliedText(interaction)).toContain("couldn't be delivered");
        // The wallet was not touched — no phantom credit — and an owed record was filed.
        expect(mockUsers.get(USER_ID).balance).toBe(1000);
        expect(mockFailed.model.create).toHaveBeenCalledWith(expect.objectContaining({
            jobName: expect.stringContaining('crimePayout'),
        }));
        expect(logBigWin).not.toHaveBeenCalled();
    });
});

describe('getting caught', () => {
    it('fines the player, capped at a fifth of the wallet', async () => {
        // 0.99 misses the 72% success roll and the 8% death roll both.
        rolls([], 0.99);
        seedUser({ balance: 1000 });
        seedGuild();

        const interaction = await run();

        const stored = mockUsers.get(USER_ID);
        expect(stored.balance).toBeLessThan(1000);
        // The cap is 20% of the wallet, and the method's fineMult is 0.75.
        expect(stored.balance).toBeGreaterThanOrEqual(800);
        expect(repliedText(interaction)).toContain('Busted');
        expectNonNegativeBalance(stored, 'crime fine');
    });

    it('never takes a broke player below zero', async () => {
        rolls([], 0.99);
        seedUser({ balance: 3 });
        seedGuild();

        await run();

        expectNonNegativeBalance(mockUsers.get(USER_ID), 'crime fine on an empty wallet');
    });

    it('discounts the fine while the underground district is active', async () => {
        rolls([], 0.99);
        seedUser({ balance: 10_000 });
        seedGuild();
        await run();
        const full = 10_000 - mockUsers.get(USER_ID).balance;

        mockUsers.reset();
        mockGuilds.reset();
        isDistrictActive.mockReturnValue(true);
        rolls([], 0.99);
        seedUser({ balance: 10_000 });
        seedGuild();
        const interaction = await run();
        const discounted = 10_000 - mockUsers.get(USER_ID).balance;

        expect(discounted).toBeLessThan(full);
        expect(repliedText(interaction)).toContain('Underground district active');
    });

    it('seizes a share of the wallet on a critical failure', async () => {
        // The success roll misses and the 8% death check — the eighth roll of
        // the run — lands. Pinned by position because the two are the same
        // call, `Math.random()`, and nothing else tells them apart; a refactor
        // that moves either one fails this loudly rather than quietly turning
        // it back into the ordinary fine above.
        //
        // The position only means anything because the featured rotation is
        // mocked at the top of this file. Without that it shifted with the
        // calendar, which is what made this test fail on 31 Aug.
        rollsUntil(7, 0.99, 0.01);
        seedUser({ balance: 10_000 });
        seedGuild();

        const interaction = await run();

        expect(repliedText(interaction)).toContain('Everything Went Wrong');
        const stored = mockUsers.get(USER_ID);
        // 15–30% of the wallet.
        expect(stored.balance).toBeLessThanOrEqual(8_500);
        expect(stored.balance).toBeGreaterThanOrEqual(7_000);
        expectNonNegativeBalance(stored, 'crime critical failure');
    });

    it('spends a Lifesaver instead of coins', async () => {
        rolls([], 0.99);
        seedUser({
            balance: 10_000,
            // The shape `/use` writes: a lifesaver has one charge and no expiry.
            // Its charge is claimed in a guarded write now (#873, pass 15), so
            // the fixture has to carry one to spend.
            activeEffects: [{ type: 'lifesaver', expiresAt: null, charges: 1 }],
        });
        seedGuild();

        const interaction = await run();

        expect(repliedText(interaction)).toContain('Saved by the Lifesaver');
        expect(mockUsers.get(USER_ID).balance).toBe(10_000);
        expect(mockUsers.get(USER_ID).activeEffects).toEqual([]);
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'crime_lifesaver', amount: 0 }));
    });

    it('puts a wanted window on the loud method and none on the quiet one', async () => {
        rolls([], 0.99);
        seedUser({ balance: 10_000 });
        seedGuild();
        await run([{ customId: PICKPOCKET }, { customId: BOLD_GRAB }]);

        const wanted = mockUsers.get(USER_ID).wantedUntil;
        expect(wanted).toBeInstanceOf(Date);
        expect(wanted.getTime()).toBeGreaterThan(Date.now());

        mockUsers.reset();
        mockGuilds.reset();
        rolls([], 0.99);
        seedUser({ balance: 10_000 });
        seedGuild();
        await run([{ customId: PICKPOCKET }, { customId: FEATHER_TOUCH }]);

        expect(mockUsers.get(USER_ID).wantedUntil).toBeNull();
    });
});

describe('the cooldown refuses', () => {
    it('turns a second job inside the window away, writing nothing', async () => {
        seedUser({ balance: 1000, lastCrime: new Date(Date.now() - 60_000) });
        seedGuild();

        const interaction = await run();

        expect(repliedText(interaction)).toContain('Laying Low');
        expect(mockUsers.writes.filter(w => w.update?.$inc || w.update?.$set)).toEqual([]);
        expect(mockUsers.get(USER_ID).balance).toBe(1000);
    });

    it('refuses while the player is still wanted, and says so', async () => {
        seedUser({
            balance: 1000,
            lastCrime: new Date(Date.now() - COOLDOWN_MS - 1000),
            wantedUntil: new Date(Date.now() + 3_600_000),
        });
        seedGuild();

        const interaction = await run();

        expect(repliedText(interaction)).toContain('Still Wanted');
        expect(mockUsers.get(USER_ID).balance).toBe(1000);
    });

    it('lets the job through once both windows have passed', async () => {
        rolls([], 0.1);
        seedUser({
            balance: 1000,
            lastCrime: new Date(Date.now() - COOLDOWN_MS - 1000),
            wantedUntil: new Date(Date.now() - 1000),
        });
        seedGuild();

        await run();

        expect(mockUsers.get(USER_ID).balance).toBeGreaterThan(1000);
    });

    it('claims the slot before the job runs, not after it resolves', async () => {
        // The 30 seconds of button prompts are the window two concurrent
        // /crime calls would both slip through if lastCrime were written at the
        // end, so the claim carries the cooldown in its own filter.
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        await run();

        const claim = mockUsers.writes.find(w => w.update?.$set?.lastCrime);
        expect(claim.update.$set.lastCrime).toBeInstanceOf(Date);
        expect(claim.query.$and).toEqual([
            { $or: [{ wantedUntil: null }, { wantedUntil: { $lte: expect.any(Date) } }] },
            { $or: [{ lastCrime: null }, { lastCrime: { $lte: expect.any(Date) } }] },
        ]);
    });

    it('does not carry the guard on the upsert that makes the row', async () => {
        // An upsert whose filter misses inserts rather than returning null, and
        // { userId, guildId } is unique — so a guarded upsert answered every
        // refusal with a duplicate-key error and the branches below never ran.
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        await run();

        const upsert = mockUsers.writes.find(w => w.update?.$setOnInsert);
        expect(upsert.query).toEqual({ userId: USER_ID, guildId: GUILD_ID });
        expect(upsert.update.$set).toBeUndefined();
    });
});

describe('the switches that turn it off', () => {
    it('refuses when the economy is disabled', async () => {
        seedUser({ balance: 1000 });
        seedGuild({ enabled: false });

        const interaction = await run();

        expect(repliedText(interaction)).toContain('economy is disabled');
        expect(mockUsers.writes).toEqual([]);
    });

    it('refuses when only the crime command is disabled', async () => {
        seedUser({ balance: 1000 });
        seedGuild({ crimeEnabled: false });

        const interaction = await run();

        expect(repliedText(interaction)).toContain('crime command is disabled');
        expect(mockUsers.writes).toEqual([]);
    });

    it('refuses an account younger than a week', async () => {
        seedUser({ balance: 1000 });
        seedGuild();

        const interaction = makeInteraction({ user: { createdTimestamp: Date.now() - 2 * 86_400_000 } });
        await crime.execute(interaction);

        expect(repliedText(interaction)).toContain('at least 7 days old');
        expect(mockUsers.writes).toEqual([]);
    });
});

describe('the prompts keep the player\'s picks', () => {
    it('keeps a pick whose acknowledgement missed its window, rather than rolling a random one', async () => {
        // A `deferUpdate()` that threw used to share the timeout's catch, which
        // replaced the job just picked with a random one. 0.1 would make that
        // random fallback the first method — feather touch — so a bold grab in
        // the result can only be the player's own.
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        const interaction = await run([
            { customId: PICKPOCKET, deferRejects: true },
            { customId: BOLD_GRAB, deferRejects: true },
        ]);

        // The result alone — the step-2 prompt lists every method by name.
        const result = interaction.replies.at(-1).embeds[0].data;
        expect(result.title).toContain('Quick Snatch — Clean Getaway');
        expect(result.footer.text).toContain('Bold grab');
    });

    it('quotes odds that include every bonus the roll will use', async () => {
        // A Lucky Charm is +20%: feather touch's 72% is rolled at 92%, and the
        // buttons used to say 72% anyway.
        rolls([], 0.1);
        seedUser({
            balance: 1000,
            activeEffects: [{ type: 'lucky_charm', expiresAt: new Date(Date.now() + 3_600_000), charges: -1 }],
        });
        seedGuild();

        const interaction = await run();

        const text = repliedText(interaction);
        expect(text).toContain('92%');
        expect(text).toContain('Lucky Charm +20%');
    });
});

describe('when the job never runs', () => {
    it('gives the cooldown back when the first prompt cannot be sent', async () => {
        seedUser({ balance: 1000 });
        seedGuild();

        const interaction = makeInteraction();
        interaction.reply = jest.fn()
            .mockRejectedValueOnce(new Error('Unknown interaction'))
            .mockResolvedValue(undefined);
        await crime.execute(interaction);

        expect(mockUsers.get(USER_ID).lastCrime).toBeNull();
        expect(mockUsers.get(USER_ID).balance).toBe(1000);
        expect(interaction.reply).toHaveBeenLastCalledWith(expect.objectContaining({
            content: expect.stringContaining("cooldown wasn't used"),
        }));
    });

    it('restores the previous cooldown stamp, not a blank one, when the message goes away mid-prompt', async () => {
        const previous = new Date(Date.now() - COOLDOWN_MS - 60_000);
        seedUser({ balance: 1000, lastCrime: previous });
        seedGuild();

        const interaction = makeInteraction({ components: [{ customId: PICKPOCKET }] });
        interaction.editReply = jest.fn()
            .mockRejectedValueOnce(new Error('Unknown Message'))
            .mockResolvedValue(undefined);
        await crime.execute(interaction);

        expect(mockUsers.get(USER_ID).lastCrime.getTime()).toBe(previous.getTime());
    });

    it('keeps the cooldown and says the job stood when only the result fails to render', async () => {
        rolls([], 0.1);
        seedUser({ balance: 1000 });
        seedGuild();

        const interaction = makeInteraction({ components: [{ customId: PICKPOCKET }, { customId: FEATHER_TOUCH }] });
        const render = interaction.editReply;
        let edits = 0;
        // The step-2 prompt and the suspense frame land; the result does not.
        interaction.editReply = jest.fn(payload => (++edits === 3 ? Promise.reject(new Error('Unknown Message')) : render(payload)));
        await crime.execute(interaction);

        const stored = mockUsers.get(USER_ID);
        expect(stored.balance).toBeGreaterThan(1000);
        expect(stored.lastCrime).toBeInstanceOf(Date);
        expect(interaction.editReply).toHaveBeenLastCalledWith(expect.objectContaining({
            content: expect.stringContaining('The job went through'),
        }));
    });
});

describe('failure bookkeeping', () => {
    it('runs the cooldown from the claim on a failure too, rather than restamping it', async () => {
        rolls([], 0.99);
        seedUser({ balance: 10_000 });
        seedGuild();

        await run();

        const claim = mockUsers.writes.find(w => w.update?.$set?.lastCrime);
        expect(mockUsers.get(USER_ID).lastCrime.getTime()).toBe(claim.update.$set.lastCrime.getTime());
        expect(mockUsers.writes.filter(w => w.update?.$set?.lastCrime || w.update?.[0]?.$set?.lastCrime)).toHaveLength(1);
    });

    it('shows when the next job opens — the heat, not a flat 1.5h, after a loud failure', async () => {
        rolls([], 0.99);
        seedUser({ balance: 10_000 });
        seedGuild();

        const interaction = await run([{ customId: PICKPOCKET }, { customId: BOLD_GRAB }]);

        const wanted = mockUsers.get(USER_ID).wantedUntil;
        const text = repliedText(interaction);
        expect(text).toContain(`Next job <t:${Math.floor(wanted.getTime() / 1000)}:R>`);
        expect(text).not.toContain('Cooldown: 1.5h');
    });

    it('applies the method\'s fine multiplier before the wallet cap, so the cap holds', async () => {
        // 300 coins caps the fine at 60. Bold grab's ×1.35 applied after the
        // cap made that 81 — 27% of a wallet capped at 20%.
        rolls([], 0.99);
        seedUser({ balance: 300 });
        seedGuild();

        await run([{ customId: PICKPOCKET }, { customId: BOLD_GRAB }]);

        expect(mockUsers.get(USER_ID).balance).toBe(240);
    });

    it('does not spend a Lifesaver when there is nothing to absorb', async () => {
        rolls([], 0.99);
        seedUser({ balance: 0, activeEffects: [{ type: 'lifesaver', expiresAt: null, charges: 1 }] });
        seedGuild();

        const interaction = await run();

        expect(repliedText(interaction)).not.toContain('Saved by the Lifesaver');
        expect(mockUsers.get(USER_ID).activeEffects).toHaveLength(1);
    });

    it('shows a member frozen mid-job their real balance, not zero', async () => {
        rolls([], 0.99);
        seedUser({ balance: 10_000, economyFrozen: true });
        seedGuild();

        const interaction = await run();

        expect(repliedText(interaction)).toContain('💰10,000');
        expect(mockUsers.get(USER_ID).balance).toBe(10_000);
    });

    it('names today\'s featured job on the Still Wanted screen rather than a fixed one', async () => {
        seedUser({
            balance: 1000,
            lastCrime: new Date(Date.now() - COOLDOWN_MS - 1000),
            wantedUntil: new Date(Date.now() + 3_600_000),
        });
        seedGuild();

        const interaction = await run();

        const text = repliedText(interaction);
        expect(text).toContain('Quick Snatch');
        expect(text).not.toContain('Casino Con is next');
    });
});
