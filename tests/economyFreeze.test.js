'use strict';

/**
 * #870. `economyFrozen` was set by the dashboard and read by nothing.
 *
 * Four references in all of `src/`: the schema field, the two `$set`s in the
 * dashboard's adjust route, and the value echoed back in its response. No
 * command, event handler or wager path looked at it — so a "frozen" member kept
 * earning, gambling, gifting and transferring, while the endpoint answered
 * `success: true` and the audit log recorded a sanction that did not exist.
 *
 * The enforcement has two layers and the tests below are grouped the same way.
 * The filters are the guarantee — they hold for a path with no command behind
 * it and for a freeze that lands mid-flight — and the command gate is what stops
 * a frozen member *earning*, which no filter can do without making a refused
 * credit look like a failed one.
 *
 * The last group is the exemption list. It is the one part of this that can rot
 * quietly: a command on it that grows a coin write re-opens the hole with
 * nothing failing, so the list is checked against the sources rather than
 * against a comment.
 */

const fs   = require('fs');
const path = require('path');

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, inventory: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));

const {
    NOT_FROZEN, unfrozen, isEconomyFrozen, commandIsFreezeGated,
    FREEZE_EXEMPT_COMMANDS, FROZEN_NOTICE, FREEZE_UNKNOWN_NOTICE, frozenTargetNotice,
} = require('../src/utils/economyFreeze');
const { chargeExact, debitUpTo } = require('../src/utils/balanceDebit');
const { placeWager } = require('../src/utils/placeWager');
const { commitCoinTransfer, coinBudgets, frozenRefusal } = require('../src/utils/coinTransfer');
const { GIFT_LIMIT_DEFAULTS } = require('../src/utils/giftCaps');

const User = mockUsers.model;

const GUILD  = 'guild-1';
const PLAYER = 'player-1';
const OTHER  = 'player-2';

const seed = (userId, fields) => mockUsers.seed({ userId, guildId: GUILD, ...fields });
const filter = userId => ({ userId, guildId: GUILD });
const balanceOf = async userId => (await User.findOne(filter(userId)))?.balance;

beforeEach(() => mockUsers.reset());

describe('the guard clause itself', () => {
    // A field added to the schema after the fact is simply absent from every
    // document written before it, and `{ economyFrozen: false }` matches none of
    // them — which would freeze the entire pre-existing player base.
    test('passes a document with no economyFrozen field at all', async () => {
        seed(PLAYER, { balance: 100 });
        expect(await User.findOne(unfrozen(filter(PLAYER)))).not.toBeNull();
    });

    test('passes an explicitly unfrozen member and refuses a frozen one', async () => {
        seed(PLAYER, { balance: 100, economyFrozen: false });
        seed(OTHER,  { balance: 100, economyFrozen: true });

        expect(await User.findOne(unfrozen(filter(PLAYER)))).not.toBeNull();
        expect(await User.findOne(unfrozen(filter(OTHER)))).toBeNull();
    });

    test('leaves the caller\'s own filter intact', () => {
        expect(unfrozen({ userId: PLAYER, balance: { $gte: 5 } }))
            .toEqual({ userId: PLAYER, balance: { $gte: 5 }, ...NOT_FROZEN });
    });
});

describe('the shared debits refuse a frozen member', () => {
    // Each of these is the whole of a subsystem's spending: chargeExact is every
    // purchase, debitUpTo every capped fine, placeWager every casino stake. A
    // guard in the filter of the three of them is what makes the freeze hold for
    // a button or a collector that never passes the command gate.
    test('chargeExact takes nothing', async () => {
        seed(PLAYER, { balance: 500, economyFrozen: true });

        expect(await chargeExact(User, filter(PLAYER), 100)).toBeNull();
        expect(await balanceOf(PLAYER)).toBe(500);
    });

    test('chargeExact still charges an unfrozen member', async () => {
        seed(PLAYER, { balance: 500 });

        expect(await chargeExact(User, filter(PLAYER), 100)).not.toBeNull();
        expect(await balanceOf(PLAYER)).toBe(400);
    });

    test('debitUpTo reports no match rather than a zero fine', async () => {
        seed(PLAYER, { balance: 500, economyFrozen: true });

        // `matched: false` and not `taken: 0` on a match: the two mean different
        // things to a caller, and a frozen member was never charged at all.
        expect(await debitUpTo(User, filter(PLAYER), 100)).toEqual({ taken: 0, balance: 0, matched: false });
        expect(await balanceOf(PLAYER)).toBe(500);
    });

    test('placeWager places no bet and raises no wager signal', async () => {
        seed(PLAYER, { balance: 500, economyFrozen: true });
        const onWager = jest.fn();

        expect(await placeWager(filter(PLAYER), 100, { onWager })).toBeNull();
        expect(onWager).not.toHaveBeenCalled();
        expect(await balanceOf(PLAYER)).toBe(500);
    });

    test('placeWager leaves lifetimeGambled alone too', async () => {
        // The stake and the achievement counter are one write, so a refused
        // stake must not advance the counter behind High Roller either.
        seed(PLAYER, { balance: 500, lifetimeGambled: 40, economyFrozen: true });

        await placeWager(filter(PLAYER), 100);

        expect((await User.findOne(filter(PLAYER))).lifetimeGambled).toBe(40);
    });
});

describe('coin transfers', () => {
    const LIMITS = { ...GIFT_LIMIT_DEFAULTS };

    async function transfer() {
        const [senderDoc, receiverDoc] = await Promise.all([
            User.findOne(filter(PLAYER)),
            User.findOne(filter(OTHER)),
        ]);
        return commitCoinTransfer({
            senderId: PLAYER, receiverId: OTHER, guildId: GUILD,
            amount: 100, limits: LIMITS,
            budgets: coinBudgets(senderDoc, receiverDoc, LIMITS),
            refundKey: 'interaction-1',
        });
    }

    test('a frozen sender moves nothing', async () => {
        seed(PLAYER, { balance: 500, economyFrozen: true });
        seed(OTHER,  { balance: 0 });

        expect(await transfer()).toEqual({ status: 'debit_failed' });
        expect(await balanceOf(PLAYER)).toBe(500);
        expect(await balanceOf(OTHER)).toBe(0);
    });

    // The debit has already committed by the time the credit is attempted, so
    // this is the case where the rollback has to work: refusing the credit and
    // stopping there would destroy the sender's coins, which is the exact
    // failure #868 was about.
    test('a frozen receiver gets nothing and the sender is made whole', async () => {
        seed(PLAYER, { balance: 500 });
        seed(OTHER,  { balance: 0, economyFrozen: true });

        expect(await transfer()).toMatchObject({ refunded: true, owed: false });
        expect(await balanceOf(PLAYER)).toBe(500);
        expect(await balanceOf(OTHER)).toBe(0);
    });

    test('the pre-flight names whichever party is frozen', () => {
        const frozen = { economyFrozen: true };
        const fine   = { economyFrozen: false };

        expect(frozenRefusal(frozen, fine, { mention: '<@2>' })).toBe(FROZEN_NOTICE);
        expect(frozenRefusal(fine, frozen, { mention: '<@2>' })).toBe(frozenTargetNotice('<@2>'));
        expect(frozenRefusal(fine, fine, { mention: '<@2>' })).toBeNull();
    });

    // Both call sites read the two documents with `findOne`, which answers null
    // for a member who has never run a command here.
    test('the pre-flight tolerates a party with no document', () => {
        expect(frozenRefusal(null, null, { mention: '<@2>' })).toBeNull();
    });
});

describe('the command gate', () => {
    const command = (name, category) => ({ data: { name }, category });

    test('covers the economy category', () => {
        expect(commandIsFreezeGated(command('daily', 'economy'))).toBe(true);
    });

    test('leaves other categories alone', () => {
        expect(commandIsFreezeGated(command('ban', 'moderation'))).toBe(false);
        expect(commandIsFreezeGated(command('help', 'utility'))).toBe(false);
    });

    test('is default-deny: an economy command nobody exempted is gated', () => {
        expect(commandIsFreezeGated(command('a-command-added-tomorrow', 'economy'))).toBe(true);
    });

    test('lets the read-only views through', () => {
        for (const name of FREEZE_EXEMPT_COMMANDS) {
            expect([name, commandIsFreezeGated(command(name, 'economy'))]).toEqual([name, false]);
        }
    });

    test('reads the flag off the member, projected', async () => {
        seed(PLAYER, { balance: 1, economyFrozen: true });
        seed(OTHER,  { balance: 1 });

        expect(await isEconomyFrozen(filter(PLAYER))).toBe(true);
        expect(await isEconomyFrozen(filter(OTHER))).toBe(false);
    });

    // A first-time player has no row, and a gate that read that as frozen would
    // stand between them and every economy command they have never run.
    test('a member with no document is not frozen', async () => {
        expect(await isEconomyFrozen(filter('never-played'))).toBe(false);
    });

    // The gate fails closed, so this rejection is what refuses the command. It
    // has to reach the caller rather than being swallowed into a false.
    test('a read that cannot answer rejects rather than answering false', async () => {
        User.findOne.mockImplementationOnce(() => { throw new Error('mongo is down'); });

        await expect(isEconomyFrozen(filter(PLAYER))).rejects.toThrow('mongo is down');
    });

    // Failing closed is only tolerable if the member is not told they are
    // sanctioned: that sends them to an admin who will find nothing to lift.
    test('the unknown-state notice does not claim the member is frozen', () => {
        expect(FREEZE_UNKNOWN_NOTICE).not.toBe(FROZEN_NOTICE);
        expect(FREEZE_UNKNOWN_NOTICE.toLowerCase()).not.toContain('frozen');
        expect(FROZEN_NOTICE.toLowerCase()).toContain('frozen');
    });
});

describe('the exemption list', () => {
    const ECONOMY_DIR = path.join(__dirname, '..', 'src', 'commands', 'economy');

    /** Every source file a command name covers — a file, or a whole folder. */
    function sourcesFor(name) {
        const single = path.join(ECONOMY_DIR, `${name}.js`);
        if (fs.existsSync(single)) return [single];

        const folder = path.join(ECONOMY_DIR, name);
        if (!fs.existsSync(folder)) return [];
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) return walk(full);
            return e.name.endsWith('.js') ? [full] : [];
        });
        return walk(folder);
    }

    test('every exempt name is a real economy command', () => {
        for (const name of FREEZE_EXEMPT_COMMANDS) {
            expect([name, sourcesFor(name).length > 0]).toEqual([name, true]);
        }
    });

    // The rule the list is kept to, checked rather than described. `create` and
    // an empty `$setOnInsert` upsert are allowed: `/balance` and `/synergies`
    // create the member's own empty row, which is what any read of theirs would
    // do and is not a payment.
    test('no exempt command moves coins, items or progress', () => {
        const MOVES = /\$inc\b|\$push\b|\$pull\b|\$addToSet\b|\.save\(|placeWager|chargeExact|debitUpTo|commitCoinTransfer|commitBalanceDelta|applyBalanceDelta|creditCoins|grantInventoryItem/;

        for (const name of FREEZE_EXEMPT_COMMANDS) {
            for (const file of sourcesFor(name)) {
                const offending = fs.readFileSync(file, 'utf8')
                    .split('\n')
                    // Comments describe writes as often as they make them.
                    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
                    .filter(line => MOVES.test(line));
                expect([path.relative(ECONOMY_DIR, file), offending]).toEqual([path.relative(ECONOMY_DIR, file), []]);
            }
        }
    });
});
