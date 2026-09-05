'use strict';

/**
 * #784. `resolveExpiredSeasons` runs on a cron and does something irreversible:
 * it resets `seasonCoins` to zero for every user in the guild. The frozen
 * `SeasonRecord` is the only thing left afterwards that says who won, so the
 * order of those two writes is the whole correctness story — freeze first, then
 * reset. Nothing executed this job at all.
 */

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.fields.push(...f.flat()); return this; }
    }
    class AttachmentBuilder { constructor(buf, opts) { this.buf = buf; this.name = opts?.name; } }
    return { EmbedBuilder, AttachmentBuilder };
});

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/models/SeasonRecord', () => ({ create: jest.fn() }));
jest.mock('../src/utils/cardGenerator', () => ({
    createWarVictoryBanner: jest.fn(async () => Buffer.from('banner')),
    createSeasonRecapCard:  jest.fn(async () => Buffer.from('recap')),
    generatePetSprite:      jest.fn(async () => Buffer.from('sprite')),
}));

const Guild        = require('../src/models/Guild');
const User         = require('../src/models/User');
const SeasonRecord = require('../src/models/SeasonRecord');
const { createSeasonRecapCard } = require('../src/utils/cardGenerator');
const { resolveExpiredSeasons } = require('../src/services/economySeasonService');

/** A thenable that answers every query modifier the job chains onto `find`. */
function chain(docs) {
    const c = {
        sort: () => c, limit: () => c, select: () => c,
        lean: async () => docs,
        then: (res, rej) => Promise.resolve(docs).then(res, rej),
    };
    return c;
}

function seasonGuild(over = {}) {
    return {
        guildId: 'g1',
        name: 'Home',
        economy: { announcementChannelId: 'c1', currency: '🪙' },
        currentSeason: { id: 's1', name: 'Season One', startedAt: new Date(0), endsAt: new Date(Date.now() - 3600_000) },
        ...over,
    };
}

const TOP = [
    { userId: 'u1', seasonCoins: 900 },
    { userId: 'u2', seasonCoins: 500 },
    { userId: 'u3', seasonCoins: 100 },
];

let errorLog;
let sent;
let dms;
let missingMembers;

/**
 * `User.find` is called four times with different shapes. Route by filter so a
 * test can change one without rewriting the others.
 */
function stubUserFind({ top = TOP, active = [], ranked = TOP } = {}) {
    User.find.mockImplementation(filter => {
        if (filter['season.xp']) return chain(active);
        if (filter['season.seasonId']) return chain(ranked);
        return chain(top);
    });
}

function fakeClient() {
    sent = [];
    dms = [];
    missingMembers = new Set();
    return {
        guilds: {
            fetch: jest.fn(async guildId => ({
                id: guildId,
                systemChannelId: 'system',
                channels: {
                    fetch: async channelId => ({
                        isTextBased: () => true,
                        send: async payload => { sent.push({ guildId, channelId, payload }); },
                    }),
                },
                members: {
                    fetch: async userId => {
                        if (missingMembers.has(userId)) return null;
                        return {
                            user: { username: `name-${userId}` },
                            send: async payload => { dms.push({ userId, payload }); },
                        };
                    },
                },
            })),
        },
    };
}

/** The recap DMs are fire-and-forget, so they land a tick after the job returns. */
const settle = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });
    SeasonRecord.create.mockResolvedValue({});
    User.updateMany.mockResolvedValue({});
    stubUserFind();
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('resolveExpiredSeasons', () => {
    test('sweeps only seasons that exist and have already ended', async () => {
        Guild.find.mockResolvedValue([]);

        await resolveExpiredSeasons(fakeClient());

        const [filter] = Guild.find.mock.calls[0];
        expect(filter['currentSeason.id']).toEqual({ $ne: null });
        expect(filter['currentSeason.endsAt'].$lte).toBeInstanceOf(Date);
    });

    test('claims the season by clearing its id, so a duplicate sweep no-ops', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);

        await resolveExpiredSeasons(fakeClient());

        const [filter, update, options] = Guild.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', 'currentSeason.id': 's1' });
        expect(update.$set.currentSeason).toEqual({ id: null, name: null, startedAt: null, endsAt: null });
        expect(options).toEqual({ new: false });
    });

    test('a season another worker already claimed resets nobody', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        Guild.findOneAndUpdate.mockResolvedValue(null);

        await resolveExpiredSeasons(fakeClient());

        expect(SeasonRecord.create).not.toHaveBeenCalled();
        expect(User.updateMany).not.toHaveBeenCalled();
    });

    test('freezes the leaderboard before it wipes the coins it was computed from', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        const order = [];
        SeasonRecord.create.mockImplementation(async () => { order.push('freeze'); return {}; });
        User.updateMany.mockImplementation(async (_f, update) => {
            if (update.$set?.seasonCoins === 0) order.push('reset');
            return {};
        });

        await resolveExpiredSeasons(fakeClient());

        // Reversed, a crash between the two leaves the season with no record of
        // who won and the counts already gone — nothing to recompute from.
        expect(order).toEqual(['freeze', 'reset']);
    });

    test('freezes the top 10 with the season id, names resolved for the podium', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);

        await resolveExpiredSeasons(fakeClient());

        const [record] = SeasonRecord.create.mock.calls[0];
        expect(record).toMatchObject({ guildId: 'g1', seasonId: 's1', seasonName: 'Season One' });
        expect(record.top10).toEqual([
            { userId: 'u1', username: 'name-u1', coins: 900 },
            { userId: 'u2', username: 'name-u2', coins: 500 },
            { userId: 'u3', username: 'name-u3', coins: 100 },
        ]);
    });

    test('a duplicate freeze is another worker having won, not an error', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        const dup = Object.assign(new Error('E11000'), { code: 11000 });
        SeasonRecord.create.mockRejectedValue(dup);

        await expect(resolveExpiredSeasons(fakeClient())).resolves.toBeUndefined();

        // The reset still runs: the record exists, it was simply written by
        // whoever got there first.
        expect(User.updateMany).toHaveBeenCalled();
    });

    test('any other freeze failure aborts before the coins are wiped', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        SeasonRecord.create.mockRejectedValue(new Error('mongo down'));

        await expect(resolveExpiredSeasons(fakeClient())).resolves.toBeUndefined();

        expect(User.updateMany).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalled();
    });

    test('resets seasonCoins for the whole guild, not just the podium', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);

        await resolveExpiredSeasons(fakeClient());

        const reset = User.updateMany.mock.calls.find(([, u]) => u.$set?.seasonCoins === 0);
        expect(reset[0]).toEqual({ guildId: 'g1' });
    });

    test('announces the final podium in the guild currency', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);

        await resolveExpiredSeasons(fakeClient());

        const embed = sent[0].payload.embeds[0];
        expect(embed.title).toBe('🏁 Season Ended: Season One');
        expect(embed.fields[0].value).toContain('🥇 <@u1> — 900 🪙');
        expect(embed.fields[0].value).toContain('🥉 <@u3> — 100 🪙');
    });

    test('an empty season still announces, rather than announcing a blank podium', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        stubUserFind({ top: [], ranked: [] });

        await resolveExpiredSeasons(fakeClient());

        expect(sent[0].payload.embeds[0].fields[0].value).toBe('*No participants*');
    });

    test('falls back to the system channel when no announcement channel is set', async () => {
        Guild.find.mockResolvedValue([seasonGuild({ economy: {} })]);

        await resolveExpiredSeasons(fakeClient());

        expect(sent[0].channelId).toBe('system');
    });

    test('one guild that throws does not strand the rest of the sweep', async () => {
        Guild.find.mockResolvedValue([seasonGuild({ guildId: 'boom' }), seasonGuild({ guildId: 'ok' })]);
        Guild.findOneAndUpdate.mockImplementation(async filter => {
            if (filter.guildId === 'boom') throw new Error('mongo down');
            return { guildId: filter.guildId };
        });

        await expect(resolveExpiredSeasons(fakeClient())).resolves.toBeUndefined();

        expect(SeasonRecord.create).toHaveBeenCalledTimes(1);
    });
});

describe('resolveExpiredSeasons — recap DMs', () => {
    const ACTIVE = [
        { userId: 'u1', season: { xp: 500 } },
        { userId: 'u2', season: { xp: 10 } },
    ];

    test('DMs a recap card to each active player, ranked against the field', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        stubUserFind({ active: ACTIVE, ranked: TOP });
        const client = fakeClient();

        await resolveExpiredSeasons(client);
        await settle();

        expect(dms.map(d => d.userId)).toEqual(['u1', 'u2']);
        expect(dms[0].payload.content).toContain('Your Season One recap is here!');
        expect(dms[0].payload.files[0].name).toBe('season_recap.png');

        const [player, seasonName, rank, total] = createSeasonRecapCard.mock.calls[0];
        expect([player.userId, seasonName, rank, total]).toEqual(['u1', 'Season One', 1, 3]);
    });

    test('a card that fails to render costs that one player their DM, nobody else', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        stubUserFind({ active: ACTIVE, ranked: TOP });
        createSeasonRecapCard.mockRejectedValueOnce(new Error('canvas unavailable'));

        await resolveExpiredSeasons(fakeClient());
        await settle();

        expect(dms.map(d => d.userId)).toEqual(['u2']);
    });

    test('a player who has left the guild is skipped rather than throwing the loop', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        stubUserFind({ active: ACTIVE, ranked: TOP });
        const client = fakeClient();
        missingMembers.add('u1');

        await resolveExpiredSeasons(client);
        await settle();

        expect(dms.map(d => d.userId)).toEqual(['u2']);
    });

    test('points the channel at the DMs once they have gone out', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        stubUserFind({ active: ACTIVE, ranked: TOP });

        await resolveExpiredSeasons(fakeClient());
        await settle();

        expect(sent.some(s => String(s.payload).includes('Check your DMs'))).toBe(true);
    });

    test('a season nobody played sends no DMs', async () => {
        Guild.find.mockResolvedValue([seasonGuild()]);
        stubUserFind({ active: [], ranked: TOP });

        await resolveExpiredSeasons(fakeClient());
        await settle();

        expect(dms).toEqual([]);
        expect(createSeasonRecapCard).not.toHaveBeenCalled();
    });
});
