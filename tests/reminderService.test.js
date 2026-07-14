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

function makeClient({ channel = undefined, channelFetchThrows = false, dmUser = undefined, dmSendThrows = false } = {}) {
    return {
        channels: {
            cache: { get: jest.fn().mockReturnValue(channel) },
            fetch: jest.fn().mockImplementation(async () => {
                if (channelFetchThrows || !channel) throw new Error('Unknown channel');
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

    test('marks completed (does not throw) when both channel and DM delivery fail', async () => {
        const reminder = makeReminder();
        Reminder.find.mockResolvedValue([reminder]);
        const client = makeClient({ channel: undefined, dmUser: undefined });

        await expect(checkReminders(client)).resolves.toBeUndefined();
        expect(reminder.completed).toBe(true);
        expect(reminder.save).toHaveBeenCalled();
    });
});

describe('checkReminders recurrence', () => {
    afterEach(() => jest.clearAllMocks());

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

    test('a transient save failure is retried via the catch path and does not stop later reminders', async () => {
        const failing = makeReminder({ _id: 'r1' });
        failing.save = jest.fn()
            .mockRejectedValueOnce(new Error('transient db error'))
            .mockResolvedValueOnce(undefined);
        const healthy = makeReminder({ _id: 'r2' });
        Reminder.find.mockResolvedValue([failing, healthy]);
        const channel = { send: jest.fn().mockResolvedValue(undefined) };
        const client = makeClient({ channel });

        await checkReminders(client);

        expect(failing.completed).toBe(true);
        expect(failing.save).toHaveBeenCalledTimes(2);
        expect(healthy.completed).toBe(true);
        expect(healthy.save).toHaveBeenCalled();
    });
});
