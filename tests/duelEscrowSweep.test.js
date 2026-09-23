'use strict';

/**
 * #873 — the sweep that hands back duel stakes a restart stranded in escrow.
 *
 * A duel's stakes are two keyed debits taken at accept; the duel itself lives
 * only in collectors. The sweep may reverse an escrow only for a duel that never
 * settled, and "an escrow still standing" is not that: a won duel leaves the
 * loser's standing for good. The store evaluates the reversal's key guard for
 * real, so "exactly once" is the helper's answer, not a mock's.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [], spentDebits: [], lifetimeGambled: 0 });
const mockPending = fakeCollection('PendingDuel', {}, { unique: ['duelId'] });
const mockOwed = { record: null };

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/PendingDuel', () => mockPending.model);
jest.mock('../src/models/FailedJob', () => ({
    findOne: jest.fn(query => ({
        lean: async () => {
            const re = new RegExp(query['payload.payoutKey'].$regex);
            return mockOwed.record && re.test(mockOwed.record.payload.payoutKey) ? mockOwed.record : null;
        },
    })),
}));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/sharding', () => ({
    ...jest.requireActual('../src/utils/sharding'),
    handlesGuild: jest.fn(guildId => guildId !== 'other-shard-guild'),
}));

const { sweepStrandedDuels, notePendingDuel, STRANDED_AFTER_MS } = require('../src/services/duelEscrowSweep');
const { logTransaction } = require('../src/utils/logTransaction');

const GUILD = 'guild-1';
const CH = 'challenger';
const OP = 'opponent';
const BET = 100;
const DUEL = 'challenger_1700000000000';
const OLD = () => new Date(Date.now() - STRANDED_AFTER_MS - 60_000);

const escrow = (userId, extra = {}) => ({ key: `duel:${DUEL}:escrow:${userId}`, at: OLD(), ...extra });
const balanceOf = id => mockUsers.get(id)?.balance;
const pendingLeft = () => mockPending.all().length;

function seedDuel({ guildId = GUILD, createdAt = OLD(), challenger = {}, opponent = {} } = {}) {
    mockPending.seed({ _id: 'p1', duelId: DUEL, guildId, challengerId: CH, opponentId: OP, amount: BET, createdAt });
    mockUsers.seed({ userId: CH, guildId, balance: 900, spentDebits: [escrow(CH)], ...challenger });
    mockUsers.seed({ userId: OP, guildId, balance: 900, spentDebits: [escrow(OP)], ...opponent });
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockUsers.reset();
    mockPending.reset();
    mockOwed.record = null;
});

afterEach(() => jest.restoreAllMocks());

test('a stranded pair is handed back exactly once, however many sweeps run', async () => {
    seedDuel();

    expect(await sweepStrandedDuels()).toMatchObject({ refunded: 1 });
    await sweepStrandedDuels();

    expect(balanceOf(CH)).toBe(1_000);
    expect(balanceOf(OP)).toBe(1_000);
    expect(mockUsers.get(CH).spentDebits[0].reversed).toBe(true);
    expect(logTransaction).toHaveBeenCalledTimes(2);
    expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ userId: CH, type: 'duel_refund', amount: BET, balance: 1_000 }));
    expect(pendingLeft()).toBe(0);
});

test('two sweeps racing hand the stakes back once', async () => {
    seedDuel();

    await Promise.all([sweepStrandedDuels(), sweepStrandedDuels()]);

    expect(balanceOf(CH)).toBe(1_000);
    expect(balanceOf(OP)).toBe(1_000);
});

test('a won duel is left alone: the loser\'s escrow standing is the pot, paid to the winner', async () => {
    seedDuel({ challenger: { paidPayouts: [{ key: `duel:${DUEL}:payout:${CH}`, at: new Date() }] } });

    expect(await sweepStrandedDuels()).toMatchObject({ settled: 1, refunded: 0 });

    expect(balanceOf(CH)).toBe(900);
    expect(balanceOf(OP)).toBe(900);
    expect(pendingLeft()).toBe(0);
});

test('a tie is left alone: its stakes came back as refunds, not reversals', async () => {
    seedDuel({
        challenger: { paidPayouts: [{ key: `duel:${DUEL}:refund:${CH}` }] },
        opponent:   { paidPayouts: [{ key: `duel:${DUEL}:refund:${OP}` }] },
    });

    await sweepStrandedDuels();

    expect([balanceOf(CH), balanceOf(OP)]).toEqual([900, 900]);
});

test('a payout recorded as owed is left for the replay, not paid again as refunds', async () => {
    seedDuel();
    mockOwed.record = { jobName: 'duelPayout.owed', payload: { kind: 'coins', payoutKey: `duel:${DUEL}:payout:${OP}` } };

    expect(await sweepStrandedDuels()).toMatchObject({ settled: 1, refunded: 0 });

    expect([balanceOf(CH), balanceOf(OP)]).toEqual([900, 900]);
});

test('an owed record for another duel does not count', async () => {
    seedDuel();
    mockOwed.record = { payload: { payoutKey: `duel:${DUEL}0:payout:${OP}` } };

    await sweepStrandedDuels();

    expect([balanceOf(CH), balanceOf(OP)]).toEqual([1_000, 1_000]);
});

test('a duel young enough to still be running is not judged', async () => {
    seedDuel({ createdAt: new Date(Date.now() - STRANDED_AFTER_MS + 60_000) });

    await sweepStrandedDuels();

    expect([balanceOf(CH), balanceOf(OP)]).toEqual([900, 900]);
    expect(pendingLeft()).toBe(1);
});

test("another shard's guild is left to that shard", async () => {
    seedDuel({ guildId: 'other-shard-guild' });

    await sweepStrandedDuels();

    expect([balanceOf(CH), balanceOf(OP)]).toEqual([900, 900]);
    expect(pendingLeft()).toBe(1);
});

test('a half-finished escrow rollback is completed: the reversed stake is kept, the standing one handed back', async () => {
    // takeEscrow reversed the challenger's stake when the opponent's could not
    // be taken, and the opponent's own rollback was never confirmed.
    seedDuel({ challenger: { balance: 1_000, spentDebits: [escrow(CH, { reversed: true })] } });

    await sweepStrandedDuels();

    expect(balanceOf(CH)).toBe(1_000);
    expect(balanceOf(OP)).toBe(1_000);
});

test('a duel whose stakes were never taken is simply cleared', async () => {
    seedDuel({ challenger: { balance: 1_000, spentDebits: [] }, opponent: { balance: 1_000, spentDebits: [] } });

    expect(await sweepStrandedDuels()).toMatchObject({ settled: 1 });

    expect([balanceOf(CH), balanceOf(OP)]).toEqual([1_000, 1_000]);
    expect(pendingLeft()).toBe(0);
});

test('notePendingDuel records the stake, and never throws', async () => {
    await notePendingDuel({ duelId: 'd2', guildId: GUILD, challengerId: CH, opponentId: OP, amount: 50 });
    expect(mockPending.all()).toEqual([expect.objectContaining({ duelId: 'd2', amount: 50 })]);

    mockPending.model.create.mockRejectedValueOnce(new Error('down'));
    await expect(notePendingDuel({ duelId: 'd3', guildId: GUILD, challengerId: CH, opponentId: OP, amount: 50 })).resolves.toBeUndefined();
});

test('/duel notes the duel before it takes the stakes', () => {
    const src = require('fs').readFileSync(require.resolve('../src/commands/economy/duel'), 'utf8');
    expect(src.indexOf('await notePendingDuel(')).toBeGreaterThan(-1);
    expect(src.indexOf('await notePendingDuel(')).toBeLessThan(src.indexOf('await takeEscrow('));
});

test('the scheduler runs the sweep for each shard, every five minutes', async () => {
    const { JOBS, SCOPE } = require('../src/services/scheduler');
    const job = JOBS.find(j => j.name === 'sweepStrandedDuels');
    expect(job).toMatchObject({ scope: SCOPE.GUILD, schedule: '*/5 * * * *' });

    seedDuel();
    await job.fn(null);
    expect(balanceOf(CH)).toBe(1_000);
});
