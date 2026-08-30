'use strict';

/**
 * The bounded limiter is what four different subsystems lean on to keep a
 * per-user map from growing for the life of the process, and until #600 it had
 * no test of its own — it was only ever exercised through whatever was using
 * it. These cover the cap, the sweep, and the counting half of the API the spam
 * window needs (`hit`/`reset`), where an off-by-one is a real user being
 * punished a message early or a message late.
 */

const { BoundedRateLimiter } = require('../src/utils/boundedRateLimiter');

describe('check', () => {
    test('allows up to the limit inside the window, then refuses', () => {
        const limiter = new BoundedRateLimiter();

        expect(limiter.check('a', 1000, 2)).toBe(true);
        expect(limiter.check('a', 1000, 2)).toBe(true);
        expect(limiter.check('a', 1000, 2)).toBe(false);
    });

    test('a refusal is not recorded, so the window still holds exactly `limit`', () => {
        const limiter = new BoundedRateLimiter();
        for (let i = 0; i < 5; i++) limiter.check('a', 60_000, 2);

        // Two recorded, three refused. Were refusals recorded, the key would
        // stay over the limit for a whole window after the caller stopped.
        expect(limiter.peek('a', 60_000, 3)).toBe(true);
    });

    test('keys age out of the window', () => {
        jest.useFakeTimers();
        try {
            const limiter = new BoundedRateLimiter();
            expect(limiter.check('a', 1000, 1)).toBe(true);
            expect(limiter.check('a', 1000, 1)).toBe(false);

            jest.advanceTimersByTime(1100);

            expect(limiter.check('a', 1000, 1)).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('the cap', () => {
    test('never holds more than maxSize keys', () => {
        const limiter = new BoundedRateLimiter(3);
        for (let i = 0; i < 50; i++) limiter.check(`key${i}`, 60_000, 5);

        expect(limiter.size).toBe(3);
    });

    test('evicts the oldest key first, so the newest arrivals survive', () => {
        const limiter = new BoundedRateLimiter(2);
        limiter.check('first', 60_000, 1);
        limiter.check('second', 60_000, 1);
        limiter.check('third', 60_000, 1);

        // 'first' was dropped to make room, so its budget is forgiven — the
        // documented failure mode under key-flooding is a briefly more
        // permissive limit, never unbounded memory.
        expect(limiter.check('first', 60_000, 1)).toBe(true);
        expect(limiter.check('third', 60_000, 1)).toBe(false);
    });

    test('hit obeys the same cap', () => {
        const limiter = new BoundedRateLimiter(3);
        for (let i = 0; i < 50; i++) limiter.hit(`key${i}`, 60_000);

        expect(limiter.size).toBe(3);
    });
});

describe('cleanup', () => {
    test('drops keys whose timestamps have all aged out, and keeps the rest', () => {
        jest.useFakeTimers();
        try {
            const limiter = new BoundedRateLimiter();
            limiter.check('stale', 60_000, 5);

            jest.advanceTimersByTime(61_000);
            limiter.check('fresh', 60_000, 5);
            limiter.cleanup(60_000);

            expect(limiter.size).toBe(1);
            expect(limiter.peek('fresh', 60_000, 1)).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('expires a timestamp that is exactly one window old', () => {
        jest.useFakeTimers();
        try {
            const limiter = new BoundedRateLimiter();
            limiter.hit('a', 60_000);

            jest.advanceTimersByTime(60_000);

            // `check` and `hit` keep a timestamp only while `now - t <
            // windowMs`, so at exactly `windowMs` it has already aged out for
            // them. The sweep agrees on the same tick rather than holding the
            // key for one more round.
            expect(limiter.hit('a', 60_000)).toBe(1);
            limiter.reset('a');

            limiter.hit('a', 60_000);
            jest.advanceTimersByTime(60_000);
            limiter.cleanup(60_000);

            expect(limiter.size).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('hit', () => {
    test('counts the hit it just recorded', () => {
        const limiter = new BoundedRateLimiter();

        expect(limiter.hit('a', 60_000)).toBe(1);
        expect(limiter.hit('a', 60_000)).toBe(2);
        expect(limiter.hit('a', 60_000)).toBe(3);
    });

    test('counts only what is inside the window', () => {
        jest.useFakeTimers();
        try {
            const limiter = new BoundedRateLimiter();
            limiter.hit('a', 5_000);
            limiter.hit('a', 5_000);

            jest.advanceTimersByTime(6_000);

            // The two before the gap are outside the window now — this is the
            // slow chatter who must not be read as a burst.
            expect(limiter.hit('a', 5_000)).toBe(1);
        } finally {
            jest.useRealTimers();
        }
    });

    test('keys are independent', () => {
        const limiter = new BoundedRateLimiter();
        limiter.hit('a', 60_000);
        limiter.hit('a', 60_000);

        expect(limiter.hit('b', 60_000)).toBe(1);
    });
});

describe('reset', () => {
    test('forgets the key, so the next hit counts as the first', () => {
        const limiter = new BoundedRateLimiter();
        limiter.hit('a', 60_000);
        limiter.hit('a', 60_000);

        limiter.reset('a');

        expect(limiter.hit('a', 60_000)).toBe(1);
        expect(limiter.size).toBe(1);
    });

    test('resetting a key that was never seen is not an error', () => {
        const limiter = new BoundedRateLimiter();

        expect(() => limiter.reset('nobody')).not.toThrow();
        expect(limiter.size).toBe(0);
    });

    test('forgives a check budget too', () => {
        const limiter = new BoundedRateLimiter();
        limiter.check('a', 60_000, 1);
        expect(limiter.check('a', 60_000, 1)).toBe(false);

        limiter.reset('a');

        expect(limiter.check('a', 60_000, 1)).toBe(true);
    });
});
