'use strict';

/**
 * An in-memory stand-in for a Mongoose model, implementing the query and update
 * shapes this codebase's economy commands actually issue.
 *
 * #786: the economy commands were untested not because they resist testing but
 * because every one of them opens with a guarded `findOneAndUpdate` — the
 * cooldown compare-and-set, the `balance: { $gte: cost }` debit — and a mock
 * that cannot evaluate the guard cannot tell the happy path from the refusal.
 * tests/robBalanceWrite.test.js and tests/giftItemTransfer.test.js each wrote
 * their own; this is the shared one, and it is deliberately strict: an operator
 * it does not implement throws rather than being ignored, because a guard that
 * silently evaluates to "matched" turns a refusal test green.
 *
 *   const mockUsers = fakeCollection('User');
 *   jest.mock('../src/models/User', () => mockUsers.model);
 *   mockUsers.seed({ userId: 'u1', guildId: 'g1', balance: 500 });
 *   mockUsers.writes  // every update that was applied, in order
 *   mockUsers.get('u1')
 *
 * The `mock` prefix is not decoration: jest hoists `jest.mock` above the file's
 * own declarations and refuses a factory that closes over anything else.
 */

const { applyPipelineUpdate, evaluate } = require('./pipelineUpdate');

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** Mongo compares dates by value; `===` on two Date objects never matches. */
function equals(a, b) {
    if (a instanceof Date || b instanceof Date) {
        if (a == null || b == null) return (a ?? null) === (b ?? null);
        return new Date(a).getTime() === new Date(b).getTime();
    }
    return a === b;
}

function compare(a, b) {
    const av = a instanceof Date ? a.getTime() : a;
    const bv = b instanceof Date ? b.getTime() : b;
    return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * A dotted path that crosses an array yields that field's value from every
 * element, the way Mongo resolves `deceasedPets._id` — and the way a query on
 * such a path matches if *any* element matches.
 */
function getPath(doc, path) {
    return path.split('.').reduce((cur, key) => {
        if (cur == null) return undefined;
        if (Array.isArray(cur) && !/^\d+$/.test(key)) {
            return cur.map(el => el?.[key]).filter(v => v !== undefined);
        }
        return cur[key];
    }, doc);
}

/** True if `value` matches, or — when the path crossed an array — any of it does. */
function anyMatch(value, test) {
    if (Array.isArray(value)) return value.some(test);
    return test(value);
}

function setPath(doc, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let cur = doc;
    for (const key of keys) {
        if (cur[key] == null) cur[key] = {};
        cur = cur[key];
    }
    cur[last] = value;
}

const OPERATORS = new Set(['$gte', '$gt', '$lte', '$lt', '$ne', '$in', '$nin', '$eq', '$elemMatch', '$exists', '$not']);

/** One `{ field: condition }` clause. Records the positional index for `$elemMatch`. */
function matchesField(doc, field, condition, state) {
    if (isPlainObject(condition) && Object.keys(condition).some(k => k.startsWith('$'))) {
        for (const [op, operand] of Object.entries(condition)) {
            if (!OPERATORS.has(op)) throw new Error(`fakeCollection: unsupported operator ${op} on ${field}`);
            const value = getPath(doc, field);
            switch (op) {
                case '$gte': if (!anyMatch(value, v => v != null && compare(v, operand) >= 0)) return false; break;
                case '$gt':  if (!anyMatch(value, v => v != null && compare(v, operand) > 0)) return false; break;
                case '$lte': if (!anyMatch(value, v => v != null && compare(v, operand) <= 0)) return false; break;
                case '$lt':  if (!anyMatch(value, v => v != null && compare(v, operand) < 0)) return false; break;
                case '$ne':  if (anyMatch(value, v => equals(v, operand))) return false; break;
                case '$eq':  if (!anyMatch(value, v => equals(v, operand))) return false; break;
                case '$in':  if (!anyMatch(value, v => operand.some(o => equals(v, o)))) return false; break;
                case '$nin': if (anyMatch(value, v => operand.some(o => equals(v, o)))) return false; break;
                case '$exists': if ((value !== undefined) !== operand) return false; break;
                // `{ field: { $not: { $gt: x } } }`. Mongo's `$not` also
                // matches a document where the field is absent, which is what
                // falling through to matchesField gives: a missing value fails
                // the inner operator, so negating it succeeds. `/invest`
                // filters on `activeUntil: { $not: { $gt: now } }` — "not
                // currently active", where never-activated is null — so a mock
                // without this cannot run the command at all.
                case '$not': {
                    // Its own state: a nested $elemMatch here binds nothing, and
                    // letting it write into the caller's would aim a positional
                    // update at an element the query did not match.
                    if (matchesField(doc, field, operand, { positional: {} })) return false;
                    break;
                }
                case '$elemMatch': {
                    const array = value ?? [];
                    const index = array.findIndex(element =>
                        Object.entries(operand).every(([f, c]) => matchesField(element, f, c, state)));
                    if (index === -1) return false;
                    // The positional `$` in an update binds to the element the
                    // query matched, which is the whole point of the pattern.
                    state.positional[field] = index;
                    break;
                }
            }
        }
        return true;
    }
    const value = getPath(doc, field);
    // A RegExp condition tests the string, the way Mongo matches a field against
    // a regex literal. Falling through to `equals` compared the regex object
    // with the string and answered false for every document.
    if (condition instanceof RegExp) {
        return anyMatch(value, v => typeof v === 'string' && condition.test(v));
    }
    // An array-crossing path matches when any element does; a scalar `null`
    // condition also matches a field that is simply absent, as Mongo's does.
    if (Array.isArray(value) && field.includes('.')) return value.some(v => equals(v, condition ?? null));
    return equals(value, condition ?? null);
}

function matches(doc, query, state) {
    if (!doc) return false;
    for (const [field, condition] of Object.entries(query)) {
        if (field === '$or') {
            if (!condition.some(clause => matches(doc, clause, state))) return false;
        } else if (field === '$and') {
            if (!condition.every(clause => matches(doc, clause, state))) return false;
        } else if (field === '$nor') {
            if (condition.some(clause => matches(doc, clause, state))) return false;
        } else if (field === '$expr') {
            // Evaluated for real, with the same evaluator that applies a
            // pipeline update. `$expr` is how the daily gift and transfer caps
            // are enforced — the cap check lives in the write's own filter so a
            // concurrent transfer cannot slip past a check it invalidated — so a
            // mock that waved it through would report every cap as working.
            //
            // `$$NOW` is bound the way applyPipelineUpdate binds it, because
            // the real server resolves it in an `$expr` filter too — without it
            // a cap filter that reached for the clock would throw "unbound
            // variable" here and match on the server.
            if (!evaluate(condition, doc, { NOW: new Date() })) return false;
        } else if (field.startsWith('$')) {
            throw new Error(`fakeCollection: unsupported top-level operator ${field}`);
        } else if (!matchesField(doc, field, condition, state)) {
            return false;
        }
    }
    return true;
}

const UPDATE_OPERATORS = new Set(['$set', '$inc', '$setOnInsert', '$push', '$pull', '$unset', '$max', '$min', '$addToSet']);

function applyUpdate(doc, update, { inserted = false, positional = {}, arrayFilters = [] } = {}) {
    if (Array.isArray(update)) {
        applyPipelineUpdate(doc, update);
        return;
    }
    for (const op of Object.keys(update)) {
        if (!UPDATE_OPERATORS.has(op)) throw new Error(`fakeCollection: unsupported update operator ${op}`);
    }

    const resolve = path => {
        if (path.includes('.$[')) {
            const [prefix, rest] = path.split(/\.\$\[[^\]]*\]\./);
            const filter = arrayFilters[0] ?? {};
            const key = Object.keys(filter)[0]?.split('.').slice(1).join('.');
            const wanted = Object.values(filter)[0];
            const array = getPath(doc, prefix) ?? [];
            return array
                .map((el, i) => (getPath(el, key) === wanted ? `${prefix}.${i}.${rest}` : null))
                .filter(Boolean);
        }
        if (path.includes('.$.')) {
            const [prefix, rest] = path.split('.$.');
            const index = positional[prefix];
            if (index === undefined) {
                throw new Error(`fakeCollection: positional update on ${path} with no $elemMatch to bind it`);
            }
            return [`${prefix}.${index}.${rest}`];
        }
        return [path];
    };

    for (const [path, value] of Object.entries(update.$set ?? {})) {
        for (const target of resolve(path)) setPath(doc, target, value);
    }
    for (const [path, delta] of Object.entries(update.$inc ?? {})) {
        for (const target of resolve(path)) setPath(doc, target, (getPath(doc, target) ?? 0) + delta);
    }
    for (const [path, value] of Object.entries(update.$max ?? {})) {
        const current = getPath(doc, path);
        if (current === undefined || compare(value, current) > 0) setPath(doc, path, value);
    }
    for (const [path, value] of Object.entries(update.$min ?? {})) {
        const current = getPath(doc, path);
        if (current === undefined || compare(value, current) < 0) setPath(doc, path, value);
    }
    for (const path of Object.keys(update.$unset ?? {})) setPath(doc, path, undefined);
    for (const [path, value] of Object.entries(update.$push ?? {})) {
        const array = getPath(doc, path) ?? [];
        if (isPlainObject(value) && Array.isArray(value.$each)) array.push(...value.$each);
        else array.push(value);
        setPath(doc, path, array);
    }
    for (const [path, value] of Object.entries(update.$addToSet ?? {})) {
        const array = getPath(doc, path) ?? [];
        if (!array.some(el => equals(el, value))) array.push(value);
        setPath(doc, path, array);
    }
    for (const [path, condition] of Object.entries(update.$pull ?? {})) {
        const array = getPath(doc, path) ?? [];
        setPath(doc, path, array.filter(el => !matches(el, condition, { positional: {} })));
    }
    if (inserted) {
        for (const [path, value] of Object.entries(update.$setOnInsert ?? {})) setPath(doc, path, value);
    }
}

/**
 * @param {string} name  the model's name, so an unsupported-shape error says
 *                       which collection tripped it
 * @param {object} [defaults]  fields every seeded document gets unless it says
 *                       otherwise — the ones a Mongoose schema would default
 * @param {object} [options]
 * @param {string[]} [options.unique]  the fields of the collection's unique
 *                       index. An upsert whose filter misses inserts a document
 *                       built from the filter's equality terms, and if that
 *                       duplicates the key the real server answers with E11000
 *                       rather than a null — which is the difference between a
 *                       command's refusal branch running and it throwing.
 */
function fakeCollection(name, defaults = {}, { unique = ['userId', 'guildId'] } = {}) {
    let docs = [];
    const writes = [];

    // A fresh copy of the defaults per document. `{ ...defaults }` is shallow,
    // so every document that did not name its own `inventory` shared one array
    // — and a flow that pushes an item into a user's bag was pushing into every
    // other seeded user's bag as well, across tests, since the defaults outlive
    // reset(). It surfaced as a stray quantity in an unrelated assertion, which
    // is the worst way for it to surface.
    const freshDefaults = () => structuredClone(defaults);

    const uniqueKey = doc => (unique.length ? unique.map(field => getPath(doc, field)).join('\u0000') : null);

    /** A document as the caller gets it: a deep copy, plus a save() that writes back. */
    const hydrate = stored => {
        if (!stored) return null;
        const copy = JSON.parse(JSON.stringify(stored), (key, value) =>
            (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? new Date(value) : value));
        copy.save = jest.fn(async () => {
            const { save, ...fields } = copy;
            Object.assign(stored, JSON.parse(JSON.stringify(fields), (k, v) =>
                (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v)));
            writes.push({ op: 'save', doc: stored.userId ?? stored.guildId, update: fields });
            return copy;
        });
        // Mongoose documents carry these and several flows call them.
        copy.markModified = jest.fn();
        copy.unmarkModified = jest.fn();
        // `isModified` decides whether a caller bothers to save — /invest fills
        // in missing districts and saves only if that changed something — so a
        // stub that always answered one way would either skip the write under
        // test or add one that would not happen live. Compared against the
        // document as it was handed over, which is what Mongoose tracks.
        // Snapshotted here, not on the first call: a lazy capture would take
        // its "before" after the mutation it is being asked about.
        const asLoaded = JSON.parse(JSON.stringify(stored));
        copy.isModified = jest.fn(path =>
            JSON.stringify(getPath(copy, path) ?? null) !== JSON.stringify(getPath(asLoaded, path) ?? null));
        copy.toObject = () => ({ ...copy });
        return copy;
    };

    const find = (query, state) => docs.find(doc => matches(doc, query, state)) ?? null;

    /**
     * The document an upsert whose filter missed inserts: the query's equality
     * terms plus `$setOnInsert`. It is the same for findOneAndUpdate and
     * updateOne, and it is where a duplicate of a unique key surfaces as the
     * E11000 the real server answers with rather than as a silent second row.
     */
    function insert(query, update) {
        const stored = freshDefaults();
        for (const [field, condition] of Object.entries(query)) {
            if (!field.startsWith('$') && !isPlainObject(condition)) setPath(stored, field, condition);
        }
        for (const [path, value] of Object.entries(update.$setOnInsert ?? {})) setPath(stored, path, value);
        if (unique.length && docs.some(d => uniqueKey(d) === uniqueKey(stored))) {
            const error = new Error(
                `E11000 duplicate key error collection: ${name} index: ${unique.join('_1_')}_1`);
            error.code = 11000;
            throw error;
        }
        docs.push(stored);
        return stored;
    }

    const model = {
        findOne: jest.fn((query = {}) => {
            const found = hydrate(find(query, { positional: {} }));
            // Mongoose returns a thenable Query, and callers use either form.
            return {
                lean: async () => (found ? { ...found } : null),
                select: function () { return this; },
                sort: function () { return this; },
                then: (resolve, reject) => Promise.resolve(found).then(resolve, reject),
                catch: reject => Promise.resolve(found).catch(reject),
            };
        }),

        find: jest.fn((query = {}) => {
            const state = { positional: {} };
            const found = docs.filter(doc => matches(doc, query, state)).map(hydrate);
            return {
                lean: async () => found.map(d => ({ ...d })),
                sort: function () { return this; },
                limit: function () { return this; },
                then: (resolve, reject) => Promise.resolve(found).then(resolve, reject),
            };
        }),

        findOneAndUpdate: jest.fn(async (query = {}, update = {}, options = {}) => {
            const state = { positional: {} };
            let stored = find(query, state);
            let inserted = false;
            if (!stored && options.upsert) {
                stored = insert(query, update);
                inserted = true;
            }
            if (!stored) return null;
            // Mongoose hands back the document as it was *before* the update
            // unless `new: true` says otherwise, and utils/balanceDebit.js
            // depends on exactly that — the pre-image is the only way it can
            // learn how much its clamped debit actually took.
            const before = options.new ? null : hydrate(stored);
            if (Object.keys(update).length) {
                applyUpdate(stored, update, { inserted, positional: state.positional, arrayFilters: options.arrayFilters });
                writes.push({ op: 'findOneAndUpdate', query, update, doc: stored.userId ?? stored.guildId });
            }
            // An upsert that inserted has no pre-image, and Mongoose returns
            // null rather than inventing one.
            if (!options.new) return inserted ? null : before;
            return hydrate(stored);
        }),

        updateOne: jest.fn(async (query = {}, update = {}, options = {}) => {
            const state = { positional: {} };
            let stored = find(query, state);
            let inserted = false;
            // `updateOne(filter, {}, { upsert: true })` is how /gift makes sure
            // the recipient's row exists before crediting it. Without this the
            // mock answered `matchedCount: 0` and wrote nothing, which reads as
            // a refusal the real call never makes.
            if (!stored && options.upsert) {
                stored = insert(query, update);
                inserted = true;
            }
            if (!stored) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
            if (Object.keys(update).length) {
                applyUpdate(stored, update, { inserted, positional: state.positional, arrayFilters: options.arrayFilters });
                writes.push({ op: 'updateOne', query, update, doc: stored.userId ?? stored.guildId });
            }
            return inserted
                ? { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
                : { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }),

        findOneAndDelete: jest.fn(async (query = {}) => {
            const stored = find(query, { positional: {} });
            if (!stored) return null;
            docs = docs.filter(d => d !== stored);
            writes.push({ op: 'findOneAndDelete', query, doc: stored._id ?? stored.userId });
            return hydrate(stored);
        }),

        deleteOne: jest.fn(async (query = {}) => {
            const stored = find(query, { positional: {} });
            if (!stored) return { deletedCount: 0 };
            docs = docs.filter(d => d !== stored);
            return { deletedCount: 1 };
        }),

        countDocuments: jest.fn(async (query = {}) =>
            docs.filter(doc => matches(doc, query, { positional: {} })).length),

        // The distinct values of one field across the matching documents, in
        // first-seen order. Autocomplete handlers use it to offer only the
        // values a collection actually holds.
        distinct: jest.fn(async (field, query = {}) => {
            const seen = [];
            for (const doc of docs) {
                if (!matches(doc, query, { positional: {} })) continue;
                const value = doc[field];
                if (value !== undefined && !seen.includes(value)) seen.push(value);
            }
            return seen;
        }),

        create: jest.fn(async fields => {
            const stored = { _id: `id-${docs.length + 1}`, ...freshDefaults(), ...fields };
            docs.push(stored);
            writes.push({ op: 'create', doc: stored._id });
            return hydrate(stored);
        }),

        // Named so a failure inside a mock says which collection it came from.
        modelName: name,
    };

    return {
        model,
        writes,
        /** Put documents in. Each is merged over `defaults`. */
        seed(...seeded) {
            for (const doc of seeded.flat()) docs.push({ ...freshDefaults(), ...doc });
            return this;
        },
        /** The stored document, by userId — the live one, not a copy. */
        // By `userId` or by `guildId`: the store is used for Guild documents
        // too, and `writes` already identifies a document by the same pair.
        get(id) {
            return docs.find(d => d.userId === id || d.guildId === id) ?? null;
        },
        all() { return docs; },
        reset() {
            docs = [];
            writes.length = 0;
            for (const fn of Object.values(model)) if (typeof fn?.mockClear === 'function') fn.mockClear();
            return this;
        },
    };
}

module.exports = { fakeCollection, matches, applyUpdate };
