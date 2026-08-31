'use strict';

/**
 * #906. `tournamentService` sat at 6.4% statements — the service that splits a
 * fishing tournament's prize pool and credits it to three players had never had
 * a line of it executed by a test, and neither had the command layer above it
 * (#890). A prize payout is a batch: one bad split or one lost credit hits
 * every winner of that tournament at once, not one player.
 *
 * What is driven here is the money: how the pool is divided, who is paid, what
 * happens when a credit does not land, and the claim that stops a tournament
 * being paid out twice. The User model is the shared fake rather than a stub
 * that answers yes, so `$inc` really moves a balance and a missing member
 * really matches nothing.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0 });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/FishingTournament', () => ({
    findOne: jest.fn(),
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
}));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const FishingTournament = require('../src/models/FishingTournament');
const { logTransaction } = require('../src/utils/logTransaction');
const tournamentService = require('../src/services/tournamentService');

const GUILD = 'guild-1';

/** A claimable tournament document, with the `save()` the service calls. */
const makeTournament = (fields = {}) => {
    const doc = {
        _id: 'tourney-1',
        guildId: GUILD,
        status: 'active',
        prizePool: 1000,
        entryFee: 0,
        entries: [],
        prizes: [],
        // Relative to now: submitCatch compares the clock against `endsAt` and
        // ends a tournament that has run out, so a fixed date would make these
        // assert the expiry path from next week onwards.
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        ...fields,
    };
    doc.save = jest.fn(async () => doc);
    return doc;
};

const entry = (userId, score, caughtAt, fields = {}) => ({
    userId, username: userId, fishName: 'Cod', fishEmoji: '🐟',
    tier: 'common', score, caughtAt: new Date(caughtAt), isBossKill: false, ...fields,
});

/** The service's claim succeeded and handed back `doc`. */
const claimYields = doc => FishingTournament.findOneAndUpdate.mockResolvedValue(doc);

beforeEach(() => {
    jest.clearAllMocks();
    mockUsers.reset();
});

describe('ending a tournament', () => {
    test('splits the pool 60/25/15 and credits each winner', async () => {
        mockUsers.seed(
            { userId: 'first', guildId: GUILD, balance: 100 },
            { userId: 'second', guildId: GUILD, balance: 0 },
            { userId: 'third', guildId: GUILD, balance: 50 },
        );
        const tournament = makeTournament({
            prizePool: 1000,
            entries: [
                entry('third', 10, '2026-08-31T10:10:00Z'),
                entry('first', 90, '2026-08-31T10:30:00Z'),
                entry('second', 50, '2026-08-31T10:20:00Z'),
            ],
        });
        claimYields(tournament);

        const ended = await tournamentService.endTournament(tournament._id);

        expect(ended.prizes).toEqual([
            { place: 1, userId: 'first', amount: 600, paidOut: true },
            { place: 2, userId: 'second', amount: 250, paidOut: true },
            { place: 3, userId: 'third', amount: 150, paidOut: true },
        ]);
        expect(mockUsers.get('first').balance).toBe(700);
        expect(mockUsers.get('second').balance).toBe(250);
        expect(mockUsers.get('third').balance).toBe(200);
        expect(tournament.save).toHaveBeenCalled();
    });

    // The whole pool is meant to leave: a split that quietly kept a coin, or
    // handed out more than was in the pool, would do it on every tournament.
    test('pays out the pool it was given, no more and no less', async () => {
        mockUsers.seed(
            { userId: 'a', guildId: GUILD }, { userId: 'b', guildId: GUILD }, { userId: 'c', guildId: GUILD },
        );
        const tournament = makeTournament({
            prizePool: 999,
            entries: [
                entry('a', 30, '2026-08-31T10:10:00Z'),
                entry('b', 20, '2026-08-31T10:11:00Z'),
                entry('c', 10, '2026-08-31T10:12:00Z'),
            ],
        });
        claimYields(tournament);

        const ended = await tournamentService.endTournament(tournament._id);

        const total = ended.prizes.reduce((sum, p) => sum + p.amount, 0);
        expect(total).toBe(999);
        expect(ended.prizes.every(p => Number.isInteger(p.amount))).toBe(true);
    });

    test('a tie is broken by whoever caught it first', async () => {
        mockUsers.seed({ userId: 'early', guildId: GUILD }, { userId: 'late', guildId: GUILD });
        const tournament = makeTournament({
            entries: [
                entry('late', 50, '2026-08-31T10:45:00Z'),
                entry('early', 50, '2026-08-31T10:05:00Z'),
            ],
        });
        claimYields(tournament);

        const ended = await tournamentService.endTournament(tournament._id);

        expect(ended.prizes.map(p => p.userId)).toEqual(['early', 'late']);
    });

    test('two entrants share the pool between the two places that exist', async () => {
        mockUsers.seed({ userId: 'a', guildId: GUILD }, { userId: 'b', guildId: GUILD });
        const tournament = makeTournament({
            prizePool: 1000,
            entries: [entry('a', 30, '2026-08-31T10:10:00Z'), entry('b', 20, '2026-08-31T10:11:00Z')],
        });
        claimYields(tournament);

        const ended = await tournamentService.endTournament(tournament._id);

        expect(ended.prizes).toHaveLength(2);
        expect(ended.prizes.map(p => p.amount)).toEqual([600, 250]);
    });

    test('an empty pool pays nobody and writes no prizes', async () => {
        mockUsers.seed({ userId: 'a', guildId: GUILD, balance: 10 });
        const tournament = makeTournament({
            prizePool: 0,
            entries: [entry('a', 30, '2026-08-31T10:10:00Z')],
        });
        claimYields(tournament);

        const ended = await tournamentService.endTournament(tournament._id);

        expect(ended.prizes).toEqual([]);
        expect(mockUsers.get('a').balance).toBe(10);
        expect(logTransaction).not.toHaveBeenCalled();
    });

    test('a tournament with no entries ends without paying anyone', async () => {
        const tournament = makeTournament({ entries: [] });
        claimYields(tournament);

        const ended = await tournamentService.endTournament(tournament._id);

        expect(ended.prizes).toEqual([]);
        expect(mockUsers.writes).toEqual([]);
    });

    // The credit is the thing that can fail on its own: a winner who has left
    // the guild has no member document, so the update matches nothing. That
    // must not be recorded as paid — `paidOut: false` is what an operator has
    // to be able to find afterwards.
    test('a winner with no member document is left unpaid rather than marked paid', async () => {
        mockUsers.seed({ userId: 'present', guildId: GUILD, balance: 0 });
        const tournament = makeTournament({
            prizePool: 1000,
            entries: [
                entry('departed', 90, '2026-08-31T10:10:00Z'),
                entry('present', 50, '2026-08-31T10:11:00Z'),
            ],
        });
        claimYields(tournament);

        const ended = await tournamentService.endTournament(tournament._id);

        expect(ended.prizes[0]).toEqual({ place: 1, userId: 'departed', amount: 600, paidOut: false });
        expect(ended.prizes[1].paidOut).toBe(true);
        expect(mockUsers.get('present').balance).toBe(250);
        // The unpaid winner is not in the ledger either — a ledger row is the
        // record of coins that moved.
        expect(logTransaction).toHaveBeenCalledTimes(1);
    });

    test('each paid prize is written to the ledger with the balance it produced', async () => {
        mockUsers.seed({ userId: 'a', guildId: GUILD, balance: 400 });
        const tournament = makeTournament({
            prizePool: 1000,
            entries: [entry('a', 30, '2026-08-31T10:10:00Z')],
        });
        claimYields(tournament);

        await tournamentService.endTournament(tournament._id);

        expect(logTransaction).toHaveBeenCalledWith({
            userId: 'a',
            guildId: GUILD,
            type: 'tournament_prize',
            amount: 600,
            balance: 1000,
            note: 'Tournament place #1',
        });
    });

    // The status flip is the claim: `{ _id, status: 'active' }` matches once, so
    // a second call — a scheduled sweep and a `/fish` that both notice the clock
    // has run out — finds nothing to claim and must pay nobody.
    test('claims the tournament by flipping it out of active in the same write', async () => {
        const tournament = makeTournament({ entries: [entry('a', 30, '2026-08-31T10:10:00Z')] });
        claimYields(tournament);

        await tournamentService.endTournament(tournament._id);

        const [filter, update] = FishingTournament.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ _id: tournament._id, status: 'active' });
        expect(update.$set.status).toBe('ended');
        expect(update.$set.winnersAnnouncedAt).toBeInstanceOf(Date);
    });

    test('a tournament somebody else already ended is read back, not paid again', async () => {
        mockUsers.seed({ userId: 'a', guildId: GUILD, balance: 100 });
        const alreadyEnded = makeTournament({
            status: 'ended',
            prizes: [{ place: 1, userId: 'a', amount: 600, paidOut: true }],
        });
        FishingTournament.findOneAndUpdate.mockResolvedValue(null);
        FishingTournament.findById.mockResolvedValue(alreadyEnded);

        const ended = await tournamentService.endTournament(alreadyEnded._id);

        expect(ended).toBe(alreadyEnded);
        expect(mockUsers.get('a').balance).toBe(100);
        expect(mockUsers.writes).toEqual([]);
        expect(logTransaction).not.toHaveBeenCalled();
    });
});

describe('submitting a catch', () => {
    test('an entry fee is added to the pool once, on the first catch', async () => {
        const tournament = makeTournament({ prizePool: 100, entryFee: 25 });
        FishingTournament.findOne.mockResolvedValue(tournament);

        await tournamentService.submitCatch(GUILD, { userId: 'a', username: 'a', fishName: 'Cod', fishEmoji: '🐟', tier: 'common', score: 10 });
        await tournamentService.submitCatch(GUILD, { userId: 'a', username: 'a', fishName: 'Cod', fishEmoji: '🐟', tier: 'common', score: 20 });

        expect(tournament.prizePool).toBe(125);
        expect(tournament.entries).toHaveLength(1);
    });

    test('only a better catch replaces the one already recorded', async () => {
        const tournament = makeTournament({
            entries: [entry('a', 80, '2026-08-31T10:05:00Z', { fishName: 'Marlin' })],
        });
        FishingTournament.findOne.mockResolvedValue(tournament);

        await tournamentService.submitCatch(GUILD, { userId: 'a', username: 'a', fishName: 'Cod', fishEmoji: '🐟', tier: 'common', score: 20 });

        expect(tournament.entries[0].score).toBe(80);
        expect(tournament.entries[0].fishName).toBe('Marlin');

        await tournamentService.submitCatch(GUILD, { userId: 'a', username: 'a', fishName: 'Tuna', fishEmoji: '🐟', tier: 'rare', score: 200 });

        expect(tournament.entries[0].score).toBe(200);
        expect(tournament.entries[0].fishName).toBe('Tuna');
    });

    test('a catch after the clock ran out ends the tournament instead of scoring', async () => {
        const expired = makeTournament({ endsAt: new Date(Date.now() - 60_000), entries: [] });
        FishingTournament.findOne.mockResolvedValue(expired);
        claimYields(expired);

        const result = await tournamentService.submitCatch(GUILD, {
            userId: 'a', username: 'a', fishName: 'Cod', fishEmoji: '🐟', tier: 'common', score: 10,
        });

        expect(result).toBeNull();
        expect(FishingTournament.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: expired._id, status: 'active' }, expect.anything(), expect.anything(),
        );
    });

    test('there is nothing to submit to without an active tournament', async () => {
        FishingTournament.findOne.mockResolvedValue(null);

        const result = await tournamentService.submitCatch(GUILD, {
            userId: 'a', username: 'a', fishName: 'Cod', fishEmoji: '🐟', tier: 'common', score: 10,
        });

        expect(result).toBeNull();
    });
});

describe('starting a tournament', () => {
    test('refuses a second one while another is running or scheduled', async () => {
        FishingTournament.findOne.mockResolvedValue(makeTournament());

        await expect(tournamentService.startTournament(GUILD)).rejects.toThrow(/already running or scheduled/);
        expect(FishingTournament.create).not.toHaveBeenCalled();
    });

    test('seeds the pool with the amount it was given', async () => {
        FishingTournament.findOne.mockResolvedValue(null);
        FishingTournament.create.mockImplementation(async fields => fields);

        const started = await tournamentService.startTournament(GUILD, { seedAmount: 500, entryFee: 20, durationMs: 30 * 60_000 });

        expect(started.prizePool).toBe(500);
        expect(started.seedAmount).toBe(500);
        expect(started.entryFee).toBe(20);
        expect(started.endsAt.getTime() - started.startedAt.getTime()).toBe(30 * 60_000);
    });
});

describe('the winners embed', () => {
    test('names each winner with the prize the payout actually recorded', () => {
        const tournament = makeTournament({
            entries: [entry('a', 90, '2026-08-31T10:10:00Z'), entry('b', 50, '2026-08-31T10:11:00Z')],
            prizes: [
                { place: 1, userId: 'a', amount: 600, paidOut: true },
                { place: 2, userId: 'b', amount: 250, paidOut: true },
            ],
        });

        const embed = tournamentService.buildWinnersEmbed(tournament, '🪙');

        expect(embed.data.description).toContain('🪙600');
        expect(embed.data.description).toContain('🪙250');
        expect(embed.data.description).toContain('<@a>');
    });

    test('says so when nobody entered', () => {
        const embed = tournamentService.buildWinnersEmbed(makeTournament({ entries: [] }));

        expect(embed.data.description).toContain('No participants');
    });
});
