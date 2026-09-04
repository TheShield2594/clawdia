'use strict';

/**
 * #884. `chargeExact` and `refundCharge` are the all-or-nothing purchase
 * primitive and its compensating refund, and lcov had both of them at zero
 * executed lines — while every sibling in utils/balanceDebit.js (`debitUpTo`,
 * and `placeWager`/`payoutKey`/`balanceDelta` beside it) sat at 100%.
 *
 * They are what every /hunt, /fish and /mine shop purchase spends through, via
 * `grindWallet` in utils/grindShop.js, and those three command trees are at
 * 0-3% branch coverage themselves — so a regression in the pair had no net at
 * the primitive and no net at any of its call sites either.
 *
 * The three paths that matter are the ones a shop actually walks:
 *
 *   1. The filter misses because the coins are no longer there, and nothing is
 *      debited. This is the whole reason the check lives in the update's filter
 *      rather than beside it — the balance a command read to decide the player
 *      could afford something is stale the moment anything else pays them.
 *   2. The filter matches and exactly the price comes out. Not "up to" the
 *      price: a purchase is not a fine, and `debitUpTo`'s clamp would sell an
 *      item to someone who could not pay for it.
 *   3. The purchase is charged, the thing it bought fails to save, and the
 *      refund puts the coins back. That path is the entire reason
 *      `refundCharge` exists.
 *
 * Driven against the shared in-memory model rather than an assertion on the
 * filter's shape: a mock that cannot evaluate `balance: { $gte: cost }` cannot
 * tell case 1 from case 2, which is the distinction being tested.
 */

const mockUsers = require('./helpers/fakeCollection').fakeCollection('User', { balance: 0 });
jest.mock('../src/models/User', () => mockUsers.model);

const User = require('../src/models/User');
const { chargeExact, refundCharge } = require('../src/utils/balanceDebit');
const { walletOf, grindWallet } = require('../src/utils/grindShop');

const WALLET = { userId: 'u1', guildId: 'g1' };
const interaction = { user: { id: 'u1' }, guild: { id: 'g1' } };

let errors;

beforeEach(() => {
    mockUsers.reset();
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    errors.mockRestore();
});

describe('chargeExact', () => {
    test('takes exactly the price when the coins are there', async () => {
        mockUsers.seed({ ...WALLET, balance: 500 });

        const charged = await chargeExact(User, WALLET, 200);

        // The caller reads `balance` off the result and writes it back onto the
        // document it is about to save, so the post-image is what it must be.
        expect(charged?.balance).toBe(300);
        expect(mockUsers.get('u1').balance).toBe(300);
    });

    test('takes nothing when the coins have already moved', async () => {
        // The command decided this purchase was affordable and something else
        // spent the money in between; the filter is what notices.
        mockUsers.seed({ ...WALLET, balance: 100 });

        const charged = await chargeExact(User, WALLET, 200);

        expect(charged).toBeNull();
        expect(mockUsers.get('u1').balance).toBe(100);
    });

    test('sells at exactly the asking price — the guard is $gte, not $gt', async () => {
        // A player with the price and not a coin more can buy the thing. Off by
        // one in the other direction is a purchase refused for funds that are
        // there, which nobody would report as a bug in a shop.
        mockUsers.seed({ ...WALLET, balance: 200 });

        const charged = await chargeExact(User, WALLET, 200);

        expect(charged?.balance).toBe(0);
        expect(mockUsers.get('u1').balance).toBe(0);
    });

    test('never takes a member below zero, whatever order the calls land in', async () => {
        // Two purchases the player can afford one of. `$inc` will happily go
        // past zero on its own, so the second has to miss.
        mockUsers.seed({ ...WALLET, balance: 300 });

        const [first, second] = await Promise.all([
            chargeExact(User, WALLET, 200),
            chargeExact(User, WALLET, 200),
        ]);

        expect([first, second].filter(Boolean)).toHaveLength(1);
        expect(mockUsers.get('u1').balance).toBe(100);
    });

    test('charges a frozen member nothing, however much they hold (#870)', async () => {
        mockUsers.seed({ ...WALLET, balance: 5000, economyFrozen: true });

        const charged = await chargeExact(User, WALLET, 200);

        // Same null a filter miss gives, which is what makes every existing
        // caller handle a freeze without knowing it exists.
        expect(charged).toBeNull();
        expect(mockUsers.get('u1').balance).toBe(5000);
    });

    test('charges nothing when there is no wallet to charge', async () => {
        expect(await chargeExact(User, WALLET, 200)).toBeNull();
    });
});

describe('refundCharge', () => {
    test('puts back exactly what was taken', async () => {
        mockUsers.seed({ ...WALLET, balance: 500 });

        await chargeExact(User, WALLET, 200);
        await refundCharge(User, WALLET, 200, 'mineshop');

        expect(mockUsers.get('u1').balance).toBe(500);
    });

    test('refunds a member whose balance is now below the refund itself', async () => {
        // The refund is a credit, so it carries no `$gte` guard: by the time a
        // save fails the player may have spent what is left, and a guarded
        // refund would then quietly not happen.
        mockUsers.seed({ ...WALLET, balance: 200 });

        await chargeExact(User, WALLET, 200);
        await refundCharge(User, WALLET, 200, 'mineshop');

        expect(mockUsers.get('u1').balance).toBe(200);
    });

    test('says which caller a failed refund belongs to, and does not throw', async () => {
        // A refund that itself fails is the point at which a human has to go
        // looking, and the tag is how they know where. It must not throw on top
        // of the failure that caused it — the caller is already in a catch.
        mockUsers.seed({ ...WALLET, balance: 300 });
        User.updateOne.mockRejectedValueOnce(new Error('connection reset'));

        await expect(refundCharge(User, WALLET, 200, 'fishshop')).resolves.toBeUndefined();

        expect(errors).toHaveBeenCalledWith('[fishshop] refund error:', expect.any(Error));
    });

    test('falls back to a generic tag when a caller gives none', async () => {
        User.updateOne.mockRejectedValueOnce(new Error('connection reset'));

        await refundCharge(User, WALLET, 200);

        expect(errors).toHaveBeenCalledWith('[balance] refund error:', expect.any(Error));
    });
});

describe('a grind shop purchase (utils/grindShop.js)', () => {
    test('charges the buyer in the guild they bought in', async () => {
        mockUsers.seed({ ...WALLET, balance: 500 });
        mockUsers.seed({ userId: 'u1', guildId: 'g2', balance: 500 });

        const { chargeBalance } = grindWallet('mine');
        await chargeBalance(interaction, 200);

        expect(mockUsers.get('u1').balance).toBe(300);
        // Balances are per guild; a purchase in one server must not reach the
        // same player's wallet in another.
        expect(mockUsers.all().find(d => d.guildId === 'g2').balance).toBe(500);
        expect(walletOf(interaction)).toEqual(WALLET);
    });

    test('rolls the purchase back when what it bought will not save', async () => {
        // The sequence every shop subcommand runs: charge, apply the thing to
        // the profile, save, and on a failed save undo both halves.
        mockUsers.seed({ ...WALLET, balance: 500 });
        const { chargeBalance, refundBalance } = grindWallet('mine');

        const charged = await chargeBalance(interaction, 200);
        expect(charged.balance).toBe(300);

        const saveGrind = jest.fn().mockRejectedValue(new Error('write concern failed'));
        await expect(saveGrind()).rejects.toThrow();
        await refundBalance(interaction, 200);

        expect(mockUsers.get('u1').balance).toBe(500);
    });

    test('refuses the purchase rather than reporting one that did not happen', async () => {
        mockUsers.seed({ ...WALLET, balance: 150 });

        const { chargeBalance } = grindWallet('hunt');

        expect(await chargeBalance(interaction, 200)).toBeNull();
        expect(mockUsers.get('u1').balance).toBe(150);
    });

    test('attributes a failed refund to the shop that failed it', async () => {
        for (const activity of ['hunt', 'fish', 'mine']) {
            User.updateOne.mockRejectedValueOnce(new Error('connection reset'));
            await grindWallet(activity).refundBalance(interaction, 200);
            expect(errors).toHaveBeenCalledWith(`[${activity}shop] refund error:`, expect.any(Error));
        }
    });
});
