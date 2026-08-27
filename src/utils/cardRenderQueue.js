'use strict';

/**
 * Admission control for canvas cards rendered off a gateway event.
 *
 * A join raid is the worst-case load pattern the bot has: hundreds of
 * `guildMemberAdd` events arrive back to back, and before #592 each one drew and
 * synchronously encoded an 800×300 welcome card on the main thread, with no
 * concurrency cap and no ceiling of any kind. `utils/imageRateLimit.js` existed
 * but guarded only the slash commands a *person* can spam — not the path a
 * raider drives for free.
 *
 * Three limits, in the order they apply:
 *
 *   1. A per-guild sliding window. Past `GUILD_LIMIT` cards a minute the answer
 *      is simply no, and the caller sends the plain embed instead. This is the
 *      one that actually caps the work; the rest only shape it.
 *   2. A concurrency cap. Drawing is main-thread work no queue can remove, but
 *      running two renders at a time rather than three hundred bounds how many
 *      avatar downloads and full-size pixel buffers are alive at once.
 *   3. A bounded wait queue. Waiting is only worth doing if the card will still
 *      be worth sending when its turn comes; past `MAX_QUEUED` waiters the
 *      answer is no again, which is what keeps a raid from converting into an
 *      unbounded backlog of pending renders.
 *
 * Every "no" is a `null` return, never a throw: refusing to draw a card is a
 * degrade to the plain embed, not an error.
 */

const { BoundedRateLimiter } = require('./boundedRateLimiter');

/** Renders allowed to run at once, process-wide. */
const MAX_CONCURRENT = 2;

/** Renders allowed to wait for a slot. Past this, callers are refused outright. */
const MAX_QUEUED = 8;

const GUILD_WINDOW_MS = 60_000;

/** Cards per guild per window. Comfortably above an organic join rate. */
const GUILD_LIMIT = 20;

let guildLimiter = new BoundedRateLimiter(5_000);
setInterval(() => guildLimiter.cleanup(GUILD_WINDOW_MS), GUILD_WINDOW_MS).unref();

let active = 0;
/** @type {Array<(admitted: boolean) => void>} */
const waiters = [];

/**
 * Takes one of the `MAX_CONCURRENT` slots, waiting if the queue has room.
 * Resolves false when it does not.
 */
function acquire() {
    if (active < MAX_CONCURRENT) {
        active++;
        return Promise.resolve(true);
    }
    if (waiters.length >= MAX_QUEUED) return Promise.resolve(false);
    return new Promise(resolve => waiters.push(resolve));
}

/**
 * Hands the slot straight to the next waiter rather than releasing and
 * re-acquiring it, so `active` never dips below the cap while work is queued —
 * and, more importantly, so a waiter cannot be skipped by a fresh caller
 * arriving in the same tick.
 */
function release() {
    const next = waiters.shift();
    if (next) next(true);
    else active--;
}

/**
 * Runs `render` under the limits above.
 *
 * @param {string} guildId the guild the card is for; the rate window is per guild.
 * @param {() => Promise<Buffer>} render
 * @returns {Promise<Buffer|null>} null when the render was refused.
 *
 * The per-guild slot is spent before the queue is consulted, so a card refused
 * for a full queue still counts against the window. That is deliberate: both
 * refusals mean "this guild is generating more cards than it can be served",
 * and both degrade to the same plain embed, so counting them errs toward
 * shedding load sooner during exactly the burst the limit exists for.
 */
async function renderQueued(guildId, render) {
    if (!guildLimiter.check(String(guildId), GUILD_WINDOW_MS, GUILD_LIMIT)) return null;
    if (!await acquire()) return null;

    try {
        return await render();
    } finally {
        release();
    }
}

/** Test seam: drops the rate window and the in-flight accounting. */
function _resetCardRenderQueue() {
    guildLimiter = new BoundedRateLimiter(5_000);
    active = 0;
    while (waiters.length) waiters.shift()(false);
}

module.exports = {
    renderQueued,
    _resetCardRenderQueue,
    MAX_CONCURRENT,
    MAX_QUEUED,
    GUILD_LIMIT,
    GUILD_WINDOW_MS,
};
