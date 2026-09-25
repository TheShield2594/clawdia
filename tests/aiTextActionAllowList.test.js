'use strict';

// A trailing ACTION block can be prompt-injected (an MCP tool result, a quoted
// message), and the text route has no approval prompt. schedule_task — which
// the tool route only runs after an admin approves it — must never run from
// here (#1148).

const mockScheduleCreate = jest.fn();
jest.mock('../src/services/scheduledTaskService', () => ({
    createTask: (...args) => mockScheduleCreate(...args),
    HANDLERS: { prompt: () => {} }
}));
jest.mock('../src/models/Reminder', () => ({
    countDocuments: jest.fn(async () => 0),
    create: jest.fn(async () => ({}))
}));

const { executeAction, TEXT_PROTOCOL_ACTIONS } = require('../src/services/ai/actions');

function fakeMessage() {
    return {
        author: { id: 'u1' },
        guild: { id: 'g1', channels: { cache: { get: jest.fn() } } },
        channel: { id: 'c1', send: jest.fn(async payload => payload) },
        member: { permissions: { has: jest.fn(() => true) } }
    };
}

describe('text-protocol action allow-list', () => {
    test('schedule_task is not executable from an ACTION block', async () => {
        expect(TEXT_PROTOCOL_ACTIONS.has('schedule_task')).toBe(false);

        const message = fakeMessage();
        await executeAction(
            { type: 'schedule_task', prompt: 'post every day', delayMinutes: 60, repeat: 'daily' },
            message
        );

        expect(mockScheduleCreate).not.toHaveBeenCalled();
        expect(message.channel.send).toHaveBeenCalledTimes(1);
        const [payload] = message.channel.send.mock.calls[0];
        expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    test('the documented text actions stay allowed', () => {
        for (const type of ['create_poll', 'create_reminder', 'suggest_mod_action']) {
            expect(TEXT_PROTOCOL_ACTIONS.has(type)).toBe(true);
        }
    });
});
