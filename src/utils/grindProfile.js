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
 * - A save only writes the systems the flow actually marked. `prof.data` is
 *   replaced wholesale, so writing an untouched system would push a snapshot read
 *   at load time back over anything that changed in between — which is how a
 *   /mine raid's material transfer could be undone by an unrelated /fish cast
 *   that merely had the mining profile attached for a cross-system read.
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
            user._grindSnapshots ??= {};
            user._grindSnapshots[system] = snapshot(prof.data);
        }
    }

    wrapSave(user);
    return user;
}

/**
 * Snapshot of a profile's data as loaded, used to tell a flow that changed a system
 * from one that merely had it attached for a cross-system read.
 */
function snapshot(data) {
    try {
        return JSON.stringify(data ?? null);
    } catch {
        // Anything uncomparable is treated as changed — a redundant write is safe,
        // a skipped one is not.
        return null;
    }
}

function grindChanged(user, system) {
    const before = user._grindSnapshots?.[system];
    if (before === undefined) return true;
    const after = snapshot(user[system]);
    return after === null || after !== before;
}

/**
 * Persists the attached profiles for `user`.
 *
 * With no `systems` argument this writes only the profiles whose data actually
 * differs from what was loaded. `prof.data` is replaced wholesale, so writing back
 * an untouched system would push a load-time snapshot over anything that changed in
 * the meantime — which is how a /mine raid's material transfer could be undone by
 * an unrelated /fish cast that had the mining profile attached only to read it.
 *
 * Comparison is by content rather than by markModified: a mutation site that forgot
 * to mark would otherwise stop persisting silently, which is a worse failure than a
 * redundant write. Pass `systems` explicitly to force a write regardless.
 */
async function saveGrind(user, systems = null) {
    if (!user?._grindProfiles) return;
    const targets = systems ?? SYSTEMS.filter(system => grindChanged(user, system));
    for (const system of targets) {
        const prof = user._grindProfiles[system];
        if (!prof) continue;
        prof.data = user[system];
        // Never persist a profile that holds no data (e.g. attached for a
        // read-only command on a user who has never touched the system).
        if (prof.data == null || (prof.isNew && Object.keys(prof.data).length === 0)) continue;
        prof.markModified('data');
        await prof.save();
        if (user._grindSnapshots) user._grindSnapshots[system] = snapshot(prof.data);
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
