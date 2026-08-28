const { BoundedRateLimiter } = require('../../utils/boundedRateLimiter');
const { peekMonthlyUsage, monthlyBudget } = require('./usage');

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

// And the same bound for the calls nobody sent.
//
// A scheduled run — a digest, a newspaper, a recurring task — has no user to
// charge, and `toolCallBudget` used to answer that by returning null, which the
// toolkit reads as unbounded. So the one class of request that runs on a timer,
// with nobody watching and nobody to notice, was the only one that could fan
// out without limit: four rounds of six parallel calls, every hour, against
// somebody else's server in this bot's name.
//
// The budget is per guild rather than per job, because the guild is what pays,
// and the window is an hour because that is the cadence the scheduled work
// actually runs on — a job that fires hourly gets its full allowance each time,
// and a guild that has stacked up several of them shares one.
const SCHEDULED_TOOL_CALLS_PER_HOUR = 24;
const SCHEDULED_WINDOW_MS = 60 * 60 * 1000;

// And an allowance of its own for deep task mode (#835).
//
// A task turn is attributed to whoever ran it, so the guild's ordinary message
// and tool windows already apply to it. This is the extra one, because a task
// is not an ordinary message: three times the rounds and five times the wall
// clock, running detached from the interaction with the bot free to keep
// working after the person has walked away. A guild that allows twenty messages
// an hour did not thereby allow twenty of those.
const deepTaskLimits = new BoundedRateLimiter(AI_RL_MAX_KEYS);
const DEEP_TASKS_PER_WINDOW = 3;
const DEEP_TASK_WINDOW_MS = 60 * 60 * 1000;

setInterval(() => {
    rateLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
    channelRateLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
    toolCallLimits.cleanup(AI_RL_SWEEP_WINDOW_MS);
    deepTaskLimits.cleanup(DEEP_TASK_WINDOW_MS);
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

/**
 * Thrown when a guild has spent its configured monthly AI allowance.
 *
 * A sibling of AiRateLimitError rather than a subclass of it: both are refusals
 * no retry loop should re-attempt (`rateLimited`), and every transport already
 * shows `err.message` for one — but the two say different things to the person
 * reading. A rate limit clears in minutes and the wording says "shortly"; this
 * one clears on the first of the month, and telling somebody to try again in a
 * moment would be a lie.
 */
class AiBudgetError extends Error {
    constructor({ usedTokens, limitTokens, usedCost, limitCost, exceeded }) {
        super(exceeded === 'cost'
            ? `This server has reached its monthly AI budget ($${limitCost.toFixed(2)}). It resets at the start of next month.`
            : `This server has reached its monthly AI budget (${limitTokens.toLocaleString()} tokens). It resets at the start of next month.`);
        this.name = 'AiBudgetError';
        this.rateLimited = true;
        this.scope = 'guild';
        this.exceeded = exceeded;
        this.usedTokens = usedTokens;
        this.limitTokens = limitTokens;
        this.usedCost = usedCost;
        this.limitCost = limitCost;
    }
}

/**
 * What is left of a guild's monthly allowance, or null when it has none set (or
 * when the month's totals have not been read yet).
 *
 * Exported so the dashboard's usage panel shows the same number enforcement
 * uses, rather than a second calculation that can disagree with it.
 */
function monthlyBudgetState(guildId, limits) {
    if (!guildId) return null;
    // The shape is `usage.monthlyBudget`'s, shared with the dashboard panel so
    // the number on screen and the number doing the refusing cannot drift
    // apart. What differs is only where the totals come from: enforcement reads
    // the cache, because this call sits on a synchronous path.
    return monthlyBudget(peekMonthlyUsage(guildId), limits);
}

/**
 * Refuse a call that would spend past the guild's monthly ceiling.
 *
 * Both ceilings are optional and either one is enough to refuse: an operator
 * who thinks in dollars sets the cost one, one who thinks in tokens sets the
 * other, and a guild with neither is unbounded exactly as before.
 */
function enforceMonthlyBudget(guildId, rateLimit) {
    const state = monthlyBudgetState(guildId, rateLimit);
    if (!state) return;

    if (state.tokens && state.tokens.used >= state.tokens.limit) {
        throw new AiBudgetError({
            exceeded: 'tokens',
            usedTokens: state.tokens.used, limitTokens: state.tokens.limit,
            usedCost: state.cost?.used ?? 0, limitCost: state.cost?.limit ?? 0
        });
    }
    if (state.cost && state.cost.used >= state.cost.limit) {
        throw new AiBudgetError({
            exceeded: 'cost',
            usedTokens: state.tokens?.used ?? 0, limitTokens: state.tokens?.limit ?? 0,
            usedCost: state.cost.used, limitCost: state.cost.limit
        });
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

    // Widest bound first, and the only one that applies to a call nobody sent:
    // the scheduled digests and newspapers spend the same guild's money as
    // everybody else, and a ceiling they could route around would not be one.
    // Refusing here spends no per-user or per-channel slot, which matters —
    // the guild is out of budget either way and the person should not also
    // lose their own allowance to the refusal.
    enforceMonthlyBudget(guildId, rateLimit);

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
 *
 * `peek` on the returned function answers the same question without spending
 * anything. The toolkit uses it for a call that needs a person's approval: the
 * refusal can still be given before the buttons go up, while the slot is only
 * charged once somebody has said yes and the call is actually going to run.
 */
function toolCallBudget({ guildId, userId, rateLimit }) {
    // A call with nobody to charge it to is the scheduled work, and it gets a
    // budget of its own (#831) rather than the null that used to mean
    // unbounded. Keyed on the guild, since that is who pays for it.
    if (!userId) return guildId ? spender(`scheduled:${guildId}`, SCHEDULED_WINDOW_MS, SCHEDULED_TOOL_CALLS_PER_HOUR) : null;

    if (!rateLimit) return null;
    const { perUser, windowMin } = rateLimit;
    if (!perUser || perUser <= 0) return null;

    return spender(
        userRateLimitKey(guildId, userId),
        (windowMin || 10) * 60 * 1000,
        perUser * TOOL_CALLS_PER_MESSAGE
    );
}

/**
 * Spend one of this person's deep-task slots, and say whether there was one.
 *
 * Keyed per guild for the same reason the message window is: the allowance and
 * the API key being billed both belong to one server.
 */
function checkDeepTaskLimit(guildId, userId) {
    return deepTaskLimits.check(userRateLimitKey(guildId, userId), DEEP_TASK_WINDOW_MS, DEEP_TASKS_PER_WINDOW);
}

/** A budget function over one key, in the shape the MCP toolkit spends. */
function spender(key, windowMs, limit) {
    const budget = () => toolCallLimits.check(key, windowMs, limit);
    budget.peek = () => toolCallLimits.peek(key, windowMs, limit);
    return budget;
}

module.exports = {
    checkRateLimit,
    monthlyBudgetState,
    checkDeepTaskLimit,
    DEEP_TASKS_PER_WINDOW,
    DEEP_TASK_WINDOW_MS,
    enforceMonthlyBudget,
    AiBudgetError,
    SCHEDULED_TOOL_CALLS_PER_HOUR,
    checkChannelRateLimit,
    peekRateLimit,
    peekChannelRateLimit,
    enforceRateLimit,
    userRateLimitKey,
    toolCallBudget,
    TOOL_CALLS_PER_MESSAGE,
    AiRateLimitError
};
