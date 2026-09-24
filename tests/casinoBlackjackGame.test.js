'use strict';

/**
 * `/casino blackjack`, driven hand by hand over a stacked deck.
 *
 * The review that led here found the game's money was sound underneath and the
 * table on top was not: a double-click on Double took two stakes and paid one,
 * the dealer only checked for blackjack under an ace, a failed read at the
 * settlement dropped the payout with no owed record, and a wager that failed
 * after the large-bet prompt threw instead of saying so. Each of those is pinned
 * here, along with the table features that replaced the old flow: even money,
 * split hands that stand on 21, the idle auto-stand, Rules and Rebet.
 */

jest.mock('../src/models/User', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
    updateMany:       jest.fn(),
    find:             jest.fn(),
    create:           jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
}));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({ economy: {} })) }));
// The table image is drawn for real in its own test below; here it only has to exist.
jest.mock('../src/games/casino/blackjackTable', () => ({
    ...jest.requireActual('../src/games/casino/blackjackTable'),
    renderTable: jest.fn(async () => Buffer.from('png')),
}));
let mockDeck = null;
jest.mock('../src/games/casino/blackjackHands', () => {
    const actual = jest.requireActual('../src/games/casino/blackjackHands');
    return { ...actual, buildDeck: (...args) => (mockDeck ? [...mockDeck] : actual.buildDeck(...args)) };
});

const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const blackjack = require('../src/games/casino/blackjack');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { walletDoc, GUILD_ID, USER_ID, BET, WALLET } = require('./helpers/casinoInteraction');

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** Cards in the order they are dealt: player, player, dealer up, dealer hole, then draws. */
function stack(...notation) {
    const cards = notation.map(t => ({ value: t.slice(0, -1), suit: t.slice(-1) }));
    // Dealt off the end, so the first card dealt is the last in the deck.
    return [...cards].reverse();
}

const isGuardedDebit = filter => filter?.balance?.$gte !== undefined;
const debits = () => User.findOneAndUpdate.mock.calls.filter(([filter]) => isGuardedDebit(filter));

/** Every keyed coin credit attempted, as `{ key, amount }`. */
const keyedCredits = () => User.findOneAndUpdate.mock.calls
    .filter(([filter, update]) => Array.isArray(update) && filter?.['paidPayouts.key']?.$ne)
    .map(([filter, update]) => ({
        key:    filter['paidPayouts.key'].$ne,
        amount: update[0]?.$set?.balance?.$add?.[1],
    }));

/** The latest button whose customId starts with `prefix`. */
const buttonId = (interaction, prefix) => interaction.replies
    .flatMap(r => r?.components ?? [])
    .flatMap(row => row.components ?? [])
    .map(c => c.data?.custom_id)
    .filter(id => id?.startsWith(prefix))
    .at(-1);

const query = doc => {
    const q = Promise.resolve(doc);
    q.lean = () => Promise.resolve(doc);
    return q;
};

let economy;
let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDeck = null;
    economy = {};
    User.findOne.mockImplementation(() => query(walletDoc()));
    User.findOneAndUpdate.mockImplementation(() => Promise.resolve(walletDoc({ balance: WALLET - BET })));
    User.updateOne.mockResolvedValue({ matchedCount: 1 });
    Guild.findOne.mockImplementation(() => query({ guildId: GUILD_ID, economy }));
});

afterEach(() => errorSpy.mockRestore());

/** Deals a hand on a stacked deck and leaves its collectors open. */
const { claimCommandCooldown } = require('../src/utils/commandPolicy');
// The claim casino.js hands every game, against the real /casino command's
// cooldown settings.
const casinoCommand = { data: { name: 'casino' }, cooldownKey: i => `casino:${i.options.getSubcommand()}`, cooldownAmount: () => 3 };

async function deal(cards, { components = [], onWager = jest.fn(), releaseLock = jest.fn() } = {}) {
    mockDeck = stack(...cards);
    const interaction = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID, components, holdCollectors: true });
    interaction.client.cooldowns = new Map();
    const claimCooldown = (asCommand, settings) => claimCommandCooldown(interaction.client, casinoCommand, asCommand, settings);
    await blackjack.execute(interaction, { releaseLock, onWager, claimCooldown });
    await flush();
    return { interaction, onWager, releaseLock };
}

async function press(interaction, prefix, user) {
    const pressed = await interaction.press({ customId: buttonId(interaction, prefix), user });
    await flush();
    return pressed;
}

describe('one stake per press', () => {
    test('a double-click on Double takes one extra stake, not two', async () => {
        const { interaction } = await deal(['6♠', '5♥', '9♦', '8♣', '10♠', '10♥', '10♦']);
        const id = buttonId(interaction, 'bj_double_');
        expect(id).toBeDefined();

        await Promise.all([
            interaction.press({ customId: id }),
            interaction.press({ customId: id }),
        ]);
        await flush();

        // The opening bet, then exactly one double down.
        expect(debits()).toHaveLength(2);
        const [, doubled] = debits();
        expect(doubled[1].$inc.balance).toBe(-BET);
        // 21 against the dealer's 17 pays even money on the doubled stake.
        expect(keyedCredits()).toEqual([expect.objectContaining({ amount: 4 * BET })]);
    });

    test('a Split pressed twice splits once', async () => {
        const { interaction } = await deal(['8♠', '8♥', '9♦', '8♣', '3♠', '2♥', '10♦', '10♣']);
        const id = buttonId(interaction, 'bj_split_');
        await Promise.all([interaction.press({ customId: id }), interaction.press({ customId: id })]);
        await flush();
        expect(debits()).toHaveLength(2);
    });
});

describe('the dealer peek', () => {
    test('a ten-up dealer blackjack ends the hand before the player can act', async () => {
        const { interaction, releaseLock } = await deal(['10♠', '6♥', 'K♦', 'A♣']);
        const text = repliedText(interaction);
        expect(text).toMatch(/Dealer blackjack/);
        expect(buttonId(interaction, 'bj_hit_')).toBeUndefined();
        expect(buttonId(interaction, 'bj_double_')).toBeUndefined();
        expect(debits()).toHaveLength(1);
        expect(keyedCredits()).toEqual([]);
        expect(releaseLock).toHaveBeenCalled();
    });

    test('a ten-up dealer without blackjack says it checked, and play goes on', async () => {
        const { interaction } = await deal(['10♠', '6♥', 'K♦', '7♣']);
        expect(repliedText(interaction)).toMatch(/Dealer checks under the ten — no blackjack/);
        expect(buttonId(interaction, 'bj_hit_')).toBeDefined();
    });
});

describe('settlement', () => {
    test('a failed settlement read still pays the hand and releases the lock', async () => {
        const { interaction, releaseLock } = await deal(['10♠', '9♥', '9♦', '8♣']);
        User.findOne.mockImplementation(() => Promise.reject(new Error('stepdown')));
        await press(interaction, 'bj_stand_');

        expect(keyedCredits()).toEqual([expect.objectContaining({ amount: 2 * BET })]);
        expect(repliedText(interaction)).toMatch(/You win/);
        expect(releaseLock).toHaveBeenCalled();
    });

    test('a turn left alone stands itself and says so', async () => {
        const { interaction, releaseLock } = await deal(['10♠', '7♥', '9♦', '8♣']);
        interaction.endCollectors('idle');
        await flush();
        expect(repliedText(interaction)).toMatch(/Time's up — standing on what you have/);
        expect(releaseLock).toHaveBeenCalled();
    });

    test('the dealer draws one card at a time, each on its own frame', async () => {
        const { interaction } = await deal(['10♠', '9♥', '9♦', '4♣', '2♠', '3♥']);
        const before = interaction.replies.length;
        await press(interaction, 'bj_stand_');
        // Reveal, two draws, and the result.
        expect(interaction.replies.length - before).toBe(4);
        expect(repliedText(interaction)).toMatch(/Dealer draws `2♠︎` · \*\*15\*\*/);
        expect(repliedText(interaction)).toMatch(/Dealer draws `3♥︎` · \*\*18\*\*/);
    });
});

describe('naturals', () => {
    test('even money pays 1:1 at once against a dealer ace', async () => {
        mockDeck = stack('A♠', 'K♥', 'A♦', '9♣');
        const interaction = makeInteraction({
            options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID, holdCollectors: true,
            components: [{ get customId() { return buttonId(interaction, 'bj_evenmoney_'); } }],
        });
        await blackjack.execute(interaction, { releaseLock: jest.fn(), onWager: jest.fn() });
        await flush();

        expect(keyedCredits()).toEqual([{ key: expect.stringMatching(/:even-money$/), amount: 2 * BET }]);
        expect(repliedText(interaction)).toMatch(/Even money/);
    });

    test('a declined even money pays 3:2 when the dealer has no blackjack', async () => {
        const { interaction } = await deal(['A♠', 'K♥', 'A♦', '9♣']);
        expect(keyedCredits()).toEqual([{ key: expect.stringMatching(/:natural$/), amount: BET + Math.floor(BET * 1.5) }]);
        expect(repliedText(interaction)).toMatch(/Blackjack!/);
    });
});

describe('splits', () => {
    test('a split hand dealt to 21 stands itself and play moves on', async () => {
        const { interaction } = await deal(['K♠', 'Q♥', '9♦', '7♣', 'A♠', '5♦', '2♣']);
        await press(interaction, 'bj_split_');
        const text = repliedText(interaction);
        expect(text).toMatch(/▶ Playing Hand 2/);
        expect(text).toMatch(/✓ Hand 1 · 21/);
        // A split 21 is not blackjack.
        expect(text).not.toMatch(/Hand 1 · Blackjack/);
    });

    test('the split result shows the balance', async () => {
        const { interaction } = await deal(['K♠', 'Q♥', '9♦', '7♣', 'A♠', '5♦', '2♣']);
        await press(interaction, 'bj_split_');
        await press(interaction, 'bj_stand_');
        expect(repliedText(interaction)).toMatch(/🏦 Balance/);
    });
});

describe('the large-bet confirmation', () => {
    const confirm = { customId: 'confirm_large_bet' };

    test('a wager that fails after confirming edits the prompt instead of throwing', async () => {
        economy = { betConfirmThreshold: 50 };
        User.findOneAndUpdate.mockImplementation(filter =>
            Promise.resolve(isGuardedDebit(filter) ? null : walletDoc()));
        const interaction = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID, components: [confirm] });
        await expect(blackjack.execute(interaction, { releaseLock: jest.fn() })).resolves.not.toThrow();
        expect(interaction.reply).toHaveBeenCalledTimes(1);
        expect(interaction.editReply).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/Not enough/) }));
    });

    test('a confirmed large bet is dealt on a public follow-up', async () => {
        economy = { betConfirmThreshold: 50 };
        mockDeck = stack('10♠', '7♥', '9♦', '8♣');
        const interaction = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID, components: [confirm], holdCollectors: true });
        await blackjack.execute(interaction, { releaseLock: jest.fn() });
        await flush();
        expect(interaction.followUp).toHaveBeenCalledTimes(1);
        const [payload] = interaction.followUp.mock.calls[0];
        expect(payload.flags).toBeUndefined();
        expect(payload.embeds).toHaveLength(1);
    });
});

describe('rules and rebet', () => {
    test('Rules answers anyone at the table, privately', async () => {
        const { interaction } = await deal(['10♠', '7♥', '9♦', '8♣']);
        const pressed = await press(interaction, 'bj_rules_', 'someone-else');
        expect(pressed.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.any(Number) }));
        expect(JSON.stringify(pressed.reply.mock.calls[0][0])).toMatch(/House rules/);
    });

    // A bystander's press on the turn collector used to reset its idle timer,
    // so Rules pressed by anyone could keep an abandoned hand from standing.
    test('a bystander pressing Rules never reaches the turn collector', async () => {
        mockDeck = stack('10♠', '7♥', '9♦', '8♣');
        const interaction = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID, holdCollectors: true });
        const opened = [];
        const create = interaction.message.createMessageComponentCollector;
        interaction.message.createMessageComponentCollector = opts => { opened.push(opts); return create(opts); };
        await blackjack.execute(interaction, { releaseLock: jest.fn() });
        await flush();

        const as = (prefix, user = USER_ID) => ({ customId: buttonId(interaction, prefix), user: { id: user }, reply: jest.fn().mockResolvedValue() });
        const turn = opened.find(o => o.idle && o.filter(as('bj_hit_')));
        expect(turn).toBeDefined();
        // Neither the owner's Rules press nor a bystander's counts toward the turn.
        expect(turn.filter(as('bj_rules_'))).toBe(false);
        expect(turn.filter(as('bj_rules_', 'someone-else'))).toBe(false);
        // The Rules collector takes them instead, from anyone.
        const rules = opened.find(o => o.filter(as('bj_rules_', 'someone-else')));
        expect(rules).toBeDefined();
        expect(rules.idle).toBeUndefined();
    });

    test('Rebet deals a new hand on a fresh wager', async () => {
        const { interaction, onWager } = await deal(['A♠', 'K♥', '5♦', '9♣']);
        expect(onWager).toHaveBeenCalledTimes(1);
        await press(interaction, 'bj_rebet_');
        expect(onWager).toHaveBeenCalledTimes(2);
        expect(keyedCredits()).toHaveLength(2);
    });

    test('Rebet spends the command cooldown, and a press inside it deals nothing', async () => {
        const { getGuildSettings } = require('../src/utils/guildSettingsCache');
        getGuildSettings.mockResolvedValue({ economy: {}, commandPolicies: { cooldownOverrides: [] } });
        const { interaction, onWager } = await deal(['A♠', 'K♥', '5♦', '9♣']);
        // The typed command spent it a moment ago.
        interaction.client.cooldowns.set(`${GUILD_ID}:casino:blackjack`, new Map([[USER_ID, Date.now()]]));
        const pressed = await press(interaction, 'bj_rebet_');
        expect(pressed.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/on cooldown/) }));
        expect(onWager).toHaveBeenCalledTimes(1);
    });

    test('Rebet is refused once the table has outlived its token', async () => {
        const { interaction, onWager } = await deal(['A♠', 'K♥', '5♦', '9♣']);
        interaction.createdTimestamp = Date.now() - 14 * 60_000;
        const pressed = await press(interaction, 'bj_rebet_');
        expect(pressed.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/table has closed/) }));
        expect(onWager).toHaveBeenCalledTimes(1);
    });
});

describe('the table image', () => {
    test('draws a PNG for a split mid-hand and a settled natural', async () => {
        const { renderTable } = jest.requireActual('../src/games/casino/blackjackTable');
        const c = (value, suit) => ({ value, suit });
        const png = await renderTable({
            dealer: { cards: [c('K', '♠'), c('4', '♥')], holeHidden: true, label: 'showing K' },
            hands: [
                { cards: [c('8', '♠'), c('3', '♦'), c('J', '♣')], label: '21', bet: 12_500, tag: { text: 'WIN', tone: 'win' } },
                { cards: [c('8', '♥'), c('10', '♣')], label: '18', bet: 12_500, active: true },
            ],
            banner: { text: 'BLACKJACK!', tone: 'gold' },
        });
        expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
});
