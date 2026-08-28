'use strict';

// setTimeout stores its delay in a 32-bit signed integer. Anything larger does
// not fail — Node warns and substitutes 1 — so `/poll ... duration 30d` armed a
// 2.59e9 ms timer that fired on the next tick and closed the poll immediately.

jest.mock('../src/models/Poll', () => ({ findOne: jest.fn(), find: jest.fn(), create: jest.fn() }));
jest.mock('../src/utils/jobRunner', () => ({ runJob: jest.fn() }));

const Poll = require('../src/models/Poll');
const { runJob } = require('../src/utils/jobRunner');
const { scheduleExpiry, scheduleActivePollExpirations } = require('../src/services/pollService');

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

// ── Picking unclosed polls back up at boot ──────────────────────────────────
//
// `/poll` without a duration is stored open with `endsAt: null` — that is the
// feature, not a stalled poll. The startup sweep selected every unclosed poll
// and handed each to scheduleExpiry, where `endsAt.getTime()` threw
// "Cannot read properties of null (reading 'getTime')" once per no-expiry poll
// on every boot, and counted them in the pickup line as if a timer had been
// armed for them.
describe('scheduleActivePollExpirations', () => {
    function clientWith(msg) {
        const channel = { messages: { fetch: jest.fn(async () => msg) } };
        const guild = { channels: { cache: new Map([['c1', channel]]) } };
        return { guilds: { cache: new Map([['g1', guild]]) } };
    }

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('asks only for polls that actually carry a deadline', async () => {
        Poll.find.mockResolvedValue([]);

        await scheduleActivePollExpirations(clientWith(msg));

        expect(Poll.find).toHaveBeenCalledWith({ closed: false, endsAt: { $ne: null } });
    });

    test('arms a timer for an overdue poll without logging a failure', async () => {
        Poll.find.mockResolvedValue([{
            messageId: 'msg1', guildId: 'g1', channelId: 'c1',
            question: 'q', options: ['a', 'b'],
            endsAt: new Date(Date.now() - 5_000), createdBy: 'someone',
        }]);

        await scheduleActivePollExpirations(clientWith(msg));

        jest.advanceTimersByTime(0);
        expect(runJob).toHaveBeenCalledTimes(1);
        expect(console.error).not.toHaveBeenCalled();
    });
});
