/**
 * #785. blackjack.js measured 29.3% lines / 21.3% branches — #623 covered the
 * opening debit, and everything after it sat behind a button collector: the
 * soft-ace demotion, the dealer drawing to 17, and which of win/push/lose a
 * finished hand is.
 *
 * It is src/games/casino/blackjackHands.js now, over fixed hands and a fixed
 * deck.
 */
const {
    buildDeck,
    cardValue,
    handTotal,
    canDoubleDown,
    canSplitHand,
    playDealerHand,
    settleHand,
    isNaturalBlackjack,
} = require('../src/games/casino/blackjackHands');

/** 'A♠ K♥' -> two card objects. */
const hand = notation => notation.split(' ').map(t => ({
    value: t.slice(0, -1),
    suit: t.slice(-1),
}));

describe('card values', () => {
    it('counts every face card as ten', () => {
        for (const face of ['J', 'Q', 'K']) {
            expect([face, cardValue({ value: face, suit: '♠' })]).toEqual([face, 10]);
        }
    });

    it('counts an ace as eleven before any demotion', () => {
        expect(cardValue({ value: 'A', suit: '♠' })).toBe(11);
    });

    it('counts a pip card as its number', () => {
        expect(cardValue({ value: '7', suit: '♦' })).toBe(7);
        expect(cardValue({ value: '10', suit: '♦' })).toBe(10);
    });
});

describe('handTotal demotes an ace only when it has to', () => {
    it('keeps the ace at eleven in a soft hand', () => {
        expect(handTotal(hand('A♠ 6♥'))).toBe(17);
    });

    it('drops it to one when eleven would bust', () => {
        expect(handTotal(hand('A♠ 6♥ K♦'))).toBe(17);
    });

    it('drops one ace and keeps the other', () => {
        // 11 + 11 = 22 busts; one demotion gets to 12, and no more is needed.
        expect(handTotal(hand('A♠ A♥'))).toBe(12);
    });

    it('drops as many as it takes', () => {
        expect(handTotal(hand('A♠ A♥ A♦ A♣ 9♠'))).toBe(13);
    });

    it('still reports a bust when demotion cannot save the hand', () => {
        expect(handTotal(hand('K♠ Q♥ 5♦'))).toBe(25);
    });

    it('reads blackjack as 21', () => {
        expect(handTotal(hand('A♠ K♥'))).toBe(21);
    });
});

describe('what the buttons are allowed to offer', () => {
    it('offers double down on a two-card 9, 10 or 11', () => {
        expect(canDoubleDown(hand('4♠ 5♥'))).toBe(true);
        expect(canDoubleDown(hand('4♠ 6♥'))).toBe(true);
        expect(canDoubleDown(hand('5♠ 6♥'))).toBe(true);
    });

    it('withholds it on any other two-card total', () => {
        expect(canDoubleDown(hand('4♠ 4♥'))).toBe(false);
        expect(canDoubleDown(hand('K♠ 2♥'))).toBe(false);
    });

    it('withholds it once the hand has three cards, whatever the total', () => {
        expect(handTotal(hand('2♠ 4♥ 5♦'))).toBe(11);
        expect(canDoubleDown(hand('2♠ 4♥ 5♦'))).toBe(false);
    });

    it('offers a split on two cards of equal value', () => {
        expect(canSplitHand(hand('8♠ 8♥'))).toBe(true);
        // K and Q are not the same rank, but they are the same value, which is
        // the rule the game plays.
        expect(canSplitHand(hand('K♠ Q♥'))).toBe(true);
    });

    it('withholds a split on unequal cards or a longer hand', () => {
        expect(canSplitHand(hand('8♠ 9♥'))).toBe(false);
        expect(canSplitHand(hand('8♠ 8♥ 8♦'))).toBe(false);
    });
});

describe('the dealer loop', () => {
    // pop() takes from the end, so the cards arrive in reverse of this list.
    const deckOf = notation => hand(notation).reverse();

    it('stands on a hard 17', () => {
        const dealer = hand('K♠ 7♥');
        const deck = deckOf('5♦');
        expect(playDealerHand(dealer, deck)).toBe(17);
        expect(dealer).toHaveLength(2);
        expect(deck).toHaveLength(1);
    });

    it('stands on a soft 17, because the ace has already been demoted', () => {
        // A + 6 reads 17, so the dealer does not hit it.
        const dealer = hand('A♠ 6♥');
        expect(playDealerHand(dealer, deckOf('5♦'))).toBe(17);
        expect(dealer).toHaveLength(2);
    });

    it('draws until it reaches 17', () => {
        const dealer = hand('5♠ 6♥');
        const deck = deckOf('2♦ 4♣');   // 11 -> 13 -> 17
        expect(playDealerHand(dealer, deck)).toBe(17);
        expect(dealer).toHaveLength(4);
        expect(deck).toHaveLength(0);
    });

    it('busts when the draw takes it past 21, and stops there', () => {
        const dealer = hand('K♠ 6♥');
        const deck = deckOf('9♦ 3♣');   // 16 -> 25, and no second draw
        expect(playDealerHand(dealer, deck)).toBe(25);
        expect(dealer).toHaveLength(3);
        expect(deck).toHaveLength(1);
    });

    it('does not draw at all on a pat 20', () => {
        const deck = deckOf('2♦');
        expect(playDealerHand(hand('K♠ Q♥'), deck)).toBe(20);
        expect(deck).toHaveLength(1);
    });

    it('shows the drawn cards in the hand it was given', () => {
        // The message renders the dealer's cards from this array, so the draw
        // has to land in it rather than in a copy.
        const dealer = hand('5♠ 6♥');
        playDealerHand(dealer, deckOf('9♦'));
        expect(dealer.map(c => `${c.value}${c.suit}`)).toEqual(['5♠', '6♥', '9♦']);
    });
});

describe('settleHand', () => {
    it('calls a player bust a bust, even when the dealer busts too', () => {
        expect(settleHand(22, 25)).toBe('bust');
        expect(settleHand(22, 18)).toBe('bust');
    });

    it('pays a standing player when the dealer busts', () => {
        expect(settleHand(15, 22)).toBe('win');
    });

    it('pays the higher total', () => {
        expect(settleHand(20, 19)).toBe('win');
        expect(settleHand(19, 20)).toBe('lose');
    });

    it('pushes an equal total', () => {
        expect(settleHand(18, 18)).toBe('push');
        expect(settleHand(21, 21)).toBe('push');
    });
});

describe('isNaturalBlackjack', () => {
    it('is a two-card 21', () => {
        expect(isNaturalBlackjack(hand('A♠ K♥'))).toBe(true);
    });

    it('is not a 21 that took three cards', () => {
        expect(handTotal(hand('7♠ 7♥ 7♦'))).toBe(21);
        expect(isNaturalBlackjack(hand('7♠ 7♥ 7♦'))).toBe(false);
    });

    it('is not a two-card 20', () => {
        expect(isNaturalBlackjack(hand('K♠ Q♥'))).toBe(false);
    });
});

describe('the deck', () => {
    it('is 52 distinct cards', () => {
        const deck = buildDeck();
        expect(deck).toHaveLength(52);
        expect(new Set(deck.map(c => `${c.value}${c.suit}`)).size).toBe(52);
    });

    it('shuffles through the rng it is handed', () => {
        const spy = jest.spyOn(Math, 'random');
        try {
            const a = buildDeck(() => 0.25).map(c => `${c.value}${c.suit}`);
            const b = buildDeck(() => 0.25).map(c => `${c.value}${c.suit}`);
            expect(a).toEqual(b);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
