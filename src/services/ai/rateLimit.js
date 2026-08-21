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

function checkRateLimit(userId, limit, windowMin) {
    if (!limit || limit <= 0) return true;
    return rateLimits.check(userId, (windowMin || 10) * 60 * 1000, limit);
}

function checkChannelRateLimit(channelId, limit, windowMin) {
    if (!limit || limit <= 0) return true;
    return channelRateLimits.check(channelId, (windowMin || 10) * 60 * 1000, limit);
}

module.exports = { checkRateLimit, checkChannelRateLimit };
