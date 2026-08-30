'use strict';

/**
 * #783. `handleAutoModeration` is the only part of the bot that punishes real
 * users with no human in the loop, and every one of its nine filter bodies was
 * unexecuted — 37 of 154 statements, 45 of 146 branches. The block was only
 * ever *entered*, on the early-return path.
 *
 * Each filter has a configurable threshold and an `isModerator` bypass, and
 * neither was exercised for any of them. A false positive deletes a legitimate
 * message and files a case against its author; a false negative lets a raid
 * through. So each filter is driven three ways: a message that trips it, one
 * that sits just under, and one from a member with moderator permissions.
 */

jest.mock('../src/models/User',     () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/Guild',    () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/models/Case',     () => ({ findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/Reminder', () => ({ create: jest.fn() }));
jest.mock('../src/services/moderationLogService', () => ({ logModeration: jest.fn() }));
jest.mock('../src/services/aiService', () => ({ handleAIChat: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));

const User = require('../src/models/User');
const Case = require('../src/models/Case');
const { logModeration } = require('../src/services/moderationLogService');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { makeMessage, makeModerationSettings } = require('./helpers/messageCreateMessage');
const messageCreate = require('../src/events/messageCreate');

const run = message => messageCreate.execute(message, { user: { id: 'bot1' } });

/** A user document quiet enough that no ladder rung fires — the filters are what is under test. */
function calmUser() {
    return {
        userId: 'author1', guildId: 'guild1', behaviorScore: 0, lastScoreDecay: null,
        save: jest.fn(async () => {}),
    };
}

let quiet;

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // The handlers past auto-moderation are not mocked here and complain; this
    // file is about what auto-moderation does, not about what follows it.
    quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    User.findOne.mockResolvedValue(calmUser());
    Case.countDocuments.mockResolvedValue(0);
    Case.findOne.mockResolvedValue(null);
    logModeration.mockResolvedValue({ caseId: 7 });
});

afterEach(() => {
    // Each filter schedules its own warning for deletion five seconds out.
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    quiet.mockRestore();
});

// ---------------------------------------------------------------------------
// One row per filter: the setting that arms it, a message that trips it, and a
// message that sits just under the same threshold.
// ---------------------------------------------------------------------------

const REPEATED = 'aaaaaaaaaaaaaaaaaaaa spam';    // 20 a's, over the 12-char floor
const ZALGO    = 'h' + '́'.repeat(6);

const FILTERS = [
    {
        name:    'invite links',
        setting: { inviteFilter: true },
        trips:   'join us at discord.gg/raidserver',
        under:   'join us at example.com/raidserver',
        warning: /invite links are not allowed/,
        weight:  2,
        reason:  'posting an invite link',
    },
    {
        name:    'links',
        setting: { linkFilter: true },
        trips:   'look at https://example.com',
        under:   'look at example.com',
        warning: /links are not allowed/,
        weight:  1,
        reason:  'posting a link',
    },
    {
        name:    'repeated text',
        setting: { repeatedTextFilter: true },
        trips:   REPEATED,
        // Same character, one repeat short of the run the filter looks for.
        under:   'aaaaaaaa is fine here',
        warning: /repeated\/spammy text/,
        weight:  1,
        reason:  'repeated text spam',
    },
    {
        name:    'excessive caps',
        setting: { excessiveCapsFilter: true },
        trips:   'STOP SHOUTING AT EVERYONE',
        under:   'stop shouting at everyone',
        warning: /excessive caps/,
        weight:  1,
        reason:  'excessive caps',
    },
    {
        name:    'excessive emojis',
        setting: { excessiveEmojisFilter: true },
        trips:   '🎉'.repeat(8),
        under:   '🎉'.repeat(7),
        warning: /too many emojis/,
        weight:  1,
        reason:  'excessive emojis',
    },
    {
        name:    'zalgo',
        setting: { zalgoFilter: true },
        trips:   ZALGO,
        under:   'h' + '́'.repeat(5),
        warning: /zalgo\/combining text/,
        weight:  1,
        reason:  'zalgo text',
    },
    {
        name:    'excessive mentions',
        setting: { excessiveMentionsFilter: true },
        trips:   { content: 'hey', mentionedUsers: 5 },
        under:   { content: 'hey', mentionedUsers: 4 },
        warning: /too many mentions/,
        weight:  1,
        reason:  'excessive mentions',
    },
    {
        name:    'profanity',
        setting: { profanityFilter: true, customBadWords: ['flibbertigibbet'] },
        trips:   'you absolute flibbertigibbet',
        under:   'you absolute delight',
        warning: /watch your language/,
        weight:  2,
        reason:  'using prohibited language',
    },
];

describe.each(FILTERS)('$name filter', ({ setting, trips, under, warning, weight, reason }) => {
    test('deletes a message that trips it and warns the author', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings(setting));
        const msg = makeMessage(trips);

        await run(msg);

        expect(msg.delete).toHaveBeenCalledTimes(1);
        expect(msg.channel.sent[0]).toMatch(warning);
        expect(msg.channel.sent[0]).toContain('<@author1>');
    });

    test('leaves a message that sits just under the threshold alone', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings(setting));
        const msg = makeMessage(under);

        await run(msg);

        expect(msg.delete).not.toHaveBeenCalled();
        expect(msg.channel.sent).toEqual([]);
        expect(logModeration).not.toHaveBeenCalled();
    });

    test('exempts a member with ManageMessages', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings(setting));
        const msg = makeMessage(trips, { isModerator: true });

        await run(msg);

        expect(msg.delete).not.toHaveBeenCalled();
    });

    test('exempts a member holding an immunity role', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings({ ...setting, immunityRoleIds: ['trusted'] }));
        const msg = makeMessage(trips, { roleIds: ['trusted'] });

        await run(msg);

        expect(msg.delete).not.toHaveBeenCalled();
    });

    test('does nothing when the filter itself is off', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings({}));
        const msg = makeMessage(trips);

        await run(msg);

        expect(msg.delete).not.toHaveBeenCalled();
    });

    test('files the offence at its own weight', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings(setting));
        const doc = calmUser();
        User.findOne.mockResolvedValue(doc);

        await run(makeMessage(trips));

        // Weights are what make an invite or a slur count for more than a
        // stray link; a filter that files everything at 1 flattens the ladder.
        expect(doc.behaviorScore).toBe(weight);
        expect(logModeration).toHaveBeenCalledWith(
            'guild1', 'warn', expect.anything(), expect.anything(),
            `[AutoMod] ${reason}`, expect.objectContaining({ evidence: expect.anything() }),
        );
    });
});

// ---------------------------------------------------------------------------
// The spam window is stateful, so it does not fit the table above.
// ---------------------------------------------------------------------------

describe('spam window filter', () => {
    const spamSettings = (over = {}) => makeModerationSettings({ spamProtection: true, spamThreshold: 3, spamWindow: 5, ...over });

    // The tracker is module state keyed on (guild, user) and fake timers freeze
    // the clock, so each test gets its own author rather than inheriting the
    // previous one's timestamps.
    const burst = who => makeMessage({ content: 'hi', userId: who });

    test('lets a burst under the threshold through', async () => {
        getGuildSettings.mockResolvedValue(spamSettings());
        const sent = [burst('under'), burst('under')];

        for (const m of sent) await run(m);

        expect(sent.every(m => m.delete.mock.calls.length === 0)).toBe(true);
    });

    test('trips on the message that reaches the threshold', async () => {
        getGuildSettings.mockResolvedValue(spamSettings());
        const sent = [burst('trips'), burst('trips'), burst('trips')];

        for (const m of sent) await run(m);

        expect(sent[2].delete).toHaveBeenCalledTimes(1);
        expect(sent[2].channel.sent[0]).toMatch(/slow down/);
        // Only the message that tripped it is deleted; the two before it stand.
        expect(sent[0].delete).not.toHaveBeenCalled();
    });

    test('forgets timestamps that fall out of the window', async () => {
        getGuildSettings.mockResolvedValue(spamSettings());
        await run(burst('window'));
        await run(burst('window'));

        jest.advanceTimersByTime(6_000);   // window is 5s
        const late = burst('window');
        await run(late);

        // Without the window filter this third message is the third in the
        // tracker and trips — which is the false positive on a slow chatter.
        expect(late.delete).not.toHaveBeenCalled();
    });

    test('resets the window after it fires, so the next message is not also deleted', async () => {
        getGuildSettings.mockResolvedValue(spamSettings());
        for (let i = 0; i < 3; i++) await run(burst('reset'));

        const next = burst('reset');
        await run(next);

        expect(next.delete).not.toHaveBeenCalled();
    });

    test('clamps an out-of-range window to the floor rather than reading it as unset', async () => {
        // 0 is not a window the dashboard can produce, but nothing validates
        // this field on the way into the database. It means "as short as
        // allowed" — one second — not "use the five-second default", which is
        // what a falsy fallback would have made of it.
        getGuildSettings.mockResolvedValue(spamSettings({ spamWindow: 0 }));
        await run(burst('zerowindow'));
        await run(burst('zerowindow'));

        jest.advanceTimersByTime(1_500);
        const late = burst('zerowindow');
        await run(late);

        expect(late.delete).not.toHaveBeenCalled();
    });

    test('honours a configured threshold rather than the default of five', async () => {
        getGuildSettings.mockResolvedValue(spamSettings({ spamThreshold: 2 }));
        const sent = [makeMessage({ content: 'hi', userId: 'fast' }), makeMessage({ content: 'hi', userId: 'fast' })];

        for (const m of sent) await run(m);

        expect(sent[1].delete).toHaveBeenCalledTimes(1);
    });

    test('exempts a moderator, however fast they type', async () => {
        getGuildSettings.mockResolvedValue(spamSettings());
        const sent = Array.from({ length: 5 }, () => makeMessage({ content: 'hi', userId: 'modspam', isModerator: true }));

        for (const m of sent) await run(m);

        expect(sent.every(m => m.delete.mock.calls.length === 0)).toBe(true);
    });

    test('tracks each user separately', async () => {
        getGuildSettings.mockResolvedValue(spamSettings());
        for (const userId of ['a', 'b', 'c']) {
            await run(makeMessage({ content: 'hi', userId }));
        }
        const fourth = makeMessage({ content: 'hi', userId: 'd' });

        await run(fourth);

        // Three messages in the window, but one each — a shared counter here
        // would punish a busy channel rather than a spammer.
        expect(fourth.delete).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------

describe('the gate in front of all of them', () => {
    test('an armed filter does nothing while autoModEnabled is off', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings({ autoModEnabled: false, linkFilter: true }));
        const msg = makeMessage('https://example.com');

        await run(msg);

        expect(msg.delete).not.toHaveBeenCalled();
    });

    test('the first matching filter wins, and the rest are not evaluated', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings({ inviteFilter: true, linkFilter: true }));
        const msg = makeMessage('https://discord.gg/raidserver');

        await run(msg);

        // Both match. Falling through would delete once and file two cases.
        expect(msg.delete).toHaveBeenCalledTimes(1);
        expect(logModeration).toHaveBeenCalledTimes(1);
        expect(logModeration.mock.calls[0][4]).toBe('[AutoMod] posting an invite link');
    });

    test('a delete the bot is not allowed to make does not stop the case being filed', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings({ linkFilter: true }));
        const msg = makeMessage('https://example.com');
        msg.delete.mockRejectedValue(new Error('Missing Permissions'));

        await run(msg);

        expect(logModeration).toHaveBeenCalledTimes(1);
    });

    test('records the offending message as evidence before deleting it', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings({ linkFilter: true }));
        const msg = makeMessage({ content: 'https://example.com', attachmentUrls: ['https://cdn/1.png'] });

        await run(msg);

        // The message is gone by the time a moderator reviews the case, so the
        // case is the only remaining record of what was actually said.
        const { evidence } = logModeration.mock.calls[0][5];
        expect(evidence).toEqual({
            messageId: 'msg1',
            jumpUrl: msg.url,
            content: 'https://example.com',
            attachmentUrls: ['https://cdn/1.png'],
        });
    });

    test('truncates very long evidence rather than storing the whole message', async () => {
        getGuildSettings.mockResolvedValue(makeModerationSettings({ linkFilter: true }));

        await run(makeMessage('https://example.com/' + 'x'.repeat(3_000)));

        expect(logModeration.mock.calls[0][5].evidence.content).toHaveLength(500);
    });
});
