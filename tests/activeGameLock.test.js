const { tryAcquire, release } = require('../src/utils/activeGameLock');
const { luckySaveEligible, LUCKY_SAVE_MAX_BET } = require('../src/services/effectsService');

describe('activeGameLock', () => {
    test('acquires a free lock and returns a token', () => {
        const token = tryAcquire('test:1');
        expect(token).toBeTruthy();
        expect(release('test:1', token)).toBe(true);
    });

    test('rejects a second acquire while held', () => {
        const token = tryAcquire('test:2');
        expect(token).toBeTruthy();
        expect(tryAcquire('test:2')).toBeNull();
        release('test:2', token);
    });

    test('can re-acquire after release', () => {
        const token = tryAcquire('test:3');
        expect(release('test:3', token)).toBe(true);
        const token2 = tryAcquire('test:3');
        expect(token2).toBeTruthy();
        release('test:3', token2);
    });

    test('expired locks can be re-acquired (TTL backstop)', () => {
        expect(tryAcquire('test:4', -1)).toBeTruthy(); // already expired
        const token = tryAcquire('test:4');
        expect(token).toBeTruthy();
        release('test:4', token);
    });

    test('release is token-validated — a stale holder cannot free a new lease', () => {
        const tokenA = tryAcquire('test:5', -1); // expires immediately
        const tokenB = tryAcquire('test:5');     // new flow takes over after expiry
        expect(tokenB).toBeTruthy();
        expect(tokenB).not.toBe(tokenA);

        // The stale holder's release must be a no-op…
        expect(release('test:5', tokenA)).toBe(false);
        // …leaving the lock still held by the new lease
        expect(tryAcquire('test:5')).toBeNull();

        // The rightful owner can release it
        expect(release('test:5', tokenB)).toBe(true);
        const token = tryAcquire('test:5');
        expect(token).toBeTruthy();
        release('test:5', token);
    });

    test('release without a matching token is a no-op', () => {
        const token = tryAcquire('test:6');
        expect(release('test:6', 'bogus-token')).toBe(false);
        expect(tryAcquire('test:6')).toBeNull(); // still held
        expect(release('test:6', token)).toBe(true);
    });

    test('locks are independent per key', () => {
        const a = tryAcquire('test:7a');
        const b = tryAcquire('test:7b');
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
        release('test:7a', a);
        release('test:7b', b);
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
