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

/** True when an options AST node sets `updatePipeline` on every branch it can take. */
function optsIn(node) {
    if (node == null) return false;
    if (node.type === 'ObjectExpression') {
        return node.properties.some(p =>
            p.type === 'Property' && !p.computed &&
            (p.key.name || p.key.value) === 'updatePipeline');
    }
    // `cond ? {...} : {...}` — both branches have to opt in.
    if (node.type === 'ConditionalExpression') {
        return optsIn(node.consequent) && optsIn(node.alternate);
    }
    return false;
}

function pipelineUpdates() {
    const found = [];
    for (const file of sourceFiles(SRC)) {
        const source = fs.readFileSync(file, 'utf8');
        const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'script', loc: true });
        const native = nativeCollectionNames(ast);

        for (const node of walk(ast)) {
            if (node.type !== 'CallExpression') continue;
            const callee = node.callee;
            if (callee.type !== 'MemberExpression' || callee.computed) continue;
            if (!UPDATE_METHODS.has(callee.property.name)) continue;

            const update = node.arguments[1];
            if (!update || update.type !== 'ArrayExpression') continue;
            if (callee.object.type === 'Identifier' && native.has(callee.object.name)) continue;

            found.push({
                where: `${path.relative(path.join(SRC, '..'), file)}:${node.loc.start.line}`,
                method: callee.property.name,
                optedIn: optsIn(node.arguments[2]),
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

    it('sets `updatePipeline: true` on every one of them', () => {
        const missing = updates.filter(u => !u.optedIn).map(u => `${u.where} (${u.method})`);
        expect(missing).toEqual([]);
    });
});
