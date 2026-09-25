'use strict';

/**
 * /casino roulette: the wheel, the Lucky Charm's refund, the frames the spin is
 * drawn in, and the game's order of operations — pay, then animate; big bets in
 * public; a replay never leaves a dead button behind.
 */

jest.mock('../src/models/User', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
}));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/games/casino/rouletteTable', () => ({
    ...jest.requireActual('../src/games/casino/rouletteTable'),
    renderRouletteTable: jest.fn(async () => Buffer.from('jpg')),
}));
jest.mock('../src/games/casino/payout', () => ({
    ...jest.requireActual('../src/games/casino/payout'),
    payHand: jest.fn(),
}));

const { MessageFlags } = require('discord.js');
const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { payHand } = require('../src/games/casino/payout');
const wheel = require('../src/games/casino/rouletteWheel');
const settlement = require('../src/games/casino/settlement');
const roulette = require('../src/games/casino/roulette');
const { makeInteraction } = require('./helpers/fakeInteraction');
const { walletDoc, GUILD_ID, USER_ID } = require('./helpers/casinoInteraction');

const OPEN = { guildId: GUILD_ID, economy: { enabled: true, gamesEnabled: true, casinoEnabled: true } };
const guildQuery = doc => Object.assign(Promise.resolve(doc), {
    lean: () => Object.assign(Promise.resolve(doc), { catch: () => Promise.resolve(doc) }),
});
const guardedDebits = () => User.findOneAndUpdate.mock.calls.filter(([f]) => f?.balance?.$gte !== undefined);

// ─── The wheel ────────────────────────────────────────────────────────────────

describe('the wheel', () => {
    test('holds every number once', () => {
        expect([...wheel.WHEEL_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
    });

    test('alternates red and black all the way round, zero aside', () => {
        const colours = wheel.WHEEL_ORDER.slice(1).map(wheel.colorOf);
        colours.forEach((c, i) => {
            if (i > 0) expect(c).not.toBe(colours[i - 1]);
        });
    });

    test('WHEEL_INDEX is where each number sits', () => {
        wheel.WHEEL_ORDER.forEach((n, i) => expect(wheel.WHEEL_INDEX[n]).toBe(i));
    });

    test.each([
        ['red', 18], ['black', 18], ['odd', 18], ['even', 18], ['low', 18], ['high', 18],
        ['dozen1', 12], ['dozen2', 12], ['dozen3', 12], ['col1', 12], ['col2', 12], ['col3', 12],
    ])('%s covers %i pockets', (key, count) => {
        expect(wheel.coveredNumbers(key)).toHaveLength(count);
        expect(wheel.coveredNumbers(key)).not.toContain(0);
    });

    test('a straight bet covers its number, zero included', () => {
        expect(wheel.coveredNumbers('number', 0)).toEqual([0]);
        expect(wheel.coveredNumbers('number', 17)).toEqual([17]);
    });

    test('a near miss is the next pocket on the wheel, not the next number', () => {
        // 17 sits between 25 and 34.
        expect(wheel.nearMiss(25, 'number', 17)).toBe(17);
        expect(wheel.nearMiss(34, 'number', 17)).toBe(17);
        expect(wheel.nearMiss(16, 'number', 17)).toBeNull();
        expect(wheel.nearMiss(25, 'red', 17)).toBeNull();
    });
});

// ─── The Lucky Charm ──────────────────────────────────────────────────────────

describe('the Lucky Charm refunds; it no longer re-spins', () => {
    const { rouletteCharmRefund, rouletteCharmSettlement } = settlement;
    const CHANCE = require('../src/services/effectsService').CASINO_LUCK.roulette.charm;

    test('hands back a tenth of the stake, never less than a coin', () => {
        expect(rouletteCharmRefund(10)).toBe(1);
        expect(rouletteCharmRefund(15)).toBe(1);
        expect(rouletteCharmRefund(2_500)).toBe(250);
        expect(rouletteCharmRefund(25_000)).toBe(2_500);
        expect(rouletteCharmSettlement(2_500)).toEqual({ profit: -2_250, credit: 250 });
    });

    // The player's return per coin staked, charm active, on every bet the table
    // takes. The re-spin this replaced returned more than 1 on all of them.
    test.each(Object.keys(wheel.BETS))('%s still favours the house with the charm', key => {
        const { payout } = wheel.BETS[key];
        const pWin = wheel.coveredNumbers(key, 17).length / 37;
        const withRefund = pWin * (payout + 1) + (1 - pWin) * CHANCE * settlement.ROULETTE_CHARM_REFUND;
        expect(withRefund).toBeLessThan(1);

        const pWinRespin = pWin + (1 - pWin) * CHANCE * pWin;
        expect(pWinRespin * (payout + 1)).toBeGreaterThan(1);
    });
});

// ─── The spin's frames ────────────────────────────────────────────────────────

describe('spinFrames', () => {
    test.each(wheel.WHEEL_ORDER)('lands the ball in %i, under the marker', result => {
        const frames = wheel.spinFrames(result);
        const last = frames.at(-1);
        expect(wheel.pocketUnderBall(last)).toBe(result);
        expect(last.onTrack).toBe(false);
        expect(last.ball).toBeCloseTo(-Math.PI / 2);
    });

    test('is a handful of long frames, not a flurry of short ones', () => {
        const frames = wheel.spinFrames(5);
        expect(frames.length).toBeLessThanOrEqual(6);
        expect(frames.slice(0, -1).every(f => f.holdMs >= 500)).toBe(true);
    });

    test('slows down', () => {
        const speeds = wheel.spinFrames(5).map(f => f.speed);
        speeds.slice(1).forEach((s, i) => expect(s).toBeLessThan(speeds[i]));
    });
});

// ─── The words ────────────────────────────────────────────────────────────────

describe('the result embed', () => {
    const { resultEmbed } = roulette.__test;
    const interaction = makeInteraction({ userId: USER_ID, guildId: GUILD_ID });
    const state = over => ({
        result: 17, won: true, charmSaved: false, betKey: 'black', target: null, bet: 100,
        profit: 100, credit: 200, outcome: 'win', ...over,
    });

    test('never nests bold inside bold', () => {
        // `**Landed on ${pocketLabel(result)}**` wrapped a `**17**` in another
        // pair and broke the headline into `**Landed on ⚫ **17****`.
        for (const outcome of ['win', 'loss', 'charm', 'jackpot']) {
            const e = resultEmbed({ interaction, spinState: state({ outcome }), balance: 1_000, history: [], withImage: false }).data;
            expect(e.description).not.toMatch(/\*{3,}/);
            expect(e.title).not.toMatch(/\*/);
        }
    });

    test('says the zero sinks outside bets only when it does', () => {
        const zero = resultEmbed({ interaction, spinState: state({ result: 0, outcome: 'loss', profit: -100 }), balance: 0, history: [], withImage: true }).data;
        expect(zero.description).toMatch(/Zero — every outside bet loses/);
        const hit = resultEmbed({ interaction, spinState: state({ result: 0, betKey: 'number', target: 0, outcome: 'jackpot', profit: 3_500 }), balance: 0, history: [], withImage: true }).data;
        expect(hit.description).not.toMatch(/every outside bet loses/);
    });

    test('draws the wheel in words when there is no image', () => {
        const e = resultEmbed({ interaction, spinState: state(), balance: 0, history: [3, 17], withImage: false }).data;
        // 17's neighbours on the wheel, not on the number line.
        expect(e.description).toMatch(/🔴 25 {2}\*\*▶ ⚫ 17 ◀\*\* {2}🔴 34/);
        expect(e.description).toMatch(/Recent/);
        expect(e.image).toBeUndefined();
    });
});

// ─── The game ─────────────────────────────────────────────────────────────────

describe('/casino roulette', () => {
    let randomSpy;
    let errorSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        Guild.findOne.mockImplementation(() => guildQuery(OPEN));
        Guild.findOneAndUpdate.mockResolvedValue({ casinoStats: { rouletteHistory: [4, 21] } });
        User.findOneAndUpdate.mockImplementation(async () => walletDoc());
        User.findOne.mockImplementation(() => guildQuery(walletDoc()));
        getGuildSettings.mockResolvedValue(OPEN);
        payHand.mockImplementation(async (_f, amount) => ({ credited: true, owed: false, balance: 10_000 + amount }));
    });

    afterEach(() => {
        randomSpy?.mockRestore();
        randomSpy = null;
        errorSpy.mockRestore();
    });

    /** Lands the first spin on `n`; every later draw is 0.5. */
    const landOn = (n, ...more) => {
        randomSpy = jest.spyOn(Math, 'random');
        randomSpy.mockReturnValueOnce((n + 0.5) / 37);
        more.forEach(v => randomSpy.mockReturnValueOnce(v));
        randomSpy.mockReturnValue(0.5);
    };

    const play = async (options, extra = {}) => {
        const interaction = makeInteraction({ options, userId: USER_ID, guildId: GUILD_ID, ...extra });
        await roulette.execute(interaction, { releaseLock: jest.fn(), onWager: jest.fn() });
        return interaction;
    };

    /** Lets the replay's collector deliver and the replay spin, however many turns that takes. */
    const until = async (done, turns = 500) => {
        for (let i = 0; i < turns && !done(); i++) await new Promise(r => setImmediate(r));
    };

    const spinFrameEdits = interaction => interaction.editReply.mock.calls
        .map(([p]) => p)
        .filter(p => p?.embeds?.[0]?.data?.description?.includes('ball is in play'));

    test('pays the spin before the wheel is drawn', async () => {
        landOn(3);   // red
        const interaction = await play({ bet: 'red', amount: 100, number: null });

        const paidAt  = payHand.mock.invocationCallOrder[0];
        const firstFrame = interaction.editReply.mock.invocationCallOrder[0];
        expect(payHand).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ phase: 'settle' }));
        expect(paidAt).toBeLessThan(firstFrame);
    });

    test('draws each frame as an image and settles on the result', async () => {
        landOn(3);
        const interaction = await play({ bet: 'red', amount: 100, number: null });

        const frames = spinFrameEdits(interaction);
        expect(frames.length).toBeGreaterThanOrEqual(3);
        frames.forEach(f => expect(f.files?.[0]?.name).toBe('roulette.jpg'));

        const last = interaction.editReply.mock.calls.at(-1)[0];
        expect(last.embeds[0].data.title).toBe('🎡 Roulette — 🔴 3');
        expect(last.embeds[0].data.image.url).toBe('attachment://roulette.jpg');
        expect(last.components.length).toBe(2);
    });

    test('a `number` on an outside bet is refused, not ignored', async () => {
        const interaction = await play({ bet: 'red', amount: 100, number: 17 });
        expect(guardedDebits()).toHaveLength(0);
        expect(interaction.replies[0]).toEqual({
            content: expect.stringMatching(/only applies to a \*\*Straight Number\*\*/),
            flags: MessageFlags.Ephemeral,
        });
    });

    test('a confirmed large bet spins in public, not inside the private prompt', async () => {
        landOn(3);
        const confirm = { customId: 'confirm_large_bet' };
        const interaction = await play({ bet: 'red', amount: 9_000, number: null }, { components: [confirm] });

        // The prompt is the ephemeral reply; the wheel goes on a follow-up.
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
        expect(interaction.followUp).toHaveBeenCalledTimes(1);
        expect(interaction.followUp.mock.calls[0][0].flags).toBeUndefined();
        // Every later edit names the follow-up rather than the prompt.
        const edits = interaction.editReply.mock.calls.map(([p]) => p).filter(p => p.embeds);
        expect(edits.length).toBeGreaterThan(0);
        edits.forEach(p => expect(p.message).toBeDefined());
    });

    test('the Lucky Charm hands back a slice of a lost stake, and does not re-spin', async () => {
        const charmed = walletDoc({ activeEffects: [{ type: 'lucky_charm', expiresAt: new Date(Date.now() + 60_000) }] });
        User.findOneAndUpdate.mockImplementation(async () => charmed);
        landOn(2, 0.1);   // black 2 on a red bet; then the charm's roll

        const interaction = await play({ bet: 'red', amount: 100, number: null });

        expect(payHand).toHaveBeenCalledTimes(1);
        expect(payHand).toHaveBeenCalledWith(expect.anything(), 10, expect.objectContaining({ phase: 'settle' }));
        const last = interaction.editReply.mock.calls.at(-1)[0].embeds[0].data;
        expect(last.title).toBe('🎡 Roulette — ⚫ 2');
        expect(last.description).toMatch(/Lucky Charm\*\* hands back \*\*10\*\* — net \*\*−90\*\*/);
    });

    test('a replay clears the old buttons the moment it starts spinning', async () => {
        landOn(3);
        let interaction = null;
        const press = {
            get customId() {
                return interaction?.replies
                    .flatMap(r => r?.components ?? [])
                    .flatMap(row => row.components ?? [])
                    .map(c => c.data?.custom_id)
                    .find(id => id?.startsWith('roulette_replay_'));
            },
        };
        interaction = makeInteraction({ options: { bet: 'red', amount: 100, number: null }, userId: USER_ID, guildId: GUILD_ID, components: [press] });
        await roulette.execute(interaction, { releaseLock: jest.fn(), onWager: jest.fn() });
        // Let the collector deliver its press and the replay run.
        await until(() => payHand.mock.calls.length >= 2 && interaction.replies.filter(r => r?.components?.length).length >= 2);

        expect(guardedDebits()).toHaveLength(2);
        const replayFrames = interaction.replies.slice(interaction.replies.findIndex(r => r.components?.length) + 1)
            .filter(p => p?.embeds?.[0]?.data?.description?.includes('ball is in play'));
        expect(replayFrames.length).toBeGreaterThan(0);
        replayFrames.forEach(p => expect(p.components).toEqual([]));
    });

    test('half and double re-stake the bet they name', async () => {
        landOn(3);
        let interaction = null;
        const press = {
            get customId() {
                return interaction?.replies
                    .flatMap(r => r?.components ?? [])
                    .flatMap(row => row.components ?? [])
                    .map(c => c.data?.custom_id)
                    .find(id => id?.startsWith('roulette_double_'));
            },
        };
        interaction = makeInteraction({ options: { bet: 'red', amount: 100, number: null }, userId: USER_ID, guildId: GUILD_ID, components: [press] });
        await roulette.execute(interaction, { releaseLock: jest.fn(), onWager: jest.fn() });
        await until(() => payHand.mock.calls.length >= 2);

        expect(guardedDebits().map(([, update]) => -update.$inc.balance)).toEqual([100, 200]);
    });
});

// ─── The image ────────────────────────────────────────────────────────────────

describe('the table image', () => {
    const { renderRouletteTable } = jest.requireActual('../src/games/casino/rouletteTable');

    test('draws a spinning frame and a settled one as JPEGs', async () => {
        const frames = wheel.spinFrames(17);
        const base = { betLabel: 'RED', odds: '1:1', bet: 2_500, covered: wheel.coveredNumbers('red'), history: [3, 0, 32] };
        for (const [frame, result] of [[frames[1], null], [frames.at(-1), 17]]) {
            const jpg = await renderRouletteTable({ ...base, frame, result, banner: result === null ? null : { text: 'LOSS  −2,500', tone: 'lose' } });
            expect(jpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
            expect(jpg.length).toBeLessThan(250_000);
        }
    });
});
