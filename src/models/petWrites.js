'use strict';

// ── Pet arrays are never written whole by save() ─────────────────────────────
//
// `pets` and `deceasedPets` used to go back to the database as whole arrays.
// Every /pet command called `markModified('pets')`, and even without it
// Mongoose writes the whole array when one save both edits a pet and adds or
// removes one (a runaway, a splice, an adoption on top of hunger decay). A
// whole-array `$set` is the snapshot the command read, so it erased what the
// atomic pet writers did in between: the Pet of the Week ribbon and weekly
// counter reset, a ladder title, a PvP battle claim, the hunger-warning flags —
// and a pet that /use revive_scroll pushed was removed outright, the scroll
// already spent. `optimisticConcurrency` cannot catch it: atomic updates do
// not bump `__v` (see the note on it in User.js).
//
// What changed is worked out against a snapshot taken when the document was
// loaded (`snapshotPetArrays`, from a post-init hook), and written one of
// three ways, preferring whatever keeps it inside the save's own update:
//
//   1. Left to Mongoose, when its own write is already per entry: a lone
//      `$push` or `$pull`, or field edits by index with the array itself
//      unmarked. A rare drop or an adoption is therefore one write with the
//      rest of the save, as it always was.
//
//   2. Field edits only, with the array marked whole (what `markModified`
//      does): rewritten as the same per-field index paths, so they too ride
//      the save's own update. Indexes are safe here: no atomic writer removes
//      or reorders pets (they set fields, or `$push` at the end), and a save
//      that removed one bumped `__v`, which this save's version check catches.
//
//   3. Anything else (edits together with an addition or removal, a splice,
//      a runaway): taken out of the save and committed after it, naming each
//      pet by `_id` —
//        a. `$set` the changed fields, through arrayFilters on `_id`;
//        b. `$pull` removed pets together with the memorial `$push`, in one
//           update, so a runaway is never out of both arrays;
//        c. `$push` added pets, unless one with that `_id` is already there.
//      These run after the save lands, so a save that loses a version race
//      commits none of them, and each is safe to replay. Unlike the effect and
//      season commits they throw (after those have run): a pet that was not
//      added is a failure the caller has to answer.
//
// A field another writer changed and this flow did not is left alone; a pet
// another writer added or removed stays added or removed. Two writers that
// change the *same* field still race, last write wins, as with any `$set`.
//
// A document with no snapshot, such as one built with `new User(...)`, is left
// to Mongoose: its insert is the first write, with nothing stored to overwrite.

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
 * How one array differs from its snapshot: `edits` ({ index, id, key }),
 * `pulls` (ids), `pushes` (plain entries), and whether the surviving entries
 * are still in their loaded order. Null when nothing differs.
 *
 * An array with a `slice` limit (the memorial) never pulls: the only entries
 * a flow drops from it are the ones its own trim pushes out of the limit, and
 * the `$push`'s `$slice` does that trim against what is stored, so a record a
 * concurrent revive already took cannot make it pull one the limit would keep.
 */
function diffArray(snap, current, spec) {
    const edits = [], pulls = [], pushes = [], ids = [];
    let index = 0;
    for (const entry of current ?? []) {
        const data = plain(entry);
        const at = index++;
        if (data._id == null) continue;
        const id = String(data._id);
        ids.push(id);
        const before = snap.byId.get(id);
        if (!before) { pushes.push(data); continue; }
        for (const key of new Set([...Object.keys(before), ...Object.keys(data)])) {
            if (key === '_id') continue;
            if (canonical(data[key]) !== before[key]) edits.push({ index: at, id, key, value: data[key] });
        }
    }
    const now = new Set(ids);
    if (spec.slice == null) {
        for (const id of snap.order) if (!now.has(id)) pulls.push(id);
    }
    if (!edits.length && !pulls.length && !pushes.length) return null;
    const kept = snap.order.filter(id => now.has(id));
    const inOrder = kept.length === ids.length && kept.every((id, i) => id === ids[i]);
    return { edits, pulls, pushes, inOrder };
}

/** Every pending path at or under `path`. */
function pendingUnder(doc, path) {
    const defaults = doc.$__?.activePaths?.getStatePaths?.('default') ?? {};
    const all = new Set([
        ...(doc.modifiedPaths?.({ includeChildren: true }) ?? []),
        ...(doc.directModifiedPaths?.() ?? []),
        ...Object.keys(defaults),
    ]);
    return [...all].filter(p => p === path || p.startsWith(`${path}.`));
}

/** Whether Mongoose's own write for `path` will already be per entry (way 1). */
function mongooseWritesPerEntry(doc, path) {
    const ops = (doc.get(path)?.$__getAtomics?.() ?? []).map(([op]) => op);
    // Direct changes only: a pushed entry's own defaults are not edits.
    const direct = doc.directModifiedPaths?.() ?? [];
    const childEdits = direct.some(p => p.startsWith(`${path}.`));
    const marked = direct.includes(path);
    // A lone $push or $pull, even with the array marked (Mongoose still sends
    // the atomic), as long as no entry was also edited.
    if (!childEdits && ops.length === 1 && (ops[0] === '$push' || ops[0] === '$pull')) return true;
    // Edits by index, with the array itself untouched.
    return childEdits && !marked && !ops.includes('$push') && !ops.includes('$pull');
}

/**
 * Settle the pet arrays' part of the pending `save()` of a loaded document:
 * leave it to Mongoose, narrow it to per-field paths, or take it out and hand
 * it back for `applyPetWrites` to commit once the save lands.
 *
 * @returns {Array|null} the writes to commit after the save, or null
 */
function detachPetWrites(doc, limit) {
    if (!doc || doc.isNew) return null;
    const snap = doc.$locals?.[SNAPSHOT_KEY];
    if (!snap) return null;

    const out = [];
    for (const [path, spec] of Object.entries(arraySpecs(limit))) {
        if (!(path in snap) || !(typeof doc.isModified === 'function' && doc.isModified(path))) continue;
        if (snap[path] === null) {
            // Ids made up on load (see snapshotOf): write the array whole this
            // once, which stores them.
            doc.markModified(path);
            continue;
        }
        if (mongooseWritesPerEntry(doc, path)) continue;

        const diff = diffArray(snap[path], doc.get(path), spec);
        for (const p of pendingUnder(doc, path)) doc.unmarkModified(p);
        if (!diff) continue;

        if (!diff.pulls.length && !diff.pushes.length && diff.inOrder) {
            // Way 2: the same edits as per-field index paths in this save.
            for (const { index, key } of diff.edits) doc.markModified(`${path}.${index}.${key}`);
            continue;
        }
        out.push({ path, spec, ...diff });
    }
    return out.length ? out : null;
}

/**
 * Commit the writes detachPetWrites took out of a save (way 3). Each names its
 * pets by `_id`, so a pet another writer moved, added or removed in the
 * meantime is matched or left alone rather than overwritten.
 *
 * Throws on a failed write.
 */
async function applyPetWrites(Model, filter, writes) {
    if (!writes?.length) return;
    const toId = toObjectId(Model);

    // a. Field edits, one arrayFilter per pet.
    const $set = {}, $unset = {}, arrayFilters = [];
    writes.forEach((w, wi) => {
        const idents = new Map();
        for (const { id, key, value } of w.edits) {
            if (!idents.has(id)) {
                const ident = `e${wi}x${idents.size}`;
                idents.set(id, ident);
                arrayFilters.push({ [`${ident}._id`]: toId(id) });
            }
            const field = `${w.path}.$[${idents.get(id)}].${key}`;
            if (value === undefined) $unset[field] = '';
            else $set[field] = value;
        }
    });
    if (arrayFilters.length) {
        const update = {};
        if (Object.keys($set).length) update.$set = $set;
        if (Object.keys($unset).length) update.$unset = $unset;
        await Model.updateOne(filter, update, { arrayFilters });
    }

    // b. Removals, with any push to a *different* array (a runaway's memorial
    //    record), in one update. Guarded on that record not being there yet:
    //    if it is, an earlier commit already made this same update, removal
    //    included.
    // c. Then pushes to the arrays that also had removals.
    const pulled = new Set(writes.filter(w => w.pulls.length).map(w => w.path));
    const update = {}, guard = {};
    for (const w of writes) {
        if (w.pulls.length) (update.$pull ??= {})[w.path] = { _id: { $in: w.pulls.map(toId) } };
    }
    const later = [];
    for (const w of writes) {
        if (!w.pushes.length) continue;
        if (pulled.has(w.path)) { later.push(w); continue; }
        (update.$push ??= {})[w.path] = pushSpec(w);
        guard[`${w.path}._id`] = { $nin: w.pushes.map(p => p._id) };
    }
    if (Object.keys(update).length) await Model.updateOne({ ...filter, ...guard }, update);
    for (const w of later) {
        await Model.updateOne(
            { ...filter, [`${w.path}._id`]: { $nin: w.pushes.map(p => p._id) } },
            { $push: { [w.path]: pushSpec(w) } },
        );
    }
}

function pushSpec(w) {
    const each = { $each: w.pushes };
    if (w.spec.position != null) each.$position = w.spec.position;
    if (w.spec.slice != null) each.$slice = w.spec.slice;
    return each;
}

/** A string id back to the ObjectId the array stores, through the model's mongoose. */
function toObjectId(Model) {
    const { Types } = Model.base;
    return id => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id);
}

module.exports = {
    snapshotPetArrays, detachPetWrites, applyPetWrites,
    __test__: { canonical, diffArray, snapshotOf, mongooseWritesPerEntry },
};
