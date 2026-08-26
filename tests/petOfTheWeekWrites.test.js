'use strict';

/**
 * #784. `selectPetOfTheWeek` pays a 5,000-coin prize on a cron and then wipes
 * every `weeklyInteractions` counter in the guild. Both are one-way: the
 * counters are what the winner was chosen from, so once they are zeroed there
 * is nothing left to recompute a missed crowning from. Nothing executed it.
 */

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setThumbnail(t) { this.thumbnail = t; return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.fields.push(...f.flat()); return this; }
    }
    class AttachmentBuilder { constructor(buf, opts) { this.buf = buf; this.name = opts?.name; } }
    return { EmbedBuilder, AttachmentBuilder };
});

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/utils/cardGenerator', () => ({
    createWarVictoryBanner: jest.fn(async () => Buffer.from('banner')),
    createSeasonRecapCard:  jest.fn(async () => Buffer.from('recap')),
    generatePetSprite:      jest.fn(async () => Buffer.from('sprite')),
}));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const Guild = require('../src/models/Guild');
const User  = require('../src/models/User');
const { generatePetSprite } = require('../src/utils/cardGenerator');
const { logTransaction } = require('../src/utils/logTransaction');
const { selectPetOfTheWeek } = require('../src/services/schedulerService');

const DEFAULT_REWARD = 5_000;
const WEEK = 7 * 24 * 3600_000;

const WINNER = {
    userId: 'u1',
    pet: { _id: 'pet1', petId: 'cat', name: 'Mochi', weeklyInteractions: 42, adoptedAt: new Date(Date.now() - 3 * 86400000), evolutionStage: 1 },
};

let sent;
let errorLog;

function fakeClient() {
    sent = [];
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
            })),
        },
    };
}

function guildDoc(over = {}) {
    return { guildId: 'g1', economy: { announcementChannelId: 'c1' }, potwLastRunAt: null, ...over };
}

/** The two counter-clearing writes, told apart by their update shape. */
const ribbonClear  = () => User.updateMany.mock.calls.find(([, u]) => 'pets.$[old].potw' in (u.$set ?? {}));
const counterClear = () => User.updateMany.mock.calls.find(([, u]) => 'pets.$[].weeklyInteractions' in (u.$set ?? {}));

beforeEach(() => {
    jest.clearAllMocks();
    Guild.find.mockReturnValue({ lean: async () => [guildDoc()] });
    Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });
    User.aggregate.mockResolvedValue([WINNER]);
    User.updateOne.mockResolvedValue({});
    User.updateMany.mockResolvedValue({});
    User.findOneAndUpdate.mockResolvedValue({ balance: 12_345 });
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('selectPetOfTheWeek', () => {
    test('leases each guild on a weekly cadence, so a re-run within the week pays nothing', async () => {
        await selectPetOfTheWeek(fakeClient());

        const [filter, update, options] = Guild.findOneAndUpdate.mock.calls[0];
        expect(filter.guildId).toBe('g1');
        // Unrun, or last run at least a week ago — nothing in between.
        expect(filter.$or).toEqual([{ potwLastRunAt: null }, { potwLastRunAt: { $lte: expect.any(Date) } }]);
        expect(Date.now() - filter.$or[1].potwLastRunAt.$lte.getTime()).toBeGreaterThanOrEqual(WEEK - 5_000);
        expect(update.$set.potwLastRunAt).toBeInstanceOf(Date);
        expect(options).toEqual({ new: false });
    });

    test('a guild another worker already ran this week is skipped entirely', async () => {
        Guild.findOneAndUpdate.mockResolvedValue(null);

        await selectPetOfTheWeek(fakeClient());

        expect(User.aggregate).not.toHaveBeenCalled();
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(User.updateMany).not.toHaveBeenCalled();
    });

    test('picks the winner in the database rather than scanning every pet in memory', async () => {
        await selectPetOfTheWeek(fakeClient());

        const [pipeline] = User.aggregate.mock.calls[0];
        const stages = pipeline.map(s => Object.keys(s)[0]);
        expect(stages).toEqual(['$match', '$unwind', '$match', '$sort', '$limit', '$project']);
        // Only pets that were actually interacted with can win.
        expect(pipeline[2].$match).toEqual({ 'pets.weeklyInteractions': { $gt: 0 } });
        expect(pipeline[4].$limit).toBe(1);
    });

    test('crowns the winner before it clears the counters', async () => {
        const order = [];
        User.updateOne.mockImplementation(async (_f, u) => {
            if (u.$set?.['pets.$.potw'] === true) order.push('crown');
            return {};
        });
        User.updateMany.mockImplementation(async (_f, u) => {
            order.push('pets.$[].weeklyInteractions' in (u.$set ?? {}) ? 'clear-counters' : 'clear-ribbons');
            return {};
        });

        await selectPetOfTheWeek(fakeClient());

        // Reversed, a failure between the two leaves the week with no POTW and
        // the counts already wiped.
        expect(order).toEqual(['crown', 'clear-ribbons', 'clear-counters']);
        expect(User.updateOne.mock.calls[0][0]).toEqual({ guildId: 'g1', userId: 'u1', 'pets._id': 'pet1' });
    });

    test('clears last week’s ribbons from every pet except the new winner', async () => {
        await selectPetOfTheWeek(fakeClient());

        const [filter, , options] = ribbonClear();
        expect(filter).toEqual({ guildId: 'g1' });
        expect(options.arrayFilters).toEqual([{ 'old._id': { $ne: 'pet1' } }]);
        // Two writes, not one: `$[]` and `$[old]` over the same array in a
        // single `$set` is a path conflict MongoDB can reject outright.
        expect(counterClear()[0]).toEqual({ guildId: 'g1' });
    });

    test('pays the prize and files the ledger entry', async () => {
        await selectPetOfTheWeek(fakeClient());

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { guildId: 'g1', userId: 'u1' },
            { $inc: { balance: DEFAULT_REWARD } },
            { new: true },
        );
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u1', guildId: 'g1', type: 'potw_reward', amount: DEFAULT_REWARD, balance: 12_345,
        }));
    });

    test('honours a guild’s configured prize, including zero', async () => {
        Guild.find.mockReturnValue({ lean: async () => [guildDoc({ economy: { announcementChannelId: 'c1', potwReward: 250 } })] });
        await selectPetOfTheWeek(fakeClient());
        expect(User.findOneAndUpdate.mock.calls[0][1]).toEqual({ $inc: { balance: 250 } });

        jest.clearAllMocks();
        Guild.find.mockReturnValue({ lean: async () => [guildDoc({ economy: { announcementChannelId: 'c1', potwReward: 0 } })] });
        Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });
        User.aggregate.mockResolvedValue([WINNER]);

        await selectPetOfTheWeek(fakeClient());

        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        // And the embed must not advertise a prize nobody was paid.
        expect(sent[0].payload.embeds[0].fields.some(f => f.name.includes('Prize'))).toBe(false);
    });

    test('a week where nobody interacted still clears the counters and crowns nobody', async () => {
        User.aggregate.mockResolvedValue([]);

        await selectPetOfTheWeek(fakeClient());

        expect(User.updateOne).not.toHaveBeenCalled();
        expect(counterClear()).toBeDefined();
        // No winner to exempt, so every ribbon comes off.
        expect(ribbonClear()[2].arrayFilters).toEqual([{ 'old._id': { $ne: null } }]);
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
    });

    test('announces the winner with the interaction count and the prize', async () => {
        await selectPetOfTheWeek(fakeClient());

        const embed = sent[0].payload.embeds[0];
        expect(embed.title).toBe('🌟 Pet of the Week!');
        expect(embed.description).toContain('**Mochi** — owned by <@u1>');
        expect(embed.description).toContain('42 interactions this week');
        expect(embed.fields.find(f => f.name.includes('Prize')).value).toBe('5,000 coins');
    });

    test('a sprite that fails to render still lets the announcement go out', async () => {
        generatePetSprite.mockRejectedValueOnce(new Error('canvas unavailable'));

        await selectPetOfTheWeek(fakeClient());

        expect(sent[0].payload.embeds[0].title).toBe('🌟 Pet of the Week!');
        expect(sent[0].payload.files).toEqual([]);
    });

    test('a guild with nowhere to announce is still paid and still reset', async () => {
        Guild.find.mockReturnValue({ lean: async () => [guildDoc({ economy: {} })] });
        const client = fakeClient();
        client.guilds.fetch.mockResolvedValue(null);   // bot no longer in the guild

        await selectPetOfTheWeek(client);

        expect(User.findOneAndUpdate).toHaveBeenCalled();
        expect(counterClear()).toBeDefined();
        expect(sent).toEqual([]);
    });

    test('one guild that throws does not strand the rest of the sweep', async () => {
        Guild.find.mockReturnValue({ lean: async () => [guildDoc({ guildId: 'boom' }), guildDoc({ guildId: 'ok' })] });
        Guild.findOneAndUpdate.mockImplementation(async filter => {
            if (filter.guildId === 'boom') throw new Error('mongo down');
            return { guildId: filter.guildId };
        });

        await expect(selectPetOfTheWeek(fakeClient())).resolves.toBeUndefined();

        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalled();
    });
});
