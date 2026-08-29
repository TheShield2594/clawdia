'use strict';

const { tryAcquire, release, DEFAULT_TTL_MS } = require('../../utils/activeGameLock');

/**
 * One turn at a time, per campaign (#837).
 *
 * `/dm action` reads the story log, spends an AI call on it, and writes the
 * result back. Nothing serialised those three steps, so two players acting at
 * the same moment both read the same history, both paid for a completion, and
 * both appended a narration written as though the other had not happened. The
 * log ends up with two mutually exclusive versions of the same moment in it,
 * and the HP write of whichever finished second was computed from a party
 * snapshot the first had already invalidated. `/dm begin` had the smaller
 * version of the same problem: it checks `storyLog.length === 0` and then
 * pushes, so two hosts clicking together get two opening scenes.
 *
 * The lease is the Mongo-backed one rather than the in-process queue in
 * `utils/userMutex.js`, for two reasons. It refuses instead of queueing, which
 * is the right answer here — a player who waits thirty seconds for their turn
 * gets a narration written against a story that moved on while they waited, and
 * would rather be told "someone is mid-turn, try again in a moment". And its
 * timeout does not fall through: `withUserLock` runs anyway once the wait
 * exceeds its bound, and an AI call routinely outruns that bound, so the very
 * turns worth serialising are the ones it would let through.
 *
 * The TTL is short because the thing it covers is one completion. A holder that
 * dies mid-turn — a crash between the model call and the write — costs the
 * channel one lease's worth of waiting, not the rest of the campaign.
 */

// Comfortably longer than a slow completion, comfortably shorter than a party's
// patience for a stuck session.
const TURN_TTL_MS = 90 * 1000;

function turnKey(sessionId) {
    return `dm:${sessionId}`;
}

/**
 * Run `fn` holding this session's turn, or answer `null` if somebody else has
 * it. Callers treat `null` as "tell the player to try again in a moment"; they
 * cannot treat it as a failure, because nothing was attempted.
 *
 * The release is in a `finally` so a throw inside the turn frees the campaign
 * rather than parking it until the TTL expires — and it is token-checked by
 * `activeGameLock`, so a turn that overran its lease cannot release the turn
 * that took over from it.
 *
 * @param {string} sessionId the `guildId:channelId` session key
 * @param {() => Promise<*>} fn the turn
 * @param {string} [activity] what the lease is held for, shown to whoever is
 *        turned away
 * @returns {Promise<*|null>} whatever `fn` returned, or null if not acquired
 */
async function withTurn(sessionId, fn, activity = 'a DM turn') {
    const token = await tryAcquire(turnKey(sessionId), TURN_TTL_MS, activity);
    if (!token) return null;

    try {
        return await fn();
    } finally {
        await release(turnKey(sessionId), token).catch(() => {});
    }
}

module.exports = { withTurn, turnKey, TURN_TTL_MS, DEFAULT_TTL_MS };
