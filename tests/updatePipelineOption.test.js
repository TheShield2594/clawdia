'use strict';

/**
 * Mongoose 9 refuses an aggregation-pipeline update unless the call opts in.
 *
 * Passing an array as the update — `findOneAndUpdate(filter, [{ $set: ... }])` —
 * used to be the way to ask for a pipeline update. Mongoose 9 rejects it with
 * "Cannot pass an array to query updates unless the `updatePipeline` option is
 * set", because an array reaching that argument is far more often a mistake
 * than an intent. The opt-in is `{ updatePipeline: true }` in the options.
 *
 * That guard is worth keeping, so this codebase opts in per call rather than
 * switching it off globally with `mongoose.set('updatePipeline', true)` — the
 * ~440 other update call sites keep the protection, and each pipeline update
 * says at the call site that a pipeline is what it meant.
 *
 * The reason this is a static check rather than something the integration
 * suite covers: the pipeline updates are the economy's concurrency primitives
 * (clamped debits, once-only payouts, inventory merges), and only one of them
 * — balanceDebit via tests/integration/models.test.js — is exercised against a
 * real server. The other seven would throw on the first real call, in a daily
 * claim or a crash-refund sweep on boot, with nothing in CI to notice. This
 * asserts the opt-in is present on all of them by reading the source.
 *
 * Native driver collections (`mongoose.connection.db.collection('users')`, as
 * the migrations use) are deliberately exempt: the guard is Mongoose's, and the
 * driver takes a pipeline array directly.
 */

const fs = require('fs');
const path = require('path');
const espree = require('espree');

const SRC = path.join(__dirname, '..', 'src');

// Methods whose second argument is the update document.
const UPDATE_METHODS = new Set([
    'findOneAndUpdate', 'findByIdAndUpdate', 'findOneAndReplace',
    'updateOne', 'updateMany', 'update', 'replaceOne',
]);

function* walk(node) {
    if (!node || typeof node.type !== 'string') return;
    yield node;
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) yield* walk(child);
        } else if (value && typeof value.type === 'string') {
            yield* walk(value);
        }
    }
}

function* sourceFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // dashboard/public is browser-side assets, vendored libraries included.
        if (entry.isDirectory()) {
            if (full !== path.join(SRC, 'dashboard', 'public')) yield* sourceFiles(full);
        } else if (entry.name.endsWith('.js')) {
            yield full;
        }
    }
}

/** Names bound to a native driver collection, e.g. `const users = db.collection('users')`. */
function nativeCollectionNames(ast) {
    const names = new Set();
    for (const node of walk(ast)) {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') continue;
        const init = node.init;
        if (init && init.type === 'CallExpression' &&
            init.callee.type === 'MemberExpression' &&
            !init.callee.computed &&
            init.callee.property.name === 'collection') {
            names.add(node.id.name);
        }
    }
    return names;
}

/**
 * Names the file binds to a pipeline at some point — `const u = [{ $set: ... }]`
 * or `let u; ... u = [{ $set: ... }]`.
 *
 * The dashboard's two adjust routes built their pipeline into a `let` and passed
 * the variable, so the scan below walked past both of them and they shipped
 * without the opt-in: an admin taking coins or XP got a 500 from a call that
 * threw before it ran (#925). A pipeline is no less a pipeline for having been
 * assigned to something first.
 */
function pipelineNames(ast) {
    const names = new Set();
    for (const node of walk(ast)) {
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
            node.init?.type === 'ArrayExpression') {
            names.add(node.id.name);
        }
        if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' &&
            node.right.type === 'ArrayExpression') {
            names.add(node.left.name);
        }
    }
    return names;
}

/** True for the literal `true`, which is the only value that opts in. */
const isTrue = node => node?.type === 'Literal' && node.value === true;

/**
 * Names the file sets `updatePipeline` on, e.g. `options.updatePipeline = true`.
 *
 * Only a literal `true` counts. `updatePipeline: false` is Mongoose's default
 * spelled out, and a computed value is a promise this scan cannot check — both
 * would otherwise read as an opt-in on the strength of the property name.
 */
function optedInNames(ast) {
    const names = new Set();
    for (const node of walk(ast)) {
        if (node.type !== 'AssignmentExpression') continue;
        const target = node.left;
        if (target.type === 'MemberExpression' && !target.computed &&
            target.object.type === 'Identifier' &&
            target.property.name === 'updatePipeline' &&
            isTrue(node.right)) {
            names.add(target.object.name);
        }
    }
    return names;
}

/**
 * True when an options AST node sets `updatePipeline` on every branch it can take.
 *
 * An options object held in a variable is answered by `optedIn`: the file has to
 * assign `updatePipeline` to that name somewhere. That is weaker than the
 * literal case — it cannot tell which branch the assignment sits on — but it is
 * the difference between noticing a missing opt-in and not looking at all.
 */
function optsIn(node, optedIn = new Set()) {
    if (node == null) return false;
    if (node.type === 'ObjectExpression') {
        return node.properties.some(p =>
            p.type === 'Property' && !p.computed &&
            (p.key.name || p.key.value) === 'updatePipeline' &&
            isTrue(p.value));
    }
    // `cond ? {...} : {...}` — both branches have to opt in.
    if (node.type === 'ConditionalExpression') {
        return optsIn(node.consequent, optedIn) && optsIn(node.alternate, optedIn);
    }
    if (node.type === 'Identifier') return optedIn.has(node.name);
    return false;
}

function pipelineUpdates() {
    const found = [];
    for (const file of sourceFiles(SRC)) {
        const source = fs.readFileSync(file, 'utf8');
        const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'script', loc: true });
        const native = nativeCollectionNames(ast);
        const pipelines = pipelineNames(ast);
        const optedIn = optedInNames(ast);

        for (const node of walk(ast)) {
            if (node.type !== 'CallExpression') continue;
            const callee = node.callee;
            if (callee.type !== 'MemberExpression' || callee.computed) continue;
            if (!UPDATE_METHODS.has(callee.property.name)) continue;

            const update = node.arguments[1];
            const isPipeline = update?.type === 'ArrayExpression' ||
                (update?.type === 'Identifier' && pipelines.has(update.name));
            if (!isPipeline) continue;
            if (callee.object.type === 'Identifier' && native.has(callee.object.name)) continue;

            found.push({
                where: `${path.relative(path.join(SRC, '..'), file)}:${node.loc.start.line}`,
                method: callee.property.name,
                optedIn: optsIn(node.arguments[2], optedIn),
            });
        }
    }
    return found;
}

describe('aggregation-pipeline updates opt in to Mongoose 9', () => {
    const updates = pipelineUpdates();

    // If this ever reads 0, the scan stopped finding call sites rather than the
    // call sites going away — a renamed method or a parse that silently failed.
    it('finds the pipeline updates the economy is built on', () => {
        expect(updates.length).toBeGreaterThanOrEqual(8);
    });

    // The two dashboard adjust routes are the reason the scan resolves
    // identifiers: each holds its pipeline in a `let` and passes the variable to
    // a single findOneAndUpdate (#925), so the literal-only scan saw neither.
    it('sees a pipeline that was assigned to a variable first', () => {
        const byVariable = updates.map(u => u.where).filter(where =>
            where.includes('routes/api/economy.js') || where.includes('routes/api/leveling.js'));
        expect(byVariable.length).toBe(2);
    });

    it('sets `updatePipeline: true` on every one of them', () => {
        const missing = updates.filter(u => !u.optedIn).map(u => `${u.where} (${u.method})`);
        expect(missing).toEqual([]);
    });
});
