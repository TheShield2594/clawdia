'use strict';

// ── Pet arrays are never written whole by save() ─────────────────────────────
//
// `pets` and `deceasedPets` used to go back to the database as whole arrays.
// Every /pet command called `markModified('pets')`, and even without it
// Mongoose writes the whole array when one save both edits a pet and adds or
// removes one (a runaway, an adoption, a rare drop on top of hunger decay).
// A whole-array `$set` is the snapshot the command read, so it erased what the
// atomic pet writers did in between: the Pet of the Week ribbon and weekly
// counter reset, a ladder title, a PvP battle claim, the hunger-warning flags —
// and a pet that /use revive_scroll pushed was removed outright, the scroll
// already spent. `optimisticConcurrency` cannot catch it: atomic updates do
// not bump `__v` (see the note on it in User.js).
//
// So the arrays are taken out of the save, the way `activeEffects` and the
// season fields are, and committed after it as writes that name each pet by
// `_id` and each field by name:
//
//   1. `$set` the fields that changed, per pet, through arrayFilters on `_id`
//   2. `$pull` the pets the flow removed, by `_id`
//   3. `$push` the pets the flow added, unless a pet with that `_id` is there
//
// A field another writer changed and this flow did not is left alone; a pet
// another writer added or removed stays added or removed. Two writers that
// change the *same* field still race, last write wins, as with any `$set`.
//
// What changed is worked out against a snapshot taken when the document was
// loaded (`snapshotPetArrays`, from a post-init hook). A document with no
// snapshot, such as one built with `new User(...)` and not yet inserted, is
// left to Mongoose: its insert is the first write, with nothing stored to
// overwrite.
//
// The three writes are made after the save lands, so a save that loses a
// version race commits none of them and a retry recomputes them from a fresh
// read. Unlike the effect and season writes they *do* throw: a pet that was
// adopted but not pushed is a failure the caller has to answer (/pet adopt
// refunds its fee on one), not something to log and carry on from.

const SNAPSHOT_KEY = 'petSnapshot';

// Each array this covers, and how an added entry goes in. The memorial keeps
// the newest runaway first and holds DECEASED_PET_LIMIT, so a push goes to the
// front and trims the tail, as the flow's own `unshift` + `slice` did.
function arraySpecs(limit) {
    return {
        pets:         {},
        deceasedPets: { position: 0, slice: limit },
    };
}

/** A value reduced to something two copies of it compare equal by. */
function canonical(value) {
    if (value === undefined) return undefined;
    return JSON.stringify(normalize(value));
}

function normalize(value) {
    if (value == null) return null;
    if (value instanceof Date) return { $date: value.getTime() };
    if (typeof value?.toHexString === 'function') return { $oid: value.toHexString() };
    if (typeof value?.toObject === 'function') return normalize(value.toObject({ depopulate: true }));
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined) out[key] = normalize(value[key]);
        }
        return out;
    }
    return value;
}

/** A subdocument as plain data, `_id` included. */
function plain(entry) {
    return typeof entry?.toObject === 'function' ? entry.toObject({ depopulate: true }) : { ...entry };
}

/**
 * `{ order: [id], byId: Map<id, { field: canonical }> }` for one array, or
 * null when an entry has no `_id` of its own in the database.
 *
 * Mongoose gives an entry stored without an `_id` a fresh one every time the
 * document loads, so a write naming it by that `_id` would match nothing and
 * be lost without a word. Such an array is left to Mongoose's own write for
 * that save, which stores the ids, and every save after it diffs as normal.
 */
function snapshotOf(entries) {
    const order = [];
    const byId = new Map();
    for (const entry of entries ?? []) {
        if (typeof entry?.$isDefault === 'function' && entry.$isDefault('_id')) return null;
        const data = plain(entry);
        if (data._id == null) return null;
        const id = String(data._id);
        const fields = {};
        for (const [key, val] of Object.entries(data)) {
            if (key !== '_id') fields[key] = canonical(val);
        }
        order.push(id);
        byId.set(id, fields);
    }
    return { order, byId };
}

/**
 * Remember the pet arrays as loaded, for detachPetWrites to diff against.
 * Arrays the query did not select are skipped: they cannot be modified.
 */
function snapshotPetArrays(doc, limit) {
    if (!doc?.$locals) return;
    const snap = {};
    for (const path of Object.keys(arraySpecs(limit))) {
        if (typeof doc.isSelected === 'function' && !doc.isSelected(path)) continue;
        snap[path] = snapshotOf(doc.get(path));
    }
    doc.$locals[SNAPSHOT_KEY] = snap;
}

/**
 * The writes that take one array from its snapshot to its current state:
 * `{ sets, unsets, filters, pulls, pushes }`, or null when nothing changed.
 */
function diffArray(path, snap, current, spec, tag) {
    const sets = {}, unsets = {}, filters = [], pulls = [], pushes = [];
    const now = new Map();
    for (const entry of current ?? []) {
        const data = plain(entry);
        if (data._id == null) continue;
        now.set(String(data._id), data);
    }

    let n = 0;
    for (const [id, data] of now) {
        const before = snap.byId.get(id);
        if (!before) { pushes.push(data); continue; }
        const changed = [];
        for (const key of new Set([...Object.keys(before), ...Object.keys(data)])) {
            if (key === '_id') continue;
            if (canonical(data[key]) !== before[key]) changed.push(key);
        }
        if (!changed.length) continue;
        const ident = `${tag}${n++}`;
        filters.push({ [`${ident}._id`]: data._id });
        for (const key of changed) {
            if (data[key] === undefined) unsets[`${path}.$[${ident}].${key}`] = '';
            else sets[`${path}.$[${ident}].${key}`] = data[key];
        }
    }
    for (const id of snap.order) {
        if (!now.has(id)) pulls.push(id);
    }

    if (!filters.length && !pulls.length && !pushes.length) return null;
    return { path, spec, sets, unsets, filters, pulls, pushes };
}

/** Whether anything at or under `path` is waiting to be saved. */
function touched(doc, path) {
    return typeof doc.isModified === 'function' && doc.isModified(path);
}

/**
 * Take the pet arrays out of the pending `save()` of a loaded document, and
 * hand back the writes for `applyPetWrites` to commit once the save lands.
 *
 * @returns {Array|null} one entry per array that changed, or null
 */
function detachPetWrites(doc, limit) {
    if (!doc || doc.isNew) return null;
    const snap = doc.$locals?.[SNAPSHOT_KEY];
    if (!snap) return null;

    const specs = arraySpecs(limit);
    const out = [];
    const detached = [];
    for (const [path, spec] of Object.entries(specs)) {
        if (!(path in snap) || !touched(doc, path)) continue;
        if (snap[path] === null) {
            // Ids made up on load (see snapshotOf): write the array whole this
            // once, which stores them.
            doc.markModified(path);
            continue;
        }
        const diff = diffArray(path, snap[path], doc.get(path), spec, path === 'pets' ? 'p' : 'd');
        if (diff) out.push(diff);
        detached.push(path);
    }
    if (!detached.length) return null;

    const defaults = doc.$__?.activePaths?.getStatePaths?.('default') ?? {};
    const pending = new Set([
        ...(doc.modifiedPaths?.({ includeChildren: true }) ?? []),
        ...(doc.directModifiedPaths?.() ?? []),
        ...Object.keys(defaults),
    ]);
    for (const p of pending) {
        if (detached.some(path => p === path || p.startsWith(`${path}.`))) doc.unmarkModified(p);
    }
    return out.length ? out : null;
}

/**
 * Commit detached pet writes: field sets, then removals, then additions. Each
 * names its pets by `_id`, so a pet another writer moved, added or removed in
 * the meantime is matched or left alone rather than overwritten.
 *
 * Throws on a failed write, so the caller's `save()` rejects.
 */
async function applyPetWrites(Model, filter, writes) {
    if (!writes?.length) return;

    const $set = {}, $unset = {}, arrayFilters = [];
    for (const w of writes) {
        Object.assign($set, w.sets);
        Object.assign($unset, w.unsets);
        arrayFilters.push(...w.filters);
    }
    if (arrayFilters.length) {
        const update = {};
        if (Object.keys($set).length) update.$set = $set;
        if (Object.keys($unset).length) update.$unset = $unset;
        await Model.updateOne(filter, update, { arrayFilters });
    }

    const $pull = {};
    for (const w of writes) {
        if (w.pulls.length) $pull[w.path] = { _id: { $in: w.pulls.map(toObjectId(Model)) } };
    }
    if (Object.keys($pull).length) await Model.updateOne(filter, { $pull });

    for (const w of writes) {
        if (!w.pushes.length) continue;
        const each = { $each: w.pushes };
        if (w.spec.position != null) each.$position = w.spec.position;
        if (w.spec.slice != null) each.$slice = w.spec.slice;
        // Only while none of them is there yet, so a replayed commit cannot
        // add a second copy.
        await Model.updateOne(
            { ...filter, [`${w.path}._id`]: { $nin: w.pushes.map(p => p._id) } },
            { $push: { [w.path]: each } },
        );
    }
}

/** A string id back to the ObjectId the array stores, through the model's mongoose. */
function toObjectId(Model) {
    const { Types } = Model.base;
    return id => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id);
}

module.exports = { snapshotPetArrays, detachPetWrites, applyPetWrites, __test__: { canonical, diffArray, snapshotOf } };
