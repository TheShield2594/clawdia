/**
 * #885. `evaluate()` decides the payout on every slots spin and was neither
 * exported nor directly tested: it lived inside slots.js behind a three-stage
 * reveal animation and a collector, so #623's bet guard drove the command as
 * far as the debit and no further.
 *
 * It is now src/games/casino/slotsReels.js. What is pinned here is every win
 * tier, wild substitution, the multiplier stack, the tie-break that had no
 * defined behaviour at all, and the `payout: 0` jackpot hand-off contract that
 * slots.js relies on.
 */
const reels = require('../src/games/casino/slotsReels');
const { evaluate, SYMBOLS, SPIN_POOL, TOTAL_WEIGHT, FREE_SPIN_JACKPOT_MULT, spinReel, randomEmoji, bestRegular } = reels;

const S = Object.fromEntries(SYMBOLS.map(s => [s.name, s]));
const { Cherry, Lemon, Grape, Bell, Diamond, Star, Wild, Scatter } = S;
const Boost = S['2x Boost'];

const BET = 100;

describe('the reel table itself', () => {
    it('has one entry per symbol, and every regular pays a distinct multiple', () => {
        const payouts = SYMBOLS.filter(s => s.type === 'regular').map(s => s.payout);

        expect(new Set(SYMBOLS.map(s => s.name)).size).toBe(SYMBOLS.length);
        expect(new Set(payouts).size).toBe(payouts.length);
        // Distinctness is what makes the payout tie-break below total: two
        // regulars paying the same multiple would put it back on entry order.
        expect(payouts).toEqual([...payouts].sort((a, b) => a - b));
    });

    it('spins from the weighted table, and the reels can only show regulars and wilds', () => {
        // Scatter and Boost are in SYMBOLS — a real spin can land them — but the
        // filler used while a reel is still spinning must not, or the animation
        // shows a symbol the locked reels then contradict.
        expect(SPIN_POOL.map(s => s.name)).toEqual(['Cherry', 'Lemon', 'Grape', 'Bell', 'Diamond', 'Star', 'Wild']);
        expect(TOTAL_WEIGHT).toBe(SYMBOLS.reduce((sum, s) => sum + s.weight, 0));

        expect(spinReel(() => 0).name).toBe('Cherry');           // first band
        expect(spinReel(() => 0.999999).name).toBe('Scatter');   // last band
        expect(spinReel(() => 27 / TOTAL_WEIGHT).name).toBe('Cherry');
        expect(spinReel(() => 29 / TOTAL_WEIGHT).name).toBe('Lemon');
        expect(randomEmoji(() => 0.999999)).toBe(Wild.emoji);
    });
});

describe('win tiers', () => {
    it('pays three of a kind at the symbol’s row', () => {
        expect(evaluate([Cherry, Cherry, Cherry], BET)).toMatchObject({ outcome: 'three', payout: 200, symbol: Cherry });
        expect(evaluate([Star, Star, Star], BET)).toMatchObject({ outcome: 'three', payout: 2_500, symbol: Star });
    });

    it('pays two of a kind at half that row, floored', () => {
        expect(evaluate([Cherry, Cherry, Scatter], BET)).toMatchObject({ outcome: 'two', payout: 100 });
        expect(evaluate([Bell, Bell, Scatter], BET)).toMatchObject({ outcome: 'two', payout: 400 });
        // 15 × 0.5 × 3 = 22.5. The floor is what stops a partial win minting a
        // coin the player never staked.
        expect(evaluate([Diamond, Diamond, Scatter], 3).payout).toBe(22);
    });

    it('pays three multipliers a flat 4× and nothing from the stack on top', () => {
        expect(evaluate([Boost, Boost, Boost], BET)).toMatchObject({ outcome: 'mult3', payout: 400, multFactor: 8, symbol: null });
    });

    it('is a loss when three different regulars land', () => {
        expect(evaluate([Cherry, Lemon, Grape], BET)).toMatchObject({ outcome: 'lose', payout: 0, symbol: null });
    });

    it('is a loss when a boost stack has nothing to multiply', () => {
        // Two boosts is multFactor 4 and still no hand — the factor is reported
        // for the embed's "4x Boost applied" line, not as a payout of its own.
        expect(evaluate([Boost, Boost, Cherry], BET)).toMatchObject({ outcome: 'lose', payout: 0, multFactor: 4 });
    });
});

describe('wild substitution', () => {
    it('completes a pair into three of a kind', () => {
        expect(evaluate([Wild, Grape, Grape], BET)).toMatchObject({ outcome: 'three', payout: 500, symbol: Grape, wildCount: 1 });
    });

    it('completes a single regular into two of a kind, not three', () => {
        expect(evaluate([Wild, Wild, Lemon], BET)).toMatchObject({ outcome: 'three', payout: 300, symbol: Lemon, wildCount: 2 });
        expect(evaluate([Wild, Lemon, Scatter], BET)).toMatchObject({ outcome: 'two', payout: 150, symbol: Lemon, wildCount: 1 });
    });

    it('reports the wild count on every hand it assisted', () => {
        // resultEmbed prints "Wild card assisted!" off this, so a hand that won
        // without a wild must not claim one.
        expect(evaluate([Cherry, Cherry, Cherry], BET).wildCount).toBe(0);
        expect(evaluate([Wild, Cherry, Cherry], BET).wildCount).toBe(1);
    });
});

describe('wild and multiplier stacking', () => {
    it('multiplies a wild-completed three of a kind', () => {
        expect(evaluate([Wild, Bell, Boost], BET)).toMatchObject({ outcome: 'two', payout: 800, multFactor: 2 });
        expect(evaluate([Wild, Bell, Bell], BET).payout).toBe(800);
    });

    it('multiplies a two of a kind after the half rate, not before', () => {
        // floor(100 × 5 × 0.5 × 2) = 500. Halving the multiplied figure and
        // multiplying the halved one agree here; the order is pinned so a
        // rewrite that flips them still has to keep the floor last.
        expect(evaluate([Grape, Grape, Boost], BET)).toMatchObject({ outcome: 'two', payout: 500, multFactor: 2 });
        expect(evaluate([Grape, Grape, Boost], 3).payout).toBe(15);
    });
});

describe('the 1-wild-2-different tie-break', () => {
    // This is the case #885 was filed on. 🃏 🍒 🌟 is one wild and two
    // one-of-a-kind regulars: the wild can complete either into a two of a
    // kind, and which it completes used to fall out of the insertion order of
    // a frequency object — whichever of the two sat on the lower reel.
    it('pays the higher-paying symbol, whichever reel it landed on', () => {
        expect(evaluate([Wild, Cherry, Star], BET)).toMatchObject({ outcome: 'two', symbol: Star, payout: 1_250 });
        expect(evaluate([Wild, Star, Cherry], BET)).toMatchObject({ outcome: 'two', symbol: Star, payout: 1_250 });
        expect(evaluate([Star, Wild, Cherry], BET)).toMatchObject({ outcome: 'two', symbol: Star, payout: 1_250 });
    });

    it('does not depend on the order of the symbol table', () => {
        // The behaviour the issue describes: reorder SYMBOLS and the winner
        // changes. It is a payout rule now, so it does not.
        for (const hand of [[Wild, Cherry, Star], [Wild, Diamond, Lemon], [Wild, Bell, Grape]]) {
            const forward = evaluate(hand, BET);
            const reversed = evaluate([...hand].reverse(), BET);
            expect(reversed.symbol).toBe(forward.symbol);
            expect(reversed.payout).toBe(forward.payout);
        }
    });

    it('still prefers the larger group over the better-paying one', () => {
        // Two cherries beat one star: count first, payout only as the tie-break.
        expect(evaluate([Cherry, Cherry, Star], BET)).toMatchObject({ outcome: 'two', symbol: Cherry, payout: 100 });
    });

    it('picks nothing when there is no regular to play for', () => {
        expect(bestRegular([])).toBeNull();
        expect(bestRegular([Star, Cherry])).toEqual({ symbol: Star, count: 1 });
        expect(bestRegular([Cherry, Cherry, Star])).toEqual({ symbol: Cherry, count: 2 });
    });
});

describe('the jackpot hand-off contract', () => {
    it('returns payout 0 for three wilds and leaves the figure to the caller', () => {
        // slots.js fills this in from casinoJackpotService's claim, or from
        // FREE_SPIN_JACKPOT_MULT when the pool cannot be claimed. Returning a
        // number here would be one the caller has to remember to overwrite.
        expect(evaluate([Wild, Wild, Wild], BET)).toEqual({
            payout: 0, outcome: 'jackpot', symbol: null, wildCount: 3, multFactor: 1, scatterCount: 0,
        });
        expect(FREE_SPIN_JACKPOT_MULT).toBe(25);
    });

    it('never reports a multiplier stack on a jackpot, because three wilds leave no reel for one', () => {
        expect(evaluate([Wild, Wild, Wild], BET).multFactor).toBe(1);
    });
});

describe('scatters', () => {
    it('wins spins rather than coins, and reports how many landed', () => {
        expect(evaluate([Scatter, Scatter, Cherry], BET)).toMatchObject({ outcome: 'scatter', payout: 0, scatterCount: 2 });
        expect(evaluate([Scatter, Scatter, Scatter], BET)).toMatchObject({ outcome: 'scatter', payout: 0, scatterCount: 3 });
    });

    it('does not count a lone scatter as a hand', () => {
        // One scatter beside two others is just a blank reel. scatterCount is
        // reported as 0 so the caller's `>= 3 ? 5 : 3` never runs on it.
        expect(evaluate([Scatter, Cherry, Lemon], BET)).toMatchObject({ outcome: 'lose', scatterCount: 0 });
        expect(evaluate([Scatter, Cherry, Cherry], BET)).toMatchObject({ outcome: 'two', scatterCount: 0 });
    });

    it('ranks below three wilds and three boosts', () => {
        expect(evaluate([Scatter, Scatter, Boost], BET).outcome).toBe('scatter');
        expect(evaluate([Boost, Boost, Boost], BET).outcome).toBe('mult3');
    });
});

describe('every hand returns the same shape', () => {
    const hands = [
        [Wild, Wild, Wild], [Boost, Boost, Boost], [Scatter, Scatter, Scatter],
        [Star, Star, Star], [Wild, Cherry, Star], [Cherry, Lemon, Grape],
    ];

    it.each(hands.map(h => [h.map(s => s.emoji).join(''), h]))('%s', (_label, hand) => {
        const result = evaluate(hand, BET);

        expect(Object.keys(result).sort()).toEqual(
            ['multFactor', 'outcome', 'payout', 'scatterCount', 'symbol', 'wildCount']);
        expect(Number.isInteger(result.payout)).toBe(true);
        expect(result.payout).toBeGreaterThanOrEqual(0);
    });
});
