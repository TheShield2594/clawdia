const { BoundedRateLimiter } = require('../../utils/boundedRateLimiter');

// Sliding-window AI rate limiting, per user and per channel.
//
// These were plain Maps swept every 15 minutes, which meant they grew with every
// distinct user and channel the bot ever saw and only shrank long after entries
// expired. Bounded now, same as the dashboard's write limiter: a hard ceiling on
// tracked keys, with the oldest evicted first.
const AI_RL_MAX_KEYS = 10_000;
const AI_RL_SWEEP_WINDOW_MS = 2 * 60 * 60 * 1000; // widest window the settings allow

const rateLimits = new BoundedRateLimiter(AI_RL_MAX_KEYS);
const channelRateLimits = new BoundedRateLimiter(AI_RL_MAX_KEYS);

setInterval(() => {
    rateLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
    channelRateLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
}, 15 * 60 * 1000).unref();

/**
 * Thrown by getCompletion/streamCompletion when a request would exceed the
 * guild's configured AI limit. It carries the numbers so each transport can
 * phrase its own refusal, and `rateLimited` marks it as something no retry
 * loop should re-attempt — the answer will not change inside the window.
 */
class AiRateLimitError extends Error {
    constructor(scope, limit, windowMin) {
        super(scope === 'channel'
            ? `AI channel rate limit reached (${limit} per ${windowMin}m)`
            : `AI rate limit reached (${limit} per ${windowMin}m)`);
        this.name = 'AiRateLimitError';
        this.rateLimited = true;
        this.scope = scope;
        this.limit = limit;
        this.windowMin = windowMin;
    }
}

function checkRateLimit(userId, limit, windowMin) {
    if (!limit || limit <= 0) return true;
    return rateLimits.check(userId, (windowMin || 10) * 60 * 1000, limit);
}

function checkChannelRateLimit(channelId, limit, windowMin) {
    if (!limit || limit <= 0) return true;
    return channelRateLimits.check(channelId, (windowMin || 10) * 60 * 1000, limit);
}

/** Non-consuming form of checkRateLimit, for refusing before the expensive work. */
function peekRateLimit(userId, limit, windowMin) {
    if (!limit || limit <= 0) return true;
    return rateLimits.peek(userId, (windowMin || 10) * 60 * 1000, limit);
}

/** Non-consuming form of checkChannelRateLimit. */
function peekChannelRateLimit(channelId, limit, windowMin) {
    if (!limit || limit <= 0) return true;
    return channelRateLimits.peek(channelId, (windowMin || 10) * 60 * 1000, limit);
}

/**
 * The single enforcement point for AI limits, called from getCompletion and
 * streamCompletion so no provider call can route around it.
 *
 * `rateLimit` is the block resolveProviderConfig attaches to every provider
 * config, so any caller that spreads that config carries the guild's limits
 * without knowing they exist. A call with no `userId` and no `channelId` is
 * unattributed — the scheduled digests and newspapers, which run on a fixed
 * cadence the guild configures rather than on demand — and is not bounded here.
 *
 * Throws AiRateLimitError rather than returning false: the caller is about to
 * spend real provider tokens, so the failure has to be impossible to ignore.
 */
function enforceRateLimit({ userId, channelId, rateLimit }) {
    if (!rateLimit) return;
    const { perUser, perChannel, windowMin } = rateLimit;

    // Channel first: it is the wider bound, and refusing on it should not
    // silently spend one of the user's own slots.
    if (channelId && !peekChannelRateLimit(channelId, perChannel, windowMin)) {
        throw new AiRateLimitError('channel', perChannel, windowMin);
    }
    if (userId && !checkRateLimit(userId, perUser, windowMin)) {
        throw new AiRateLimitError('user', perUser, windowMin);
    }
    if (channelId && !checkChannelRateLimit(channelId, perChannel, windowMin)) {
        throw new AiRateLimitError('channel', perChannel, windowMin);
    }
}

module.exports = {
    checkRateLimit,
    checkChannelRateLimit,
    peekRateLimit,
    peekChannelRateLimit,
    enforceRateLimit,
    AiRateLimitError
};
