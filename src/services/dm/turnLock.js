'use strict';

const { tryAcquire, release, DEFAULT_TTL_MS } = require('../../utils/activeGameLock');
const { MAX_TOOL_ROUNDS, TURN_BUDGET_MS } = require('../ai/mcp/toolkit');

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
 * The TTL has to outlast the whole turn, not a typical one. A lease that expires
 * while its holder is still waiting on a provider does not fail safe: the next
 * player acquires the same key, and the two turns this exists to serialise run
 * side by side — with the difference that nobody is being told to try again, so
 * the failure is silent. Weighed against that, the cost of a long TTL is that a
 * holder which dies mid-turn (a crash between the model call and the write)
 * blocks the channel until the lease expires. That is the cheaper mistake: it
 * announces itself, and it recovers on its own.
 *
 * So the ceiling is derived rather than guessed. A turn is at most one model
 * request per tool round plus a final one, each bounded by the longest
 * per-request timeout any provider here sets, plus the tool loop's own budget.
 */

// Ollama's axios timeout, which is the longest per-request ceiling in
// providers/ — the OpenAI and Anthropic SDKs are left on their own defaults and
// the toolkit's budget below is what actually bounds those turns.
const PROVIDER_REQUEST_TIMEOUT_MS = 120 * 1000;

// Every round makes one request, and the round after the last tool call makes
// the one that answers.
const TURN_TTL_MS = (MAX_TOOL_ROUNDS + 1) * PROVIDER_REQUEST_TIMEOUT_MS + TURN_BUDGET_MS;

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
