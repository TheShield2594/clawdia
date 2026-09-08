'use strict';

/**
 * The parts of auto-moderation an admin configures and the filters then have to
 * honour.
 *
 * `inviteAllowlist` and `linkAllowlist` were collected by the dashboard, stored
 * on the guild, rendered back into their textareas -- and read by nothing. A
 * server that allowed youtube.com had its YouTube links deleted, and one that
 * allowed its own invite code had that invite deleted, with no way to tell from
 * the outside that the setting was inert.
 */

jest.mock('../src/models/User',     () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/Guild',    () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/models/Case',     () => ({ findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/services/moderationLogService', () => ({ logModeration: jest.fn() }));

const User = require('../src/models/User');
const Case = require('../src/models/Case');
const { logModeration } = require('../src/services/moderationLogService');
const { makeMessage, makeModerationSettings } = require('./helpers/messageCreateMessage');
const {
    handleAutoModeration,
    _inviteGuildCache,
    _getCustomBadWordRegexes,
} = require('../src/services/autoModService');

/** A user quiet enough that no escalation rung fires -- the filters are what is under test. */
function calmUser() {
    return { userId: 'author1', guildId: 'guild1', behaviorScore: 0, lastScoreDecay: null, save: jest.fn(async () => {}) };
}

let quiet;

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    _inviteGuildCache.clear();
    User.findOne.mockResolvedValue(calmUser());
    Case.countDocuments.mockResolvedValue(0);
    Case.findOne.mockResolvedValue(null);
    logModeration.mockResolvedValue({ caseId: 7 });
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    quiet.mockRestore();
});

/**
 * Drive one message through the filters.
 *
 * `fetchInvite` stands in for the API call that turns an invite code into the
 * id of the server it points at; passing null makes it a code that will not
 * resolve, which is what a deleted or fake invite looks like.
 */
async function run(content, filters, { fetchInvite, ...overrides } = {}) {
    const message = makeMessage(content, overrides);
    if (fetchInvite !== undefined) {
        message.client.fetchInvite = jest.fn(async code =>
            (fetchInvite === null ? Promise.reject(new Error('Unknown Invite')) : { code, guild: { id: fetchInvite } })
        );
    }
    const deleted = await handleAutoModeration(message, makeModerationSettings(filters));
    return { deleted, message };
}

describe('invite allowlist', () => {
    it('deletes an invite that is on no list', async () => {
        const { deleted } = await run('join discord.gg/raidserver', { inviteFilter: true }, { fetchInvite: '999' });
        expect(deleted).toBe(true);
    });

    it('keeps an invite whose code the admin allowed', async () => {
        const { deleted, message } = await run(
            'join discord.gg/ourpartner',
            { inviteFilter: true, inviteAllowlist: ['ourpartner'] }
        );
        expect(deleted).toBe(false);
        expect(message.delete).not.toHaveBeenCalled();
    });

    it('keeps an invite to a server id the admin allowed', async () => {
        // The dashboard field asks for server ids, which a link does not carry;
        // resolving the code is what connects the two.
        const { deleted } = await run(
            'join discord.gg/partnercode',
            { inviteFilter: true, inviteAllowlist: ['222222222222222222'] },
            { fetchInvite: '222222222222222222' }
        );
        expect(deleted).toBe(false);
    });

    it('keeps an invite back to this server by default', async () => {
        const { deleted } = await run(
            'here is our link: discord.gg/ourown',
            { inviteFilter: true },
            { fetchInvite: 'guild1' }
        );
        expect(deleted).toBe(false);
    });

    it('deletes an invite to this server when the guild turns that off', async () => {
        const { deleted } = await run(
            'here is our link: discord.gg/ourown',
            { inviteFilter: true, allowOwnServerInvites: false },
            { fetchInvite: 'guild1' }
        );
        expect(deleted).toBe(true);
    });

    it('deletes an invite whose code will not resolve', async () => {
        // An unverified invite is not an allowed one.
        const { deleted } = await run(
            'join discord.gg/deadcode',
            { inviteFilter: true, inviteAllowlist: ['222222222222222222'] },
            { fetchInvite: null }
        );
        expect(deleted).toBe(true);
    });

    it('deletes a message that mixes an allowed invite with a disallowed one', async () => {
        const { deleted } = await run(
            'discord.gg/ourpartner and discord.gg/raidserver',
            { inviteFilter: true, inviteAllowlist: ['ourpartner'] },
            { fetchInvite: '999' }
        );
        expect(deleted).toBe(true);
    });

    it('spends no API call when nothing could be allowed', async () => {
        const { deleted, message } = await run(
            'join discord.gg/raidserver',
            { inviteFilter: true, allowOwnServerInvites: false },
            { fetchInvite: '999' }
        );
        expect(deleted).toBe(true);
        expect(message.client.fetchInvite).not.toHaveBeenCalled();
    });

    it('resolves a repeated code once', async () => {
        const settings = { inviteFilter: true, inviteAllowlist: ['222222222222222222'] };
        const first = await run('discord.gg/samecode', settings, { fetchInvite: '222222222222222222' });
        const second = await run('discord.gg/samecode', settings, { fetchInvite: '222222222222222222' });

        expect(first.deleted).toBe(false);
        expect(second.deleted).toBe(false);
        expect(second.message.client.fetchInvite).not.toHaveBeenCalled();
    });
});

describe('link allowlist', () => {
    it('keeps a link to an allowed domain', async () => {
        const { deleted } = await run(
            'watch https://www.youtube.com/watch?v=x',
            { linkFilter: true, linkAllowlist: ['youtube.com'] }
        );
        expect(deleted).toBe(false);
    });

    it('deletes a link to a domain that is not allowed', async () => {
        const { deleted } = await run(
            'claim at https://free-nitro.tld/x',
            { linkFilter: true, linkAllowlist: ['youtube.com'] }
        );
        expect(deleted).toBe(true);
    });

    it('deletes a message that mixes an allowed link with a disallowed one', async () => {
        const { deleted } = await run(
            'https://youtube.com/x and https://free-nitro.tld/y',
            { linkFilter: true, linkAllowlist: ['youtube.com'] }
        );
        expect(deleted).toBe(true);
    });

    it('deletes a bare domain with no scheme', async () => {
        // The test was `content.includes('http://')`, so the shape a scam link
        // actually takes was the one shape that got through.
        // A real suffix, because a bare host is only read as one when its TLD
        // is on the known list -- that is what keeps `readme.md` out of it.
        const { deleted } = await run('claim at www.free-nitro.com/x', { linkFilter: true });
        expect(deleted).toBe(true);
    });
});

describe('profanity allowlist', () => {
    it('honours a word struck out of the built-in list', async () => {
        const before = await run('what the hell', { profanityFilter: true });
        expect(before.deleted).toBe(true);

        const after = await run(
            'what the hell',
            { profanityFilter: true, profanityAllowlist: ['hell'] }
        );
        expect(after.deleted).toBe(false);
    });
});

describe('exempt channels', () => {
    it('skips a channel the admin exempted', async () => {
        const { deleted } = await run(
            'you fuck',
            { profanityFilter: true, exemptChannelIds: ['chan1'] }
        );
        expect(deleted).toBe(false);
    });

    it('skips a channel whose category is exempted', async () => {
        const message = makeMessage('you fuck');
        message.channel.parentId = 'cat1';
        const deleted = await handleAutoModeration(
            message,
            makeModerationSettings({ profanityFilter: true, exemptChannelIds: ['cat1'] })
        );
        expect(deleted).toBe(false);
    });

    it('still filters a channel that is not on the list', async () => {
        const { deleted } = await run(
            'you fuck',
            { profanityFilter: true, exemptChannelIds: ['someother'] }
        );
        expect(deleted).toBe(true);
    });
});

describe('mass mentions', () => {
    it('deletes a real @everyone ping when the filter is on', async () => {
        const message = makeMessage('@everyone free nitro');
        message.mentions.everyone = true;
        const deleted = await handleAutoModeration(
            message,
            makeModerationSettings({ everyoneMentionFilter: true })
        );
        expect(deleted).toBe(true);
    });

    it('leaves it alone when the filter is off', async () => {
        const message = makeMessage('@everyone free nitro');
        message.mentions.everyone = true;
        const deleted = await handleAutoModeration(message, makeModerationSettings({}));
        expect(deleted).toBe(false);
    });

    it('counts repeated pings of one user toward the mention threshold', async () => {
        // Discord collapses `mentions.users` by user, so twenty pings of one
        // person counted as one and sat under every threshold.
        const spam = '<@111111111111111111> '.repeat(20).trim();
        const { deleted } = await run(
            spam,
            { excessiveMentionsFilter: true, mentionThreshold: 5 },
            { mentionedUsers: 1 }
        );
        expect(deleted).toBe(true);
    });
});

describe('guards', () => {
    it('does nothing without a member to judge', async () => {
        const message = makeMessage('you fuck');
        message.member = null;
        const deleted = await handleAutoModeration(message, makeModerationSettings({ profanityFilter: true }));
        expect(deleted).toBe(false);
        expect(message.delete).not.toHaveBeenCalled();
    });

    it('does nothing when auto-moderation is off', async () => {
        const message = makeMessage('you fuck');
        const deleted = await handleAutoModeration(message, {
            moderation: { enabled: true, autoModEnabled: false, profanityFilter: true },
        });
        expect(deleted).toBe(false);
    });
});

describe('edits', () => {
    it('does not charge the rate window for an edit', async () => {
        // The rate filter counts events, not content: an edit re-running it
        // would make fixing typos indistinguishable from posting.
        const settings = { spamProtection: true, spamThreshold: 2, spamWindow: 5 };

        // One real message, then an edit. Without the opt-out the edit is the
        // second event in the window and trips the threshold.
        await run('first message', settings);
        const edited = makeMessage('fixed typo');
        const deleted = await handleAutoModeration(edited, makeModerationSettings(settings), { isEdit: true });

        expect(deleted).toBe(false);
        expect(edited.delete).not.toHaveBeenCalled();
    });

    it('still applies the content filters to an edit', async () => {
        const edited = makeMessage('you fuck');
        const deleted = await handleAutoModeration(
            edited,
            makeModerationSettings({ profanityFilter: true }),
            { isEdit: true }
        );

        expect(deleted).toBe(true);
    });
});

describe('bad-word cache keys', () => {
    it('does not confuse one entry containing the separator with two entries', () => {
        // The signature joined the entries on a NUL. That is unambiguous only
        // while no entry can contain one -- and while the dashboard textarea
        // cannot produce a NUL, the settings API takes arbitrary strings. These
        // two word lists produced an identical signature, so the second guild
        // configuration was served the first one's compiled patterns: one
        // pattern for the literal `alpha\0beta`, reused where two separate
        // words were meant.
        const NUL = String.fromCharCode(0);

        const joined = _getCustomBadWordRegexes('gA', [`alpha${NUL}beta`]);
        const separate = _getCustomBadWordRegexes('gA', ['alpha', 'beta']);

        expect(joined).toHaveLength(1);
        expect(separate).toHaveLength(2);
        expect(separate[1].test('beta')).toBe(true);
    });
});
