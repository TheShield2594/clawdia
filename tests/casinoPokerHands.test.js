/**
 * #785. #623 closed with the atomic balance-debit guard covered for all eight
 * casino games, and both suites that drive them stop at the opening debit.
 * Everything that decides what the player is *paid* was still unexecuted:
 * poker.js measured 9.4% lines / 4.3% branches, and the resolution math was
 * module-private, so reaching it meant driving a whole interaction through a
 * collector.
 *
 * It is src/games/casino/pokerHands.js now, and these are fixed hands.
 */
const {
    RANK,
    buildDeck,
    cardStr,
    handStr,
    rankHand,
    compareTuple,
    bestHand,
    compareHands,
} = require('../src/games/casino/pokerHands');

/** '10♠ J♠ Q♠ K♠ A♠' -> five card objects. */
const hand = notation => notation.split(' ').map(t => ({
    value: t.slice(0, -1),
    suit: t.slice(-1),
}));

describe('rankHand names every category', () => {
    // Category, an example, and the score the evaluator must give it. One row
    // per branch in rankHand — the file had none of them covered.
    const CATEGORIES = [
        ['Straight Flush', '10♠ J♠ Q♠ K♠ A♠', 8],
        ['Four of a Kind', '9♠ 9♥ 9♦ 9♣ 2♠', 7],
        ['Full House',     '9♠ 9♥ 9♦ 4♣ 4♠', 6],
        ['Flush',          '2♥ 5♥ 9♥ J♥ K♥', 5],
        ['Straight',       '5♠ 6♥ 7♦ 8♣ 9♠', 4],
        ['Three of a Kind','9♠ 9♥ 9♦ 4♣ 2♠', 3],
        ['Two Pair',       '9♠ 9♥ 4♦ 4♣ 2♠', 2],
        ['One Pair',       '9♠ 9♥ 5♦ 4♣ 2♠', 1],
        ['High Card',      '2♠ 5♥ 9♦ J♣ K♠', 0],
    ];

    it.each(CATEGORIES)('calls %s a %s (score %i)', (name, notation, score) => {
        expect(rankHand(hand(notation))).toMatchObject({ name, score });
    });

    it('orders the categories exactly as the list above does', () => {
        const scores = CATEGORIES.map(([, notation]) => rankHand(hand(notation)).score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
        expect(new Set(scores).size).toBe(CATEGORIES.length);
    });
});

describe('the wheel, which is the ace playing low', () => {
    it('is a straight, not a high-card ace', () => {
        expect(rankHand(hand('A♠ 2♥ 3♦ 4♣ 5♠'))).toMatchObject({ name: 'Straight', score: 4 });
    });

    it('is a straight flush when it is all one suit', () => {
        expect(rankHand(hand('A♠ 2♠ 3♠ 4♠ 5♠'))).toMatchObject({ name: 'Straight Flush', score: 8 });
    });

    it('loses to a six-high straight, because it is the lowest one there is', () => {
        const wheel = rankHand(hand('A♠ 2♥ 3♦ 4♣ 5♠'));
        const six   = rankHand(hand('2♠ 3♥ 4♦ 5♣ 6♠'));
        expect(compareTuple(wheel, six)).toBeLessThan(0);
    });

    it('is beaten by a broadway straight as well', () => {
        const wheel = rankHand(hand('A♠ 2♥ 3♦ 4♣ 5♠'));
        const broadway = rankHand(hand('10♠ J♥ Q♦ K♣ A♠'));
        expect(compareTuple(wheel, broadway)).toBeLessThan(0);
    });

    it('is not a straight with a gap at the top', () => {
        // A-2-3-4-6 is the near miss the wheel check has to reject.
        expect(rankHand(hand('A♠ 2♥ 3♦ 4♣ 6♠'))).toMatchObject({ name: 'High Card' });
    });
});

describe('compareTuple breaks ties inside a category', () => {
    it('ranks the higher pair first', () => {
        const kings = rankHand(hand('K♠ K♥ 5♦ 4♣ 2♠'));
        const nines = rankHand(hand('9♠ 9♥ 5♦ 4♣ 2♠'));
        expect(compareTuple(kings, nines)).toBeGreaterThan(0);
        expect(compareTuple(nines, kings)).toBeLessThan(0);
    });

    it('falls through to the kicker when the pair is the same', () => {
        const aceKicker = rankHand(hand('9♠ 9♥ A♦ 4♣ 2♠'));
        const kingKicker = rankHand(hand('9♦ 9♣ K♦ 4♥ 2♥'));
        expect(compareTuple(aceKicker, kingKicker)).toBeGreaterThan(0);
    });

    it('calls two identically ranked hands a tie', () => {
        expect(compareTuple(rankHand(hand('9♠ 9♥ A♦ 4♣ 2♠')),
                            rankHand(hand('9♦ 9♣ A♥ 4♥ 2♥')))).toBe(0);
    });

    it('treats a missing tiebreak slot as the lowest possible one', () => {
        // bestHand only ever produces equal-length tiebreaks, so this is the
        // guard rather than a hand the game deals: a shorter tuple must lose
        // rather than compare as undefined.
        const short = { score: 1, tiebreak: [9] };
        const long  = { score: 1, tiebreak: [9, 5] };
        expect(compareTuple(short, long)).toBeLessThan(0);
        expect(compareTuple(long, short)).toBeGreaterThan(0);
        expect(compareTuple(short, { score: 1, tiebreak: [9, 0] })).toBe(0);
    });

    it('puts the category above every kicker', () => {
        // A pair of deuces beats ace-king-high, which is the mistake a
        // comparison that started with the tiebreak would make.
        const deuces = rankHand(hand('2♠ 2♥ 5♦ 4♣ 3♠'));
        const aceHigh = rankHand(hand('A♠ K♥ 9♦ 6♣ 3♠'));
        expect(compareTuple(deuces, aceHigh)).toBeGreaterThan(0);
    });
});

describe('bestHand picks five from seven', () => {
    it('finds the flush hidden among two off-suit cards', () => {
        const seven = hand('2♥ 5♥ 9♥ J♥ K♥ A♠ 3♣');
        const best = bestHand(seven);
        expect(best.name).toBe('Flush');
        expect(best.cards.map(cardStr)).toEqual(['2♥', '5♥', '9♥', 'J♥', 'K♥']);
    });

    it('takes the full house over the flush draw it also holds', () => {
        const best = bestHand(hand('9♠ 9♥ 9♦ 4♣ 4♠ 2♥ 7♥'));
        expect(best.name).toBe('Full House');
    });

    it('leaves out the low card when the board makes a straight', () => {
        const best = bestHand(hand('5♠ 6♥ 7♦ 8♣ 9♠ 2♥ 3♣'));
        expect(best.name).toBe('Straight');
        expect(best.cards.map(c => RANK[c.value]).sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9]);
    });

    it('considers every five-card subset, not just the first', () => {
        // The winning five are the last five of the seven, so a search that
        // stopped early would return two pair.
        const best = bestHand(hand('2♣ 3♦ 10♠ J♠ Q♠ K♠ A♠'));
        expect(best.name).toBe('Straight Flush');
    });
});

describe('compareHands is the showdown', () => {
    const board = '7♦ 8♣ 9♠ 2♥ 3♣';

    it('gives the win to the better five', () => {
        const player = hand(`5♠ 6♥ ${board}`);   // straight
        const dealer = hand(`A♠ K♥ ${board}`);   // ace high
        expect(compareHands(player, dealer).result).toBe('win');
    });

    it('gives it to the dealer the other way round', () => {
        const player = hand(`A♠ K♥ ${board}`);
        const dealer = hand(`5♠ 6♥ ${board}`);
        expect(compareHands(player, dealer).result).toBe('lose');
    });

    it('pushes when both play the same board', () => {
        // Both hole pairs are below the board's cards, so each plays the same
        // five and neither kicker gets a look in.
        const result = compareHands(hand(`4♠ 5♥ 7♦ 8♣ 9♠ 10♥ J♣`),
                                    hand(`4♦ 5♣ 7♦ 8♣ 9♠ 10♥ J♣`));
        expect(result.result).toBe('push');
        expect(result.playerHand.name).toBe(result.dealerHand.name);
    });

    it('hands back the five each side actually played', () => {
        const result = compareHands(hand(`5♠ 6♥ ${board}`), hand(`A♠ K♥ ${board}`));
        expect(result.playerHand.cards).toHaveLength(5);
        expect(result.dealerHand.cards).toHaveLength(5);
        expect(handStr(result.playerHand.cards)).toContain('♠');
    });
});

describe('the deck', () => {
    it('is 52 distinct cards', () => {
        const deck = buildDeck();
        expect(deck).toHaveLength(52);
        expect(new Set(deck.map(cardStr)).size).toBe(52);
    });

    it('shuffles through the rng it is handed, so a test can deal a known board', () => {
        // rng() === 0 sends every swap to index 0, which is a deterministic
        // permutation rather than a no-op — the point is only that the deck
        // follows the injected source and not Math.random.
        const zeros = buildDeck(() => 0);
        expect(zeros).toHaveLength(52);
        expect(buildDeck(() => 0).map(cardStr)).toEqual(zeros.map(cardStr));

        const spy = jest.spyOn(Math, 'random');
        try {
            buildDeck(() => 0.5);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('still shuffles by default', () => {
        const ordered = [];
        for (const suit of ['♠', '♥', '♦', '♣']) {
            for (const value of ['2','3','4','5','6','7','8','9','10','J','Q','K','A']) {
                ordered.push(`${value}${suit}`);
            }
        }
        // One shuffled deck could land back in order once in 52!; two could not.
        const decks = [buildDeck(), buildDeck()].map(d => d.map(cardStr).join(','));
        expect(decks.every(d => d === ordered.join(','))).toBe(false);
    });
});
