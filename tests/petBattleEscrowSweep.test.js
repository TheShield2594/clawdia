'use strict';

// #1184 — the restart sweep for pet-battle stakes: a battle a restart left
// with its stakes taken is refunded exactly once; one that settled is not.

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });
const mockPending = fakeCollection('PendingPetBattle', { stakes: [] }, { unique: ['battleId'] });
const mockFailed = fakeCollection('FailedJob', {}, { unique: [] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/PendingPetBattle', () => mockPending.model);
jest.mock('../src/models/FailedJob', () => mockFailed.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/sharding', () => ({ handlesGuild: jest.fn(() => true) }));

const { sweepStrandedPetBattles, notePetStake, clearPendingPetBattle, STRANDED_AFTER_MS } = require('../src/services/petBattleEscrowSweep');
const { logTransaction } = require('../src/utils/logTransaction');
const { handlesGuild } = require('../src/utils/sharding');

const GUILD = 'guild-1';
const NOW = Date.UTC(2026, 8, 25, 12);
const old = new Date(NOW - STRANDED_AFTER_MS - 1000);
const pending = (fields = {}) => ({
    battleId: 'b1', guildId: GUILD, challengerId: 'alice', opponentId: 'bob', amount: 100,
    stakes: ['alice', 'bob'], createdAt: old, ...fields,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockUsers.reset();
    mockPending.reset();
    mockFailed.reset();
    mockUsers.seed({ userId: 'alice', guildId: GUILD, balance: 900 }, { userId: 'bob', guildId: GUILD, balance: 900 });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a stranded battle has every recorded stake handed back, once', async () => {
    mockPending.seed(pending());

    expect(await sweepStrandedPetBattles(null, { now: NOW })).toEqual({ refunded: 1, settled: 0, failed: 0 });
    expect(mockUsers.get('alice').balance).toBe(1000);
    expect(mockUsers.get('bob').balance).toBe(1000);
    expect(mockPending.all()).toEqual([]);
    expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', amount: 100, note: 'bot restart refund — pet battle b1' }));

    // A second sweep, or a replayed entry, pays nothing more: the refund is keyed.
    mockPending.seed(pending());
    expect(await sweepStrandedPetBattles(null, { now: NOW })).toEqual({ refunded: 0, settled: 1, failed: 0 });
    expect(mockUsers.get('alice').balance).toBe(1000);
});

test('only the stakes that landed come back', async () => {
    mockPending.seed(pending({ stakes: ['alice'] }));

    await sweepStrandedPetBattles(null, { now: NOW });

    expect(mockUsers.get('alice').balance).toBe(1000);
    expect(mockUsers.get('bob').balance).toBe(900);
});

test.each([
    ['a paid pot', () => mockUsers.get('bob').paidPayouts.push({ key: 'pet:battle:b1:bob:payout' })],
    ['an owed refund', () => mockFailed.seed({ payload: { payoutKey: 'pet:battle:b1:alice:refund' } })],
])('a battle that settled with %s is dropped, not refunded', async (_label, settle) => {
    mockPending.seed(pending());
    settle();

    expect(await sweepStrandedPetBattles(null, { now: NOW })).toEqual({ refunded: 0, settled: 1, failed: 0 });
    expect(mockUsers.get('alice').balance).toBe(900);
    expect(mockPending.all()).toEqual([]);
});

test('a battle young enough to be live, or in another shard\'s guild, is left alone', async () => {
    mockPending.seed(pending({ createdAt: new Date(NOW - 60_000) }));
    expect(await sweepStrandedPetBattles(null, { now: NOW })).toEqual({ refunded: 0, settled: 0, failed: 0 });

    mockPending.all()[0].createdAt = old;
    handlesGuild.mockReturnValueOnce(false);
    await sweepStrandedPetBattles(null, { now: NOW });
    expect(mockPending.all()).toHaveLength(1);
    expect(mockUsers.get('alice').balance).toBe(900);
});

test('a refund that can neither land nor be recorded keeps the entry for the next sweep', async () => {
    mockPending.seed(pending({ stakes: ['ghost'] }));
    require('../src/utils/owedPayout').recordOwedPayout.mockResolvedValueOnce(false);

    expect(await sweepStrandedPetBattles(null, { now: NOW })).toEqual({ refunded: 0, settled: 0, failed: 1 });
    expect(mockPending.all()).toHaveLength(1);
});

test('stakes are noted one at a time on one entry, and cleared on settlement', async () => {
    const battle = { battleId: 'b2', guildId: GUILD, challengerId: 'alice', opponentId: 'bob', amount: 50 };
    await notePetStake(battle, 'alice');
    await notePetStake(battle, 'bob');
    await notePetStake(battle, 'bob');

    expect(mockPending.all()).toEqual([expect.objectContaining({ battleId: 'b2', amount: 50, stakes: ['alice', 'bob'] })]);
    await clearPendingPetBattle('b2');
    expect(mockPending.all()).toEqual([]);
});

test('a note that cannot be written does not stop the battle', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockPending.model.updateOne.mockRejectedValueOnce(new Error('db down'));
    await expect(notePetStake({ battleId: 'b3', guildId: GUILD, challengerId: 'a', opponentId: 'b', amount: 1 }, 'a')).resolves.toBeUndefined();
});

test('the scheduler runs the sweep for each shard, every five minutes', async () => {
    const { JOBS, SCOPE } = require('../src/services/scheduler');
    const job = JOBS.find(j => j.name === 'sweepStrandedPetBattles');
    expect(job).toMatchObject({ scope: SCOPE.GUILD, schedule: '*/5 * * * *', service: 'petBattleEscrowSweep' });

    mockPending.seed(pending({ createdAt: new Date(Date.now() - STRANDED_AFTER_MS - 1000) }));
    await job.fn(null);
    expect(mockUsers.get('alice').balance).toBe(1000);
});
