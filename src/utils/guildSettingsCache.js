'use strict';

/**
 * Short-lived cache for guild configuration on the hot read paths.
 *
 * Every message and every slash command used to issue its own
 * `Guild.findOne({ guildId })`, which loads and hydrates the entire guild
 * document. On a busy server that is one full document read per message, and
 * it is the single biggest scaling limit in the bot. The read here excludes
 * the shop's inline `imageData` Buffers (see HEAVY_FIELDS_PROJECTION), and
 * telemetry lives in its own GuildAnalytics collection, so the heavyweight
 * parts of the old document never enter the heap on this path.
 *
 * Two properties make this safe to share between callers:
 *
 *   1. Entries are plain objects (`doc.toObject()`), not Mongoose documents, so
 *      a caller cannot call `.save()` on a shared instance and write another
 *      caller's view back to the database. Defaults still apply, because the
 *      document is hydrated by `findOne` before being converted — a `.lean()`
 *      read would skip defaults and hand back `undefined` for any field added
 *      to the schema after a guild's document was last written.
 *   2. Only read-only paths use it. `messageCreate` and `interactionCreate`
 *      never mutate or persist the settings object they receive; every writer
 *      (commands, dashboard routes, background services) goes through the
 *      model directly and is unaffected.
 *
 * Cached objects must be treated as immutable. Nothing enforces that, so a
 * caller that mutates one corrupts the view every other caller sees until the
 * entry expires.
 *
 * Invalidation is driven by Mongoose middleware registered in models/Guild.js
 * rather than by callers remembering to invalidate, so it cannot drift as write
 * sites are added. The TTL is a backstop for anything that writes around the
 * model (a direct driver call, or another process sharing the database).
 */

const DEFAULT_TTL_MS = 30_000;

// Bounds memory if the bot is in a very large number of guilds. Eviction is
// FIFO by insertion order; an evicted guild simply re-reads on its next message.
const MAX_ENTRIES = 5_000;

const cache = new Map();   // guildId -> { expiresAt, settings }
const inFlight = new Map(); // guildId -> Promise, collapses concurrent misses

// Guilds invalidated while a read for them was still in flight. Bounded by
// inFlight: an id is only ever added when a read is outstanding, and is removed
// when that read resolves. See the check in getGuildSettings for why.
const staleInFlight = new Set();

let ttlMs = DEFAULT_TTL_MS;
let hits = 0;
let misses = 0;

// Heavy payloads nothing on the cached read paths (messageCreate,
// interactionCreate) ever looks at. Excluded so a guild with a fully
// illustrated shop does not pin megabytes of image Buffers in this cache.
// Exclusion projection on a hydrated read still applies schema defaults to
// every other field.
const HEAVY_FIELDS_PROJECTION = '-shop.imageData';

// Required lazily: models/Guild.js registers invalidation hooks that reach back
// into this module, and a top-level require in both directions would leave one
// of them holding a half-initialised exports object.
function getGuildModel() {
    return require('../models/Guild');
}

/**
 * Returns this guild's settings as a plain, shared, read-only object, or null
 * if no document exists yet.
 */
async function getGuildSettings(guildId) {
    if (!guildId) return null;

    const entry = cache.get(guildId);
    if (entry && entry.expiresAt > Date.now()) {
        hits++;
        return entry.settings;
    }

    // A burst of messages arriving on a cold entry should issue one query, not
    // one per message.
    const pending = inFlight.get(guildId);
    if (pending) return pending;

    misses++;
    const promise = (async () => {
        const doc = await getGuildModel().findOne({ guildId }, HEAVY_FIELDS_PROJECTION);
        // Misses are not cached: a missing document is a first-message event,
        // and caching the absence would delay the freshly created settings.
        if (!doc) return null;

        // findOne returns a hydrated document, whose toObject() yields a plain
        // deep copy with schema defaults applied. Tolerate an already-plain
        // object too, so a lean() read introduced later degrades to a working
        // cache rather than a crash on every message.
        const settings = typeof doc.toObject === 'function' ? doc.toObject() : doc;

        // A write that landed while this read was in flight has already been
        // applied to the database but is not reflected in `settings`. Deleting a
        // cache entry cannot undo a read that has not stored one yet, so without
        // this check the pre-write snapshot would be installed *after* the
        // invalidation and served for a full TTL. Hand the value to the callers
        // that are waiting on it, but do not cache it.
        if (staleInFlight.delete(guildId)) return settings;

        if (cache.size >= MAX_ENTRIES && !cache.has(guildId)) {
            cache.delete(cache.keys().next().value);
        }
        cache.set(guildId, { expiresAt: Date.now() + ttlMs, settings });
        return settings;
    })();

    inFlight.set(guildId, promise);
    try {
        return await promise;
    } finally {
        inFlight.delete(guildId);
        staleInFlight.delete(guildId);
    }
}

/** Drops one guild's entry. Called by the model's write hooks. */
function invalidateGuildSettings(guildId) {
    if (!guildId) return;
    cache.delete(guildId);
    // Also poison any read already in flight, which would otherwise install a
    // snapshot taken before this write.
    if (inFlight.has(guildId)) staleInFlight.add(guildId);
}

/** Drops every entry — used when a write's scope cannot be determined. */
function clearGuildSettingsCache() {
    cache.clear();
    for (const guildId of inFlight.keys()) staleInFlight.add(guildId);
}

/**
 * Invalidation handler for a saved Guild document. `Model.create()` routes
 * through `save()`, so this covers document creation too.
 */
function onGuildDocumentSaved(doc) {
    invalidateGuildSettings(doc?.guildId);
}

// Top-level Guild fields that are recorded telemetry rather than configuration.
// Nothing on the cached read paths looks at them, so a write touching only these
// need not evict the entry.
//
// The per-command and per-join telemetry writers now target the separate
// GuildAnalytics collection and never pass through here at all; 'analytics'
// stays listed so a straggling write to a not-yet-migrated document (or a
// rollback) still does not evict each active guild continuously.
const NON_SETTINGS_ROOTS = new Set(['analytics']);

/**
 * True when an update document modifies nothing outside NON_SETTINGS_ROOTS.
 *
 * `$setOnInsert` is skipped rather than inspected: it only applies when the
 * update inserts a new document, and a guild that did not exist has nothing
 * cached (misses are never cached).
 */
function touchesOnlyNonSettings(update) {
    if (!update || typeof update !== 'object') return false;

    const paths = [];
    for (const [key, value] of Object.entries(update)) {
        if (key === '$setOnInsert') continue;
        if (key.startsWith('$')) {
            if (value && typeof value === 'object') paths.push(...Object.keys(value));
            else return false; // unrecognised operator shape — assume it matters
        } else {
            paths.push(key);
        }
    }

    if (!paths.length) return false;
    return paths.every(path => NON_SETTINGS_ROOTS.has(path.split('.')[0]));
}

/**
 * Invalidation handler for a Guild *query* write (findOneAndUpdate, updateOne,
 * deleteMany, ...). The filter is almost always `{ guildId }`, which lets a
 * single entry be dropped. Anything broader — a bulk update, or a filter keyed
 * on something else — cannot be attributed to one guild, so the whole cache is
 * dropped rather than left serving values the write may have changed.
 */
function onGuildQueryWrite(query) {
    if (touchesOnlyNonSettings(query?.getUpdate?.())) return;

    const guildId = query?.getFilter?.()?.guildId;
    if (typeof guildId === 'string') invalidateGuildSettings(guildId);
    else clearGuildSettingsCache();
}

/** Test seam: override the TTL. Returns the previous value. */
function setGuildSettingsTtl(ms) {
    const previous = ttlMs;
    ttlMs = ms;
    return previous;
}

function getGuildSettingsCacheStats() {
    return { size: cache.size, hits, misses, ttlMs };
}

module.exports = {
    getGuildSettings,
    invalidateGuildSettings,
    clearGuildSettingsCache,
    onGuildDocumentSaved,
    onGuildQueryWrite,
    setGuildSettingsTtl,
    getGuildSettingsCacheStats,
};
