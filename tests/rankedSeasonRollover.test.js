'use strict';

/**
 * #784. `resolveRankedSeasons` runs on a cron, pays a 50,000-coin top prize
 * split three ways, and soft-resets every participant's ELO. Both are one-way
 * and both key off `currentSeasonId`, which the same job rolls forward — so a
 * claim that is not atomic pays the podium twice and resets the ELO of a season
 * that has already started. None of it was executed.
 */

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setFooter(f) { this.footer = f; return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.fields.push(...f.flat()); return this; }
    }
    return { EmbedBuilder, AttachmentBuilder: class {} };
});

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User',  () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));

const Guild = require('../src/models/Guild');
const User  = require('../src/models/User');
const { softResetElo } = require('../src/utils/duelElo');
const { resolveRankedSeasons } = require('../src/services/schedulerService');

const DAY = 86_400_000;

function chain(docs) {
    const c = {
        sort: () => c, limit: () => c, select: () => c,
        lean: async () => docs,
        then: (res, rej) => Promise.resolve(docs).then(res, rej),
    };
    return c;
}

function rankedGuild(over = {}) {
    return {
        guildId: 'g1',
        economy: { currency: '💰', announcementChannelId: 'c1' },
        rankedDuels: {
            enabled: true,
            currentSeasonId: 'S3',
            seasonNumber: 3,
            seasonDurationDays: 60,
            seasonEndsAt: new Date(Date.now() - DAY),
            announceChannelId: 'rank-c',
            topReward: 50_000,
        },
        ...over,
    };
}

const PODIUM = [
    { userId: 'u1', ranked: { seasonPeakElo: 1800 } },
    { userId: 'u2', ranked: { seasonPeakElo: 1600 } },
    { userId: 'u3', ranked: { seasonPeakElo: 1400 } },
];

let sent;
let errorLog;

function fakeClient() {
    sent = [];
    return {
        guilds: {
            fetch: jest.fn(async guildId => ({
                id: guildId,
                channels: {
                    fetch: async channelId => ({
                        isTextBased: () => true,
                        send: async payload => { sent.push({ guildId, channelId, payload }); },
                    }),
                },
            })),
        },
    };
}

/** `find` is called for uninitialized guilds, expired guilds, the podium, and participants. */
function stubFinds({ uninitialized = [], expired = [rankedGuild()], podium = PODIUM, participants = [] } = {}) {
    Guild.find.mockImplementation(async filter =>
        filter.$or ? uninitialized : expired);
    User.find.mockImplementation(filter =>
        chain(filter['ranked.currentSeasonId'] ? podium : participants));
}

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });
    User.updateOne.mockResolvedValue({});
    User.bulkWrite.mockResolvedValue({});
    stubFinds();
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('resolveRankedSeasons', () => {
    test('gives a ranked guild with no season yet its first one', async () => {
        const fresh = rankedGuild({
            rankedDuels: { enabled: true, seasonNumber: 1, seasonDurationDays: 30, currentSeasonId: null, seasonEndsAt: null },
            save: jest.fn(async () => {}),
        });
        stubFinds({ uninitialized: [fresh], expired: [] });

        await resolveRankedSeasons(fakeClient());

        expect(fresh.rankedDuels.currentSeasonId).toBe('S1');
        expect(fresh.rankedDuels.seasonEndsAt.getTime() - fresh.rankedDuels.seasonStartedAt.getTime()).toBe(30 * DAY);
        expect(fresh.save).toHaveBeenCalled();
    });

    test('rolls the season forward as the claim, before it pays anything', async () => {
        const order = [];
        Guild.findOneAndUpdate.mockImplementation(async () => { order.push('claim'); return { guildId: 'g1' }; });
        User.updateOne.mockImplementation(async () => { order.push('pay'); return {}; });

        await resolveRankedSeasons(fakeClient());

        expect(order[0]).toBe('claim');
        const [filter, update, options] = Guild.findOneAndUpdate.mock.calls[0];
        // Matching on the *old* season id is what makes this a claim: the update
        // replaces it, so a second sweep finds nothing to match.
        expect(filter).toEqual({ guildId: 'g1', 'rankedDuels.currentSeasonId': 'S3' });
        expect(update.$set['rankedDuels.currentSeasonId']).toBe('S4');
        expect(update.$set['rankedDuels.seasonNumber']).toBe(4);
        expect(options).toEqual({ new: false });
    });

    test('a season another worker already rolled pays nobody', async () => {
        Guild.findOneAndUpdate.mockResolvedValue(null);

        await resolveRankedSeasons(fakeClient());

        expect(User.updateOne).not.toHaveBeenCalled();
        expect(User.bulkWrite).not.toHaveBeenCalled();
    });

    test('counts only players who actually played this season', async () => {
        await resolveRankedSeasons(fakeClient());

        const [filter] = User.find.mock.calls.find(([f]) => f['ranked.currentSeasonId']);
        // Without the season-id clause a prior-season winner's lingering
        // seasonPeakElo reclaims a podium slot without playing a single game.
        expect(filter['ranked.currentSeasonId']).toBe('S3');
        expect(filter.$or).toEqual([
            { 'ranked.seasonRankedWins':   { $gt: 0 } },
            { 'ranked.seasonRankedLosses': { $gt: 0 } },
        ]);
    });

    test('pays 100/60/30% of the configured top reward, in rank order', async () => {
        await resolveRankedSeasons(fakeClient());

        expect(User.updateOne.mock.calls.map(([f, u]) => [f.userId, u.$inc.balance]))
            .toEqual([['u1', 50_000], ['u2', 30_000], ['u3', 15_000]]);
    });

    test('awards a distinct title per place and records the season it was won in', async () => {
        await resolveRankedSeasons(fakeClient());

        const titles = User.updateOne.mock.calls.map(([, u]) => u.$addToSet['ranked.seasonalTitles']);
        expect(titles).toEqual(['S3 Champion', 'S3 Runner-Up', 'S3 Third Place']);
        for (const [, update] of User.updateOne.mock.calls) {
            expect(update.$set['ranked.lastSeasonId']).toBe('S3');
        }
    });

    test('soft-resets every participant toward 1200 in one bulkWrite', async () => {
        stubFinds({ participants: [
            { _id: 'a', ranked: { elo: 2000 } },
            { _id: 'b', ranked: { elo: 800 } },
            { _id: 'c', ranked: {} },
        ] });

        await resolveRankedSeasons(fakeClient());

        expect(User.bulkWrite).toHaveBeenCalledTimes(1);
        const [ops, options] = User.bulkWrite.mock.calls[0];
        expect(options).toEqual({ ordered: false });
        expect(ops.map(o => o.updateOne.update.$set['ranked.elo']))
            .toEqual([softResetElo(2000), softResetElo(800), softResetElo(1000)]);
        // Season counters zeroed and everyone moved onto the new season id, or
        // the next rollover finds them still tagged with the old one.
        expect(ops[0].updateOne.update.$set).toMatchObject({
            'ranked.seasonRankedWins': 0, 'ranked.seasonRankedLosses': 0, 'ranked.currentSeasonId': 'S4',
        });
    });

    test('a season with no participants writes nothing and still announces', async () => {
        stubFinds({ podium: [], participants: [] });

        await resolveRankedSeasons(fakeClient());

        expect(User.updateOne).not.toHaveBeenCalled();
        expect(User.bulkWrite).not.toHaveBeenCalled();
        expect(sent[0].payload.embeds[0].description).toBe('_No ranked games played this season._');
    });

    test('announces to the ranked channel, falling back to the economy one', async () => {
        await resolveRankedSeasons(fakeClient());
        expect(sent[0].channelId).toBe('rank-c');

        jest.clearAllMocks();
        stubFinds({ expired: [rankedGuild({
            rankedDuels: { ...rankedGuild().rankedDuels, announceChannelId: null },
        })] });
        Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });

        await resolveRankedSeasons(fakeClient());
        expect(sent[0].channelId).toBe('c1');
    });

    test('the announcement names the podium, its prizes and the new season', async () => {
        await resolveRankedSeasons(fakeClient());

        const embed = sent[0].payload.embeds[0];
        expect(embed.title).toBe('🏆 Ranked Season Ended — S3');
        expect(embed.description).toContain('🥇 <@u1> — 1800 ELO · earned **💰50,000**');
        expect(embed.description).toContain('🥉 <@u3> — 1400 ELO');
        expect(embed.footer.text).toContain('Season 4 starts now');
    });

    test('one guild that throws does not strand the rest of the sweep', async () => {
        stubFinds({ expired: [rankedGuild({ guildId: 'boom' }), rankedGuild({ guildId: 'ok' })] });
        Guild.findOneAndUpdate.mockImplementation(async filter => {
            if (filter.guildId === 'boom') throw new Error('mongo down');
            return { guildId: filter.guildId };
        });

        await expect(resolveRankedSeasons(fakeClient())).resolves.toBeUndefined();

        expect(User.updateOne.mock.calls.map(([f]) => f.guildId)).toEqual(['ok', 'ok', 'ok']);
        expect(errorLog).toHaveBeenCalled();
    });
});
