'use strict';

/**
 * #783. `applyAutoModAction` is the ladder that turns an accumulated behaviour
 * score into warn / timeout / kick / ban, and it was uncovered from `:563`
 * onward. Nothing proved the ladder picks the right action for a given score,
 * that the score decays the way the setting says, or that the warning-count
 * fallback underneath it fires when the score band does not.
 *
 * This is the part of the bot that bans people without a human in the loop, so
 * every band is driven at its boundary — one under, exactly on, and over.
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

const DAY = 86_400_000;

/** A link, so exactly one filter fires and it is worth exactly one point. */
const offend = (over = {}) => makeMessage({ content: 'https://example.com', ...over });

/** Auto-moderation with the link filter armed and the ladder thresholds under test. */
const ladder = (over = {}) => makeModerationSettings({ linkFilter: true, ...over });

function userDoc(over = {}) {
    const doc = { userId: 'author1', guildId: 'guild1', behaviorScore: 0, lastScoreDecay: null, ...over };
    doc.save = jest.fn(async () => {});
    return doc;
}

/** Runs one offence against a starting score and reports what the member was subjected to. */
async function offence({ score = 0, settings = {}, member = {}, warnCount = 0 } = {}) {
    const doc = userDoc({ behaviorScore: score });
    User.findOne.mockResolvedValue(doc);
    Case.countDocuments.mockResolvedValue(warnCount);
    getGuildSettings.mockResolvedValue(ladder(settings));

    const msg = offend({ bannable: true, kickable: true, moderatable: true, ...member });
    await run(msg);

    const actions = logModeration.mock.calls.map(c => c[1]);
    return {
        doc, msg,
        banned:    msg.member.ban.mock.calls,
        kicked:    msg.member.kick.mock.calls,
        timedOut:  msg.member.timeout.mock.calls,
        dms:       msg.author.send.mock.calls.map(c => c[0]),
        // The `warn` entry is the offence itself; anything after it is the ladder.
        escalation: actions.slice(1),
    };
}

let quiet;

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    Case.findOne.mockResolvedValue(null);
    logModeration.mockResolvedValue({ caseId: 7 });
    User.create.mockImplementation(async doc => userDoc(doc));
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    quiet.mockRestore();
});

describe('the behaviour score', () => {
    test('every offence adds its weight and is persisted', async () => {
        const { doc } = await offence({ score: 4 });

        expect(doc.behaviorScore).toBe(5);
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    test('a first-time offender gets a document rather than being skipped', async () => {
        User.findOne.mockResolvedValue(null);
        getGuildSettings.mockResolvedValue(ladder());

        await run(offend());

        expect(User.create).toHaveBeenCalledWith({ userId: 'author1', guildId: 'guild1' });
    });

    test('halves once per elapsed decay period', async () => {
        const { doc } = await offence({
            score: 16,
            settings: { behaviorScoreDecayDays: 7 },
            // 21 days is three whole periods: 16 → 8 → 4 → 2, then +1 for this offence.
        });
        expect(doc.behaviorScore).toBe(17);   // no decay stamp yet, so nothing decayed

        const aged = userDoc({ behaviorScore: 16, lastScoreDecay: new Date(Date.now() - 21 * DAY) });
        User.findOne.mockResolvedValue(aged);
        await run(offend());

        expect(aged.behaviorScore).toBe(3);
        expect(aged.lastScoreDecay.getTime()).toBeCloseTo(Date.now(), -3);
    });

    test('does not decay before a full period has passed', async () => {
        const doc = userDoc({ behaviorScore: 16, lastScoreDecay: new Date(Date.now() - 6 * DAY) });
        User.findOne.mockResolvedValue(doc);
        getGuildSettings.mockResolvedValue(ladder({ behaviorScoreDecayDays: 7 }));

        await run(offend());

        // Decaying early forgives a run of offences a user is still in the
        // middle of committing.
        expect(doc.behaviorScore).toBe(17);
    });

    test('honours a guild’s configured decay window', async () => {
        const doc = userDoc({ behaviorScore: 8, lastScoreDecay: new Date(Date.now() - 2 * DAY) });
        User.findOne.mockResolvedValue(doc);
        getGuildSettings.mockResolvedValue(ladder({ behaviorScoreDecayDays: 1 }));

        await run(offend());

        expect(doc.behaviorScore).toBe(3);   // 8 → 4 → 2, +1
    });

    test('stamps the first offence so the clock starts from it', async () => {
        const { doc } = await offence({ score: 0 });
        expect(doc.lastScoreDecay).toBeInstanceOf(Date);
    });
});

describe('the ladder', () => {
    const bands = { behaviorScoreMuteAt: 10, behaviorScoreKickAt: 20, behaviorScoreBanAt: 30 };

    test.each([
        ['nothing', 8,  { banned: 0, kicked: 0, timedOut: 0 }],
        ['a mute',  9,  { banned: 0, kicked: 0, timedOut: 1 }],
        ['a mute',  15, { banned: 0, kicked: 0, timedOut: 1 }],
        ['a kick',  19, { banned: 0, kicked: 1, timedOut: 0 }],
        ['a kick',  25, { banned: 0, kicked: 1, timedOut: 0 }],
        ['a ban',   29, { banned: 1, kicked: 0, timedOut: 0 }],
        ['a ban',   60, { banned: 1, kicked: 0, timedOut: 0 }],
    ])('a score reaching %s at %i', async (_label, score, expected) => {
        // Scores are the pre-offence value; the offence itself adds one, so
        // `9` is the message that lands the user exactly on the mute band.
        const result = await offence({ score, settings: bands });

        expect({
            banned:   result.banned.length,
            kicked:   result.kicked.length,
            timedOut: result.timedOut.length,
        }).toEqual(expected);
    });

    test('takes the highest band a score qualifies for, not the first', async () => {
        const { banned, kicked, timedOut } = await offence({ score: 100, settings: bands });

        expect([banned.length, kicked.length, timedOut.length]).toEqual([1, 0, 0]);
    });

    test('mutes for ten minutes and logs the duration', async () => {
        const { timedOut, escalation } = await offence({ score: 9, settings: bands });

        expect(timedOut[0][0]).toBe(10 * 60 * 1000);
        expect(escalation).toEqual(['mute']);
        expect(logModeration.mock.calls[1][5]).toEqual({ duration: 10 });
    });

    test('names the score and the threshold in the reason it files', async () => {
        const { escalation } = await offence({ score: 29, settings: bands });

        expect(escalation).toEqual(['ban']);
        expect(logModeration.mock.calls[1][4]).toBe('[AutoMod] Behavior score 30 >= 30');
        // The reason on the ban itself is what the audit log shows.
        expect(logModeration.mock.calls[1][1]).toBe('ban');
    });

    test('a band set to zero is off, and the next one down still applies', async () => {
        // Each field is labelled "0 = disabled" on the dashboard and the guards
        // in the ladder test `> 0` for that reason — but the defaults were read
        // with `||`, which reads 0 as absent and handed back 30. An operator who
        // turned auto-ban off got it re-armed at the default instead (#783).
        const { banned, kicked } = await offence({
            score: 100,
            settings: { ...bands, behaviorScoreBanAt: 0 },
        });

        expect([banned.length, kicked.length]).toEqual([0, 1]);
    });

    test('every band set to zero leaves the ladder off entirely', async () => {
        const { banned, kicked, timedOut } = await offence({
            score: 500,
            settings: { behaviorScoreMuteAt: 0, behaviorScoreKickAt: 0, behaviorScoreBanAt: 0 },
        });

        expect([banned.length, kicked.length, timedOut.length]).toEqual([0, 0, 0]);
    });

    test('an unconfigured guild still gets the documented defaults', async () => {
        // `??` must not turn "never set" into "disabled": a guild that has
        // never opened the panel is meant to have the ladder on.
        const { timedOut } = await offence({ score: 9, settings: {} });
        expect(timedOut).toHaveLength(1);
    });

    test.each([
        ['ban',  'bannable',    { bannable: false }, 'banned'],
        ['kick', 'kickable',    { kickable: false }, 'kicked'],
        ['mute', 'moderatable', { moderatable: false }, 'timedOut'],
    ])('a member the bot cannot %s falls through rather than throwing', async (_action, _flag, member, key) => {
        const score = { banned: 29, kicked: 19, timedOut: 9 }[key];
        const result = await offence({ score, settings: bands, member });

        expect(result[key]).toHaveLength(0);
        // A permission the bot lacks must not swallow the offence: the score is
        // still recorded, so the next moderator sees why.
        expect(result.doc.save).toHaveBeenCalled();
    });

    test('DMs an appeal route with the case id when appeals are on', async () => {
        Case.findOne.mockResolvedValue({ caseId: 42 });
        const { dms } = await offence({ score: 9, settings: { ...bands, appealsEnabled: true } });

        expect(dms[0]).toContain('auto-muted in **Guild One**');
        expect(dms[0]).toContain('Case ID **#42**');
    });

    test('says nothing when there is no case to appeal against', async () => {
        Case.findOne.mockResolvedValue(null);
        const { dms } = await offence({ score: 9, settings: { ...bands, appealsEnabled: true } });

        expect(dms).toEqual([]);
    });

    test('does not DM when appeals are off', async () => {
        Case.findOne.mockResolvedValue({ caseId: 42 });
        const { dms } = await offence({ score: 9, settings: bands });

        expect(dms).toEqual([]);
    });

    test('a closed DM does not cost the mute', async () => {
        Case.findOne.mockResolvedValue({ caseId: 42 });
        const doc = userDoc({ behaviorScore: 9 });
        User.findOne.mockResolvedValue(doc);
        getGuildSettings.mockResolvedValue(ladder({ ...bands, appealsEnabled: true }));
        const msg = offend({ moderatable: true });
        msg.author.send.mockRejectedValue(new Error('Cannot send messages to this user'));

        await run(msg);

        expect(msg.member.timeout).toHaveBeenCalled();
    });
});

describe('the warning-count fallback under the ladder', () => {
    // Reached only when no behaviour-score band fires, which is where a guild
    // that never configured scores lives.
    const quietBands = { behaviorScoreMuteAt: 999, behaviorScoreKickAt: 999, behaviorScoreBanAt: 999 };

    test('bans on the warning count when the score band did not fire', async () => {
        const { banned, escalation } = await offence({
            warnCount: 10,
            settings: { ...quietBands, banThreshold: 10 },
        });

        expect(banned).toHaveLength(1);
        expect(escalation).toEqual(['ban']);
        expect(logModeration.mock.calls[1][4]).toBe('[AutoMod] Warning count 10 >= ban threshold 10');
    });

    test('kicks on the warning count, and the ban threshold wins when both are met', async () => {
        const kickOnly = await offence({ warnCount: 5, settings: { ...quietBands, kickThreshold: 5, banThreshold: 10 } });
        expect([kickOnly.banned.length, kickOnly.kicked.length]).toEqual([0, 1]);

        const both = await offence({ warnCount: 10, settings: { ...quietBands, kickThreshold: 5, banThreshold: 10 } });
        expect([both.banned.length, both.kicked.length]).toEqual([1, 0]);
    });

    test('a threshold of zero is off, not "on every warning"', async () => {
        const { banned, kicked } = await offence({
            warnCount: 3,
            settings: { ...quietBands, kickThreshold: 0, banThreshold: 0 },
        });

        // `warnCount >= 0` is true for everyone; reading zero as a live
        // threshold bans the whole server on its first offence.
        expect([banned.length, kicked.length]).toEqual([0, 0]);
    });

    test('warns the user directly once they pass the warn threshold', async () => {
        const { dms, banned, kicked } = await offence({ warnCount: 3, settings: quietBands });

        expect([banned.length, kicked.length]).toEqual([0, 0]);
        expect(dms[0]).toContain('**3** warnings in **Guild One**');
    });

    test('stays quiet below the warn threshold', async () => {
        const { dms } = await offence({ warnCount: 2, settings: quietBands });
        expect(dms).toEqual([]);
    });

    test('counts only warnings, and only this user’s, in this guild', async () => {
        await offence({ warnCount: 1, settings: quietBands });

        expect(Case.countDocuments).toHaveBeenCalledWith({
            guildId: 'guild1', targetUserId: 'author1', type: 'warn',
        });
    });
});

describe('when the ladder itself fails', () => {
    test('a failed score write does not take the message deletion with it', async () => {
        const doc = userDoc();
        doc.save.mockRejectedValue(new Error('mongo down'));
        User.findOne.mockResolvedValue(doc);
        getGuildSettings.mockResolvedValue(ladder());
        const msg = offend();

        await expect(run(msg)).resolves.toBeUndefined();

        expect(msg.delete).toHaveBeenCalledTimes(1);
        expect(quiet.mock.calls.flat().join(' ')).toContain('AutoMod action error');
    });

    test('a message from outside a guild member context is left alone', async () => {
        getGuildSettings.mockResolvedValue(ladder());
        const msg = offend();
        msg.member = null;

        await expect(run(msg)).resolves.toBeUndefined();

        expect(logModeration).not.toHaveBeenCalled();
    });
});
