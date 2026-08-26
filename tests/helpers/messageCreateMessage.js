'use strict';

/**
 * Fake `message` and guild-settings builders for the `messageCreate` handlers.
 *
 * Lifted out of `tests/messageCreateSharedUser.test.js` for #783: the auto-mod
 * filters need the same fake message that test already built, plus the few
 * fields they read that leveling never touched (mention counts, attachments,
 * and the `bannable`/`kickable`/`moderatable` flags the escalation ladder gates
 * on). Keeping one builder means a filter cannot pass against a message shape
 * the real handler would never see.
 */

/** A channel that records what was sent to it and hands back a deletable message. */
function makeChannel(id = 'chan1') {
    const sent = [];
    const channel = {
        id,
        sent,
        send: jest.fn(async payload => {
            sent.push(payload);
            return { delete: jest.fn(async () => {}) };
        }),
    };
    return channel;
}

/**
 * @param {string|object} contentOrOverrides  message content, or an overrides object
 * @param {object} [overrides]
 *   content            — message text
 *   isModerator        — grants ManageMessages
 *   roleIds            — role ids the member holds, for immunity checks
 *   mentionedUsers     — number of distinct users mentioned
 *   mentionedRoles     — number of distinct roles mentioned
 *   attachmentUrls     — attachment urls, which the evidence payload records
 *   bannable/kickable/moderatable — what the bot is permitted to do to the member
 */
function makeMessage(contentOrOverrides = 'hello there', overrides = {}) {
    // Both forms merge `overrides` last, so `makeMessage(spec, { isModerator: true })`
    // means the same thing whether `spec` is a string or an object. The object
    // form used to drop the second argument entirely, which reads as working.
    const base = typeof contentOrOverrides === 'string'
        ? { content: contentOrOverrides }
        : { content: 'hello there', ...contentOrOverrides };
    const opts = { ...base, ...overrides };

    const {
        content, isModerator = false, roleIds = [],
        mentionedUsers = 0, mentionedRoles = 0, attachmentUrls = [],
        bannable = false, kickable = false, moderatable = false,
        userId = 'author1', guildId = 'guild1', channelId = 'chan1',
    } = opts;

    const channel = makeChannel(channelId);
    const sized = n => ({ size: n });

    return {
        id: 'msg1',
        url: `https://discord.com/channels/${guildId}/${channelId}/msg1`,
        content,
        author: {
            id: userId,
            bot: false,
            toString: () => `<@${userId}>`,
            send: jest.fn(async () => {}),
        },
        attachments: new Map(attachmentUrls.map((url, i) => [`a${i}`, { url }])),
        mentions: { has: () => false, users: sized(mentionedUsers), roles: sized(mentionedRoles) },
        member: {
            id: userId,
            permissions: { has: perm => isModerator && perm === 'ManageMessages' },
            roles: { cache: { some: fn => roleIds.some(id => fn({ id })) } },
            bannable, kickable, moderatable,
            ban: jest.fn(async () => {}),
            kick: jest.fn(async () => {}),
            timeout: jest.fn(async () => {}),
        },
        guild: { id: guildId, name: 'Guild One' },
        channel,
        client: { user: { id: 'bot1' } },
        delete: jest.fn(async () => {}),
    };
}

/** Guild settings with every handler off, so a test only turns on what it means to exercise. */
function makeSettings(overrides = {}) {
    return {
        ai: { enabled: false },
        leveling: { enabled: true, rewardsEnabled: true, xpRate: 1, noXpChannelIds: [], noXpRoleIds: [] },
        moderation: { enabled: false },
        suggestions: { enabled: false },
        bibleVerse: { autoRespond: false },
        ...overrides,
    };
}

/**
 * Settings with auto-moderation on and every filter off. `filters` turns on the
 * ones under test, so a filter that fires is unambiguously the one asked for.
 */
function makeModerationSettings(filters = {}, rest = {}) {
    return makeSettings({
        leveling: { enabled: false },
        moderation: {
            enabled: true,
            autoModEnabled: true,
            immunityRoleIds: [],
            ...filters,
        },
        ...rest,
    });
}

module.exports = { makeMessage, makeSettings, makeModerationSettings, makeChannel };
