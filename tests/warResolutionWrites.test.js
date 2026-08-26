'use strict';

/**
 * #784. `resolveExpiredWars` runs on a cron and pays out: every member of the
 * winning guild gets a 24h 2× coin booster and a 30-day badge, pushed with an
 * unfiltered `updateMany`. Nobody watches it run, so a wrong winner or a
 * double payout lands in balances and stays there.
 *
 * The thing that keeps it from paying twice is the atomic
 * `activeWar.status: 'active' → 'ended'` claim: whoever flips it owns the
 * resolution. These pin that claim, and that the rewards follow the score
 * rather than the perspective of whichever guild document the sweep happened
 * to find first.
 */

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setImage(i) { this.image = i; return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.fields.push(...f.flat()); return this; }
    }
    class AttachmentBuilder {
        constructor(buf, opts) { this.buf = buf; this.name = opts?.name; }
    }
    return { EmbedBuilder, AttachmentBuilder };
});

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/utils/cardGenerator', () => ({
    createWarVictoryBanner: jest.fn(async () => Buffer.from('banner')),
    createSeasonRecapCard:  jest.fn(async () => Buffer.from('recap')),
    generatePetSprite:      jest.fn(async () => Buffer.from('sprite')),
}));

const Guild = require('../src/models/Guild');
const User  = require('../src/models/User');
const { createWarVictoryBanner } = require('../src/utils/cardGenerator');
const { resolveExpiredWars } = require('../src/services/schedulerService');

const HOUR = 3600_000;

/** Collects everything the job posts, keyed by the guild it was posted to. */
function fakeClient() {
    const posts = [];
    const channel = { isTextBased: () => true, send: jest.fn(async () => {}) };
    return {
        posts,
        channel,
        client: {
            guilds: {
                fetch: jest.fn(async guildId => ({
                    id: guildId,
                    channels: { fetch: async channelId => { channel.lastFor = [guildId, channelId]; return channel; } },
                    members:  { fetch: async userId => ({ user: { username: `name-${userId}` } }) },
                })),
            },
        },
    };
}

function warGuild(over = {}) {
    return {
        guildId: 'g1',
        name: 'Home',
        activeWar: {
            status: 'active',
            myScore: 100,
            opponentScore: 40,
            opponentGuildId: 'g2',
            opponentGuildName: 'Away',
            announcementChannelId: 'c1',
            endsAt: new Date(Date.now() - HOUR),
        },
        ...over,
    };
}

/** Records the posts a fake channel receives, per guild. */
function capture(client) {
    const sent = [];
    client.guilds.fetch.mockImplementation(async guildId => ({
        id: guildId,
        channels: {
            fetch: async channelId => ({
                isTextBased: () => true,
                send: async payload => { sent.push({ guildId, channelId, payload }); },
            }),
        },
        members: { fetch: async userId => ({ user: { username: `name-${userId}` } }) },
    }));
    return sent;
}

function chain(docs) {
    const c = {
        sort: () => c,
        limit: () => c,
        select: () => c,
        lean: async () => docs,
        then: (res, rej) => Promise.resolve(docs).then(res, rej),
    };
    return c;
}

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });   // claim won
    Guild.findOne.mockReturnValue({ lean: async () => ({ activeWar: { announcementChannelId: 'c2' } }) });
    User.findOne.mockReturnValue(chain(null));
    User.updateMany.mockResolvedValue({});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('resolveExpiredWars', () => {
    test('sweeps only wars that are still active and already past their end', async () => {
        Guild.find.mockResolvedValue([]);

        await resolveExpiredWars(fakeClient().client);

        const [filter] = Guild.find.mock.calls[0];
        expect(filter['activeWar.status']).toBe('active');
        expect(filter['activeWar.endsAt'].$ne).toBeNull();
        expect(filter['activeWar.endsAt'].$lte).toBeInstanceOf(Date);
    });

    test('claims the war by flipping active → ended before it pays anything', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        const order = [];
        Guild.findOneAndUpdate.mockImplementation(async filter => {
            order.push(filter['activeWar.status'] === 'active' ? 'claim' : 'other');
            return { guildId: 'g1' };
        });
        User.updateMany.mockImplementation(async () => { order.push('pay'); return {}; });

        await resolveExpiredWars(fakeClient().client);

        expect(order[0]).toBe('claim');
        expect(order).toContain('pay');

        const [filter, update, options] = Guild.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', 'activeWar.status': 'active' });
        expect(update).toEqual({ $set: { 'activeWar.status': 'ended' } });
        // `new: false` is not cosmetic here: the pre-update document is what
        // proves this call is the one that won the claim.
        expect(options).toEqual({ new: false });
    });

    test('a war another worker already claimed pays nothing', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        Guild.findOneAndUpdate.mockResolvedValue(null);   // someone else flipped it

        await resolveExpiredWars(fakeClient().client);

        expect(User.updateMany).not.toHaveBeenCalled();
    });

    test('pays the booster and the badge to the winning guild, and only to it', async () => {
        Guild.find.mockResolvedValue([warGuild()]);   // 100 – 40, this guild wins

        await resolveExpiredWars(fakeClient().client);

        expect(User.updateMany).toHaveBeenCalledTimes(1);
        const [filter, update] = User.updateMany.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1' });

        const { activeEffects, badges } = update.$push;
        expect(activeEffects).toMatchObject({ type: 'coin_booster_2x', charges: -1 });
        expect(badges).toMatchObject({ id: 'war_victor' });
        // 24 hours and 30 days, not the other way round.
        expect(activeEffects.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);
        expect(activeEffects.expiresAt.getTime() - Date.now()).toBeLessThan(25 * HOUR);
        expect(badges.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 24 * HOUR);
    });

    test('pays the opponent when the opponent is the one that won', async () => {
        Guild.find.mockResolvedValue([warGuild({ activeWar: { ...warGuild().activeWar, myScore: 10, opponentScore: 90 } })]);

        await resolveExpiredWars(fakeClient().client);

        // The sweep found g1's document, but g2 outscored it. Paying the guild
        // whose document was found is the bug this guards.
        expect(User.updateMany.mock.calls[0][0]).toEqual({ guildId: 'g2' });
    });

    test('a tie pays nobody', async () => {
        Guild.find.mockResolvedValue([warGuild({ activeWar: { ...warGuild().activeWar, myScore: 50, opponentScore: 50 } })]);

        await resolveExpiredWars(fakeClient().client);

        expect(User.updateMany).not.toHaveBeenCalled();
        expect(createWarVictoryBanner).not.toHaveBeenCalled();
    });

    test('announces the win to the winner and the loss to the opponent', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        const { client } = fakeClient();
        const sent = capture(client);

        await resolveExpiredWars(client);

        const titles = Object.fromEntries(sent.map(s => [
            s.guildId,
            (s.payload.embeds?.[0] ?? s.payload).title,
        ]));
        expect(titles.g1).toMatch(/WINS THE WAR/);
        expect(titles.g2).toMatch(/War Lost/);
        // The opponent's own announcement channel, read from its own document —
        // not the channel id off the guild that happened to be swept.
        expect(sent.find(s => s.guildId === 'g2').channelId).toBe('c2');
    });

    test('names the MVP from the winning guild, not the guild that was swept', async () => {
        Guild.find.mockResolvedValue([warGuild({ activeWar: { ...warGuild().activeWar, myScore: 10, opponentScore: 90 } })]);
        const seen = [];
        User.findOne.mockImplementation(filter => { seen.push(filter.guildId); return chain({ userId: 'mvp', duelWins: 9 }); });
        const { client } = fakeClient();
        capture(client);

        await resolveExpiredWars(client);

        expect(new Set(seen)).toEqual(new Set(['g2']));
    });

    test('a banner that fails to render still lets the announcement go out', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        createWarVictoryBanner.mockRejectedValueOnce(new Error('canvas unavailable'));
        const { client } = fakeClient();
        const sent = capture(client);

        await resolveExpiredWars(client);

        expect(sent.some(s => (s.payload.embeds?.[0] ?? s.payload).title?.includes('WINS'))).toBe(true);
        expect(sent.every(s => !s.payload.files?.length)).toBe(true);
    });

    test('one war that throws does not strand the rest of the sweep', async () => {
        Guild.find.mockResolvedValue([warGuild({ guildId: 'boom' }), warGuild({ guildId: 'ok' })]);
        Guild.findOneAndUpdate.mockImplementation(async filter => {
            if (filter.guildId === 'boom') throw new Error('mongo down');
            return { guildId: filter.guildId };
        });

        await expect(resolveExpiredWars(fakeClient().client)).resolves.toBeUndefined();

        expect(User.updateMany).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalled();
    });
});
