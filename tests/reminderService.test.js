'use strict';

jest.mock('../src/models/Reminder', () => ({ find: jest.fn() }));

const Reminder = require('../src/models/Reminder');
const { checkReminders } = require('../src/services/reminderService');

function makeReminder(overrides = {}) {
    return {
        _id: 'r1',
        userId: 'user1',
        channelId: 'chan1',
        message: 'Do the thing',
        remindAt: new Date('2026-07-14T12:00:00Z'),
        completed: false,
        repeatInterval: null,
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

function makeClient({ channel = undefined, dmUser = undefined } = {}) {
    return {
        channels: {
            cache: { get: jest.fn().mockReturnValue(channel) },
            fetch: jest.fn().mockImplementation(async () => {
                if (!channel) throw new Error('Unknown channel');
                return channel;
            })
        },
        users: {
            fetch: jest.fn().mockImplementation(async () => {
                if (!dmUser) throw new Error('Unknown user');
                return dmUser;
            })
        }
    };
}

describe('checkReminders delivery', () => {
    afterEach(() => jest.clearAllMocks());

    test('sends to the channel when it is cached and reachable', async () => {
        const reminder = makeReminder();
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('Do the thing'));
        expect(reminder.completed).toBe(true);
        expect(reminder.save).toHaveBeenCalled();
    });

    test('falls back to DMing the user when the channel is missing', async () => {
        const reminder = makeReminder();
        Reminder.find.mockResolvedValue([reminder]);
        const dmSend = jest.fn().mockResolvedValue(undefined);
        const client = makeClient({ channel: undefined, dmUser: { send: dmSend } });

        await checkReminders(client);

        expect(dmSend).toHaveBeenCalledWith(expect.stringContaining('Do the thing'));
        expect(reminder.completed).toBe(true);
    });

    test('falls back to DMing the user when the channel send throws', async () => {
        const reminder = makeReminder();
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockRejectedValue(new Error('Missing Access')) };
        const dmSend = jest.fn().mockResolvedValue(undefined);
        const client = makeClient({ channel, dmUser: { send: dmSend } });

        await checkReminders(client);

        expect(channel.send).toHaveBeenCalled();
        expect(dmSend).toHaveBeenCalledWith(expect.stringContaining('Do the thing'));
        expect(reminder.completed).toBe(true);
    });

    test('a failed delivery leaves the reminder due and counts the attempt (#817)', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const reminder = makeReminder();
        Reminder.find.mockResolvedValue([reminder]);
        const client = makeClient({ channel: undefined, dmUser: undefined });

        await expect(checkReminders(client)).resolves.toBeUndefined();

        // Not lost: still open, still due, picked up again next tick.
        expect(reminder.completed).toBe(false);
        expect(reminder.deliveryAttempts).toBe(1);
        expect(reminder.save).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    test('a delivery that succeeds after failures resets the attempt counter', async () => {
        const reminder = makeReminder({ deliveryAttempts: 3 });
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(reminder.completed).toBe(true);
        expect(reminder.deliveryAttempts).toBe(0);
    });

    test('a destination that stays dead is given up on after the attempt cap', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const reminder = makeReminder({ deliveryAttempts: 4 });
        Reminder.find.mockResolvedValue([reminder]);
        const client = makeClient({ channel: undefined, dmUser: undefined });

        await checkReminders(client);

        // Fifth consecutive failure: completed so it stops retrying forever,
        // and the loss is logged rather than silent.
        expect(reminder.completed).toBe(true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Giving up on reminder'));
        consoleSpy.mockRestore();
    });
});

describe('checkReminders recurrence', () => {
    // Rescheduling is measured against "now": missed occurrences are skipped,
    // so these tests pin the clock just past each reminder's due time to see
    // the ordinary single-interval advance.
    beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-07-14T12:00:30Z')));
    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    test('one-time reminders are marked completed, not rescheduled', async () => {
        const reminder = makeReminder({ repeatInterval: null });
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(reminder.completed).toBe(true);
    });

    test('daily reminders reschedule remindAt by 24h and stay open', async () => {
        const originalTime = new Date('2026-07-14T12:00:00Z').getTime();
        const reminder = makeReminder({ repeatInterval: 'daily' });
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(reminder.completed).toBe(false);
        expect(reminder.remindAt.getTime()).toBe(originalTime + 24 * 60 * 60 * 1000);
        expect(reminder.save).toHaveBeenCalled();
    });

    test('weekly reminders reschedule remindAt by 7 days and stay open', async () => {
        const originalTime = new Date('2026-07-14T12:00:00Z').getTime();
        const reminder = makeReminder({ repeatInterval: 'weekly' });
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(reminder.completed).toBe(false);
        expect(reminder.remindAt.getTime()).toBe(originalTime + 7 * 24 * 60 * 60 * 1000);
    });

    test('daily reminders preserve local wall-clock time across a DST transition', async () => {
        jest.setSystemTime(new Date('2026-03-07T14:00:30Z'));
        // 9am EST on 2026-03-07 — the day before America/New_York springs forward.
        const reminder = makeReminder({
            repeatInterval: 'daily',
            timezone: 'America/New_York',
            remindAt: new Date('2026-03-07T14:00:00.000Z')
        });
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        // Naive +24h would land at 14:00Z (10am EDT); the correct next occurrence
        // is still 9am local, which is 13:00Z once EDT (UTC-4) is in effect.
        expect(reminder.remindAt.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    });

    test('recurring reminders with no stored timezone fall back to UTC', async () => {
        const originalTime = new Date('2026-07-14T12:00:00Z').getTime();
        const reminder = makeReminder({ repeatInterval: 'daily', timezone: null });
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(reminder.remindAt.getTime()).toBe(originalTime + 24 * 60 * 60 * 1000);
    });

    test('a daily reminder several days behind skips to the next future occurrence (#817)', async () => {
        // Three missed days of downtime: one delivery now, then straight to
        // tomorrow — not three catch-up deliveries on consecutive ticks.
        const reminder = makeReminder({
            repeatInterval: 'daily',
            remindAt: new Date('2026-07-11T12:00:00Z')
        });
        Reminder.find.mockResolvedValue([reminder]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(reminder.completed).toBe(false);
        expect(reminder.remindAt.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    });
});

describe('checkReminders query', () => {
    afterEach(() => jest.clearAllMocks());

    test('queries only due, incomplete reminders', async () => {
        Reminder.find.mockResolvedValue([]);
        const client = makeClient({});

        await checkReminders(client);

        expect(Reminder.find).toHaveBeenCalledWith(expect.objectContaining({
            remindAt: expect.objectContaining({ $lte: expect.any(Date) }),
            completed: false
        }));
    });

    test('a save failure is logged (not retried) and does not stop later reminders', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const failing = makeReminder({ _id: 'r1' });
        failing.save = jest.fn().mockRejectedValue(new Error('db down'));
        const healthy = makeReminder({ _id: 'r2' });
        Reminder.find.mockResolvedValue([failing, healthy]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(failing.save).toHaveBeenCalledTimes(1);
        expect(consoleSpy).toHaveBeenCalledWith('Error processing reminder:', expect.any(Error));
        expect(healthy.completed).toBe(true);
        expect(healthy.save).toHaveBeenCalled();

        consoleSpy.mockRestore();
    });
});
