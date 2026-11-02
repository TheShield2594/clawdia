'use strict';

// The dashboard's chat-event controls (Economy → Games) are written through the
// generic settings endpoint; these hold the validator in front of them.

jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (_req, _res, next) => next(),
    checkGuildAccess: (_req, _res, next) => next(),
    requireGuildPermission: () => (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));

const { validateChatEventUpdate, isAllowedSettingKey } = require('../src/dashboard/routes/api/settings');

const CHANNEL = '123456789012345678';

describe('validateChatEventUpdate', () => {
    test('accepts what the panel sends', () => {
        expect(validateChatEventUpdate({
            'economy.chatEventsEnabled': true,
            'economy.chatEventAirdropsEnabled': false,
            'economy.chatEventCratesEnabled': true,
            'economy.chatEventTriviaEnabled': true,
            'economy.chatEventFrequency': 'high',
            'economy.chatEventChannelId': CHANNEL,
            'economy.chatEventExcludedChannelIds': [CHANNEL],
        })).toBeNull();
        expect(validateChatEventUpdate({ 'economy.chatEventChannelId': null })).toBeNull();
    });

    test('every key is one the settings endpoint allows', () => {
        for (const key of ['economy.chatEventFrequency', 'economy.chatEventChannelId', 'economy.chatEventExcludedChannelIds']) {
            expect(isAllowedSettingKey(key)).toBe(true);
        }
    });

    test.each([
        [{ 'economy.chatEventFrequency': 'ludicrous' }, /chatEventFrequency/],
        [{ 'economy.chatEventsEnabled': 'yes' }, /true or false/],
        [{ 'economy.chatEventChannelId': 'general' }, /snowflake/],
        [{ 'economy.chatEventExcludedChannelIds': 'general' }, /array/],
        [{ 'economy.chatEventExcludedChannelIds': ['general'] }, /channel ids/],
        [{ 'economy.chatEventExcludedChannelIds': Array(101).fill(CHANNEL) }, /at most 100/],
        [{ economy: { chatEventFrequency: 'turbo' } }, /chatEventFrequency/],
    ])('rejects %j', (patch, message) => {
        expect(validateChatEventUpdate(patch)).toMatch(message);
    });

    test('ignores unrelated economy fields', () => {
        expect(validateChatEventUpdate({ 'economy.dailyAmount': 'whatever' })).toBeNull();
    });
});
