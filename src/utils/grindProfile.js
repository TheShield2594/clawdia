/**
 * Facade that bridges the legacy `user.fishing` / `user.hunt` / `user.mining` /
 * `user.exploration` access pattern onto the split GrindProfile collection.
 *
 * attachGrind(user) loads the user's grind profiles and assigns their data
 * onto the user object under the legacy property names, so the existing
 * service code (ensure*Data initializers, executeCast/executeHunt/etc.)
 * keeps working unchanged. It also wraps user.save() so that any save of the
 * user document transparently co-saves the attached profiles — preserving the
 * old "mutate user.<system>, markModified, save" contract.
 *
 * Notes:
 * - The grind fields no longer exist on the User schema, so assigning them is
 *   a plain JS property: user.save() ignores them, and legacy
 *   markModified('fishing') calls are harmless no-ops.
 * - ensure*Data() may REPLACE user.<system> with a fresh object for new
 *   players, so the wrapped save re-syncs prof.data from the user property
 *   before persisting.
 * - Profiles that were never touched (no data after the action) are not
 *   persisted, so casual users don't accumulate empty documents.
 */

const GrindProfile = require('../models/GrindProfile');

const SYSTEMS = ['fishing', 'hunt', 'mining', 'exploration'];

/**
 * Loads grind profiles for `user` and attaches their data under the legacy
 * property names. Loads all systems by default — cross-system reads are
 * common (synergies, fishing touches hunt consumables) and all profiles come
 * back in a single indexed query. Safe to call with null (returns null) and
 * idempotent per user object.
 */
async function attachGrind(user, systems = SYSTEMS) {
    if (!user) return user;
    user._grindProfiles ??= {};

    const missing = systems.filter(s => !user._grindProfiles[s]);
    if (missing.length > 0) {
        const profs = await GrindProfile.find({
            guildId: user.guildId,
            userId:  user.userId,
            system:  { $in: missing },
        });
        for (const system of missing) {
            const prof = profs.find(p => p.system === system)
                ?? new GrindProfile({ guildId: user.guildId, userId: user.userId, system });
            user._grindProfiles[system] = prof;
            user[system] = prof.data;
        }
    }

    wrapSave(user);
    return user;
}

/** Persists the attached profiles for `user` (subset via `systems`). */
async function saveGrind(user, systems = SYSTEMS) {
    if (!user?._grindProfiles) return;
    for (const system of systems) {
        const prof = user._grindProfiles[system];
        if (!prof) continue;
        prof.data = user[system];
        // Never persist a profile that holds no data (e.g. attached for a
        // read-only command on a user who has never touched the system).
        if (prof.data == null || (prof.isNew && Object.keys(prof.data).length === 0)) continue;
        prof.markModified('data');
        await prof.save();
    }
}

/**
 * Ensures the profile document for `system` exists in the database, so that
 * subsequent conditional findOneAndUpdate calls (purchases, raids) have a
 * document to match. No-op if it was already persisted.
 */
async function persistGrindIfNew(user, system) {
    const prof = user?._grindProfiles?.[system];
    if (!prof || !prof.isNew) return;
    await saveGrind(user, [system]);
}

function wrapSave(user) {
    if (user._grindSaveWrapped || typeof user.save !== 'function') return;
    user._grindSaveWrapped = true;
    const origSave = user.save.bind(user);
    user.save = async function (...args) {
        const res = await origSave(...args);
        await saveGrind(user);
        return res;
    };
}

module.exports = { attachGrind, saveGrind, persistGrindIfNew, GRIND_SYSTEMS: SYSTEMS };
