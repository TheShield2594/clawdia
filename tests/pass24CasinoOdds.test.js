'use strict';

/**
 * #873, pass 24 — the casino's odds.
 *
 * Every earlier casino pass audited how a payout is credited; none asked
 * whether the number credited was one the house could afford. Measured, four
 * games paid out more than they took in:
 *
 *   - crash's auto cash-out ran before the crash check, at the tick's own
 *     multiplier, so on the crashing tick it paid targets the round never
 *     reached — about 109% of the stake at any target up to 5×;
 *   - Three Card Monte printed the Queen's start and every swap, so following
 *     along won every round, and its "tell" was right 60% of the time;
 *   - higher-or-lower added +0.5× per correct call whatever the odds (about
 *     115% on the first call alone);
 *   - slots paid two-of-a-kind at half the row (about 153% a spin); pass 25
 *     rebuilt its paytable, and holds the coin booster off it here.
 *
 * The pure odds are pinned in casinoPayoutTables.test.js and
 * casinoSlotsReels.test.js. This file drives the games themselves.
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
jest.mock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
// A stacked deck, when a test sets one: cards are dealt off the end, player
// first, so the last four are player, player, dealer up-card, dealer hole card.
let mockDeck = null;
// Fixed spins, when a test queues them: see tests/helpers/slotsSpins.js.
let mockSpins = [];
jest.mock('../src/games/casino/slotsReels', () => {
    const actual = jest.requireActual('../src/games/casino/slotsReels');
    return { ...actual, spin: (...args) => (mockSpins.length ? mockSpins.shift() : actual.spin(...args)) };
});
// A fixed keno draw and a stacked poker deck, when a test sets them.
let mockDraw = null;
jest.mock('../src/games/casino/kenoPaytable', () => {
    const actual = jest.requireActual('../src/games/casino/kenoPaytable');
    return { ...actual, drawNumbers: (...args) => (mockDraw ? [...mockDraw] : actual.drawNumbers(...args)) };
});
let mockPokerDeck = null;
jest.mock('../src/games/casino/pokerHands', () => {
    const actual = jest.requireActual('../src/games/casino/pokerHands');
    return { ...actual, buildDeck: (...args) => (mockPokerDeck ? [...mockPokerDeck] : actual.buildDeck(...args)) };
});
jest.mock('../src/games/casino/blackjackHands', () => {
    const actual = jest.requireActual('../src/games/casino/blackjackHands');
    return { ...actual, buildDeck: (...args) => (mockDeck ? [...mockDeck] : actual.buildDeck(...args)) };
});

const { mockRandom, restoreRandom } = require('./helpers/secureRandom');
const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const crash = require('../src/games/casino/crash');
const cupgame = require('../src/games/casino/cupgame');
const higherlower = require('../src/games/casino/higherlower');
const blackjack = require('../src/games/casino/blackjack');
const slots = require('../src/games/casino/slots');
const keno = require('../src/games/casino/keno');
const poker = require('../src/games/casino/poker');
const { BY_NAME } = jest.requireActual('../src/games/casino/slotsReels');
const { view } = require('./helpers/slotsSpins');
const { deleteLobby } = require('../src/utils/crashLobby');
const { walletDoc, GUILD_ID, USER_ID, BET } = require('./helpers/casinoInteraction');
const { makeInteraction } = require('./helpers/fakeInteraction');

const CHANNEL_ID = 'channel-1';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** Every keyed coin credit attempted, as `{ key, amount }`. */
const keyedCredits = () => User.findOneAndUpdate.mock.calls
    .filter(([filter, update]) => Array.isArray(update) && filter?.['paidPayouts.key']?.$ne)
    .map(([filter, update]) => ({
        key:    filter['paidPayouts.key'].$ne,
        amount: update[0]?.$set?.balance?.$add?.[1],
    }));

const query = doc => {
    const q = Promise.resolve(doc);
    q.lean = () => Promise.resolve(doc);
    return q;
};

let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    deleteLobby(CHANNEL_ID);
    User.findOneAndUpdate.mockImplementation(() => Promise.resolve(walletDoc()));
    User.updateOne.mockResolvedValue({ matchedCount: 1 });
    User.updateMany.mockResolvedValue({});
    User.findOne.mockImplementation(() => query(walletDoc()));
    Guild.findOne.mockImplementation(() => {
        const doc = { guildId: GUILD_ID, economy: {} };
        const q = Promise.resolve(doc);
        q.lean = () => ({ catch: () => Promise.resolve(doc) });
        return q;
    });
    Guild.updateOne.mockResolvedValue({});
});

afterEach(() => {
    deleteLobby(CHANNEL_ID);
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreRandom();
    errorSpy?.mockRestore();
});

// ── crash: an auto cash-out is paid its target, and only below the crash ─────

describe('crash auto cash-out', () => {
    /** The roll that deals a crash point of `point`: 0.99 / (1 − r), floored. */
    const rollFor = point => 1 - 0.99 / (point + 0.005);

    async function playRound(point, autoCashout) {
        mockRandom(rollFor(point));
        jest.useFakeTimers();
        const spin = makeInteraction({
            options: { bet: BET, auto_cashout: autoCashout },
            userId: USER_ID, guildId: GUILD_ID, holdCollectors: true,
        });
        spin.client.users.fetch = jest.fn().mockResolvedValue({ username: 'player' });
        await crash.execute(spin, { releaseLock: jest.fn(), onWager: jest.fn() });
        await jest.advanceTimersByTimeAsync(0);
        await flush();
        spin.endCollectors('time');   // nobody joined — start the round
        await flush();
        for (let step = 0; step < 40; step++) {
            await jest.advanceTimersByTimeAsync(1_200);
            await flush();
        }
        return keyedCredits().filter(c => c.key.includes(':cashout:'));
    }

    // 1.12^6 = 1.97 and 1.12^7 = 2.21: a 1.99× round busts on the tick that
    // passes a 2.00× target. That tick used to pay the target at 2.21×.
    test('a target above the crash point is not paid on the tick that busts', async () => {
        expect(await playRound(1.99, 2.0)).toEqual([]);
    }, 20_000);

    test('a target the round reached is paid at the target, not the tick past it', async () => {
        const paid = await playRound(2.10, 2.0);
        expect(paid).toHaveLength(1);
        expect(paid[0].amount).toBe(BET * 2);
    }, 20_000);

    test('a target reached well before the crash is paid at the target too', async () => {
        const paid = await playRound(4.95, 2.0);
        expect(paid).toHaveLength(1);
        expect(paid[0].amount).toBe(BET * 2);
    }, 20_000);
});

// ── Three Card Monte shows nothing a player can follow ───────────────────────

describe('Three Card Monte', () => {
    test('does not say which cards were swapped, and has no tell', async () => {
        const hand = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID });

        await cupgame.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        await flush();

        const shown = JSON.stringify(hand.replies);
        expect(shown).toContain('Swap 1/');
        expect(shown).not.toContain('↔');
        expect(shown).not.toMatch(/warped/i);
    }, 20_000);
});

// ── higher-or-lower: a lapse pays what the session is worth ──────────────────

describe('higher-or-lower', () => {
    // rollCard takes two randoms, value then suit. 0.47 is a 7, 0.99 a King.
    const SEVEN = 0.47;
    const KING  = 0.99;

    /**
     * Plays a hand with `presses` queued, each by its id prefix. The ids carry
     * `Date.now()`, so each is read off the render at the moment it is
     * delivered, the way casinoReplayGuard.test.js reads its replay button.
     */
    async function play(rolls, presses) {
        const queue = [...rolls];
        mockRandom(() => queue.shift() ?? 0);
        jest.useFakeTimers();
        let hand = null;
        const shownId = prefix => hand?.replies
            .flatMap(r => r?.components ?? [])
            .flatMap(row => row.components ?? [])
            .map(c => c.data?.custom_id)
            .filter(id => id?.startsWith(`${prefix}_`))
            .at(-1);
        hand = makeInteraction({
            options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID,
            components: presses.map(prefix => ({ get customId() { return shownId(prefix); } })),
        });
        const run = higherlower.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        for (let i = 0; i < 400; i++) await jest.advanceTimersByTimeAsync(250);
        await run;
        return { hand, credits: keyedCredits().filter(c => c.key.startsWith('casino:higherlower:')) };
    }

    test('a correct even-money call is priced at 1.90×, not the old flat 1.50×', async () => {
        // 7 → King on "higher", then cash out.
        const { credits } = await play([SEVEN, 0, KING, 0], ['hl_up', 'hl_cash']);

        expect(credits).toHaveLength(1);
        expect(credits[0].key).toContain('cashout');
        expect(credits[0].amount).toBe(190);
    }, 20_000);

    test('a lapse after a win pays the streak, not the bare stake', async () => {
        // 7 → King on "higher", risk it, then let the next card lapse.
        const { hand, credits } = await play([SEVEN, 0, KING, 0, SEVEN, 0], ['hl_up', 'hl_risk']);

        expect(credits).toHaveLength(1);
        expect(credits[0].key).toContain('timeout');
        expect(credits[0].amount).toBe(190);
        expect(JSON.stringify(hand.replies)).toContain('streak was cashed out');
    }, 20_000);

    test('a lapse before any win refunds the stake', async () => {
        const { credits } = await play([SEVEN, 0], []);

        expect(credits).toHaveLength(1);
        expect(credits[0].amount).toBe(BET);
    }, 20_000);
});

// ── blackjack: the insurance prompt says nothing about the hole card ─────────

describe('blackjack insurance', () => {
    const card = value => ({ suit: '♠', value });
    // Dealt off the end: player 10 and 7, dealer A up and `hole` down.
    const deckWith = hole => [card('2'), card('3'), card('4'), hole, card('A'), card('7'), card('10')];

    async function deal(hole, press = null) {
        mockDeck = deckWith(hole);
        jest.useFakeTimers();
        let hand = null;
        const shownId = prefix => hand?.replies.flatMap(r => r?.components ?? [])
            .flatMap(row => row.components ?? []).map(c => c.data?.custom_id)
            .filter(id => id?.startsWith(prefix)).at(-1);
        hand = makeInteraction({
            options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID,
            components: press ? [{ get customId() { return shownId(press); } }] : [],
        });
        const run = blackjack.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        for (let i = 0; i < 100; i++) await jest.advanceTimersByTimeAsync(250);
        await run;
        mockDeck = null;
        return JSON.stringify(hand.replies);
    }

    // It used to be offered at the peek only when the dealer had blackjack, so
    // insuring on that prompt alone won every time: about +2.3% a hand.
    test('is offered on an ace whether or not the dealer has blackjack', async () => {
        expect(await deal(card('9'))).toContain('Dealer shows an Ace');
        expect(await deal(card('K'))).toContain('Dealer shows an Ace');
    }, 20_000);

    test('can be declined without waiting out the prompt', async () => {
        const shown = await deal(card('9'), 'bj_noins_');
        expect(shown).toContain('🎲 Your turn');
        expect(shown).not.toContain('insurance lost');
    }, 20_000);

    // The opening wager can leave too little for the side bet. The old table
    // button said so; the prompt that replaced it went quiet.
    test('says so when the balance cannot cover it', async () => {
        const real = User.findOneAndUpdate.getMockImplementation();
        User.findOneAndUpdate.mockImplementation((filter, update, opts) =>
            (update?.$inc?.balance === -Math.floor(BET / 2) ? Promise.resolve(null) : real(filter, update, opts)));

        expect(await deal(card('9'), 'bj_insurance_')).toContain('Not enough balance for insurance');
        expect(await deal(card('K'), 'bj_insurance_')).toContain('Not enough balance for insurance');
    }, 20_000);
});

// ── slots: what a spin pays is the paytable's, and nothing multiplies it ─────

describe('slots pays the paytable', () => {
    async function spin(spins, doc = {}) {
        mockSpins = [...spins];
        User.findOne.mockImplementation(() => query(walletDoc(doc)));
        // The wager's own write hands back the document the game reads effects off.
        const real = User.findOneAndUpdate.getMockImplementation();
        User.findOneAndUpdate.mockImplementation((filter, update, opts) =>
            (Array.isArray(update) ? real(filter, update, opts) : Promise.resolve(walletDoc(doc))));
        jest.useFakeTimers();
        const hand = makeInteraction({ options: { bet: BET }, userId: USER_ID, guildId: GUILD_ID });
        const run = slots.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        for (let i = 0; i < 100; i++) await jest.advanceTimersByTimeAsync(250);
        await run;
        mockSpins = [];
        return { hand, credits: keyedCredits().filter(c => c.key.startsWith('casino:slots:')) };
    }

    // #873, pass 25. A booster multiplied the profit on a slots win, and slots'
    // wins pay many times the stake: a 2× booster turned the 94% machine into
    // one that paid back about 169%, for 2,500 coins an hour.
    test('a coin booster does not multiply a slots win', async () => {
        const booster = { activeEffects: [{ type: 'coin_booster_2x', expiresAt: new Date(Date.now() + 3.6e6) }] };
        const { credits } = await spin([view(['Bell', 'Bell', 'Bell'])], booster);

        expect(credits.map(c => c.amount)).toEqual([BET * BY_NAME.get('Bell').three]);
    }, 20_000);

    // The old two-of-a-kind paid a quarter of the row, so a Cherry pair
    // returned half the stake and was shown as a win.
    test('a low pair pays nothing and says so, rather than returning part of the bet as a "win"', async () => {
        const { hand, credits } = await spin([view(['Cherry', 'Cherry', 'Lemon'])]);

        expect(credits).toEqual([]);
        const result = hand.replies.filter(r => r?.components?.length).at(-1).embeds[0].data;
        expect(result.title).toContain('No Win');
    }, 20_000);
});

// ── #873, pass 26: no coin booster reaches a casino payout ──────────────────
//
// A 2× Coin Booster multiplied the profit on every casino win, and a server
// coin boost stacked on it. Measured, a 2× booster alone paid back: keno 148%,
// the cup game 153%, higher-or-lower 182% (a long-shot call), blackjack 146%,
// poker 138% — slots 169% before pass 25. Each game below is dealt a win with
// both boosts active (3× together) and must credit exactly its table odds.

describe('no coin booster reaches a casino payout', () => {
    const BOOSTED = {
        activeEffects: [{ type: 'coin_booster_2x', expiresAt: new Date(Date.now() + 3.6e6) }],
    };
    const SERVER_BOOST = { type: 'coin', multiplier: 1.5, expiresAt: new Date(Date.now() + 3.6e6) };

    beforeEach(() => {
        User.findOne.mockImplementation(() => query(walletDoc(BOOSTED)));
        User.findOneAndUpdate.mockImplementation((filter, update) =>
            Promise.resolve(Array.isArray(update) ? walletDoc(BOOSTED) : walletDoc(BOOSTED)));
        Guild.findOne.mockImplementation(() => {
            const doc = { guildId: GUILD_ID, economy: {}, serverBoost: SERVER_BOOST };
            const q = Promise.resolve(doc);
            q.lean = () => Object.assign(Promise.resolve(doc), { catch: () => Promise.resolve(doc) });
            return q;
        });
    });

    afterEach(() => {
        mockDraw = null;
        mockPokerDeck = null;
        mockDeck = null;
    });

    /** Plays `game` with presses queued by id prefix; returns its keyed credits. */
    async function playGame(game, options, presses = [], rolls = null) {
        if (rolls) {
            const queue = [...rolls];
            mockRandom(() => queue.shift() ?? 0);
        }
        jest.useFakeTimers();
        let hand = null;
        const shownId = prefix => hand?.replies
            .flatMap(r => r?.components ?? [])
            .flatMap(row => row.components ?? [])
            .map(c => c.data?.custom_id)
            .filter(id => id?.startsWith(prefix))
            .at(-1);
        hand = makeInteraction({
            options, userId: USER_ID, guildId: GUILD_ID,
            components: presses.map(prefix => ({ get customId() { return shownId(prefix); } })),
        });
        const run = game.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        for (let i = 0; i < 400; i++) await jest.advanceTimersByTimeAsync(250);
        await run;
        const text = JSON.stringify(hand.replies);
        return { credits: keyedCredits().filter(c => c.key.startsWith('casino:')), text };
    }

    test('keno pays five matches at 150×, unboosted', async () => {
        mockDraw = [3, 12, 21, 33, 39, 1, 2, 4, 5, 6];
        const { credits, text } = await playGame(keno, { bet: BET, numbers: '3 12 21 33 39' });

        expect(credits.map(c => c.amount)).toEqual([BET * 150]);
        expect(text).not.toContain('Coin Booster');
    }, 30_000);

    test('the cup game pays a taken round-one win at 2.8×, unboosted', async () => {
        // The Queen starts under card 1; three swaps of cards 1 and 2 leave her
        // under card 2. Then take the money rather than doubling.
        const rolls = [0, 0, 0.4, 0, 0.4, 0, 0.4];
        const { credits, text } = await playGame(cupgame, { bet: BET }, ['monte_2_', 'monte_take_'], rolls);

        expect(credits.map(c => c.amount)).toEqual([280]);
        expect(text).not.toContain('Coin Booster');
    }, 30_000);

    test('higher-or-lower cashes an even-money call out at 1.90×, unboosted', async () => {
        // 7 → King on "higher", then cash out.
        const { credits } = await playGame(higherlower, { bet: BET }, ['hl_up', 'hl_cash'], [0.47, 0, 0.99, 0]);

        expect(credits.map(c => c.amount)).toEqual([190]);
    }, 30_000);

    test('blackjack pays a natural at 3:2, unboosted', async () => {
        const card = value => ({ suit: '♠', value });
        // Dealt off the end: player A and K, dealer 9 up and 7 down.
        mockDeck = [card('2'), card('3'), card('4'), card('7'), card('9'), card('K'), card('A')];
        const { credits, text } = await playGame(blackjack, { bet: BET });

        expect(credits.map(c => c.amount)).toEqual([BET + 150]);
        expect(text).not.toContain('🚀');
    }, 30_000);

    test('poker pays a called royal flush by the paytable, unboosted', async () => {
        const c = (value, suit) => ({ value, suit });
        // Popped from the end: player A♠ K♠, dealer 4♥ 4♦ (qualifies), then the
        // board Q♠ J♠ 10♠ 2♣ 3♦ — a royal flush against a pair of fours.
        mockPokerDeck = [
            c('3', '♦'), c('2', '♣'), c('10', '♠'), c('J', '♠'), c('Q', '♠'),
            c('4', '♦'), c('4', '♥'), c('K', '♠'), c('A', '♠'),
        ];
        const { credits, text } = await playGame(poker, { bet: BET }, ['pk_call_']);

        // Ante back plus 100:1, and the 2× call back plus 1:1.
        expect(credits.map(c2 => c2.amount)).toEqual([BET + BET * 100 + BET * 2 * 2]);
        expect(text).not.toContain('Coin Booster');
    }, 30_000);
});
