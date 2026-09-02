'use strict';

/**
 * Do the achievements actually measure what they claim to?
 *
 * An achievement has two halves and either can rot on its own: a `check` that
 * reads a field, and somewhere in the bot that writes it. The definitions were
 * fine — every one of them reads a real field with a sensible threshold — but
 * three of the wirings between them were not:
 *
 *   1. `lifetimeGambled` backs six achievements and only blackjack wrote it.
 *      The other seven casino games took a stake through the same helper and
 *      left the counter at zero, so High Roller measured "coins staked at
 *      blackjack" while promising "coins gambled". /duel, the one wager outside
 *      the casino, counted for nothing at all.
 *   2. Clean Record was unreachable for a member who has never been warned —
 *      the only people it describes.
 *   3. Completionist counts the other achievements, and a single ordered pass
 *      could only see the ones defined above it.
 *
 * This suite pins the wiring rather than the thresholds: the counter moves when
 * coins are staked, comes back when they are handed back, and the award is
 * independent of where a definition sits in the list.
 */

const { ACHIEVEMENTS } = require('../src/data/achievements');

const byId = id => ACHIEVEMENTS.find(a => a.id === id);
const DAY = 86400000;

// ── the counter behind the six wagering achievements ─────────────────────────

describe('placeWager counts every stake as gambled', () => {
    let User, placeWager;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));
        User = require('../src/models/User');
        ({ placeWager } = require('../src/utils/placeWager'));
    });

    afterEach(() => {
        jest.dontMock('../src/models/User');
        jest.resetModules();
    });

    test('the stake and the counter commit in the one write', async () => {
        User.findOneAndUpdate.mockResolvedValue({ userId: 'u', lifetimeGambled: 100 });

        await placeWager({ userId: 'u', guildId: 'g' }, 100);

        const [filter, update] = User.findOneAndUpdate.mock.calls[0];
        // The freeze guard shares the filter with the balance check (#870).
        expect(filter).toEqual({ userId: 'u', guildId: 'g', economyFrozen: { $ne: true }, balance: { $gte: 100 } });
        expect(update).toEqual({ $inc: { balance: -100, lifetimeGambled: 100 } });
    });

    test('extra bookkeeping rides along without displacing it', async () => {
        User.findOneAndUpdate.mockResolvedValue({ userId: 'u' });

        await placeWager({ userId: 'u', guildId: 'g' }, 50, { extraInc: { pendingCrashRefund: 50 } });

        expect(User.findOneAndUpdate.mock.calls[0][1]).toEqual({
            $inc: { balance: -50, lifetimeGambled: 50, pendingCrashRefund: 50 },
        });
    });

    test('the fractional part of a stake is counted the way it is charged', async () => {
        User.findOneAndUpdate.mockResolvedValue({ userId: 'u' });

        await placeWager({ userId: 'u', guildId: 'g' }, 99.9);

        expect(User.findOneAndUpdate.mock.calls[0][1].$inc).toEqual({ balance: -99, lifetimeGambled: 99 });
    });

    test('a stake the wallet could not cover counts for nothing', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);

        expect(await placeWager({ userId: 'u', guildId: 'g' }, 100)).toBeNull();
        // The guard is in the filter, so the write simply matches nothing —
        // what matters is that no second, unguarded write follows it.
        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    test('a non-positive stake never reaches the database', async () => {
        expect(await placeWager({ userId: 'u', guildId: 'g' }, 0)).toBeNull();
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('the debited document rides along so a listener can read the counter it just moved', async () => {
        const doc = { userId: 'u', guildId: 'g', lifetimeGambled: 1_000_000 };
        User.findOneAndUpdate.mockResolvedValue(doc);
        const onWager = jest.fn();

        await placeWager({ userId: 'u', guildId: 'g' }, 100, { onWager });

        expect(onWager).toHaveBeenCalledWith(expect.objectContaining({ amount: 100, doc }));
    });
});

describe('/duel — an escrowed stake is gambled, a refunded one is not', () => {
    // Driven against the in-memory store rather than by inspecting update
    // shapes: #873 moved the refund onto a keyed pipeline write, so what these
    // have to hold is the counter's resulting value, not the operator that got
    // it there.
    let users, duel;

    beforeEach(() => {
        jest.resetModules();
        // `doMock`, not `mock`: it is not hoisted, so the factory may close over
        // the store built here.
        const { fakeCollection } = require('./helpers/fakeCollection');
        users = fakeCollection('User', { balance: 0, lifetimeGambled: 0, paidPayouts: [] });
        jest.doMock('../src/models/User', () => users.model);
        jest.doMock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
        jest.doMock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
        duel = require('../src/commands/economy/duel').__test__;
        users.seed({ userId: 'a', guildId: 'g', balance: 1000 });
        users.seed({ userId: 'b', guildId: 'g', balance: 1000 });
    });

    afterEach(() => {
        jest.dontMock('../src/models/User');
        jest.dontMock('../src/utils/owedPayout');
        jest.dontMock('../src/utils/delay');
        jest.resetModules();
    });

    const gambled = userId => users.get(userId).lifetimeGambled;
    const balance = userId => users.get(userId).balance;

    test('both players are charged and counted when the escrow holds', async () => {
        expect(await duel.takeEscrow('a', 'b', 'g', 250, 'd1')).toMatchObject({ success: true });

        expect([gambled('a'), gambled('b')]).toEqual([250, 250]);
        expect([balance('a'), balance('b')]).toEqual([750, 750]);
    });

    test('a challenger refunded because the opponent could not pay is un-counted', async () => {
        users.get('b').balance = 10;

        expect(await duel.takeEscrow('a', 'b', 'g', 250, 'd1'))
            .toMatchObject({ success: false, reason: 'opponent' });
        expect(gambled('a')).toBe(0);
        expect(balance('a')).toBe(1000);
    });

    test('a duel that never resolves gives back the coins and the count', async () => {
        await duel.takeEscrow('a', 'b', 'g', 250, 'd1');
        await duel.refundEscrow('a', 'b', 'g', 250, 'd1');

        expect([gambled('a'), gambled('b')]).toEqual([0, 0]);
        expect([balance('a'), balance('b')]).toEqual([1000, 1000]);
    });

    test('escrow and refund are exactly inverse, so a cancelled duel nets to zero', async () => {
        await duel.takeEscrow('a', 'b', 'g', 250, 'd1');
        await duel.refundEscrow('a', 'b', 'g', 250, 'd1');

        expect(gambled('a') + gambled('b')).toBe(0);
    });

    test('a tie keeps the count — the duel was fought, the stakes were at risk', async () => {
        await duel.takeEscrow('a', 'b', 'g', 250, 'd1');
        await duel.refundEscrow('a', 'b', 'g', 250, 'd1', { unwager: false });

        expect([gambled('a'), gambled('b')]).toEqual([250, 250]);
        expect([balance('a'), balance('b')]).toEqual([1000, 1000]);
    });

    test('a refund that ran twice returns one stake, not two', async () => {
        // The payout key is in the write's own filter, so the second call
        // matches nothing. `settled` in runRPS is meant to make this
        // unreachable; the key is what makes it harmless if it ever is not.
        await duel.takeEscrow('a', 'b', 'g', 250, 'd1');
        await duel.refundEscrow('a', 'b', 'g', 250, 'd1');
        await duel.refundEscrow('a', 'b', 'g', 250, 'd1');

        expect([balance('a'), gambled('a')]).toEqual([1000, 0]);
    });
});

describe.each(require('./helpers/casinoInteraction').GAMES)(
    '/$name advances the wagering counter',
    (game) => {
        // The end-to-end half of the claim. The unit tests above pin what
        // placeWager writes; this pins that each of the eight games actually
        // reaches it with the opening stake, against the real helper rather
        // than a stub — which is the step blackjack alone used to take.
        const { GUILD_ID, USER_ID, walletDoc, makeInteraction, stakeFor } = require('./helpers/casinoInteraction');
        const stake = stakeFor(game);

        test('the opening stake lands on lifetimeGambled', async () => {
            jest.resetModules();
            jest.doMock('../src/models/User', () => ({
                findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(), create: jest.fn(),
            }));
            jest.doMock('../src/models/Guild', () => ({
                findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
            }));
            jest.doMock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));

            const errorSpy   = jest.spyOn(console, 'error').mockImplementation(() => {});
            const freshUser  = require('../src/models/User');
            const freshGuild = require('../src/models/Guild');

            freshGuild.findOne.mockReturnValue(Object.assign(
                Promise.resolve({ guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true } }),
                { lean: () => ({ catch: () => Promise.resolve(null) }) },
            ));
            freshGuild.findOneAndUpdate.mockResolvedValue(null);
            freshGuild.updateOne.mockResolvedValue({});
            freshUser.findOne.mockResolvedValue(walletDoc());
            freshUser.create.mockResolvedValue(walletDoc());
            freshUser.updateOne.mockResolvedValue({});
            // Every *debit* refuses, which stops the hand right after the write
            // this test is here to inspect — eight games playing themselves out
            // is not what is being measured. The upsert some games do first is
            // not a debit and still has to hand back a wallet, or they fall over
            // before reaching the stake.
            freshUser.findOneAndUpdate.mockImplementation((_filter, update) =>
                Promise.resolve(update?.$inc?.balance < 0 ? null : walletDoc()));

            await require(`../src/games/casino/${game.name}`)
                .execute(makeInteraction(game.options), { releaseLock: jest.fn(), onWager: jest.fn() });

            const opening = freshUser.findOneAndUpdate.mock.calls
                .find(([, update]) => update?.$inc?.balance === -stake);
            expect(opening).toBeDefined();
            expect(opening[0]).toMatchObject({ userId: USER_ID, guildId: GUILD_ID });
            expect(opening[1].$inc.lifetimeGambled).toBe(stake);

            errorSpy.mockRestore();
            jest.resetModules();
        });
    },
);

// ── the definitions whose wiring was wrong ───────────────────────────────────

describe('Clean Record', () => {
    const def = byId('clean_record');

    test('a member who has never been warned earns it once they have been around 30 days', () => {
        const user = { createdAt: new Date(Date.now() - 31 * DAY) };
        expect(def.check(user)).toBe(true);
        expect(def.progress(user)).toEqual([30, 30]);
    });

    test('a member who joined today has not served the 30 days yet', () => {
        const user = { createdAt: new Date() };
        expect(def.check(user)).toBe(false);
        expect(def.progress(user)).toEqual([0, 30]);
    });

    test('a warning restarts the clock even on an old account', () => {
        const user = { createdAt: new Date(Date.now() - 400 * DAY), lastWarnedAt: new Date(Date.now() - DAY) };
        expect(def.check(user)).toBe(false);
        expect(def.progress(user)).toEqual([1, 30]);
    });

    test('30 days after the last warning it comes back', () => {
        const user = { createdAt: new Date(Date.now() - 400 * DAY), lastWarnedAt: new Date(Date.now() - 31 * DAY) };
        expect(def.check(user)).toBe(true);
    });

    test('a document carrying neither date stays locked rather than unlocking on epoch zero', () => {
        expect(def.check({})).toBe(false);
        expect(def.progress({})).toEqual([0, 30]);
    });
});

describe('checkAndAward runs to a fixed point', () => {
    const { checkAndAward } = require('../src/services/achievementService');
    const settings = { achievements: { enabled: true } };

    // Completionist is defined above the tiered hunt/angler/miner/gambler
    // badges, so a user whose twentieth non-secret unlock is one of those is
    // exactly the case a single ordered pass missed.
    const nonSecretIds = ACHIEVEMENTS.filter(a => !a.secret).map(a => a.id);
    const lateTierId = 'gambler_gold';

    test('Completionist lands in the same pass as the achievement that completes it', async () => {
        expect(nonSecretIds.indexOf(lateTierId)).toBeGreaterThan(
            ACHIEVEMENTS.findIndex(a => a.id === 'completionist'),
        );

        // Nineteen already banked, and a stat that unlocks a twentieth defined
        // below Completionist.
        const already = nonSecretIds.filter(id => id !== lateTierId).slice(0, 19);
        const user = {
            achievements: already.map(id => ({ id, earnedAt: new Date(), claimed: false })),
            achievementsCount: already.length,
            lifetimeGambled: 250_000,
        };

        const earned = await checkAndAward(user, settings);
        const earnedIds = earned.map(d => d.id);

        expect(earnedIds).toContain(lateTierId);
        expect(earnedIds).toContain('completionist');
    });

    test('nothing is awarded twice, however many passes it takes', async () => {
        const user = { achievements: [], achievementsCount: 0, balance: 2_000_000, bank: 2_000_000 };

        const earned = await checkAndAward(user, settings);
        const ids = earned.map(d => d.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(user.achievementsCount).toBe(user.achievements.length);
        expect(await checkAndAward(user, settings)).toEqual([]);
    });

    test('a disabled achievement is not awarded by a later pass either', async () => {
        const user = { achievements: [], achievementsCount: 0, balance: 500, bank: 0 };
        const disabled = { achievements: { enabled: true, disabledAchievements: ['first_steps'] } };

        const earned = await checkAndAward(user, disabled);
        expect(earned.map(d => d.id)).not.toContain('first_steps');
    });
});

describe('checkAndAwardAtomic writes the achievement fields and nothing else', () => {
    const { checkAndAwardAtomic } = require('../src/services/achievementService');
    const settings = { achievements: { enabled: true } };
    const filter = { userId: 'u', guildId: 'g' };

    test('a wager that crosses a threshold is persisted without saving the wallet', async () => {
        const User = { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
        const doc = { ...filter, achievements: [], achievementsCount: 0, lifetimeGambled: 1_000_000, save: jest.fn() };

        const earned = await checkAndAwardAtomic(User, filter, doc, settings);

        expect(earned.map(d => d.id)).toEqual(expect.arrayContaining(['high_roller']));
        expect(doc.save).not.toHaveBeenCalled();

        const [q, update] = User.updateOne.mock.calls[0];
        expect(q).toMatchObject(filter);
        expect(Object.keys(update)).toEqual(['$push', '$inc']);
        // Only the counter — a balance written back from a mid-hand read is the
        // hazard this helper exists to avoid.
        expect(Object.keys(update.$inc)).toEqual(['achievementsCount']);
    });

    test('the write refuses to run if the document already carries one of the ids', async () => {
        const User = { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
        const doc = { ...filter, achievements: [], achievementsCount: 0, lifetimeGambled: 1_000_000 };

        const earned = await checkAndAwardAtomic(User, filter, doc, settings);
        const [q] = User.updateOne.mock.calls[0];

        expect(q['achievements.id']).toEqual({ $nin: earned.map(d => d.id) });
    });

    test('losing the race to a concurrent hand announces nothing', async () => {
        const User = { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 0 }) };
        const doc = { ...filter, achievements: [], achievementsCount: 0, lifetimeGambled: 1_000_000 };

        expect(await checkAndAwardAtomic(User, filter, doc, settings)).toEqual([]);
    });

    test('nothing earned means no write at all', async () => {
        const User = { updateOne: jest.fn() };
        const doc = { ...filter, achievements: [], achievementsCount: 0, lifetimeGambled: 0, balance: 0, bank: 0 };

        expect(await checkAndAwardAtomic(User, filter, doc, settings)).toEqual([]);
        expect(User.updateOne).not.toHaveBeenCalled();
    });
});
