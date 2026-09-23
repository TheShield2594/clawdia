/**
 * #785. The rest of what decides a casino payout, now that it is reachable:
 * keno's paytable (19.8% lines / 12.7% branches), the cup game's
 * double-or-nothing escalation (20.7% / 10.0%), higher-lower's session
 * multiplier (16.9% / 11.8%) and crash's curve (26.3% / 16.1%).
 *
 * Each was module-private behind a collector-driven animation, so #623's bet
 * guard drove every game as far as the debit and no further. These are fixed
 * draws and a seeded rng.
 */
const keno = require('../src/games/casino/kenoPaytable');
const cup = require('../src/games/casino/cupgameOdds');
const hl = require('../src/games/casino/higherlowerOdds');
const crash = require('../src/games/casino/crashCurve');

describe('keno pays by hit count', () => {
    it('pays nothing below two matches', () => {
        expect(keno.payoutMultiplier(0)).toBe(0);
        expect(keno.payoutMultiplier(1)).toBe(0);
        expect(keno.payoutFor(500, 1)).toBe(0);
    });

    it('pays the table from two matches up', () => {
        expect(keno.payoutMultiplier(2)).toBe(1);
        expect(keno.payoutMultiplier(3)).toBe(5);
        expect(keno.payoutMultiplier(4)).toBe(20);
        expect(keno.payoutMultiplier(5)).toBe(150);
    });

    it('returns the stake and no more on two matches, which is the break-even row', () => {
        expect(keno.payoutFor(100, 2)).toBe(100);
    });

    it('multiplies the stake on the paying rows', () => {
        expect(keno.payoutFor(100, 3)).toBe(500);
        expect(keno.payoutFor(100, 5)).toBe(15_000);
    });

    it('rounds a fractional payout down rather than minting a coin', () => {
        // Not reachable through the command, which takes an integer bet, but
        // the floor is what stops a future caller conjuring one.
        expect(keno.payoutFor(1.5, 2)).toBe(1);
    });

    it('has no row the footer does not show the player', () => {
        for (const hits of Object.keys(keno.PAYOUTS)) {
            expect([hits, keno.PAYTABLE_FOOTER.includes(`${keno.PAYOUTS[hits]}×`)]).toEqual([hits, true]);
        }
    });

    it('holds the RTP the comment claims, to the nearest point', () => {
        // Hypergeometric over 5 picks from 40 with 10 drawn. If a payout is
        // ever raised, this is the line that says what it did to the edge.
        const choose = (n, k) => {
            let r = 1;
            for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
            return r;
        };
        const p = hits => (choose(10, hits) * choose(30, 5 - hits)) / choose(40, 5);
        const rtp = [0, 1, 2, 3, 4, 5].reduce((sum, h) => sum + p(h) * keno.payoutMultiplier(h), 0);
        expect(rtp).toBeGreaterThan(0.90);
        expect(rtp).toBeLessThan(0.95);
    });
});

describe('the keno draw', () => {
    const sequence = values => {
        let i = 0;
        return () => values[i++ % values.length];
    };

    it('draws ten distinct numbers from the pool, in order', () => {
        const drawn = keno.drawNumbers(sequence([0.1, 0.9, 0.4, 0.7, 0.2]));
        expect(drawn).toHaveLength(keno.DRAW_COUNT);
        expect(new Set(drawn).size).toBe(keno.DRAW_COUNT);
        expect(drawn).toEqual([...drawn].sort((a, b) => a - b));
        expect(Math.min(...drawn)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...drawn)).toBeLessThanOrEqual(keno.POOL_SIZE);
    });

    it('falls back to Math.random when handed nothing', () => {
        const drawn = keno.drawNumbers();
        expect(drawn).toHaveLength(keno.DRAW_COUNT);
        expect(new Set(drawn).size).toBe(keno.DRAW_COUNT);
    });

    it('follows the rng it is handed rather than Math.random', () => {
        const spy = jest.spyOn(Math, 'random');
        try {
            const a = keno.drawNumbers(sequence([0.3, 0.6]));
            const b = keno.drawNumbers(sequence([0.3, 0.6]));
            expect(a).toEqual(b);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('counts a hit only where a pick was actually drawn', () => {
        expect(keno.countHits([1, 2, 3, 4, 5], [3, 5, 7, 9, 11, 13, 15, 17, 19, 21])).toBe(2);
        expect(keno.countHits([1, 2, 3, 4, 5], [21, 23, 25, 27, 29, 31, 33, 35, 37, 39])).toBe(0);
        expect(keno.countHits([1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 7, 9, 11, 13, 15])).toBe(5);
    });

    it('calls a pick within two of a drawn number a near miss, unless it was drawn', () => {
        // 4 is two away from 6; 8 was drawn, so it is a hit and not a near miss.
        expect(keno.nearMissCount([4, 8, 30], [6, 8, 12, 14, 16, 18, 20, 22, 24, 26])).toBe(1);
    });
});

describe('the cup game escalates', () => {
    it('pays the base multiplier on the first round', () => {
        expect(cup.payoutForRound(100, 1)).toBe(280);
        expect(cup.BASE_WIN_MULT).toBe(2.8);
    });

    it('doubles it every round after', () => {
        expect(cup.payoutForRound(100, 2)).toBe(560);
        expect(cup.payoutForRound(100, 3)).toBe(1_120);
        expect(cup.payoutForRound(100, 4)).toBe(2_240);
    });

    it('floors the payout, so an odd stake cannot round up into a coin', () => {
        expect(cup.payoutForRound(15, 1)).toBe(42);   // 15 × 2.8 = 42
        expect(cup.payoutForRound(11, 1)).toBe(30);   // 30.8
    });

    it('adds shuffles as the rounds go up', () => {
        expect([1, 2, 3, 4].map(cup.shufflesForRound)).toEqual([3, 5, 7, 9]);
    });

    it('holds at the last shuffle count past the table', () => {
        // MAX_ROUNDS forces a cash-out at 4, so this is the guard rather than a
        // reachable round — an unclamped index would hand the animation an
        // undefined count.
        expect(cup.shufflesForRound(cup.MAX_ROUNDS + 1)).toBe(9);
        expect(cup.shufflesForRound(99)).toBe(9);
    });

    it('caps the run at four rounds', () => {
        expect(cup.MAX_ROUNDS).toBe(cup.ROUND_SHUFFLES.length);
    });

    it('keeps the house edge the base multiplier is set for', () => {
        // One cup in three, so anything at or above 3.0 pays the player to keep
        // playing forever.
        expect(cup.BASE_WIN_MULT / 3).toBeLessThan(1);
    });
});

describe('higher-lower', () => {
    // #873, pass 24. The session used to gain a flat +0.5× per correct call
    // whatever the odds, and the first call alone returned about 115% of the
    // stake. Every call is priced by its odds now, so each one returns the same
    // HOUSE_RETURN off any card.
    it('prices every call so it returns HOUSE_RETURN, off any card', () => {
        for (let value = 1; value <= 13; value++) {
            for (const higher of [true, false]) {
                const q = hl.winChance(value, higher);
                if (q === 0) continue;
                const ev = q * hl.nextMult(1, value, higher);
                // Floored to the cent, so a call returns at most the house figure.
                expect([value, higher, ev <= hl.HOUSE_RETURN + 1e-9]).toEqual([value, higher, true]);
                expect([value, higher, ev > hl.HOUSE_RETURN - 0.01]).toEqual([value, higher, true]);
            }
        }
    });

    it('leaves ties out of the odds, since a tie is a push', () => {
        // Off a seven, six ranks are higher and six lower: even money.
        expect(hl.winChance(7, true)).toBe(0.5);
        expect(hl.nextMult(1, 7, true)).toBe(1.9);
        // Off an ace, higher is certain once ties push, and is priced to cost 5%.
        expect(hl.winChance(1, true)).toBe(1);
        expect(hl.nextMult(1, 1, true)).toBe(0.95);
    });

    it('pays nothing for a call that cannot win', () => {
        expect(hl.nextMult(3, 1, false)).toBe(0);
        expect(hl.nextMult(3, 13, true)).toBe(0);
    });

    it('builds on the session it is handed, and stops at the cap', () => {
        expect(hl.nextMult(1.9, 7, false)).toBe(3.61);
        expect(hl.nextMult(hl.MAX_SESSION_MULT, 7, true)).toBe(hl.MAX_SESSION_MULT);
    });

    it('labels the face cards and leaves the pips as numbers', () => {
        expect([1, 11, 12, 13].map(hl.cardLabel)).toEqual(['A', 'J', 'Q', 'K']);
        expect(hl.cardLabel(7)).toBe('7');
    });

    it('splits the odds three ways, and they sum to one', () => {
        for (const value of [1, 7, 13]) {
            const p = hl.probabilities(value);
            expect([value, +(p.higher + p.lower + p.equal).toFixed(10)]).toEqual([value, 1]);
        }
    });

    it('gives an ace nothing below it and a king nothing above', () => {
        expect(hl.probabilities(1).lower).toBe(0);
        expect(hl.probabilities(13).higher).toBe(0);
    });

    it('falls back to Math.random when handed nothing', () => {
        const card = hl.rollCard();
        expect(card.value).toBeGreaterThanOrEqual(1);
        expect(card.value).toBeLessThanOrEqual(13);
        expect(hl.SUITS).toContain(card.suit);
    });

    it('rolls inside the deck, through the rng it is handed', () => {
        const spy = jest.spyOn(Math, 'random');
        try {
            for (const r of [0, 0.5, 0.999]) {
                const card = hl.rollCard(() => r);
                expect([r, card.value >= 1 && card.value <= 13]).toEqual([r, true]);
                expect([r, hl.SUITS.includes(card.suit)]).toEqual([r, true]);
            }
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('the crash curve', () => {
    // #873, pass 24. The curve was 0.99/r with the bottom 1% of rolls busting
    // instantly — and those are the rolls 0.99/r maps above 99×, so the edge
    // came off the top: a 10× cash-out returned 89%, a 50× one 49%. The target
    // a player picks must not change the edge.
    it('returns 99% of the stake whichever multiplier a player cashes at', () => {
        const n = 200_000;
        for (const target of [1.01, 1.5, 2, 10, 50, 99]) {
            let reached = 0;
            for (let i = 0; i < n; i++) {
                if (crash.generateCrashPoint(() => (i + 0.5) / n) >= target) reached++;
            }
            expect([target, +(reached / n * target).toFixed(3)]).toEqual([target, 0.99]);
        }
    });

    it('busts at 1.00x on the bottom two percent of rolls', () => {
        // The 1% below 1.00x, floored up, and the 1% between 1.00x and 1.01x.
        expect(crash.generateCrashPoint(() => 0)).toBe(1.00);
        expect(crash.generateCrashPoint(() => 0.0197)).toBe(1.00);
        expect(crash.generateCrashPoint(() => 0.0199)).toBe(1.01);
    });

    it('floors to the cent rather than rounding up past the real crash', () => {
        // 0.99 / 0.5 is 1.98 exactly; a hair under 2.00 stays at 1.99.
        expect(crash.generateCrashPoint(() => 0.5)).toBe(1.98);
        expect(crash.generateCrashPoint(() => 0.505)).toBe(2.00);
        expect(crash.generateCrashPoint(() => 0.5049)).toBe(1.99);
    });

    it('never deals a round above the cap', () => {
        expect(crash.generateCrashPoint(() => 0.99)).toBe(99.00);
        expect(crash.generateCrashPoint(() => 0.9999999)).toBe(crash.MAX_CRASH);
    });

    it('never returns below 1.00, which would owe the player less than the stake', () => {
        for (let r = 0.001; r < 1; r += 0.01) {
            const point = crash.generateCrashPoint(() => r);
            expect([r, point >= 1.00]).toEqual([r, true]);
        }
    });

    it('grows 12% a tick from 1.00', () => {
        expect(crash.multiplierAt(0)).toBe(1.00);
        expect(crash.multiplierAt(1)).toBe(1.12);
        expect(crash.multiplierAt(2)).toBe(1.25);
    });

    it('counts the ticks a round survives, rounding up to the tick that busts it', () => {
        expect(crash.ticksUntilCrash(1.00)).toBe(0);
        expect(crash.ticksUntilCrash(1.12)).toBe(1);
        expect(crash.ticksUntilCrash(2.00)).toBe(7);
        expect(crash.multiplierAt(crash.ticksUntilCrash(2.00))).toBeGreaterThanOrEqual(2.00);
    });

    it('agrees with itself: the tick before the crash is still below it', () => {
        for (const point of [1.5, 2.0, 5.0, 12.5, 100.0]) {
            const ticks = crash.ticksUntilCrash(point);
            expect([point, crash.multiplierAt(ticks - 1) < point]).toEqual([point, true]);
        }
    });

    it('drops a decimal past 10x, where the row would otherwise get long', () => {
        expect(crash.multLabel(1.07)).toBe('1.07x');
        expect(crash.multLabel(9.99)).toBe('9.99x');
        expect(crash.multLabel(10)).toBe('10.0x');
        expect(crash.multLabel(100)).toBe('100.0x');
    });

    it('falls back to Math.random when handed nothing', () => {
        const point = crash.generateCrashPoint();
        expect(point).toBeGreaterThanOrEqual(1.00);
        expect(point).toBeLessThanOrEqual(crash.MAX_CRASH);
    });

    it('takes its roll from the rng it is handed', () => {
        const spy = jest.spyOn(Math, 'random');
        try {
            expect(crash.generateCrashPoint(() => 0.25)).toBe(crash.generateCrashPoint(() => 0.25));
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
