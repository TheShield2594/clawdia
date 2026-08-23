'use strict';

// setTimeout stores its delay in a 32-bit signed integer. Anything larger does
// not fail — Node warns and substitutes 1 — so `/poll ... duration 30d` armed a
// 2.59e9 ms timer that fired on the next tick and closed the poll immediately.

jest.mock('../src/models/Poll', () => ({ findOne: jest.fn(), find: jest.fn(), create: jest.fn() }));
jest.mock('../src/utils/jobRunner', () => ({ runJob: jest.fn() }));

const { runJob } = require('../src/utils/jobRunner');
const { scheduleExpiry } = require('../src/services/pollService');

const MAX_TIMEOUT_MS = 2_147_483_647;
const msg = { id: 'msg1', guildId: 'g1', edit: jest.fn() };
const arm = endsAt => scheduleExpiry(msg, 'q', ['a', 'b'], endsAt, 'someone');

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('a poll that expires further out than a 32-bit timer reaches', () => {
    test('does not close on the next tick', () => {
        arm(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

        jest.advanceTimersByTime(1000);
        expect(runJob).not.toHaveBeenCalled();
    });

    test('waits in hops until the deadline is in reach, then closes', () => {
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        arm(new Date(Date.now() + THIRTY_DAYS));

        // One hop short of the deadline: still nothing.
        jest.advanceTimersByTime(MAX_TIMEOUT_MS);
        expect(runJob).not.toHaveBeenCalled();

        jest.advanceTimersByTime(THIRTY_DAYS - MAX_TIMEOUT_MS);
        expect(runJob).toHaveBeenCalledTimes(1);
        expect(runJob).toHaveBeenCalledWith('poll', 'closeExpiredPoll', expect.any(Function),
            expect.objectContaining({ scope: 'msg1' }));
    });

    test('an ordinary duration is still armed directly', () => {
        arm(new Date(Date.now() + 60_000));

        jest.advanceTimersByTime(59_000);
        expect(runJob).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1_000);
        expect(runJob).toHaveBeenCalledTimes(1);
    });

    test('a poll already past its end closes at once', () => {
        arm(new Date(Date.now() - 5_000));

        jest.advanceTimersByTime(0);
        expect(runJob).toHaveBeenCalledTimes(1);
    });
});
