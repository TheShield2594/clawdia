'use strict';

// /coinflip's PvP wager runs entirely inside a component collector, long after
// execute() returned — so nothing above it is catching errors, and both stakes
// are already out of the players' wallets when one can be thrown. These cover
// the rule that matters: coins the bot took must never simply vanish.

jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/Transaction', () => ({ create: jest.fn().mockResolvedValue({}) }));

const User = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const { __test__ } = require('../src/commands/fun/coinflip');
const { escrowWagers, payoutState, refund, flip, other, pip } = __test__;

const GUILD = 'guild-1';
const CHALLENGER = 'user-a';
const OPPONENT = 'user-b';
const BET = 100;

const wallet = balance => ({ balance });

// The debit is a conditional update: it matches only when the balance covers
// the bet, and returns null when it doesn't.
const debitOf = call => call[0];
const incOf = call => call[1].$inc.balance;

let errorSpy;
beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('escrowWagers', () => {
    test('takes both stakes when both sides can cover', async () => {
        User.findOneAndUpdate
            .mockResolvedValueOnce(wallet(400))
            .mockResolvedValueOnce(wallet(900));

        const result = await escrowWagers(GUILD, CHALLENGER, OPPONENT, BET);

        expect(result).toMatchObject({ ok: true });
        expect(result.challengerDoc).toEqual(wallet(400));
        expect(result.opponentDoc).toEqual(wallet(900));
        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(2);

        for (const call of User.findOneAndUpdate.mock.calls) {
            expect(debitOf(call)).toMatchObject({ guildId: GUILD, balance: { $gte: BET } });
            expect(incOf(call)).toBe(-BET);
        }
    });

    test('takes nothing when the challenger is short', async () => {
        User.findOneAndUpdate.mockResolvedValueOnce(null);

        const result = await escrowWagers(GUILD, CHALLENGER, OPPONENT, BET);

        expect(result).toEqual({ ok: false, short: 'challenger' });
        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    test('returns the challenger stake when the opponent is short', async () => {
        User.findOneAndUpdate
            .mockResolvedValueOnce(wallet(400)) // challenger debited
            .mockResolvedValueOnce(null)        // opponent can't cover
            .mockResolvedValueOnce(wallet(500)); // refund

        const result = await escrowWagers(GUILD, CHALLENGER, OPPONENT, BET);

        expect(result).toEqual({ ok: false, short: 'opponent' });
        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(3);

        const refundCall = User.findOneAndUpdate.mock.calls[2];
        expect(debitOf(refundCall)).toMatchObject({ userId: CHALLENGER, guildId: GUILD });
        expect(incOf(refundCall)).toBe(BET);
    });

    test('returns the challenger stake when the opponent debit throws', async () => {
        const boom = new Error('connection reset');
        User.findOneAndUpdate
            .mockResolvedValueOnce(wallet(400))
            .mockRejectedValueOnce(boom)
            .mockResolvedValueOnce(wallet(500)); // refund

        const result = await escrowWagers(GUILD, CHALLENGER, OPPONENT, BET);

        expect(result).toEqual({ ok: false, error: boom, refunded: 'challenger' });

        const refundCall = User.findOneAndUpdate.mock.calls[2];
        expect(debitOf(refundCall)).toMatchObject({ userId: CHALLENGER });
        expect(incOf(refundCall)).toBe(BET);
    });

    test('refunds nothing when the very first debit throws', async () => {
        const boom = new Error('connection reset');
        User.findOneAndUpdate.mockRejectedValueOnce(boom);

        const result = await escrowWagers(GUILD, CHALLENGER, OPPONENT, BET);

        expect(result).toEqual({ ok: false, error: boom });
        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    test('reports the failure to the caller rather than throwing at the collector', async () => {
        // Single-use: clearAllMocks() resets calls but not implementations, so a
        // permanent rejection here would follow the mock into later tests.
        User.findOneAndUpdate.mockRejectedValueOnce(new Error('down'));
        await expect(escrowWagers(GUILD, CHALLENGER, OPPONENT, BET)).resolves.toMatchObject({ ok: false });
    });

    test('tells the caller when it put the challenger\'s stake back', async () => {
        User.findOneAndUpdate
            .mockResolvedValueOnce(wallet(400))
            .mockRejectedValueOnce(new Error('connection reset'))
            .mockResolvedValueOnce(wallet(500));

        // Without this the collector reports a bare failure and the challenger
        // is left assuming their coins are gone.
        const result = await escrowWagers(GUILD, CHALLENGER, OPPONENT, BET);
        expect(result.refunded).toBe('challenger');
    });

    test('claims no refund when it never took anything', async () => {
        User.findOneAndUpdate.mockRejectedValueOnce(new Error('connection reset'));
        const result = await escrowWagers(GUILD, CHALLENGER, OPPONENT, BET);
        expect(result.refunded).toBeUndefined();
    });
});

describe('refund', () => {
    test('credits the coins back and leaves an audit trail', async () => {
        User.findOneAndUpdate.mockResolvedValueOnce(wallet(500));

        await refund(CHALLENGER, GUILD, BET, 'wager returned');

        expect(incOf(User.findOneAndUpdate.mock.calls[0])).toBe(BET);
        expect(Transaction.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: CHALLENGER, guildId: GUILD, type: 'coinflip', amount: BET, balance: 500, note: 'wager returned',
        }));
    });

    test('never throws — it runs while another failure is already being handled', async () => {
        User.findOneAndUpdate.mockRejectedValueOnce(new Error('still down'));
        await expect(refund(CHALLENGER, GUILD, BET, 'wager returned')).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
    });
});

describe('payoutState', () => {
    const BEFORE = 400;
    const PAYOUT = 190;

    test('recognises a payout that landed despite the error', async () => {
        User.findOne.mockResolvedValueOnce(wallet(BEFORE + PAYOUT));
        await expect(payoutState(CHALLENGER, GUILD, BEFORE, PAYOUT)).resolves.toBe('applied');
    });

    test('recognises a payout that never landed', async () => {
        User.findOne.mockResolvedValueOnce(wallet(BEFORE));
        await expect(payoutState(CHALLENGER, GUILD, BEFORE, PAYOUT)).resolves.toBe('not-applied');
    });

    test('refuses to guess when something else moved the balance', async () => {
        User.findOne.mockResolvedValueOnce(wallet(BEFORE + 25));
        await expect(payoutState(CHALLENGER, GUILD, BEFORE, PAYOUT)).resolves.toBe('unknown');
    });

    test('refuses to guess when the balance cannot be read at all', async () => {
        User.findOne.mockRejectedValueOnce(new Error('still down'));
        await expect(payoutState(CHALLENGER, GUILD, BEFORE, PAYOUT)).resolves.toBe('unknown');

        User.findOne.mockResolvedValueOnce(null);
        await expect(payoutState(CHALLENGER, GUILD, BEFORE, PAYOUT)).resolves.toBe('unknown');
    });

    test('refuses to guess without a balance to compare against', async () => {
        await expect(payoutState(CHALLENGER, GUILD, undefined, PAYOUT)).resolves.toBe('unknown');
        expect(User.findOne).not.toHaveBeenCalled();
    });
});

describe('coin', () => {
    test('lands on one of two sides, both reachable', () => {
        const seen = new Set();
        for (let i = 0; i < 500; i++) seen.add(flip());
        expect([...seen].sort()).toEqual(['Heads', 'Tails']);
    });

    test('sides are each other’s opposite and carry distinct pips', () => {
        expect(other('Heads')).toBe('Tails');
        expect(other('Tails')).toBe('Heads');
        expect(pip('Heads')).not.toBe(pip('Tails'));
    });
});
