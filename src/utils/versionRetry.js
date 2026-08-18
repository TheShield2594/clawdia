'use strict';

const { delay } = require('./delay');

// ── Optimistic concurrency helpers ───────────────────────────────────────────
//
// The User schema sets `optimisticConcurrency`, but Mongoose only bumps `__v` on
// `save()`. `findOneAndUpdate` / `updateOne` / `$inc` leave the version alone, so
// the guard fires on save-vs-save only — it says nothing about a save racing an
// atomic write. See the note on `userSchema.set('optimisticConcurrency', true)`.
//
// These helpers give the save-vs-save half one definition of "this write lost the
// race" and one place that decides how to retry, in place of ad-hoc
// `err.name === 'VersionError'` branches scattered across the handlers.

const DEFAULT_ATTEMPTS  = 3;
const DEFAULT_BACKOFF_MS = 25;

/**
 * True when a write failed because the document was modified between the read
 * and the save. Mongoose reports this as a `VersionError`.
 */
function isVersionError(err) {
    return !!err && err.name === 'VersionError';
}

/**
 * Re-read → mutate → save, retrying the whole unit when the save loses a version
 * race.
 *
 * Only use this where the mutation is a pure function of the freshly loaded
 * document. A handler that has already rolled dice, awarded a reward, or sent a
 * message cannot be replayed — its mutation is not derivable from the document
 * alone, and re-running it would roll or award twice. Those call sites should
 * keep reporting the conflict to the user, using `isVersionError` to detect it.
 *
 * @param {() => Promise<object|null>} load   Re-reads the document. Called once per attempt.
 * @param {(doc: object, attempt: number) => any} mutate  Applies the change. Return
 *        `false` to abort without saving (the precondition no longer holds).
 * @param {{attempts?: number, backoffMs?: number, label?: string}} [opts]
 * @returns {Promise<object|null>} The saved document, or null if `load` found
 *          nothing or `mutate` aborted.
 * @throws  The last `VersionError` if every attempt lost, or any other error verbatim.
 */
async function withVersionRetry(load, mutate, opts = {}) {
    const attempts  = opts.attempts  ?? DEFAULT_ATTEMPTS;
    const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const label     = opts.label     ?? 'save';

    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const doc = await load();
        if (!doc) return null;

        if ((await mutate(doc, attempt)) === false) return null;

        try {
            await doc.save();
            return doc;
        } catch (err) {
            if (!isVersionError(err)) throw err;
            lastErr = err;
            if (attempt < attempts) await delay(backoffMs * attempt);
        }
    }

    console.warn(`[versionRetry] ${label} lost ${attempts} version races; giving up`);
    throw lastErr;
}

module.exports = { isVersionError, withVersionRetry, DEFAULT_ATTEMPTS };
