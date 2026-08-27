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

// A third window, for what a message *becomes*.
//
// `rateLimitPerUser` counts messages, and a message is no longer one request:
// with MCP servers configured it is up to four provider rounds and every tool
// call the model makes inside them, each one a request to somebody else's
// server made in this bot's name. The per-turn ceilings bound one message;
// nothing bounded a user sending message after message that each fan out.
//
// So tool calls are counted separately rather than charged against the message
// allowance — a user with ten messages per window should not lose eight of them
// to one question that needed a lot of looking up. The allowance is derived
// from the message limit so there is nothing new to configure: a guild that
// allows ten messages allows the tool calls a reasonable ten messages make.
const toolCallLimits = new BoundedRateLimiter(AI_RL_MAX_KEYS);

// Enough for a message that genuinely needs several rounds of searching, and
// far short of what four rounds of six parallel calls could ask for every time.
const TOOL_CALLS_PER_MESSAGE = 8;

setInterval(() => {
    rateLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
    channelRateLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
    toolCallLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
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
 * The per-user window is keyed per guild. A Discord user ID is global, but the
 * limit, the window and the API key being billed all belong to one guild, so a
 * bare user ID would let activity in one server eat another server's allowance
 * — and the two owners pay separate bills. Channel IDs are already unique
 * across Discord, so that key is left alone.
 *
 * Throws AiRateLimitError rather than returning false: the caller is about to
 * spend real provider tokens, so the failure has to be impossible to ignore.
 */
function enforceRateLimit({ guildId, userId, channelId, rateLimit }) {
    if (!rateLimit) return;
    const { perUser, perChannel, windowMin } = rateLimit;
    const userKey = userId && (guildId ? `${guildId}:${userId}` : userId);

    // Channel first: it is the wider bound, and refusing on it should not
    // silently spend one of the user's own slots.
    if (channelId && !peekChannelRateLimit(channelId, perChannel, windowMin)) {
        throw new AiRateLimitError('channel', perChannel, windowMin);
    }
    if (userKey && !checkRateLimit(userKey, perUser, windowMin)) {
        throw new AiRateLimitError('user', perUser, windowMin);
    }
    if (channelId && !checkChannelRateLimit(channelId, perChannel, windowMin)) {
        throw new AiRateLimitError('channel', perChannel, windowMin);
    }
}

/** The per-guild key the user window is tracked under. Exported so the
 *  transports can peek with exactly the key enforcement will consume. */
function userRateLimitKey(guildId, userId) {
    return guildId ? `${guildId}:${userId}` : userId;
}

/**
 * A function that spends one of this user's tool calls and says whether there
 * was one to spend.
 *
 * Handed to the MCP toolkit, which calls it once per tool call and turns a
 * `false` into a refusal the model can answer around — the same shape the
 * per-turn budget already uses, because a tool call that will not run should
 * cost a sentence rather than the whole reply.
 *
 * Returns null when nothing applies: no limit configured, or a request with
 * nobody to attribute it to (the scheduled digests and newspapers, which run on
 * a cadence the guild set rather than on demand). The toolkit treats a missing
 * budget as unbounded, which is what those callers were before.
 */
function toolCallBudget({ guildId, userId, rateLimit }) {
    if (!rateLimit || !userId) return null;
    const { perUser, windowMin } = rateLimit;
    if (!perUser || perUser <= 0) return null;

    const key = userRateLimitKey(guildId, userId);
    const limit = perUser * TOOL_CALLS_PER_MESSAGE;
    const windowMs = (windowMin || 10) * 60 * 1000;

    return () => toolCallLimits.check(key, windowMs, limit);
}

module.exports = {
    checkRateLimit,
    checkChannelRateLimit,
    peekRateLimit,
    peekChannelRateLimit,
    enforceRateLimit,
    userRateLimitKey,
    toolCallBudget,
    TOOL_CALLS_PER_MESSAGE,
    AiRateLimitError
};
