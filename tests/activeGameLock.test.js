const { tryAcquire, release } = require('../src/utils/activeGameLock');
const { luckySaveEligible, LUCKY_SAVE_MAX_BET } = require('../src/services/effectsService');

describe('activeGameLock', () => {
    test('acquires a free lock', () => {
        expect(tryAcquire('test:1')).toBe(true);
        release('test:1');
    });

    test('rejects a second acquire while held', () => {
        expect(tryAcquire('test:2')).toBe(true);
        expect(tryAcquire('test:2')).toBe(false);
        release('test:2');
    });

    test('can re-acquire after release', () => {
        expect(tryAcquire('test:3')).toBe(true);
        release('test:3');
        expect(tryAcquire('test:3')).toBe(true);
        release('test:3');
    });

    test('expired locks can be re-acquired (TTL backstop)', () => {
        expect(tryAcquire('test:4', -1)).toBe(true); // already expired
        expect(tryAcquire('test:4')).toBe(true);
        release('test:4');
    });

    test('locks are independent per key', () => {
        expect(tryAcquire('test:5a')).toBe(true);
        expect(tryAcquire('test:5b')).toBe(true);
        release('test:5a');
        release('test:5b');
    });
});

describe('luckySaveEligible', () => {
    test('allows low-stakes bets', () => {
        expect(luckySaveEligible(10)).toBe(true);
        expect(luckySaveEligible(LUCKY_SAVE_MAX_BET)).toBe(true);
    });

    test('blocks bets above the cap', () => {
        expect(luckySaveEligible(LUCKY_SAVE_MAX_BET + 1)).toBe(false);
        expect(luckySaveEligible(1_000_000_000)).toBe(false);
    });
});
