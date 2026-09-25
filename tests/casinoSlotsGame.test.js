'use strict';

/**
 * `/casino slots` played end to end (#873, pass 25).
 *
 * The reels and the return are pinned in casinoSlotsReels.test.js. This drives
 * the game around them — the reveal, free spins, the buttons, where each spin
 * renders — through the fixes the pass made:
 *
 *   - free spins showed a final card saying "Free spins incoming…" after they
 *     had played, labelled the spin "💀 Lost" and dropped their winnings from it
 *   - "Spin Again" edited the command's own reply forever, and that token dies
 *     fifteen minutes after the command was typed
 *   - a bet that needed the large-bet confirmation played inside that private
 *     prompt, so the biggest bets were the ones the channel never saw
 *   - an error left the "Spinning…" card up under the error text
 *   - "Three Cherrys"
 *
 * And the machine image (#1199): every frame carries a picture of the machine
 * with alt text, and the embed beside it keeps the numbers.
 */

jest.mock('../src/models/User', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
    create:           jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
}));
jest.mock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
// Fixed spins, when a test queues them: see tests/helpers/slotsSpins.js.
// The machine image is drawn for real in tests/casinoSlotsTable.test.js; here
// it only has to exist, and the views it was asked to draw are what is checked.
jest.mock('../src/games/casino/slotsTable', () => ({
    ...jest.requireActual('../src/games/casino/slotsTable'),
    renderMachine: jest.fn(async () => Buffer.from('jpg')),
}));
let mockSpins = [];
jest.mock('../src/games/casino/slotsReels', () => {
    const actual = jest.requireActual('../src/games/casino/slotsReels');
    return { ...actual, spin: (...args) => (mockSpins.length ? mockSpins.shift() : actual.spin(...args)) };
});

const { MessageFlags } = require('discord.js');
const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const slots = require('../src/games/casino/slots');
const { renderMachine } = require('../src/games/casino/slotsTable');
const { BY_NAME, TRIPLE_BOOST_MULT, FREE_SPINS, HEAT_MAX } = jest.requireActual('../src/games/casino/slotsReels');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { walletDoc, GUILD_ID, USER_ID, BET } = require('./helpers/casinoInteraction');
const { view } = require('./helpers/slotsSpins');

const OPEN = { enabled: true, gamesEnabled: true, casinoEnabled: true };

const query = doc => Object.assign(Promise.resolve(doc), {
    lean: () => Object.assign(Promise.resolve(doc), { catch: () => Promise.resolve(doc) }),
});

let guild;

/** Every keyed coin credit the game issued, as `{ phase, amount }`. */
const credits = () => User.findOneAndUpdate.mock.calls
    .filter(([filter, update]) => Array.isArray(update) && filter?.['paidPayouts.key']?.$ne?.startsWith('casino:slots:'))
    .map(([filter, update]) => ({
        phase:  filter['paidPayouts.key'].$ne.split(':').at(-1),
        amount: update[0]?.$set?.balance?.$add?.[1],
    }));

/** The stakes taken, by the compare-and-set that takes one. */
const debits = () => User.findOneAndUpdate.mock.calls
    .filter(([filter]) => filter?.balance?.$gte !== undefined)
    .map(([filter]) => filter.balance.$gte);

/** The last render that carried the result's buttons. */
const resultOf = interaction => interaction.replies.filter(r => r?.components?.length).at(-1);
const field = (embed, name) => embed.data.fields.find(f => f.name.includes(name))?.value;
const buttons = payload => payload.components.flatMap(row => row.components).map(c => c.data);
/** Every machine view the game asked to draw, in order. */
const drawn = () => renderMachine.mock.calls.map(([v]) => v);

async function play(spins, { bet = BET, interaction = null, ...opts } = {}) {
    mockSpins = [...spins];
    const spin = interaction ?? makeInteraction({ options: { bet }, userId: USER_ID, guildId: GUILD_ID, ...opts });
    const run = slots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
    for (let i = 0; i < 60; i++) await jest.advanceTimersByTimeAsync(250);
    await run;
    return spin;
}

const LOSER = () => view(['Cherry', 'Lemon', 'Grape']);

let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSpins = [];
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    renderMachine.mockImplementation(async () => Buffer.from('jpg'));
    guild = { guildId: GUILD_ID, economy: { ...OPEN } };
    Guild.findOne.mockImplementation(() => query(guild));
    Guild.findOneAndUpdate.mockResolvedValue(null);
    Guild.updateOne.mockResolvedValue({});
    getGuildSettings.mockImplementation(async () => guild);
    User.findOneAndUpdate.mockImplementation(() => Promise.resolve(walletDoc()));
    User.findOne.mockImplementation(() => query(walletDoc()));
    User.updateOne.mockResolvedValue({});
});

afterEach(() => {
    jest.useRealTimers();
    errorSpy.mockRestore();
});

describe('the result card', () => {
    test('names the win properly and pays the line', async () => {
        const spin = await play([view(['Cherry', 'Cherry', 'Cherry'])]);

        const result = resultOf(spin).embeds[0];
        expect(result.data.description).toContain('Three Cherries');
        expect(result.data.description).not.toContain('Cherrys');
        expect(credits()).toEqual([{ phase: 'settle', amount: BET * BY_NAME.get('Cherry').three }]);
        expect(field(result, 'Won')).toBe(`**${(BET * BY_NAME.get('Cherry').three).toLocaleString()}**`);
    }, 20_000);

    test('pays two Wilds and a Boost as a Triple Boost', async () => {
        const spin = await play([view(['Wild', 'Wild', 'Boost'])]);

        expect(credits()).toEqual([{ phase: 'settle', amount: BET * TRIPLE_BOOST_MULT }]);
        expect(resultOf(spin).embeds[0].data.description).toContain('Triple Boost');
    }, 20_000);

    test('a loss says so plainly, with no "assisted" or "boost applied" beside it', async () => {
        const spin = await play([view(['Wild', 'Boost', 'Scatter'])]);

        const result = resultOf(spin).embeds[0].data;
        expect(result.title).toContain('No Win');
        expect(result.description).not.toMatch(/Wild completed|Boost/);
        expect(credits()).toEqual([]);
    }, 20_000);

    test('without the image, shows the whole 3×3 window in text, payline marked', async () => {
        renderMachine.mockRejectedValue(new Error('no canvas'));
        const spin = await play([view(['Star', 'Star', 'Star'], { above: ['Bell', 'Bell', 'Bell'], below: ['Grape', 'Grape', 'Grape'] })]);

        const result = resultOf(spin);
        expect(result.files).toEqual([]);
        expect(result.embeds[0].data.image).toBeUndefined();
        const [top, line, bottom] = result.embeds[0].data.description.split('\n');
        expect(top).toBe('▪️ 🔔 🔔 🔔 ▪️');
        expect(line).toBe('▶️ 🌟 🌟 🌟 ◀️');
        expect(bottom).toBe('▪️ 🍇 🍇 🍇 ▪️');
    }, 20_000);

    test('with the image, the window is in the picture and its alt text, not the embed', async () => {
        const spin = await play([view(['Star', 'Star', 'Star'], { above: ['Bell', 'Bell', 'Bell'], below: ['Grape', 'Grape', 'Grape'] })]);

        const result = resultOf(spin);
        expect(result.embeds[0].data.description).not.toContain('▶️');
        expect(result.files[0].description).toContain('Payline: Star, Star, Star');
        expect(result.files[0].description).toContain('Above it: Bell, Bell, Bell');
        expect(result.files[0].description).toContain('Below it: Grape, Grape, Grape');
    }, 20_000);
});

describe('free spins', () => {
    const SCATTERED = () => view(['Bell', 'Bell', 'Bell'], {
        above: ['Scatter', 'Cherry', 'Grape'],
        below: ['Grape', 'Scatter', 'Lemon'],
    });
    const runOf = n => [view(['Star', 'Star', 'Star']), ...Array.from({ length: n - 1 }, LOSER)];

    test('play after the line, are paid on their own key, and count in the result', async () => {
        const { spins } = FREE_SPINS[2];
        const spin = await play([SCATTERED(), ...runOf(spins)]);

        const line = BET * BY_NAME.get('Bell').three;
        const free = BET * BY_NAME.get('Star').three;
        expect(credits()).toEqual([
            { phase: 'settle', amount: line },
            { phase: 'free-spins', amount: free },
        ]);

        const result = resultOf(spin).embeds[0];
        expect(field(result, 'Won')).toBe(`**${(line + free).toLocaleString()}**`);
        expect(field(result, 'Net')).toBe(`**+${(line + free - BET).toLocaleString()}**`);
        expect(result.data.description).toContain(`Free spins: **+${free.toLocaleString()}**`);
        // The old card said "incoming" after they had played, and "Lost".
        expect(result.data.description).not.toContain('incoming');
        expect(repliedText(spin)).not.toContain('Lost');
    }, 20_000);

    test('the intro does not show a balance that already counts spins not yet played', async () => {
        // Both payouts settle before the show, so the intro used to print the
        // balance after the free spins — giving away their total before one
        // had been played.
        let wallet = 10_000;
        User.findOneAndUpdate.mockImplementation((filter, update) => {
            if (filter?.balance?.$gte !== undefined) wallet -= filter.balance.$gte;
            else if (Array.isArray(update) && filter?.['paidPayouts.key']) wallet += update[0].$set.balance.$add[1];
            return Promise.resolve(walletDoc({ balance: wallet }));
        });
        const spin = await play([SCATTERED(), ...runOf(FREE_SPINS[2].spins)]);

        const embeds = spin.replies.flatMap(r => r?.embeds ?? []);
        const intro = embeds.find(e => e.data.title?.startsWith('🌸 FREE SPINS'));
        const line = BET * BY_NAME.get('Bell').three;
        const free = BET * BY_NAME.get('Star').three;
        expect(field(intro, 'Balance')).toBe(`**${(10_000 - BET + line).toLocaleString()}**`);
        expect(field(resultOf(spin).embeds[0], 'Balance')).toBe(`**${(10_000 - BET + line + free).toLocaleString()}**`);
    }, 20_000);

    test('are introduced with the scatters in view, then played on one strip in a few edits', async () => {
        const { spins } = FREE_SPINS[2];
        const spin = await play([SCATTERED(), ...runOf(spins)]);

        const titles = spin.replies.flatMap(r => r?.embeds ?? []).map(e => e.data.title ?? '');
        const intro = titles.findIndex(t => t.startsWith('🌸 FREE SPINS'));
        expect(intro).toBeGreaterThanOrEqual(0);

        // The intro's picture outlines both Scatters, off the line, and the line.
        const introView = drawn().find(v => v.banner?.text.startsWith('FREE SPINS ×'));
        expect(introView.banner).toEqual({ text: `FREE SPINS × ${spins}`, tone: 'gold' });
        expect(introView.reels.map(r => [...r.hits].sort())).toEqual([[0, 1], [1, 2], [1]]);
        expect(introView.tag.text).toBe('THREE BELLS · 20×');

        // Three edits fill the strip, not one per spin.
        const batches = titles.slice(intro).filter(t => t.startsWith('🌸 Free Spins ·'));
        expect(batches).toEqual([`🌸 Free Spins · 3 of ${spins}`, `🌸 Free Spins · 6 of ${spins}`, `🌸 Free Spins · ${spins} of ${spins}`]);
        const strips = drawn().filter(v => v.free && v.tag.text.startsWith('FREE SPIN '));
        expect(strips.map(v => v.free.filter(Boolean).length)).toEqual([3, 6, spins]);
        expect(strips.every(v => v.free.length === spins)).toBe(true);

        // The running total is on the banner; the Star line paid on the first spin.
        const star = BET * BY_NAME.get('Star').three;
        expect(strips[0].banner.text).toBe(`FREE SPINS  +${star.toLocaleString()}`);
        expect(strips[0].free[0]).toEqual({ cells: ['star', 'star', 'star'], pay: star });
        expect(strips[0].free[1]).toEqual({ cells: ['cherry', 'lemon', 'grape'], pay: 0 });
    }, 20_000);

    test('the result keeps the finished strip, under the whole spin’s banner', async () => {
        const { spins } = FREE_SPINS[2];
        const spin = await play([SCATTERED(), ...runOf(spins)]);

        const final = drawn().at(-1);
        const line = BET * BY_NAME.get('Bell').three;
        const free = BET * BY_NAME.get('Star').three;
        expect(final.free.every(Boolean)).toBe(true);
        expect(final.tag.text).toBe(`1 OF ${spins} FREE SPINS HIT · +${free.toLocaleString()}`);
        expect(final.banner).toEqual({ text: `EPIC WIN  +${(line + free - BET).toLocaleString()}`, tone: 'gold' });
        expect(resultOf(spin).files[0].description).toContain('Free spins, 8 of 8 played');
    }, 20_000);
});

describe('the machine image', () => {
    const frames = interaction => interaction.replies.filter(r => r?.embeds?.length);

    test('every frame carries the image, with alt text, and replaces the last one', async () => {
        const spin = await play([LOSER()]);

        const shown = frames(spin);
        expect(shown.length).toBeGreaterThan(1);
        for (const frame of shown) {
            expect(frame.attachments).toEqual([]);
            expect(frame.files).toHaveLength(1);
            expect(frame.files[0].name).toBe('slots.jpg');
            expect(frame.files[0].description.length).toBeGreaterThan(20);
            expect(frame.embeds[0].data.image.url).toBe('attachment://slots.jpg');
        }
    }, 20_000);

    test('a spin draws the spinning frame, reel 1, reel 2, then the result', async () => {
        await play([view(['Star', 'Star', 'Star'])]);

        const views = drawn();
        expect(views).toHaveLength(4);
        expect(views.map(v => v.reels.map(r => Boolean(r.cells)))).toEqual([
            [false, false, false],
            [true, false, false],
            [true, true, false],
            [true, true, true],
        ]);
        // The spinning frame is always the same frame: nothing on it but the status row.
        expect(views[0]).toMatchObject({ tag: null, status: 'SPINNING…' });
        expect(views[0].reels.every(r => !r.glow)).toBe(true);
    }, 20_000);

    test('the result outlines the line, names it, and banners the tier; the embed keeps the numbers', async () => {
        const spin = await play([view(['Star', 'Star', 'Star'])]);

        const result = drawn().at(-1);
        const won = BET * BY_NAME.get('Star').three;
        expect(result.reels.map(r => r.hits)).toEqual([[1], [1], [1]]);
        expect(result.tag).toEqual({ text: 'THREE STARS · 88×', tone: 'win' });
        expect(result.banner).toEqual({ text: `EPIC WIN  +${(won - BET).toLocaleString()}`, tone: 'gold' });

        const payload = resultOf(spin);
        expect(payload.files[0].description).toContain('THREE STARS · 88×');
        expect(payload.files[0].description).toContain('EPIC WIN');
        const embed = payload.embeds[0];
        expect(embed.data.description).toContain('Three Stars');
        expect(field(embed, 'Won')).toBe(`**${won.toLocaleString()}**`);
        expect(field(embed, 'Balance')).toBeDefined();
        expect(embed.data.footer.text).toContain('Session · 1 spin · wagered 100');
    }, 20_000);

    test('a pair outlines only the cells that made it', async () => {
        await play([view(['Star', 'Cherry', 'Wild'])]);
        const result = drawn().at(-1);
        expect(result.reels.map(r => r.hits)).toEqual([[1], [], [1]]);
        expect(result.tag.text).toBe('PAIR OF STARS · 8×');
    }, 20_000);

    test('a loss says NO WIN, with no line pill', async () => {
        await play([LOSER()]);
        const result = drawn().at(-1);
        expect(result.banner).toEqual({ text: 'NO WIN', tone: 'lose' });
        expect(result.tag).toBeNull();
        expect(result.reels.every(r => r.hits.length === 0)).toBe(true);
    }, 20_000);

    test('two Wilds hold the last reel with a gold glow and a tease pill', async () => {
        const spin = await play([view(['Wild', 'Wild', 'Cherry'])]);

        const tease = drawn()[2];
        expect(tease.reels[2]).toMatchObject({ cells: null, glow: 'gold' });
        expect(tease.tag).toEqual({ text: 'ONE MORE WILD FOR THE JACKPOT', tone: 'gold' });
        expect(frames(spin)[2].files[0].description).toContain('ONE MORE WILD FOR THE JACKPOT');
        expect(frames(spin)[2].embeds[0].data.description).toContain('One more Wild for the jackpot');
    }, 20_000);

    test('a Hot Spin starts with reel 1 stopped, glowing orange, under a HOT SPIN pill', async () => {
        const hotWallet = walletDoc({ casinoStats: { slotsHeat: HEAT_MAX } });
        User.findOneAndUpdate.mockImplementation(() => Promise.resolve(hotWallet));
        await play([view(['Star', 'Cherry', 'Lemon'])]);

        const [first] = drawn();
        expect(drawn()).toHaveLength(3);
        expect(first).toMatchObject({ hot: true, tag: { text: 'HOT SPIN · REEL 1 LOCKED', tone: 'hot' } });
        expect(first.reels[0]).toMatchObject({ cells: ['cherry', 'star', 'grape'], glow: 'hot' });
        expect(first.reels[1].cells).toBeNull();
        // The result's meter reads the heat after the spin: emptied.
        expect(drawn().at(-1)).toMatchObject({ hot: false, heat: 0 });
    }, 20_000);

    test('a Triple Wild glows every reel gold, and only claims the pot on the pill when it was paid', async () => {
        // No pool to claim here (the guild update finds nothing), so the line
        // pays alone and the pill does not promise the pot.
        await play([view(['Wild', 'Wild', 'Wild'])]);
        const result = drawn().at(-1);
        expect(result.reels.every(r => r.glow === 'gold')).toBe(true);
        expect(result.tag).toEqual({ text: 'TRIPLE WILD · 100×', tone: 'gold' });
        expect(result.banner.text).toMatch(/^EPIC WIN {2}\+/);
    }, 20_000);
});

describe('the buttons', () => {
    const replayIds = interaction => buttons(resultOf(interaction)).map(b => b.custom_id);
    const idFor = (interaction, prefix) => replayIds(interaction).find(id => id.startsWith(prefix));

    test('a replay renders through the press, not the command’s fifteen-minute token', async () => {
        const spin = await play([LOSER()], { holdCollectors: true });
        const editsBefore = spin.editReply.mock.calls.length;

        mockSpins = [LOSER()];
        const press = await spin.press({ customId: idFor(spin, 'slots_replay_') });
        for (let i = 0; i < 60; i++) await jest.advanceTimersByTimeAsync(250);

        expect(debits()).toEqual([BET, BET]);
        expect(press.editReply).toHaveBeenCalled();
        expect(spin.editReply.mock.calls.length).toBe(editsBefore);
    }, 20_000);

    test('½ and 2× spin again at half and double the bet', async () => {
        const spin = await play([LOSER()], { holdCollectors: true });
        mockSpins = [LOSER()];
        await spin.press({ customId: idFor(spin, 'slots_half_') });
        for (let i = 0; i < 60; i++) await jest.advanceTimersByTimeAsync(250);
        expect(debits()).toEqual([BET, BET / 2]);

        const again = await play([LOSER()], { holdCollectors: true });
        User.findOneAndUpdate.mockClear();
        mockSpins = [LOSER()];
        await again.press({ customId: idFor(again, 'slots_double_') });
        for (let i = 0; i < 60; i++) await jest.advanceTimersByTimeAsync(250);
        expect(debits()).toEqual([BET * 2]);
    }, 20_000);

    test('2× is off when it would pass the limit, and ½ is off at the minimum', async () => {
        guild.economy.casinoMaxBet = BET + 50;
        const spin = await play([LOSER()]);
        const double = buttons(resultOf(spin)).find(b => b.custom_id.startsWith('slots_double_'));
        expect(double.disabled).toBe(true);

        const small = await play([LOSER()], { bet: 10 });
        const half = buttons(resultOf(small)).find(b => b.custom_id.startsWith('slots_half_'));
        expect(half.disabled).toBe(true);
    }, 20_000);

    test('2× will not step past the large-bet confirmation', async () => {
        // The typed command asks before a bet over the threshold; a button that
        // doubled past it would let a player walk around the prompt one press
        // at a time.
        guild.economy.betConfirmThreshold = BET + 50;
        const spin = await play([LOSER()]);
        const double = buttons(resultOf(spin)).find(b => b.custom_id.startsWith('slots_double_'));
        expect(double.disabled).toBe(true);
    }, 20_000);

    test('Max spins at the most a player can stake without a confirmation', async () => {
        // A 10,000 wallet and no configured threshold: the confirmation asks
        // above half the wallet, so Max is 5,000.
        const spin = await play([LOSER()], { holdCollectors: true });
        const max = buttons(resultOf(spin)).find(b => b.custom_id.startsWith('slots_max_'));
        expect(max.label).toBe('Max · 5,000');
        expect(max.disabled).toBe(false);

        mockSpins = [LOSER()];
        await spin.press({ customId: idFor(spin, 'slots_max_') });
        for (let i = 0; i < 60; i++) await jest.advanceTimersByTimeAsync(250);
        expect(debits()).toEqual([BET, 5_000]);
    }, 20_000);

    test('Max stops at the server’s bet limit', async () => {
        guild.economy.casinoMaxBet = 300;
        const spin = await play([LOSER()]);
        const max = buttons(resultOf(spin)).find(b => b.custom_id.startsWith('slots_max_'));
        expect(max.label).toBe('Max · 300');
    }, 20_000);

    test('Max is off when the bet is already the most it could be', async () => {
        guild.economy.casinoMaxBet = BET;
        const spin = await play([LOSER()]);
        const max = buttons(resultOf(spin)).find(b => b.custom_id.startsWith('slots_max_'));
        expect(max.disabled).toBe(true);
    }, 20_000);

    test('a row holds all five buttons, which is Discord’s limit', async () => {
        const spin = await play([LOSER()]);
        expect(buttons(resultOf(spin)).map(b => b.custom_id.split('_')[1]))
            .toEqual(['replay', 'half', 'double', 'max', 'pay']);
    }, 20_000);

    test('the paytable answers privately, with the paytable image', async () => {
        jest.useRealTimers();
        const spin = await play([LOSER()], { holdCollectors: true });
        const press = await spin.press({ customId: idFor(spin, 'slots_pay_') });

        expect(press.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        const [[payload]] = press.editReply.mock.calls;
        const [image] = payload.files;
        expect(image.name).toBe('slots-paytable.png');
        expect(image.attachment.subarray(0, 4).toString('hex')).toBe('89504e47');
        expect(image.description).toContain('Three Stars 88x');
    }, 20_000);

    test('a paytable that cannot be drawn falls back to the text paytable', async () => {
        jest.useRealTimers();
        let isolatedSlots;
        jest.isolateModules(() => {
            jest.doMock('../src/games/casino/slotsPaytableCard', () => ({
                paytableImage: () => Promise.reject(new Error('no canvas')),
                paytableAltText: () => '',
            }));
            isolatedSlots = require('../src/games/casino/slots');
        });
        mockSpins = [LOSER()];
        const spin = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID, holdCollectors: true });
        await isolatedSlots.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        const press = await spin.press({ customId: idFor(spin, 'slots_pay_') });

        const [[payload]] = press.editReply.mock.calls;
        const text = JSON.stringify(payload.embeds[0].data);
        expect(text).toContain('94.0%');
        expect(text).toContain("Coin boosters don't apply to slots");
    }, 20_000);
});

describe('where a spin plays', () => {
    test('a bet that needed confirming plays in public, not inside the private prompt', async () => {
        guild.economy.betConfirmThreshold = BET - 1;
        const spin = await play([LOSER()], { components: [{ customId: 'confirm_large_bet' }] });

        expect(spin.followUp).toHaveBeenCalledTimes(1);
        const [[first]] = spin.followUp.mock.calls;
        expect(first.flags).toBeUndefined();
        expect(first.embeds[0].data.title).toBe('🎰 Slots');
        // Every later frame edits that follow-up, named by `message`.
        const laterEdits = spin.editReply.mock.calls.map(([p]) => p).filter(p => p.embeds?.length);
        expect(laterEdits.length).toBeGreaterThan(0);
        expect(laterEdits.every(p => p.message)).toBe(true);
    }, 20_000);

    test('an error replaces the reels with an error card, and says what became of the stake', async () => {
        // A spin that cannot be read throws after the stake is taken and before
        // anything is paid, which is the case the rollback is for.
        const spin = await play([{ line: null, window: null, stops: [] }]);

        const last = spin.replies.at(-1);
        expect(last.content).toBe('');
        expect(last.components).toEqual([]);
        expect(last.embeds[0].data.description).toContain('refunded');
        expect(credits()).toEqual([{ phase: 'rollback', amount: BET }]);
    }, 20_000);
});

describe('the big-win announcement', () => {
    const announcer = () => {
        const channel = { id: 'announce-1', isTextBased: () => true, send: jest.fn().mockResolvedValue(undefined) };
        return { channel, channels: new Map([['announce-1', channel]]) };
    };

    test('goes to the announcement channel for a win of 50× or more', async () => {
        guild.economy.announcementChannelId = 'announce-1';
        const { channel, channels } = announcer();
        await play([view(['Star', 'Star', 'Star'])], { channels });

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send.mock.calls[0][0].embeds[0].data.description).toContain('Three Stars');
    }, 20_000);

    test('is not repeated in the channel the spin is already in', async () => {
        guild.economy.announcementChannelId = 'channel-1';
        const channel = { id: 'channel-1', isTextBased: () => true, send: jest.fn() };
        await play([view(['Star', 'Star', 'Star'])], { channels: new Map([['channel-1', channel]]) });

        expect(channel.send).not.toHaveBeenCalled();
    }, 20_000);
});

describe('/casino slotsconfig', () => {
    const casino = require('../src/commands/economy/casino');

    function run(options, { admin = true } = {}) {
        const interaction = makeInteraction({ options, subcommand: 'slotsconfig', userId: USER_ID, guildId: GUILD_ID });
        interaction.memberPermissions = { has: () => admin };
        return casino.execute(interaction).then(() => interaction);
    }

    test('sets the Triple Wild announcement settings slots reads', async () => {
        // They were declared on the Guild model and read by the broadcast, and
        // nothing could set them.
        Guild.findOneAndUpdate.mockResolvedValue({ slots: { announceJackpot: false, jackpotPingHere: true, jackpotChannelId: 'c-9' } });

        const interaction = await run({ announce: false, ping_here: true, channel: { id: 'c-9' } });

        expect(Guild.findOneAndUpdate).toHaveBeenCalledWith(
            { guildId: GUILD_ID },
            { $set: { 'slots.announceJackpot': false, 'slots.jackpotPingHere': true, 'slots.jackpotChannelId': 'c-9' } },
            { new: true },
        );
        const { content, flags } = interaction.replies.at(-1);
        expect(flags).toBe(MessageFlags.Ephemeral);
        expect(content).toContain('announcement: **off**');
        expect(content).toContain('<#c-9>');
    });

    test('with no options, shows the settings and writes nothing', async () => {
        const interaction = await run({});
        expect(Guild.findOneAndUpdate).not.toHaveBeenCalled();
        expect(interaction.replies.at(-1).content).toContain('announcement: **on**');
    });

    test('is for admins only', async () => {
        const interaction = await run({ announce: false }, { admin: false });
        expect(Guild.findOneAndUpdate).not.toHaveBeenCalled();
        expect(interaction.replies.at(-1).content).toContain('Manage Server');
    });
});
