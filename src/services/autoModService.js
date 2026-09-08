'use strict';

/**
 * Auto-moderation: the filters that read every message, and the escalation they
 * feed.
 *
 * Lifted out of `events/messageCreate` (it was roughly a fifth of that file)
 * for two reasons. The first is ownership: this reads guild settings, writes
 * User and Case documents and talks to Discord -- service work that happened to
 * be living in an event handler. The second is that `messageUpdate` needs it.
 * Auto-moderation that only ever saw `messageCreate` had an opening anyone
 * could walk through: post something harmless, edit it into the invite link,
 * and no filter ever ran on the text that ended up on screen.
 *
 * The matching itself lives in `utils/contentFilters` -- pure functions over a
 * string, so each evasion and each false positive is a test case there rather
 * than a fake message driven through an event handler.
 */

const User = require('../models/User');
const Case = require('../models/Case');
const { logModeration } = require('./moderationLogService');
const BASE_BAD_WORDS = require('../data/profanityList');
const { BoundedRateLimiter } = require('../utils/boundedRateLimiter');
const {
    normalizeToxic,
    buildBadWordRegexes,
    matchesAny,
    extractInviteCodes,
    extractLinkHosts,
    isHostAllowed,
    capsStats,
    countEmojis,
    countMentions,
} = require('../utils/contentFilters');

// Offense weights for behavioral scoring
const OFFENSE_WEIGHTS = { spam: 1, invite: 2, link: 1, profanity: 2 };

// How long the "please stop" notice stays in the channel before removing itself.
const WARNING_TTL_MS = 5000;

// Pre-compile base word regexes once at module load -- avoids per-message regex
// construction.
const BASE_BAD_WORD_REGEXES = buildBadWordRegexes(BASE_BAD_WORDS);

// A guild that allows some of the base words needs its own compiled copy of the
// list. Keyed on the allowlist rather than on the guild, since guilds that set
// one mostly set the same handful of words, and bounded for the same reason the
// custom-word cache below is.
const MAX_BASE_LIST_VARIANTS = 500;
const baseBadWordVariants = new Map();

function getBaseBadWordRegexes(allowlist) {
    const words = allowlist || [];
    if (!words.length) return BASE_BAD_WORD_REGEXES;

    const signature = JSON.stringify(words);
    const cached = baseBadWordVariants.get(signature);
    if (cached) return cached;

    const regexes = buildBadWordRegexes(BASE_BAD_WORDS, words);
    if (baseBadWordVariants.size >= MAX_BASE_LIST_VARIANTS) {
        baseBadWordVariants.delete(baseBadWordVariants.keys().next().value);
    }
    baseBadWordVariants.set(signature, regexes);
    return regexes;
}

// The base list above is compiled once, but a guild's own additions used to be
// rebuilt from scratch on every message that reached the profanity filter. They
// change only when an admin edits the word list, so they are compiled once and
// kept here until that happens.
//
// The entry is keyed on the word list itself rather than on a settings version:
// the cached settings object is replaced wholesale on every invalidation, and a
// TTL expiry alone would otherwise force a recompile that changed nothing. A
// guild whose list is unchanged keeps its regexes across settings reloads.
//
// guildId -> { signature, regexes }
const customBadWordRegexes = new Map();

// Bounds memory across a large guild count, the same way guildSettingsCache
// does: FIFO by insertion order, and an evicted guild simply recompiles on its
// next filtered message.
const MAX_CUSTOM_BAD_WORD_GUILDS = 5_000;

function getCustomBadWordRegexes(guildId, customBadWords, allowlist = []) {
    const words = customBadWords || [];
    if (!words.length) return [];

    // Serialized, not joined on separators. A separator is unambiguous only
    // while it cannot occur inside an entry: the dashboard's textarea cannot
    // produce one, but the settings API takes arbitrary strings, so
    // `['a<sep>b'] + ['c']` and `['a'] + ['b<sep>c']` collided on one signature
    // and the second configuration was handed the first one's compiled
    // patterns -- the wrong words blocked, the wrong words allowed. (The
    // separator here was also a literal control character sitting invisibly in
    // the source, which is its own reason not to keep one.) The allowlist is
    // part of the key because it decides which of these words compile at all.
    const signature = JSON.stringify([allowlist || [], words]);
    const cached = customBadWordRegexes.get(guildId);
    if (cached && cached.signature === signature) return cached.regexes;

    const regexes = buildBadWordRegexes(words, allowlist);
    if (customBadWordRegexes.size >= MAX_CUSTOM_BAD_WORD_GUILDS && !customBadWordRegexes.has(guildId)) {
        customBadWordRegexes.delete(customBadWordRegexes.keys().next().value);
    }
    customBadWordRegexes.set(guildId, { signature, regexes });
    return regexes;
}

// One entry per (guild, user) seen inside the spam window.
//
// This was a `Map<guildId, Map<userId, timestamps>>` with nothing that ever
// removed an entry: a user's array was pruned only when *that same user* posted
// again, so a visitor who said one word in one guild two months ago was still
// resident, and the outer map grew a guild entry per guild for the life of the
// process (#600). The bounded limiter is what the rest of the bot already uses
// for exactly this -- a hard key ceiling with FIFO eviction, plus a sweep that
// drops keys whose timestamps have all aged out.
//
// The key is `guildId:userId` rather than a nested map because the ceiling has
// to bound the whole thing; a cap on the outer map alone bounds nothing, since
// the arrays hang off the inner ones. Eviction only forgives whatever a user
// had accumulated, which costs them a longer run-up to the threshold -- the
// same trade every other limiter here makes.
const SPAM_MAX_KEYS = 20_000;

// The dashboard offers 1-60 seconds for the window, so 60s is the longest one
// any guild can be running. The sweep uses it, which is what makes the sweep
// safe: `cleanup` only drops a key once every timestamp on it predates the
// window it is given, so sweeping on the *widest* configurable window can never
// forget a message some guild's narrower window would still have counted.
const SPAM_MIN_WINDOW_MS = 1_000;
const SPAM_MAX_WINDOW_MS = 60_000;

const spamLimiter = new BoundedRateLimiter(SPAM_MAX_KEYS);
setInterval(() => spamLimiter.cleanup(SPAM_MAX_WINDOW_MS), SPAM_MAX_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// Invite resolution
// ---------------------------------------------------------------------------

// The dashboard collects "allowed server IDs", which an invite link does not
// carry -- it carries a code. Resolving one to the other is an API call, so the
// answers are cached: a guild that allows its own invites sees the same handful
// of codes over and over.
//
// Failures are cached too, for a shorter time. A code that does not resolve is
// blocked, and a raid pasting fifty dead invites must not cost fifty API calls
// a message.
const INVITE_CACHE_MAX = 2_000;
const INVITE_TTL_MS = 60 * 60 * 1000;
const INVITE_MISS_TTL_MS = 5 * 60 * 1000;
const inviteGuildCache = new Map();

function cacheInviteResult(code, guildId) {
    if (inviteGuildCache.size >= INVITE_CACHE_MAX && !inviteGuildCache.has(code)) {
        inviteGuildCache.delete(inviteGuildCache.keys().next().value);
    }
    inviteGuildCache.set(code, {
        guildId,
        expires: Date.now() + (guildId ? INVITE_TTL_MS : INVITE_MISS_TTL_MS),
    });
    return guildId;
}

async function resolveInviteGuildId(client, guild, code) {
    // The guild's own vanity URL is knowable without asking Discord.
    if (guild?.vanityURLCode && guild.vanityURLCode.toLowerCase() === code) return guild.id;

    const cached = inviteGuildCache.get(code);
    if (cached && cached.expires > Date.now()) return cached.guildId;

    if (typeof client?.fetchInvite !== 'function') return cacheInviteResult(code, null);

    try {
        const invite = await client.fetchInvite(code);
        return cacheInviteResult(code, invite?.guild?.id ?? null);
    } catch {
        // A deleted or malformed invite, or a transient API failure. Either way
        // there is no server id to compare the allowlist against, and an
        // unverified invite is not an allowed one.
        return cacheInviteResult(code, null);
    }
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * May this invite stay?
 *
 * An allowlist entry matches either the invite code itself (what someone
 * pasting a link into the box will have typed) or the id of the server it
 * points at (what the dashboard's label asks for). Invites back to the server
 * the message was posted in are allowed unless a guild turns that off --
 * deleting your own server's invite link is the complaint every invite filter
 * collects first.
 *
 * None of this ran before: the allowlist was collected by the dashboard, stored
 * on the guild, and read by nothing. Every invite was deleted, including the
 * ones an admin had explicitly permitted.
 */
async function inviteIsAllowed(message, mod, code) {
    const allowlist = (mod.inviteAllowlist || [])
        .map(entry => String(entry ?? '').trim().toLowerCase())
        .filter(Boolean);

    if (allowlist.includes(code)) return true;

    const allowOwn = mod.allowOwnServerInvites !== false;
    const hasServerIds = allowlist.some(entry => SNOWFLAKE_RE.test(entry));
    // Nothing is left that resolving the code could satisfy, so do not spend
    // the call on it.
    if (!allowOwn && !hasServerIds) return false;

    const resolvedGuildId = await resolveInviteGuildId(message.client, message.guild, code);
    if (!resolvedGuildId) return false;
    if (allowOwn && resolvedGuildId === message.guild.id) return true;
    return allowlist.includes(resolvedGuildId);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Delete the message, post a self-deleting notice, and file the offence. */
async function punish(message, guildSettings, notice, reason, weight) {
    await message.delete().catch(console.error);
    const warn = await message.channel.send(notice).catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), WARNING_TTL_MS);
    await applyAutoModAction(message, guildSettings, reason, weight);
    return true;
}

function isImmune(message, mod) {
    const member = message.member;
    if (member.permissions.has('ManageMessages')) return true;
    return Boolean(
        mod.immunityRoleIds?.length && member.roles.cache.some(r => mod.immunityRoleIds.includes(r.id))
    );
}

/** Channels -- or whole categories -- an admin has put out of the filters' reach. */
function isExemptChannel(message, mod) {
    const exempt = mod.exemptChannelIds;
    if (!exempt?.length) return false;
    return exempt.includes(message.channel?.id) || exempt.includes(message.channel?.parentId);
}

/**
 * Run every armed filter over one message.
 *
 * Returns true when the message was deleted, which is the caller's signal to
 * stop processing it.
 */
async function handleAutoModeration(message, guildSettings, { isEdit = false } = {}) {
    const mod = guildSettings?.moderation;
    if (!mod?.autoModEnabled) return false;
    // No member means no permissions to read and no roles to check -- an
    // uncached author, or a partial from an edit. Filtering on a guessed
    // exemption is worse than not filtering.
    if (!message.member) return false;
    if (isExemptChannel(message, mod)) return false;

    const isModerator = isImmune(message, mod);
    const content = message.content ?? '';

    // Every other filter reads the message's content, so re-running it on an
    // edit asks the same question of new text. This one counts events, not
    // content: it would charge a user's rate window for fixing two typos, and
    // at the default five-in-five-seconds that is a deletion, a case and a
    // behaviour-score bump for tidying up. An edit is not a new message.
    if (mod.spamProtection && !isModerator && !isEdit) {
        const guildId = message.guild.id;
        const userId = message.author.id;
        // Clamped to the range the dashboard's own input offers. Nothing
        // validates `spamWindow` on the way into the database, and the sweep
        // above is only sound while no guild's window outruns it.
        //
        // `??`, not `||`: an out-of-range value is the clamp's job, so a stored
        // 0 becomes the one-second floor rather than being read as "unset" and
        // silently given the five-second default.
        const windowMs = Math.min(
            Math.max((mod.spamWindow ?? 5) * 1000, SPAM_MIN_WINDOW_MS),
            SPAM_MAX_WINDOW_MS
        );
        const threshold = mod.spamThreshold || 5;

        const key = `${guildId}:${userId}`;

        if (spamLimiter.hit(key, windowMs) >= threshold) {
            // Forget the burst that just earned a punishment, so the next
            // message starts a fresh count instead of tripping the same
            // still-full window again.
            spamLimiter.reset(key);
            return punish(
                message, guildSettings,
                `${message.author}, slow down! You're sending messages too fast.`,
                'spam', OFFENSE_WEIGHTS.spam
            );
        }
    }

    if (mod.inviteFilter && !isModerator) {
        const codes = extractInviteCodes(content);
        if (codes.length) {
            // One disallowed invite is enough; the allowed ones alongside it do
            // not redeem the message.
            const verdicts = await Promise.all(codes.map(code => inviteIsAllowed(message, mod, code)));
            if (verdicts.some(allowed => !allowed)) {
                return punish(
                    message, guildSettings,
                    `${message.author}, invite links are not allowed!`,
                    'posting an invite link', OFFENSE_WEIGHTS.invite
                );
            }
        }
    }

    if (mod.linkFilter && !isModerator) {
        const hosts = extractLinkHosts(content);
        if (hosts.length && !hosts.every(host => isHostAllowed(host, mod.linkAllowlist))) {
            return punish(
                message, guildSettings,
                `${message.author}, links are not allowed!`,
                'posting a link', OFFENSE_WEIGHTS.link
            );
        }
    }

    if (mod.repeatedTextFilter && !isModerator) {
        const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.length > 12 && /(.)\1{8,}/.test(normalized)) {
            return punish(
                message, guildSettings,
                `${message.author}, please avoid repeated/spammy text.`,
                'repeated text spam', OFFENSE_WEIGHTS.spam
            );
        }
    }

    if (mod.excessiveCapsFilter && !isModerator) {
        const { letters, ratio } = capsStats(content);
        if (letters >= 10 && ratio >= (mod.capsThresholdPercent || 70)) {
            return punish(
                message, guildSettings,
                `${message.author}, please avoid excessive caps.`,
                'excessive caps', OFFENSE_WEIGHTS.spam
            );
        }
    }

    if (mod.excessiveEmojisFilter && !isModerator) {
        if (countEmojis(content) >= (mod.emojiThreshold || 8)) {
            return punish(
                message, guildSettings,
                `${message.author}, too many emojis in one message.`,
                'excessive emojis', OFFENSE_WEIGHTS.spam
            );
        }
    }

    if (mod.zalgoFilter && !isModerator) {
        const combiningMarks = (content.normalize('NFD').match(/[\u0300-\u036F]/g) || []).length;
        if (combiningMarks >= 6) {
            return punish(
                message, guildSettings,
                `${message.author}, zalgo/combining text is not allowed.`,
                'zalgo text', OFFENSE_WEIGHTS.spam
            );
        }
    }

    // A real @everyone or @here ping -- `mentions.everyone` is only true when
    // the author actually held the permission to make it land, so this is the
    // ping itself and not someone typing the word.
    if (mod.everyoneMentionFilter && !isModerator && message.mentions?.everyone) {
        return punish(
            message, guildSettings,
            `${message.author}, @everyone and @here pings are not allowed here.`,
            'mass mention (@everyone/@here)', OFFENSE_WEIGHTS.spam
        );
    }

    if (mod.excessiveMentionsFilter && !isModerator) {
        if (countMentions(message) >= (mod.mentionThreshold || 5)) {
            return punish(
                message, guildSettings,
                `${message.author}, too many mentions in one message.`,
                'excessive mentions', OFFENSE_WEIGHTS.spam
            );
        }
    }

    if (mod.profanityFilter && !isModerator) {
        const normalized = normalizeToxic(content);
        const allowlist = mod.profanityAllowlist || [];
        const hasBadWord = matchesAny(normalized, getBaseBadWordRegexes(allowlist))
            || matchesAny(normalized, getCustomBadWordRegexes(message.guild.id, mod.customBadWords, allowlist));

        if (hasBadWord) {
            return punish(
                message, guildSettings,
                `${message.author}, please watch your language!`,
                'using prohibited language', OFFENSE_WEIGHTS.profanity
            );
        }
    }

    return false;
}

async function applyAutoModAction(message, guildSettings, reason, scoreWeight = 1) {
    const mod = guildSettings.moderation;
    const member = message.member;
    if (!member) return;

    try {
        const evidence = {
            messageId: message.id,
            jumpUrl: message.url,
            content: (message.content ?? '').slice(0, 500),
            attachmentUrls: [...message.attachments.values()].map(a => a.url)
        };
        await logModeration(
            message.guild.id, 'warn', message.author, message.client.user,
            `[AutoMod] ${reason}`, { evidence }
        );

        // Behavioral score (with decay)
        let user = await User.findOne({ userId: member.id, guildId: message.guild.id });
        if (!user) {
            user = await User.create({ userId: member.id, guildId: message.guild.id });
        }

        // Apply decay: 50% every N days
        const decayDays = mod.behaviorScoreDecayDays || 7;
        if (user.lastScoreDecay) {
            const daysSince = (Date.now() - user.lastScoreDecay.getTime()) / 86400000;
            if (daysSince >= decayDays) {
                const periods = Math.floor(daysSince / decayDays);
                user.behaviorScore = user.behaviorScore * Math.pow(0.5, periods);
                user.lastScoreDecay = new Date();
            }
        } else {
            user.lastScoreDecay = new Date();
        }

        user.behaviorScore = (user.behaviorScore || 0) + scoreWeight;
        await user.save();

        const score = user.behaviorScore;
        // `??`, not `||`. Each of these is documented as "0 = disabled" beside
        // its dashboard field, the schema allows `min: 0`, and the guards below
        // test `> 0` for exactly that reason — but `||` reads 0 as absent and
        // hands back the default, so an operator who turned auto-ban off got it
        // silently re-armed at 30 and the `> 0` guards were unreachable (#783).
        const banAt = mod.behaviorScoreBanAt ?? 30;
        const kickAt = mod.behaviorScoreKickAt ?? 20;
        const muteAt = mod.behaviorScoreMuteAt ?? 10;

        if (banAt > 0 && score >= banAt && member.bannable) {
            await member.ban({ reason: `[AutoMod] Behavior score ${Math.round(score)} reached ban threshold` });
            await logModeration(message.guild.id, 'ban', message.author, message.client.user,
                `[AutoMod] Behavior score ${Math.round(score)} >= ${banAt}`);
        } else if (kickAt > 0 && score >= kickAt && member.kickable) {
            await member.kick(`[AutoMod] Behavior score ${Math.round(score)} reached kick threshold`);
            await logModeration(message.guild.id, 'kick', message.author, message.client.user,
                `[AutoMod] Behavior score ${Math.round(score)} >= ${kickAt}`);
        } else if (muteAt > 0 && score >= muteAt && member.moderatable) {
            await member.timeout(10 * 60 * 1000, `[AutoMod] Behavior score ${Math.round(score)} reached mute threshold`);
            await logModeration(message.guild.id, 'mute', message.author, message.client.user,
                `[AutoMod] Behavior score ${Math.round(score)} >= ${muteAt}`, { duration: 10 });
            // Notify user with appeal info if enabled
            if (mod.appealsEnabled) {
                const latestCase = await Case.findOne(
                    { guildId: message.guild.id, targetUserId: member.id },
                    {}, { sort: { createdAt: -1 } }
                );
                if (latestCase) {
                    await message.author.send(
                        `You have been auto-muted in **${message.guild.name}**.\n` +
                        `Reason: ${reason}\n\n` +
                        `To appeal, use \`/appeal\` in ${message.guild.name} with Case ID **#${latestCase.caseId}**.`
                    ).catch(() => {});
                }
            }
        } else {
            const warnCount = await Case.countDocuments({ guildId: message.guild.id, targetUserId: member.id, type: 'warn' });
            const kickThreshold = mod.kickThreshold || 0;
            const banThreshold = mod.banThreshold || 0;

            if (banThreshold > 0 && warnCount >= banThreshold && member.bannable) {
                await member.ban({ reason: `[AutoMod] Warning count ${warnCount} reached ban threshold (${banThreshold})` });
                await logModeration(message.guild.id, 'ban', message.author, message.client.user,
                    `[AutoMod] Warning count ${warnCount} >= ban threshold ${banThreshold}`);
            } else if (kickThreshold > 0 && warnCount >= kickThreshold && member.kickable) {
                await member.kick(`[AutoMod] Warning count ${warnCount} reached kick threshold (${kickThreshold})`);
                await logModeration(message.guild.id, 'kick', message.author, message.client.user,
                    `[AutoMod] Warning count ${warnCount} >= kick threshold ${kickThreshold}`);
            } else if (warnCount >= (mod.warnThreshold || 3)) {
                await message.author.send(
                    `You have received **${warnCount}** warnings in **${message.guild.name}**. ` +
                    `Further violations may result in a mute or kick.`
                ).catch(() => {});
            }
        }
    } catch (err) {
        console.error('AutoMod action error:', err);
    }
}

module.exports = {
    handleAutoModeration,
    applyAutoModAction,
    OFFENSE_WEIGHTS,
    // Exported for unit testing only.
    _getCustomBadWordRegexes: getCustomBadWordRegexes,
    _spamLimiter: spamLimiter,
    _inviteGuildCache: inviteGuildCache,
};
