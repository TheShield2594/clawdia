'use strict';

/**
 * Getting a JSON object back out of a chat model.
 *
 * `/forge` and `/questgen` both ask a model for one JSON object and both had
 * their own copy of the same three-step recovery: strip the markdown fence the
 * model was told not to use, cut everything outside the outermost braces, and
 * ask again with a bigger token budget when what came back would not parse.
 * Two copies of the most delicate parsing in the tree, neither of them tested
 * (#830). This is that logic, once.
 *
 * Everything here is about the ways a model's answer differs from the answer it
 * was asked for. A model that is up, authenticated and inside its rate limit can
 * still hand back a fence, a sentence of preamble, or a string cut in half
 * because the budget ran out mid-token — and only the last of those is worth
 * spending another request on.
 */

// The budgets a caller retries through, in order. The first is what the answer
// costs; the second is what it costs when the model spent most of the first on
// hidden reasoning before the visible JSON — Gemini 2.5 and the OpenAI o-series
// both do, and a tight budget then truncates the object mid-string.
const DEFAULT_TOKEN_BUDGETS = [700, 1600];

/**
 * The JSON object in `raw`, or null when there is nothing that parses.
 *
 * Null rather than a throw: the caller retries on this, and "the model wrote
 * prose" and "the model wrote half an object" are the same answer here — try
 * again with more room, then give up.
 */
function extractJson(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;

    // The fence the prompt asked the model not to use. Removed rather than
    // parsed around, because it can arrive with or without a language tag and
    // with the closing half missing entirely on a truncated response.
    const cleaned = raw.replace(/```json|```/gi, '').trim();

    // The outermost braces, so a sentence of preamble or a sign-off after the
    // object does not fail the parse. Nested objects are unaffected: the first
    // `{` and the last `}` are the outer object's own.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const slice = start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;

    let parsed;
    try {
        parsed = JSON.parse(slice);
    } catch {
        return null;
    }
    // A model asked for an object can answer with a bare number or an array,
    // and every caller here reads properties off what it gets back.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/**
 * Ask for a JSON object, growing the token budget until one arrives.
 *
 * `run(maxTokens)` makes one request and returns the model's text. It is called
 * once per budget, and only for the failures a bigger budget can fix: anything
 * `run` itself throws — an auth error, the guild's rate limit, a dropped
 * connection — propagates immediately, because asking again with more tokens
 * would fail the same way and cost the user another wait.
 *
 * @param {(maxTokens: number) => Promise<string>} run
 * @param {object} [options]
 * @param {number[]} [options.budgets] token budgets to try, in order
 * @returns {Promise<object>} the parsed object
 * @throws {Error} when every budget came back unparseable
 */
async function requestModelJson(run, { budgets = DEFAULT_TOKEN_BUDGETS } = {}) {
    let lastRaw = '';
    for (const maxTokens of budgets) {
        lastRaw = await run(maxTokens);
        const parsed = extractJson(lastRaw);
        if (parsed) return parsed;
    }

    // The tail is what a model that answered in prose actually said, which is
    // the difference between "it refused" and "it was cut off" in a log.
    const tail = String(lastRaw ?? '').trim().slice(0, 200);
    const err = new Error(`the model did not return JSON${tail ? `: ${tail}` : ''}`);
    err.modelJson = true;
    throw err;
}

module.exports = { extractJson, requestModelJson, DEFAULT_TOKEN_BUDGETS };
