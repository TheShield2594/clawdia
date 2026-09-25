'use strict';

/**
 * #1185 — the ranked pet ladder: the rated write, the same-opponent cap, the
 * rating band, the rating leaderboard and the season rollover, against the
 * shared fakeCollection store, which evaluates the conditional writes' filters
 * for real.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockLadders = fakeCollection('PetLadder', { seasonNumber: 1, rev: 0, ratings: {} }, { unique: ['guildId'] });
const mockUsers = fakeCollection('User', { pets: [] });
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/PetLadder', () => mockLadders.model);
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildAnnounce', () => ({ postAnnouncement: jest.fn(async () => true) }));
jest.mock('../src/utils/sharding', () => ({ handlesGuild: jest.fn(() => true) }));

const ladderService = require('../src/services/petLadderService');
const { postAnnouncement } = require('../src/utils/guildAnnounce');
const { handlesGuild } = require('../src/utils/sharding');

const {
    LADDER_START_RATING, RATING_BAND, SAME_OPPONENT_DAILY_CAP, LADDER_SEASON_DAYS,
    getLadder, entryOf, ratedEligibility, recordRatedResult, ratingLeaderboard,
    resetRatings, resolvePetLadderSeasons,
} = ladderService;

const GUILD = 'guild-1';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 12);

const side = (userId, petRef, name = petRef) => ({ userId, petRef, petId: 'dog', name });
const A = side('alice', 'pa', 'Rex');
const B = side('bob', 'pb', 'Tom');
const C = side('carol', 'pc', 'Kit');
const stored = () => mockLadders.get(GUILD);
const realFindOneAndUpdate = mockLadders.model.findOneAndUpdate.getMockImplementation();

beforeEach(() => {
    jest.clearAllMocks();
    mockLadders.model.findOneAndUpdate.mockImplementation(realFindOneAndUpdate);
    mockLadders.reset();
    mockUsers.reset();
    mockGuilds.reset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('the ladder document', () => {
    test('is made on first use, season 1, ending a season length from now', async () => {
        const ladder = await getLadder(GUILD, NOW);

        expect(ladder.seasonNumber).toBe(1);
        expect(new Date(ladder.seasonEndsAt).getTime()).toBe(NOW + LADDER_SEASON_DAYS * DAY);
        expect(mockLadders.all()).toHaveLength(1);
        await getLadder(GUILD, NOW + 1000);
        expect(mockLadders.all()).toHaveLength(1);
    });

    test('an unrated pet reads as the middle rating', () => {
        expect(entryOf({ ratings: {} }, 'nobody')).toEqual(expect.objectContaining({
            rating: LADDER_START_RATING, games: 0, exists: false,
        }));
    });
});

describe('a rated result', () => {
    test('moves both ratings, zero-sum, in one conditional write', async () => {
        const res = await recordRatedResult(GUILD, A, B, NOW);

        expect(res).toEqual({
            rated: true, seasonId: 'S1',
            winner: { before: 1200, after: 1216, delta: 16 },
            loser:  { before: 1200, after: 1184, delta: -16 },
        });
        const writes = mockLadders.writes.filter(w => w.update.$set?.['ratings.pa']);
        expect(writes).toHaveLength(1);
        // The filter pins the season and both entries, so the write is conditional.
        expect(writes[0].query).toEqual({
            guildId: GUILD, seasonNumber: 1,
            'ratings.pa': { $exists: false }, 'ratings.pb': { $exists: false },
        });
        expect(stored().ratings.pa).toEqual(expect.objectContaining({ userId: 'alice', rating: 1216, peak: 1216, wins: 1, losses: 0, games: 1 }));
        expect(stored().ratings.pb).toEqual(expect.objectContaining({ userId: 'bob', rating: 1184, peak: 1200, wins: 0, losses: 1, games: 1 }));
        expect(stored().rev).toBe(1);
    });

    test('an upset moves more than an expected win', async () => {
        mockLadders.seed({ guildId: GUILD, ratings: {
            pa: { userId: 'alice', rating: 1100, peak: 1100, wins: 0, losses: 0, games: 4, recent: [] },
            pb: { userId: 'bob',   rating: 1350, peak: 1350, wins: 0, losses: 0, games: 4, recent: [] },
        } });

        const res = await recordRatedResult(GUILD, A, B, NOW);

        expect(res.winner.delta).toBeGreaterThan(16);
        expect(res.winner.delta).toBe(-res.loser.delta);
    });

    test('a write computed from ratings that changed underneath it misses and is recomputed', async () => {
        await recordRatedResult(GUILD, A, B, NOW);
        // Another rated battle lands between this one's read and its write.
        const real = realFindOneAndUpdate;
        let raced = false;
        mockLadders.model.findOneAndUpdate.mockImplementation(async (q, u, o) => {
            if (!raced && u.$set?.['ratings.pa']) {
                raced = true;
                const ladder = stored();
                ladder.ratings.pa = { ...ladder.ratings.pa, rating: 1250, games: 2 };
            }
            return real(q, u, o);
        });

        const res = await recordRatedResult(GUILD, A, C, NOW);

        expect(res.rated).toBe(true);
        expect(res.winner.before).toBe(1250); // recomputed from the fresh read
        expect(stored().ratings.pa.games).toBe(3);
    });

    test('a write that keeps missing gives up rather than guessing', async () => {
        mockLadders.model.findOneAndUpdate.mockImplementation(async (q, u, o) => (u.$set ? null : realFindOneAndUpdate(q, u, o)));

        expect(await recordRatedResult(GUILD, A, B, NOW)).toEqual({ rated: false, reason: 'conflict' });
    });
});

describe("repeatedly battling the same opponent can't push a rating up", () => {
    test(`two owners get ${SAME_OPPONENT_DAILY_CAP} rated results a day against each other`, async () => {
        const results = [];
        for (let i = 0; i < 10; i++) results.push(await recordRatedResult(GUILD, A, B, NOW + i * 60_000));

        expect(results.filter(r => r.rated)).toHaveLength(SAME_OPPONENT_DAILY_CAP);
        expect(results.slice(SAME_OPPONENT_DAILY_CAP).every(r => r.reason === 'cap')).toBe(true);
        expect(stored().ratings.pa.games).toBe(SAME_OPPONENT_DAILY_CAP);
        const capped = stored().ratings.pa.rating;
        expect(capped).toBeLessThan(1250);
        expect(ratedEligibility(stored(), A, B, NOW).ok).toBe(false);
    });

    test('the cap counts the owners, not the pets they field', async () => {
        for (let i = 0; i < SAME_OPPONENT_DAILY_CAP; i++) await recordRatedResult(GUILD, A, B, NOW);

        const alt = side('alice', 'pa2');
        expect(ratedEligibility(stored(), alt, B, NOW).ok).toBe(false);
        expect((await recordRatedResult(GUILD, alt, B, NOW)).reason).toBe('cap');
        // A different opponent is fine.
        expect(ratedEligibility(stored(), A, C, NOW).ok).toBe(true);
    });

    test('a day later the pair may fight rated again', async () => {
        for (let i = 0; i < SAME_OPPONENT_DAILY_CAP; i++) await recordRatedResult(GUILD, A, B, NOW);

        expect(ratedEligibility(stored(), A, B, NOW + DAY + 1).ok).toBe(true);
        expect((await recordRatedResult(GUILD, A, B, NOW + DAY + 1)).rated).toBe(true);
        // The log is pruned to the last day as it is written.
        expect(stored().ratings.pa.recent).toHaveLength(1);
    });
});

describe('the rating band', () => {
    test(`pets more than ${RATING_BAND} apart cannot fight rated`, () => {
        const ladder = { ratings: {
            pa: { userId: 'alice', rating: 1200 + RATING_BAND + 1, games: 5, recent: [] },
            pb: { userId: 'bob',   rating: 1200,                   games: 5, recent: [] },
        } };
        expect(ratedEligibility(ladder, A, B, NOW)).toEqual({ ok: false, reason: expect.stringContaining('more than 300 apart') });
        ladder.ratings.pa.rating = 1200 + RATING_BAND;
        expect(ratedEligibility(ladder, A, B, NOW).ok).toBe(true);
    });
});

describe('the rating leaderboard', () => {
    test('ranks rated pets by rating and shows only pets still with their owners', async () => {
        mockLadders.seed({ guildId: GUILD, seasonNumber: 2, ratings: {
            pa:   { userId: 'alice', rating: 1300, wins: 5, losses: 1, games: 6 },
            pb:   { userId: 'bob',   rating: 1400, wins: 7, losses: 0, games: 7 },
            gone: { userId: 'bob',   rating: 1500, wins: 9, losses: 0, games: 9 },
            idle: { userId: 'carol', rating: 1200, wins: 0, losses: 0, games: 0 },
        } });
        mockUsers.seed(
            { userId: 'alice', guildId: GUILD, pets: [{ _id: 'pa', petId: 'dog', name: 'Rex', level: 5 }] },
            { userId: 'bob',   guildId: GUILD, pets: [{ _id: 'pb', petId: 'cat', name: 'Tom', level: 5 }] },
        );

        const { seasonId, rows } = await ratingLeaderboard(GUILD);

        expect(seasonId).toBe('S2');
        expect(rows.map(r => [r.petRef, r.rating, r.pet.name])).toEqual([['pb', 1400, 'Tom'], ['pa', 1300, 'Rex']]);
    });

    test('an empty ladder has no rows', async () => {
        expect((await ratingLeaderboard(GUILD)).rows).toEqual([]);
    });
});

describe('a season rollover', () => {
    const endedLadder = (overrides = {}) => ({
        guildId: GUILD, seasonNumber: 3, rev: 12,
        seasonStartedAt: new Date(NOW - 31 * DAY), seasonEndsAt: new Date(NOW - 1000),
        ratings: {
            pa: { userId: 'alice', name: 'Rex', rating: 1600, peak: 1640, wins: 20, losses: 4, games: 24, recent: [{ vs: 'bob', at: new Date(NOW) }] },
            pb: { userId: 'bob',   name: 'Tom', rating: 1400, peak: 1400, wins: 10, losses: 9, games: 19, recent: [] },
            pc: { userId: 'carol', name: 'Kit', rating: 1000, peak: 1200, wins: 2,  losses: 9, games: 11, recent: [] },
            pd: { userId: 'dave',  name: 'Ace', rating: 1300, peak: 1300, wins: 6,  losses: 6, games: 12, recent: [] },
        },
        ...overrides,
    });

    beforeEach(() => {
        mockGuilds.seed({ guildId: GUILD, economy: { announcementChannelId: 'chan-1' } });
        mockUsers.seed(
            { userId: 'alice', guildId: GUILD, pets: [{ _id: 'pa', petId: 'dog', name: 'Rex' }] },
            { userId: 'bob',   guildId: GUILD, pets: [{ _id: 'pb', petId: 'cat', name: 'Tom' }] },
            { userId: 'dave',  guildId: GUILD, pets: [{ _id: 'pd', petId: 'fox', name: 'Ace' }] },
        );
    });

    test('soft-resets every rating halfway toward the middle and starts the next season', async () => {
        mockLadders.seed(endedLadder());

        await resolvePetLadderSeasons({}, NOW);

        const next = stored();
        expect(next.seasonNumber).toBe(4);
        expect(new Date(next.seasonEndsAt).getTime()).toBe(NOW + LADDER_SEASON_DAYS * DAY);
        expect(next.ratings.pa).toEqual(expect.objectContaining({ rating: 1400, peak: 1400, wins: 0, losses: 0, games: 0, recent: [] }));
        expect(next.ratings.pb.rating).toBe(1300);
        expect(next.ratings.pc.rating).toBe(1100);
        expect(next.ratings.pd.rating).toBe(1250);
    });

    test('titles the top three pets for the companion card and posts the recap', async () => {
        mockLadders.seed(endedLadder());

        await resolvePetLadderSeasons({}, NOW);

        expect(mockUsers.get('alice').pets[0].ladderTitle).toBe('S3 Ladder Champion');
        expect(mockUsers.get('bob').pets[0].ladderTitle).toBe('S3 Ladder Runner-Up');
        expect(mockUsers.get('dave').pets[0].ladderTitle).toBe('S3 Ladder Third');
        expect(postAnnouncement).toHaveBeenCalledTimes(1);
        const [, guildId, channelId, payload] = postAnnouncement.mock.calls[0];
        expect([guildId, channelId]).toEqual([GUILD, 'chan-1']);
        const embed = payload.embeds[0].data;
        expect(embed.title).toBe('🏆 Pet Ladder — S3 has ended');
        expect(embed.description.split('\n')[0]).toContain('**Rex** — 💎 **1600** (20W / 4L) — <@alice>');
    });

    test('a battle after the rollover counts in the new season, from the reset rating', async () => {
        mockLadders.seed(endedLadder());
        await resolvePetLadderSeasons({}, NOW);

        const res = await recordRatedResult(GUILD, A, B, NOW + 1000);

        expect(res.seasonId).toBe('S4');
        expect(res.winner.before).toBe(1400);
        expect(stored().ratings.pa.games).toBe(1);
    });

    test('runs once: a second sweep, or a stale read, changes nothing', async () => {
        mockLadders.seed(endedLadder());
        const staleRead = { ...endedLadder() };

        await resolvePetLadderSeasons({}, NOW);
        await resolvePetLadderSeasons({}, NOW);
        const { rollLadderSeason } = ladderService;
        expect(await rollLadderSeason({}, staleRead, NOW)).toBeNull();

        expect(stored().seasonNumber).toBe(4);
        expect(postAnnouncement).toHaveBeenCalledTimes(1);
    });

    test('a rated battle that lands mid-rollover makes the rollover wait for the next tick', async () => {
        mockLadders.seed(endedLadder());
        const read = { ...endedLadder() };
        stored().rev = 13; // a battle wrote after the sweep read the ladder

        expect(await ladderService.rollLadderSeason({}, read, NOW)).toBeNull();
        expect(stored().seasonNumber).toBe(3);
    });

    test('a season still running is left alone, and so is a guild on another shard', async () => {
        mockLadders.seed(endedLadder({ seasonEndsAt: new Date(NOW + DAY) }));
        await resolvePetLadderSeasons({}, NOW);
        expect(stored().seasonNumber).toBe(3);

        stored().seasonEndsAt = new Date(NOW - 1);
        handlesGuild.mockReturnValueOnce(false);
        await resolvePetLadderSeasons({}, NOW);
        expect(stored().seasonNumber).toBe(3);
    });

    test('resetRatings leaves an empty ladder empty', () => {
        expect(resetRatings({})).toEqual({});
    });
});

test('the scheduler rolls ladder seasons for each shard, hourly', async () => {
    const { JOBS, SCOPE } = require('../src/services/scheduler');
    const job = JOBS.find(j => j.name === 'resolvePetLadderSeasons');
    expect(job).toMatchObject({ scope: SCOPE.GUILD, schedule: '41 * * * *', service: 'petLadderService' });

    mockLadders.seed({ guildId: GUILD, seasonNumber: 1, rev: 0, seasonEndsAt: new Date(Date.now() - 1000), ratings: {} });
    await job.fn({});
    expect(stored().seasonNumber).toBe(2);
});
