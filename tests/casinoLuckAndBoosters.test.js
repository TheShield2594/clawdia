'use strict';

/**
 * #873, pass 26: no item makes a casino game pay its players.
 *
 * The 2× Coin Booster and the server coin boost multiplied the profit on casino
 * wins, and Lucky Charm and Lucky Streak saved 20% and 25% of losses in every
 * game that had a save. Measured, every one of those games paid back more than
 * it took — a 2× booster: keno 148%, the cup game 153%, higher-or-lower 182%,
 * blackjack 146%, poker 138%; the luck items together: keno 118%, the cup game
 * 120%, higher-or-lower 132%, roulette 116%, blackjack 111%, poker 108%, and a
 * crash lobby whose host held a charm 119%.
 *
 * Boosters no longer reach any casino payout (pinned per game, dealt a win, in
 * tests/pass24CasinoOdds.test.js). The luck items are one per-game table,
 * CASINO_LUCK, and this holds every game under 99% with both items active,
 * under the strategy that gets the most out of them — exactly, from each
 * game's own paytable.
 */

const { CASINO_LUCK, casinoLuck, LUCKY_SAVE_MAX_BET } = require('../src/services/effectsService');
const { PAYOUTS, POOL_SIZE, PICK_COUNT, DRAW_COUNT } = require('../src/games/casino/kenoPaytable');
const { BASE_WIN_MULT, MAX_ROUNDS } = require('../src/games/casino/cupgameOdds');
const { HOUSE_RETURN, winChance, nextMult } = require('../src/games/casino/higherlowerOdds');
const { LUCKY_CHARM_RESPIN, LUCKY_STREAK_REFUND } = require('../src/games/casino/slotsReels');

const CEILING = 0.99;

/**
 * The chance a losing hand is saved when the charm is asked first and the
 * streak only on a loss the charm left standing — the order every game uses.
 */
const saved = ({ charm, streak }) => charm + (1 - charm) * streak;

describe('the luck table', () => {
    it('covers every casino game with a luck save, and gives nothing where there is no room', () => {
        expect(Object.keys(CASINO_LUCK).sort()).toEqual(
            ['blackjack', 'crash', 'cupgame', 'higherlower', 'keno', 'poker', 'roulette', 'slots']);
        // Blackjack (~99.9%), poker (~99% under good play) and crash (99%)
        // return 99% or more before any save.
        for (const game of ['blackjack', 'poker', 'crash']) {
            expect(CASINO_LUCK[game]).toEqual({ charm: 0, streak: 0 });
        }
    });

    it('is the slots machine’s own rates for slots', () => {
        expect(CASINO_LUCK.slots).toEqual({ charm: LUCKY_CHARM_RESPIN, streak: LUCKY_STREAK_REFUND });
    });

    it('gives a player only the items they hold, and nothing over the bet cap', () => {
        const until = new Date(Date.now() + 3.6e6);
        const both = { activeEffects: [{ type: 'lucky_charm', expiresAt: until }, { type: 'lucky_streak', expiresAt: until }] };
        const charmOnly = { activeEffects: [{ type: 'lucky_charm', expiresAt: until }] };

        expect(casinoLuck('keno', both, 100)).toEqual(CASINO_LUCK.keno);
        expect(casinoLuck('keno', charmOnly, 100)).toEqual({ charm: CASINO_LUCK.keno.charm, streak: 0 });
        expect(casinoLuck('keno', both, LUCKY_SAVE_MAX_BET + 1)).toEqual({ charm: 0, streak: 0 });
        expect(casinoLuck('blackjack', both, 100)).toEqual({ charm: 0, streak: 0 });
        expect(casinoLuck('coinflip', both, 100)).toEqual({ charm: 0, streak: 0 });
    });
});

describe('every game stays under 99% with both luck items', () => {
    test('keno: a hand with no paying match is refunded at keno’s rate', () => {
        const C = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
        let ret = 0, lose = 0;
        for (let hits = 0; hits <= PICK_COUNT; hits++) {
            const p = C(PICK_COUNT, hits) * C(POOL_SIZE - PICK_COUNT, DRAW_COUNT - hits) / C(POOL_SIZE, DRAW_COUNT);
            ret += p * (PAYOUTS[hits] ?? 0);
            if (!PAYOUTS[hits]) lose += p;
        }
        expect(ret).toBeCloseTo(0.923, 3);
        expect(ret + lose * saved(CASINO_LUCK.keno)).toBeLessThan(CEILING);
        // The old 20% / 25%.
        expect(ret + lose * saved({ charm: 0.2, streak: 0.25 })).toBeGreaterThan(1.17);
    });

    test('the cup game: best play with the saves is still under 99%', () => {
        // A save returns the stake on any wrong guess, in any round. V(r) is
        // the best a player at round r's win can do: take it, or double on a
        // 1-in-3 with the save behind them.
        const R = saved(CASINO_LUCK.cupgame);
        const pays = round => BASE_WIN_MULT * 2 ** (round - 1);
        const best = round => (round >= MAX_ROUNDS ? pays(round)
            : Math.max(pays(round), best(round + 1) / 3 + (2 / 3) * R));
        const worth = best(1) / 3 + (2 / 3) * R;

        expect(worth).toBeLessThan(CEILING);
        expect(BASE_WIN_MULT / 3 + (2 / 3) * saved({ charm: 0.2, streak: 0.25 })).toBeGreaterThan(1.19);
    });

    test('higher-or-lower: no call, however long, clears 99%', () => {
        // Every call keeps HOUSE_RETURN of the session in expectation, so no
        // strategy's cash-out is worth more than that, and a save returns the
        // stake at most once. That bounds any session at HOUSE_RETURN + R.
        const R = saved(CASINO_LUCK.higherlower);
        expect(HOUSE_RETURN + R).toBeLessThan(CEILING);

        // And the worst single call, exactly: the long shot the old 20% / 25%
        // made pay 132%.
        let worst = 0, worstOld = 0;
        for (let card = 1; card <= 13; card++) for (const higher of [true, false]) {
            const q = winChance(card, higher);
            if (q <= 0) continue;
            const cash = q * nextMult(1, card, higher);
            worst = Math.max(worst, cash + (1 - q) * R);
            worstOld = Math.max(worstOld, cash + (1 - q) * saved({ charm: 0.2, streak: 0.25 }));
        }
        expect(worst).toBeLessThan(CEILING);
        expect(worstOld).toBeGreaterThan(1.3);
    });

    test('roulette: a tenth of a lost straight number back is the worst case, and it is under 99%', () => {
        // Single-zero wheel: an even-money bet wins 18 of 37, a dozen or column
        // 12, a straight number 1, at 1:1, 2:1 and 35:1. The charm hands back
        // ROULETTE_CHARM_REFUND of a lost stake rather than re-spinning.
        const { ROULETTE_CHARM_REFUND } = require('../src/games/casino/settlement');
        const { charm } = CASINO_LUCK.roulette;
        expect(CASINO_LUCK.roulette.streak).toBe(0);
        for (const [wins, odds] of [[18, 1], [12, 2], [1, 35]]) {
            const p = wins / 37;
            const withRefund = (odds + 1) * p + (1 - p) * charm * ROULETTE_CHARM_REFUND;
            expect(withRefund).toBeLessThan(CEILING);
        }
        // The re-spin it replaced, at the old 20%.
        expect(36 * (1 / 37 + (36 / 37) * 0.2 / 37)).toBeGreaterThan(1.16);
    });

    test('crash: the host’s charm no longer moves the crash point', () => {
        // It scaled the point by 1.2 — a 1.2× return on every target, 119%.
        const source = require('fs').readFileSync(require.resolve('../src/games/casino/crash.js'), 'utf8');
        expect(source).not.toMatch(/lucky_charm/);
        expect(source).not.toMatch(/generateCrashPoint\(\) \* 1\.2/);
    });
});

describe('no casino game reads a coin multiplier', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'src', 'games', 'casino');

    it.each(fs.readdirSync(dir).filter(f => f.endsWith('.js')))('%s', file => {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        expect(source).not.toMatch(/getCoinMultiplier|getServerCoinMultiplier|coin_booster_2x/);
        expect(source).not.toMatch(/Coin Booster applied/);
    });
});

describe('shops already seeded catch up with the new descriptions', () => {
    const { DEFAULT_SHOP_ITEMS, ensureDefaultShopItems } = require('../src/data/defaultShopItems');
    const current = id => DEFAULT_SHOP_ITEMS.find(i => i.itemId === id).description;

    it('rewrites a copy still carrying the retired default, and leaves an edited one alone', () => {
        const guild = {
            shopDefaultsSeeded: true,
            shop: [
                { itemId: 'coin_booster_2x', name: '2x Coin Booster', description: '💰🚀 2x coin earnings from all sources for 1 hour.' },
                { itemId: 'lucky_streak', name: 'Lucky Streak', description: '🎯 +25% win chance on games for 30 minutes (casino saves apply to bets up to 25k).' },
                { itemId: 'lucky_charm', name: 'Lucky Charm', description: 'Our server’s own words.' },
            ],
        };

        expect(ensureDefaultShopItems(guild)).toBe(true);
        expect(guild.shop[0].description).toBe(current('coin_booster_2x'));
        expect(guild.shop[0].description).toContain('everything but the casino');
        expect(guild.shop[1].description).toBe(current('lucky_streak'));
        expect(guild.shop[2].description).toBe('Our server’s own words.');
    });

    it('leaves a current copy exactly as it is', () => {
        const guild = {
            shopDefaultsSeeded: true,
            shop: [{ itemId: 'coin_booster_2x', name: '2x Coin Booster', description: current('coin_booster_2x') }],
        };
        ensureDefaultShopItems(guild);
        expect(guild.shop[0].description).toBe(current('coin_booster_2x'));
    });
});
