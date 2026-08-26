'use strict';

/**
 * #784. `announceHourlyWinners` pays 500 coins per winner every hour, unwatched.
 * The only thing standing between it and a double payout is the per-winner
 * `rewarded: false → true` claim; the only thing standing between a winner and
 * silence is a `HOURLY_CATEGORY_LABELS` entry, which is a separate table a new
 * competition has to be added to. Neither was executed.
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
    return { EmbedBuilder, AttachmentBuilder: class {} };
});

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User',  () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/models/HourlyWinner', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn(), updateMany: jest.fn() }));

const Guild        = require('../src/models/Guild');
const User         = require('../src/models/User');
const HourlyWinner = require('../src/models/HourlyWinner');
const { getPreviousHourKey } = require('../src/utils/hourlyWinner');
const { announceHourlyWinners } = require('../src/services/schedulerService');

const REWARD = 500;

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

function winner(over = {}) {
    return { _id: 'w1', guildId: 'g1', userId: 'u1', username: 'Ada', category: 'fish', details: 'a Coelacanth', rewarded: false, ...over };
}

beforeEach(() => {
    jest.clearAllMocks();
    HourlyWinner.find.mockReturnValue({ lean: async () => [winner()] });
    HourlyWinner.findOneAndUpdate.mockImplementation(async filter => ({ _id: filter._id, rewarded: true }));
    User.findOneAndUpdate.mockResolvedValue({});
    Guild.findOne.mockReturnValue({ lean: async () => ({ guildId: 'g1', economy: { announcementChannelId: 'c1' } }) });
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('announceHourlyWinners', () => {
    test('reads the hour that just closed, not the one still running', async () => {
        await announceHourlyWinners(fakeClient());

        const [filter] = HourlyWinner.find.mock.calls[0];
        expect(filter).toEqual({ hour: getPreviousHourKey(), rewarded: false });
    });

    test('claims each winner before crediting, so a second run pays nothing', async () => {
        const order = [];
        HourlyWinner.findOneAndUpdate.mockImplementation(async filter => { order.push('claim'); return { _id: filter._id }; });
        User.findOneAndUpdate.mockImplementation(async () => { order.push('credit'); return {}; });

        await announceHourlyWinners(fakeClient());

        expect(order).toEqual(['claim', 'credit']);
        const [filter, update] = HourlyWinner.findOneAndUpdate.mock.calls[0];
        // `rewarded: false` in the filter is the claim: without it the update
        // succeeds every time and every tick re-pays.
        expect(filter).toEqual({ _id: 'w1', rewarded: false });
        expect(update).toEqual({ $set: { rewarded: true } });
    });

    test('a winner another worker already claimed is not paid again', async () => {
        HourlyWinner.findOneAndUpdate.mockResolvedValue(null);

        await announceHourlyWinners(fakeClient());

        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
    });

    test('credits the flat reward to the winner in their own guild', async () => {
        await announceHourlyWinners(fakeClient());

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' },
            { $inc: { balance: REWARD } },
        );
    });

    test('an hour with no candidates does nothing at all', async () => {
        HourlyWinner.find.mockReturnValue({ lean: async () => [] });

        await announceHourlyWinners(fakeClient());

        expect(HourlyWinner.findOneAndUpdate).not.toHaveBeenCalled();
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('pays every winner even when the announcement has nowhere to go', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ guildId: 'g1', economy: {} }) });

        await announceHourlyWinners(fakeClient());

        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([]);
    });

    test('a failed credit does not stop the other winners being paid', async () => {
        HourlyWinner.find.mockReturnValue({ lean: async () => [winner(), winner({ _id: 'w2', userId: 'u2', category: 'mine' })] });
        User.findOneAndUpdate.mockImplementation(async filter => {
            if (filter.userId === 'u1') throw new Error('mongo down');
            return {};
        });

        await expect(announceHourlyWinners(fakeClient())).resolves.toBeUndefined();

        expect(User.findOneAndUpdate).toHaveBeenCalledTimes(2);
        expect(errorLog).toHaveBeenCalled();
    });

    test('groups the hour into one announcement per guild', async () => {
        HourlyWinner.find.mockReturnValue({ lean: async () => [
            winner(),
            winner({ _id: 'w2', userId: 'u2', username: 'Grace', category: 'mine', details: '90 ore' }),
            winner({ _id: 'w3', guildId: 'g2', userId: 'u3', username: 'Kay', category: 'hunt', details: null }),
        ] });

        await announceHourlyWinners(fakeClient());

        expect(sent.map(s => s.guildId)).toEqual(['g1', 'g2']);
        const g1 = sent[0].payload.embeds[0];
        expect(g1.title).toBe("🏆 Last Hour's Champions");
        expect(g1.description).toContain('<@u1> (Ada) with **a Coelacanth** — rewarded **+500 coins**');
        expect(g1.description).toContain('<@u2> (Grace) with **90 ore**');
        // No details recorded reads as a bare mention, not "with **undefined**".
        expect(sent[1].payload.embeds[0].description).toContain('<@u3> (Kay) — rewarded');
    });

    test('a category missing from the label table is paid but not announced', async () => {
        // The label table is a second place a new competition has to be added.
        // Silence is the intended failure here — dropping the payout is not.
        HourlyWinner.find.mockReturnValue({ lean: async () => [winner({ category: 'forage' })] });

        await announceHourlyWinners(fakeClient());

        expect(User.findOneAndUpdate).toHaveBeenCalledWith({ userId: 'u1', guildId: 'g1' }, { $inc: { balance: REWARD } });
        expect(sent).toEqual([]);
    });

    test('one guild whose announcement throws does not strand the others', async () => {
        HourlyWinner.find.mockReturnValue({ lean: async () => [winner(), winner({ _id: 'w2', guildId: 'g2', userId: 'u2' })] });
        Guild.findOne.mockImplementation(filter => ({
            lean: async () => {
                if (filter.guildId === 'g1') throw new Error('mongo down');
                return { guildId: 'g2', economy: { announcementChannelId: 'c2' } };
            },
        }));

        await expect(announceHourlyWinners(fakeClient())).resolves.toBeUndefined();

        expect(sent.map(s => s.guildId)).toEqual(['g2']);
        expect(errorLog).toHaveBeenCalled();
    });
});
