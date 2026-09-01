'use strict';

/**
 * #873. A duel holds both players' stakes in escrow and then puts them
 * somewhere, and every one of the three ways it could go wrong was live:
 *
 *   - The pot was paid, something *after* it threw — the two balance reads for
 *     the result embed were enough — and the caller's only recovery is
 *     `refundEscrow`, which handed both stakes back on top of a settled duel.
 *     `2 x amount` minted, per failure.
 *   - The escrow rollback, when the opponent's stake could not be taken, was a
 *     bare unchecked `updateOne`. A rejection travelled out to a caller that had
 *     already decided no escrow was taken, and refunded nothing; an update that
 *     matched no document did not even reject. Either way the challenger's stake
 *     was gone.
 *   - Every refund path told the players "both bets have been refunded"
 *     regardless of what the two writes did.
 *
 * These drive the escrow and the settlement directly, because that is where all
 * of the coins are.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, paidPayouts: [], duelWins: 0, duelLosses: 0, lifetimeGambled: 0,
});

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({})) }));
jest.mock('../src/services/districtService', () => ({ isDistrictActive: jest.fn(() => false) }));
jest.mock('../src/services/seasonMissionService', () => ({ advanceMissions: jest.fn(async () => {}) }));

const { recordOwedPayout } = require('../src/utils/owedPayout');
const { advanceMissions } = require('../src/services/seasonMissionService');
const { takeEscrow, refundEscrow, refundNote, finalizeDuel } =
    require('../src/commands/economy/duel').__test__;

const seedEscrowed = userId =>
    mockUsers.seed({ userId, guildId: GUILD, balance: 0, lifetimeGambled: BET });

// The store's own implementations, captured before any test replaces one.
// `mockUsers.reset()` clears call records but leaves a `mockImplementation`
// standing, so a test that makes a write fail would make it fail for every test
// after it.
const storeImpl = new Map(Object.entries(mockUsers.model)
    .filter(([, fn]) => typeof fn?.getMockImplementation === 'function')
    .map(([name, fn]) => [name, fn.getMockImplementation()]));
const restoreStore = () => {
    for (const [name, impl] of storeImpl) mockUsers.model[name].mockImplementation(impl);
};

const GUILD = 'guild-1';
const CH    = 'user-1';       // challenger — the fake interaction's own user
const OP    = 'user-2';
const DUEL  = 'duel-1';
const BET   = 100;

const seed = (userId, balance) => mockUsers.seed({ userId, guildId: GUILD, balance });
const balanceOf = userId => mockUsers.get(userId)?.balance;

/** `finalizeDuel` with the arguments both game runners pass it. */
function settle({ tie = false, challengerWins = true } = {}) {
    const interaction = makeInteraction({ guildId: GUILD, userId: CH });
    const targetUser = { id: OP, username: 'rival', displayAvatarURL: () => 'x' };
    return finalizeDuel({
        interaction, targetUser, challengerId: CH, opponentId: OP,
        amount: BET, currency: '💰', houseCut: 0.1,
        challengerWins, tie, game: 'coinflip', gameResult: 'flip', duelId: DUEL,
    }).then(() => interaction);
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    restoreStore();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('taking the escrow', () => {
    test('takes both stakes when both players can cover them', async () => {
        seed(CH, 500); seed(OP, 500);

        await expect(takeEscrow(CH, OP, GUILD, BET, DUEL)).resolves.toMatchObject({ success: true });

        expect([balanceOf(CH), balanceOf(OP)]).toEqual([400, 400]);
    });

    test('takes nothing when the challenger is short', async () => {
        seed(CH, 10); seed(OP, 500);

        await expect(takeEscrow(CH, OP, GUILD, BET, DUEL))
            .resolves.toMatchObject({ success: false, reason: 'challenger' });
        expect([balanceOf(CH), balanceOf(OP)]).toEqual([10, 500]);
    });

    test('gives the challenger their stake back when the opponent is short', async () => {
        seed(CH, 500); seed(OP, 10);

        const result = await takeEscrow(CH, OP, GUILD, BET, DUEL);

        expect(result).toMatchObject({ reason: 'opponent', returned: { refunded: true } });
        expect(balanceOf(CH)).toBe(500);
    });

    test('does not throw the rollback failure at a caller that will not refund', async () => {
        seed(CH, 500); seed(OP, 10);
        // The rollback used to be an unguarded `await`, so this rejection
        // escaped `takeEscrow` into a catch that had `escrowTaken` false.
        // The store's own implementation, not the mock wrapping it: calling
        // the mock from inside its own replacement recurses forever.
        const store = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate.mockImplementation(async (filter, update, options) => {
            // The credit is the only pipeline update in this flow; the two
            // debits above it are operator updates and go through untouched.
            if (Array.isArray(update)) throw new Error('mongo is down');
            return store(filter, update, options);
        });

        const result = await takeEscrow(CH, OP, GUILD, BET, DUEL);

        expect(result).toMatchObject({ reason: 'opponent', returned: { refunded: false, owed: true } });
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ kind: 'coins', userId: CH, amount: BET }),
        }));
    });
});

describe('a debit that rejects mid-escrow', () => {
    test('gives back the stake the first debit had already taken', async () => {
        // The first debit returned a document, so it committed. The rejection
        // used to travel out to a handler whose `escrowTaken` was still false,
        // which refunded nothing and left that stake gone.
        seed(CH, 500); seed(OP, 500);
        const store = mockUsers.model.findOneAndUpdate.getMockImplementation();
        let debits = 0;
        mockUsers.model.findOneAndUpdate.mockImplementation(async (filter, update, options) => {
            if (!Array.isArray(update) && ++debits === 2) throw new Error('mongo is down');
            return store(filter, update, options);
        });

        const result = await takeEscrow(CH, OP, GUILD, BET, DUEL);

        expect(result).toMatchObject({ success: false, reason: 'error', returned: { refunded: true } });
        expect([balanceOf(CH), balanceOf(OP)]).toEqual([500, 500]);
    });

    test('does not reject at the caller', async () => {
        seed(CH, 500); seed(OP, 500);
        const store = mockUsers.model.findOneAndUpdate.getMockImplementation();
        let debits = 0;
        mockUsers.model.findOneAndUpdate.mockImplementation(async (filter, update, options) => {
            if (!Array.isArray(update) && ++debits === 2) throw new Error('mongo is down');
            return store(filter, update, options);
        });

        await expect(takeEscrow(CH, OP, GUILD, BET, DUEL)).resolves.toBeDefined();
    });
});

describe('refunding the escrow', () => {
    test('returns both stakes', async () => {
        seed(CH, 0); seed(OP, 0);

        await expect(refundEscrow(CH, OP, GUILD, BET, DUEL))
            .resolves.toEqual({ refunded: true, owed: false });
        expect([balanceOf(CH), balanceOf(OP)]).toEqual([100, 100]);
    });

    test('does not report a refund that reached nobody', async () => {
        // Neither player has a document, so both credits match nothing — which
        // is the case a bare `updateOne` reports as a success.
        await expect(refundEscrow(CH, OP, GUILD, BET, DUEL))
            .resolves.toEqual({ refunded: false, owed: true });
    });

    test('still refunds the second player when the first cannot be paid', async () => {
        seed(OP, 0);   // the challenger has no document; the opponent does

        const result = await refundEscrow(CH, OP, GUILD, BET, DUEL);

        expect(result.refunded).toBe(false);
        expect(balanceOf(OP)).toBe(100);
    });
});

describe('what the players are told about a refund', () => {
    test('says both bets are back only when they are', () => {
        expect(refundNote({ refunded: true, owed: false })).toContain('refunded');
    });

    test('says so when the coins are recorded rather than returned', () => {
        expect(refundNote({ refunded: false, owed: true })).toContain('recorded');
    });

    test('sends the player to an admin when nothing was recorded either', () => {
        expect(refundNote({ refunded: false, owed: false })).toContain('admin');
    });
});

describe('settling a decided duel', () => {
    test('pays the winner the pot less the house cut', async () => {
        seed(CH, 0); seed(OP, 0);   // both stakes are already in escrow

        await settle({ challengerWins: true });

        expect(balanceOf(CH)).toBe(180);      // 200 pot - 10%
        expect(balanceOf(OP)).toBe(0);
    });

    test('records the win and the loss', async () => {
        seed(CH, 0); seed(OP, 0);

        await settle({ challengerWins: true });

        expect(mockUsers.get(CH).duelWins).toBe(1);
        expect(mockUsers.get(OP).duelLosses).toBe(1);
    });

    test('a failure after the pot is paid does not reach the caller', async () => {
        seed(CH, 0); seed(OP, 0);
        // The result embed's balance reads. These used to be inside the same
        // sequence the caller's catch wraps, and that catch refunds the escrow.
        mockUsers.model.findOne.mockImplementation(() => { throw new Error('mongo is down'); });

        await expect(settle({ challengerWins: true })).resolves.toBeDefined();

        // Paid exactly once, and no stake handed back on top of it.
        expect(balanceOf(CH)).toBe(180);
        expect(balanceOf(OP)).toBe(0);
    });

    test('does not announce a win it could not pay', async () => {
        // No document for the winner, so the payout matches nothing.
        seed(OP, 0);

        const interaction = await settle({ challengerWins: true });

        const text = repliedText(interaction);
        expect(text).toContain('could not be paid out');
        expect(text).toContain('recorded');
        expect(recordOwedPayout).toHaveBeenCalled();
    });

    test('does not tick the "win a duel" mission for a pot that never arrived', async () => {
        seed(OP, 0);

        await settle({ challengerWins: true });

        expect(advanceMissions).not.toHaveBeenCalled();
    });
});

describe('settling a tie', () => {
    test('returns both stakes', async () => {
        seed(CH, 0); seed(OP, 0);

        await settle({ tie: true });

        expect([balanceOf(CH), balanceOf(OP)]).toEqual([100, 100]);
    });

    test('leaves the wager counted — the duel was fought', async () => {
        // A tie is a push, not a duel that never happened, so the stakes stay
        // on `lifetimeGambled`. The refund paths that mean "this never
        // happened" take it back; this one must not.
        seedEscrowed(CH); seedEscrowed(OP);

        await settle({ tie: true });

        expect([mockUsers.get(CH).lifetimeGambled, mockUsers.get(OP).lifetimeGambled])
            .toEqual([BET, BET]);
    });

    test('still returns the second stake when the first cannot be returned', async () => {
        // The challenger has no document; the pair used to share one
        // `Promise.all`, which abandons the second write on the first failure.
        seed(OP, 0);

        const interaction = await settle({ tie: true });

        expect(balanceOf(OP)).toBe(100);
        expect(repliedText(interaction)).not.toContain('Both bets have been refunded');
    });
});
