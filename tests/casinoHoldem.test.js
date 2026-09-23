'use strict';

/**
 * #873, pass 24. `/casino poker` is Casino Hold'em. The heads-up game it
 * replaced paid back about 121% of every stake to a player who only checked:
 * its dealer "AI" folded half its hands pre-flop blind, could never fold or bet
 * after the flop, printed the showdown result as "equity", and refunded the
 * whole stake on a timeout at any street.
 */

jest.mock('../src/models/User', () => ({
    findOne:          jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne:        jest.fn(),
    updateMany:       jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
// A stacked deck, when a test sets one. Cards come off the end: player, player,
// dealer, dealer, then the five community cards.
let mockDeck = null;
jest.mock('../src/games/casino/pokerHands', () => {
    const actual = jest.requireActual('../src/games/casino/pokerHands');
    return { ...actual, buildDeck: (...args) => (mockDeck ? [...mockDeck] : actual.buildDeck(...args)) };
});

const User  = require('../src/models/User');
const Guild = require('../src/models/Guild');
const hands = require('../src/games/casino/pokerHands');
const rules = require('../src/games/casino/holdemRules');
const poker = require('../src/games/casino/poker');
const { walletDoc, GUILD_ID, USER_ID } = require('./helpers/casinoInteraction');
const { makeInteraction } = require('./helpers/fakeInteraction');

const c = (value, suit = '♠') => ({ value, suit });
const best = cards => hands.bestHand(cards);

describe('the rules', () => {
    test('an ace-high straight flush is the royal, and pays 100:1', () => {
        const royal = best([c('A'), c('K'), c('Q'), c('J'), c('10'), c('2', '♥'), c('3', '♦')]);
        expect(rules.paytableName(royal)).toBe('Royal Flush');
        expect(rules.anteOdds(royal)).toBe(100);
        const wheel = best([c('A'), c('2'), c('3'), c('4'), c('5'), c('9', '♥'), c('K', '♦')]);
        expect(rules.paytableName(wheel)).toBe('Straight Flush');
        expect(rules.anteOdds(wheel)).toBe(20);
    });

    test('everything below a flush pays the ante even money', () => {
        const straight = best([c('5'), c('6', '♥'), c('7'), c('8', '♦'), c('9'), c('K', '♣'), c('2', '♥')]);
        expect(rules.anteOdds(straight)).toBe(1);
    });

    test('the dealer qualifies with a pair of fours, not threes', () => {
        const fours  = best([c('4'), c('4', '♥'), c('9', '♦'), c('J', '♣'), c('K'), c('2', '♥'), c('7', '♦')]);
        const threes = best([c('3'), c('3', '♥'), c('9', '♦'), c('J', '♣'), c('K'), c('2', '♥'), c('7', '♦')]);
        const high   = best([c('A'), c('Q', '♥'), c('9', '♦'), c('J', '♣'), c('5'), c('2', '♥'), c('7', '♦')]);
        expect(rules.dealerQualifies(fours)).toBe(true);
        expect(rules.dealerQualifies(threes)).toBe(false);
        expect(rules.dealerQualifies(high)).toBe(false);
    });

    test('settles each branch: no-qualify, win, push, lose', () => {
        const flush  = best([c('2'), c('5'), c('9'), c('J'), c('K'), c('3', '♥'), c('7', '♦')]);
        const pair   = best([c('8'), c('8', '♥'), c('9', '♦'), c('J', '♣'), c('K', '♥'), c('2', '♥'), c('7', '♦')]);
        const junk   = best([c('A', '♥'), c('Q', '♥'), c('9', '♦'), c('J', '♣'), c('5'), c('2', '♥'), c('7', '♦')]);
        // Dealer can't qualify: ante 2:1 on the flush (100 + 200), call of 200 back.
        expect(rules.settleCalled(100, flush, junk, 1)).toEqual({ outcome: 'no-qualify', gross: 500 });
        // Dealer qualifies and loses: ante 2:1, call 1:1.
        expect(rules.settleCalled(100, flush, pair, 1)).toEqual({ outcome: 'win', gross: 700 });
        expect(rules.settleCalled(100, pair, pair, 0)).toEqual({ outcome: 'push', gross: 300 });
        expect(rules.settleCalled(100, junk, pair, -1)).toEqual({ outcome: 'lose', gross: 0 });
    });

    // The whole point of the rewrite. Seeded, so it measures the same hands
    // every run rather than asserting on a random sample.
    test('keeps an edge against a player who calls every hand', () => {
        let seed = 873;
        const rng = () => {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        let staked = 0, paid = 0;
        for (let i = 0; i < 40_000; i++) {
            const deck = hands.buildDeck(rng);
            const ph = [deck.pop(), deck.pop()];
            const dh = [deck.pop(), deck.pop()];
            const board = deck.splice(-5);
            const p = best([...ph, ...board]);
            const d = best([...dh, ...board]);
            staked += 3;
            paid += rules.settleCalled(1, p, d, hands.compareTuple(p, d)).gross;
        }
        expect(paid / staked).toBeLessThan(0.99);
        expect(paid / staked).toBeGreaterThan(0.94);
    }, 60_000);
});

// ── The command ──────────────────────────────────────────────────────────────

describe('/casino poker', () => {
    const FILTER_KEY = 'paidPayouts.key';
    const keyedCredits = () => User.findOneAndUpdate.mock.calls
        .filter(([filter, update]) => Array.isArray(update) && filter?.[FILTER_KEY]?.$ne)
        .map(([filter, update]) => ({ key: filter[FILTER_KEY].$ne, amount: update[0]?.$set?.balance?.$add?.[1] }));

    // Player A♠ K♠, dealer 8♥ 8♦, board 2♠ 7♠ Q♠ 3♣ 9♥: the player's flush
    // against the dealer's qualifying pair of eights.
    const STACKED = [c('9', '♥'), c('3', '♣'), c('Q'), c('7'), c('2'), c('8', '♦'), c('8', '♥'), c('K'), c('A')];

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        User.findOneAndUpdate.mockImplementation(() => Promise.resolve(walletDoc()));
        User.updateOne.mockResolvedValue({ matchedCount: 1 });
        User.findOne.mockImplementation(() => {
            const q = Promise.resolve(walletDoc());
            q.lean = () => Promise.resolve(walletDoc());
            return q;
        });
        Guild.findOne.mockImplementation(() => Promise.resolve({ guildId: GUILD_ID, economy: {} }));
    });

    afterEach(() => {
        mockDeck = null;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    async function play(press, ante = 100) {
        mockDeck = STACKED;
        jest.useFakeTimers();
        let hand = null;
        const shown = prefix => hand?.replies.flatMap(r => r?.components ?? [])
            .flatMap(row => row.components ?? []).map(b => b.data?.custom_id)
            .filter(id => id?.startsWith(prefix)).at(-1);
        hand = makeInteraction({
            options: { bet: ante }, userId: USER_ID, guildId: GUILD_ID,
            components: press ? [{ get customId() { return shown(press); } }] : [],
        });
        const run = poker.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        for (let i = 0; i < 200; i++) await jest.advanceTimersByTimeAsync(250);
        await run;
        return { hand, credits: keyedCredits().filter(k => k.key.startsWith('casino:poker:')) };
    }

    test('a call to the showdown pays the ante by the paytable and the call 1:1', async () => {
        const { credits } = await play('pk_call_');
        // Ante 100 + 200 (flush 2:1), call 200 + 200.
        expect(credits).toEqual([expect.objectContaining({ amount: 700 })]);
    }, 20_000);

    // The old game refunded the stake on a timeout, after the player had seen
    // their cards — a free look at every hand.
    test('a timeout folds: the ante is lost, nothing is refunded', async () => {
        const { hand, credits } = await play(null);
        expect(credits).toEqual([]);
        expect(JSON.stringify(hand.replies)).toContain('the hand folded');
    }, 20_000);

    test('a fold credits nothing', async () => {
        const { credits } = await play('pk_fold_');
        expect(credits).toEqual([]);
    }, 20_000);

    test('refuses an ante the player could not follow with a call', async () => {
        const hand = makeInteraction({ options: { bet: 4_000 }, userId: USER_ID, guildId: GUILD_ID });
        await poker.execute(hand, { releaseLock: jest.fn(), onWager: jest.fn() });
        expect(JSON.stringify(hand.replies)).toContain('needs');
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });
});
