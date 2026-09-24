/**
 * The slot machine's reels and paytable (src/games/casino/slotsReels.js).
 *
 * #885 lifted `evaluate()` out of slots.js so the payout on every spin could be
 * tested directly. #873, pass 25 rebuilt the machine on real reel strips with a
 * 94% return, and this is where that figure is held: exactly, over every one of
 * the 64³ stop combinations, rather than by sampling.
 *
 * What is pinned:
 *   - the strips: their counts, and that the window a player sees is the strip
 *   - the paytable rules — wild substitution, boosts, the best-reading rule,
 *     scatters on top of the line, no pair that pays less than the stake
 *   - the return: 92.5% from the reels and features, 94.0% with the capped
 *     progressive, and under 100% even with both luck items
 */
const reels = require('../src/games/casino/slotsReels');
const {
    SYMBOLS, BY_NAME, REELS, STRIP_COUNTS, STRIP_LENGTH, HOT_STOPS, HEAT_MAX, HIGH_VALUE_SYMBOLS,
    TRIPLE_WILD_MULT, TRIPLE_BOOST_MULT, FREE_SPINS, LUCKY_CHARM_RESPIN, LUCKY_STREAK_REFUND,
    PROGRESSIVE_RETURN, TRIPLE_WILD_CHANCE, JACKPOT_CAP_MULT,
    windowAt, spin, fillerEmoji, evaluate, isNetLoss, odds,
} = reels;
const { RANDOM_DROP_RETURN } = require('../src/services/casinoJackpotService');

const { Cherry, Lemon, Grape, Bell, Diamond, Star, Wild, Boost, Scatter } = Object.fromEntries(BY_NAME);

const BET = 100;

/** A seeded rng that walks a fixed list, for spins that must land somewhere known. */
const seq = values => { let i = 0; return () => values[i++ % values.length]; };

describe('the strips', () => {
    it('each carries exactly STRIP_COUNTS, and nothing else', () => {
        for (const strip of REELS) {
            expect(strip).toHaveLength(STRIP_LENGTH);
            const counts = {};
            for (const s of strip) counts[s.name] = (counts[s.name] ?? 0) + 1;
            expect(counts).toEqual(STRIP_COUNTS);
        }
        expect(STRIP_LENGTH).toBe(64);
    });

    it('lays each reel out differently', () => {
        const order = strip => strip.map(s => s.name).join();
        expect(new Set(REELS.map(order)).size).toBe(3);
    });

    it('never shows two Scatters in one reel’s window', () => {
        // Free spins count Scatters across the whole window; a reel showing two
        // at once would pay a count no reel layout was priced for.
        for (const strip of REELS) {
            for (let stop = 0; stop < STRIP_LENGTH; stop++) {
                const column = [-1, 0, 1].map(d => strip[(stop + d + STRIP_LENGTH) % STRIP_LENGTH]);
                expect(column.filter(s => s === Scatter).length).toBeLessThanOrEqual(1);
            }
        }
    });

    it('shows the strip itself above and below the payline, wrapping at the ends', () => {
        const window = windowAt([0, 10, STRIP_LENGTH - 1]);
        expect(window[1]).toEqual([REELS[0][0], REELS[1][10], REELS[2][STRIP_LENGTH - 1]]);
        expect(window[0]).toEqual([REELS[0][STRIP_LENGTH - 1], REELS[1][9], REELS[2][STRIP_LENGTH - 2]]);
        expect(window[2]).toEqual([REELS[0][1], REELS[1][11], REELS[2][0]]);
    });
});

describe('spin', () => {
    it('stops each reel where the rng says, and reads the line and the scatters off the window', () => {
        const result = spin({ rng: seq([0, 0.5, 0.99]) });
        expect(result.stops).toEqual([0, 32, 63]);
        expect(result.line).toEqual(result.window[1]);
        expect(result.scatterCount).toBe(result.window.flat().filter(s => s === Scatter).length);
    });

    it('a Hot Spin stops reel 1 on a high-value symbol, every time', () => {
        for (let i = 0; i < HOT_STOPS.length; i++) {
            const result = spin({ hot: true, rng: seq([i / HOT_STOPS.length, 0, 0]) });
            expect(HIGH_VALUE_SYMBOLS).toContain(result.line[0].name);
        }
    });

    it('a locked re-spin keeps reel 1 where it was', () => {
        // The Lucky Charm's second spin of a Hot Spin: it used to re-roll all
        // three reels and throw the lock away while the result still said
        // "first reel was locked to a high-value symbol".
        const hot = spin({ hot: true, rng: seq([0.3, 0.1, 0.2]) });
        const again = spin({ lock: hot.stops[0], rng: seq([0.7, 0.8]) });
        expect(again.stops[0]).toBe(hot.stops[0]);
        expect(again.line[0]).toBe(hot.line[0]);
    });

    it('fills a spinning cell with a symbol off the strip, never a Scatter', () => {
        // A Scatter flashing past on a spinning reel reads as one that landed.
        for (let i = 0; i < 64; i++) {
            const emoji = fillerEmoji(() => i / 64);
            expect(REELS[0].map(s => s.emoji)).toContain(emoji);
            expect(emoji).not.toBe(Scatter.emoji);
        }
    });
});

describe('the paytable', () => {
    it('pays three of a kind at the symbol’s row, and more for rarer symbols', () => {
        const regulars = SYMBOLS.filter(s => s.type === 'regular');
        for (const s of regulars) {
            expect(evaluate([s, s, s], BET)).toMatchObject({ outcome: 'three', symbol: s, payout: BET * s.three });
        }
        const rows = regulars.map(s => s.three);
        expect(rows).toEqual([...rows].sort((a, b) => a - b));
        expect(new Set(rows).size).toBe(rows.length);
    });

    it('never pays a pair less than the stake', () => {
        // The old two-of-a-kind paid a quarter of the three-of-a-kind row: a
        // Cherry pair returned half the bet and was shown as a win. A pair now
        // either pays a real profit or does not pay.
        for (const s of SYMBOLS.filter(x => x.type === 'regular')) {
            expect(s.pair === 0 || s.pair >= 2).toBe(true);
        }
        expect(evaluate([Cherry, Cherry, Lemon], BET)).toMatchObject({ outcome: 'lose', payout: 0 });
        expect(evaluate([Bell, Bell, Cherry], BET)).toMatchObject({ outcome: 'pair', symbol: Bell, payout: BET * Bell.pair });
    });

    it('every win on the whole machine pays more than the bet', () => {
        for (let a = 0; a < STRIP_LENGTH; a += 3) for (let b = 0; b < STRIP_LENGTH; b++) for (let c = 0; c < STRIP_LENGTH; c++) {
            const { payout } = evaluate(windowAt([a, b, c])[1], BET);
            expect(payout === 0 || payout > BET).toBe(true);
        }
    });

    it('lets a Wild complete any line, and reads it the way that pays best', () => {
        expect(evaluate([Wild, Star, Star], BET)).toMatchObject({ outcome: 'three', symbol: Star, payout: BET * Star.three });
        expect(evaluate([Bell, Wild, Bell], BET)).toMatchObject({ outcome: 'three', symbol: Bell });
        // A Wild beside two different symbols completes the better-paying pair,
        // whichever reel each is on.
        for (const hand of [[Wild, Cherry, Star], [Star, Cherry, Wild], [Cherry, Wild, Star]]) {
            expect(evaluate(hand, BET)).toMatchObject({ outcome: 'pair', symbol: Star, payout: BET * Star.pair });
        }
    });

    it('pays two Wilds beside a symbol they cannot copy', () => {
        // 🃏🃏⚡ and 🃏🃏🌸 used to lose outright — no regular symbol for the
        // wilds to copy — under a footer promising they substitute for anything.
        expect(evaluate([Wild, Wild, Boost], BET)).toMatchObject({ outcome: 'mult3', payout: BET * TRIPLE_BOOST_MULT });
        expect(evaluate([Wild, Boost, Boost], BET)).toMatchObject({ outcome: 'mult3', payout: BET * TRIPLE_BOOST_MULT });
        expect(evaluate([Wild, Wild, Scatter], BET)).toMatchObject({ outcome: 'pair', symbol: Star, payout: BET * Star.pair });
        expect(evaluate([Wild, Boost, Scatter], BET)).toMatchObject({ outcome: 'lose', payout: 0 });
    });

    it('doubles a line win for every Boost on the line', () => {
        expect(evaluate([Bell, Bell, Boost], BET)).toMatchObject({ outcome: 'pair', multFactor: 2, payout: BET * Bell.pair * 2 });
        expect(evaluate([Diamond, Boost, Wild], BET)).toMatchObject({ outcome: 'pair', multFactor: 2, payout: BET * Diamond.pair * 2 });
        expect(evaluate([Boost, Boost, Boost], BET)).toMatchObject({ outcome: 'mult3', payout: BET * TRIPLE_BOOST_MULT });
    });

    it('pays a fixed Triple Wild from the machine, and leaves the pot to the caller', () => {
        expect(evaluate([Wild, Wild, Wild], BET)).toMatchObject({ outcome: 'jackpot', payout: BET * TRIPLE_WILD_MULT, multFactor: 1 });
    });

    it('awards free spins for Scatters anywhere in the window, on top of the line', () => {
        expect(evaluate([Bell, Bell, Bell], BET, { scatterCount: 2 })).toMatchObject({
            outcome: 'three', payout: BET * Bell.three, freeSpins: FREE_SPINS[2],
        });
        expect(evaluate([Cherry, Lemon, Grape], BET, { scatterCount: 3 })).toMatchObject({
            outcome: 'lose', payout: 0, freeSpins: FREE_SPINS[3],
        });
        expect(evaluate([Cherry, Lemon, Grape], BET, { scatterCount: 1 }).freeSpins).toBeNull();
    });

    it('does not let a free spin retrigger', () => {
        expect(evaluate([Scatter, Scatter, Scatter], BET, { freeSpin: true })).toMatchObject({ freeSpins: null, scatterCount: 0 });
    });

    it('counts a spin as lost only when it paid nothing and won no free spins', () => {
        expect(isNetLoss(evaluate([Cherry, Lemon, Grape], BET), BET)).toBe(true);
        expect(isNetLoss(evaluate([Cherry, Lemon, Grape], BET, { scatterCount: 2 }), BET)).toBe(false);
        expect(isNetLoss(evaluate([Bell, Bell, Grape], BET), BET)).toBe(false);
    });

    it('never pays a fraction of a coin', () => {
        expect(Number.isInteger(evaluate([Bell, Bell, Boost], 13).payout)).toBe(true);
    });
});

// ── The return ────────────────────────────────────────────────────────────────
//
// Computed here independently of `odds()`, from the strips and `evaluate`, and
// then compared with it — so a change to either the machine or the figure the
// paytable prints shows up.

describe('the return to player', () => {
    // Per first-reel stop: what a spin is worth when it is not a loss (W) and
    // how often it is a loss (L). Losses are worth nothing — a line either pays
    // more than the bet or pays 0 — so W is the whole of a spin's value.
    const perStop = (() => {
        let freeLine = 0;
        const p = 1 / STRIP_LENGTH ** 3;
        for (let a = 0; a < STRIP_LENGTH; a++) for (let b = 0; b < STRIP_LENGTH; b++) for (let c = 0; c < STRIP_LENGTH; c++) {
            freeLine += p * evaluate(windowAt([a, b, c])[1], 1, { freeSpin: true }).payout;
        }
        const stops = [];
        for (let a = 0; a < STRIP_LENGTH; a++) {
            let W = 0, L = 0;
            const q = 1 / STRIP_LENGTH ** 2;
            for (let b = 0; b < STRIP_LENGTH; b++) for (let c = 0; c < STRIP_LENGTH; c++) {
                const window = windowAt([a, b, c]);
                const r = evaluate(window[1], 1_000, { scatterCount: window.flat().filter(s => s === Scatter).length });
                const free = r.freeSpins ? r.freeSpins.spins * r.freeSpins.mult * freeLine : 0;
                W += q * (r.payout / 1_000 + free);
                if (isNetLoss(r, 1_000)) L += q;
            }
            stops.push({ W, L });
        }
        return stops;
    })();

    /**
     * A spin's worth with the luck items: a loss is re-spun at `charm` (the
     * re-spin keeping reel 1 on a Hot Spin), and a loss that stays one is
     * refunded at `streak`.
     */
    function spinWorth(firstStops, charm, streak, locked) {
        const avg = f => firstStops.reduce((sum, a) => sum + f(perStop[a]), 0) / firstStops.length;
        const fresh = { W: avg(s => s.W), L: avg(s => s.L) };
        return avg(({ W, L }) => {
            const again = locked ? { W, L } : fresh;
            return W + L * (charm * (again.W + again.L * streak) + (1 - charm) * streak);
        });
    }

    const every = [...Array(STRIP_LENGTH).keys()];
    const loop = (charm = 0, streak = 0) =>
        (HEAT_MAX * spinWorth(every, charm, streak, false) + spinWorth(HOT_STOPS, charm, streak, true)) / (HEAT_MAX + 1);

    it('returns 92.5% from the reels and features', () => {
        expect(loop()).toBeCloseTo(0.925, 3);
        expect(odds().reelReturn).toBeCloseTo(loop(), 9);
    });

    it('returns 94.0% with the capped progressive on top', () => {
        expect(loop() + PROGRESSIVE_RETURN + RANDOM_DROP_RETURN).toBeCloseTo(0.94, 3);
    });

    it('caps a Triple Wild’s pot so the progressive is worth PROGRESSIVE_RETURN at most', () => {
        expect(TRIPLE_WILD_CHANCE).toBe((STRIP_COUNTS.Wild / STRIP_LENGTH) ** 3);
        expect(TRIPLE_WILD_CHANCE * JACKPOT_CAP_MULT).toBeLessThanOrEqual(PROGRESSIVE_RETURN);
        expect(TRIPLE_WILD_CHANCE * (JACKPOT_CAP_MULT + 1)).toBeGreaterThan(PROGRESSIVE_RETURN);
    });

    it('stays under 100% with both luck items and the whole progressive', () => {
        // At the old 20% re-spin and 25% refund this was 113%: two shop items
        // made slots a machine that paid its players.
        const both = loop(LUCKY_CHARM_RESPIN, LUCKY_STREAK_REFUND) + PROGRESSIVE_RETURN + RANDOM_DROP_RETURN;
        expect(both).toBeLessThan(1);
        expect(loop(LUCKY_CHARM_RESPIN, 0)).toBeGreaterThan(loop());
        expect(loop(0, LUCKY_STREAK_REFUND)).toBeGreaterThan(loop());
    });

    it('makes a Hot Spin worth more than a cold one, and not so much it carries the machine', () => {
        const { normalReturn, hotReturn } = odds();
        expect(hotReturn).toBeGreaterThan(normalReturn);
        expect((hotReturn - normalReturn) / (HEAT_MAX + 1)).toBeLessThan(0.05);
    });

    it('lands a line win on about one spin in six, and free spins on about one in 150', () => {
        const { hitRate, freeSpinRate } = odds();
        expect(hitRate).toBeGreaterThan(0.15);
        expect(hitRate).toBeLessThan(0.2);
        expect(1 / freeSpinRate).toBeGreaterThan(100);
        expect(1 / freeSpinRate).toBeLessThan(200);
    });
});
