'use strict';

// `save()` writes every modified path as an absolute `$set`. So a flow that
// reads a user, mutates `user.balance` in memory and then saves is writing the
// value it read — plus its own change — over whatever else happened in between.
// A casino debit erased that way is free money; a gift or payout erased that
// way is money gone.
//
// The rule is therefore: `balance` is never a modified path on a `save()`. A
// flow reaches that in one of three ways, and this scan accepts all three:
//
//   1. the coin movement is handed to `detachBalanceDelta` / `saveWithBalanceDelta`
//      and re-applied as an atomic `$inc` (src/utils/balanceDelta.js);
//   2. the balance came back from a guarded `findOneAndUpdate` and the path is
//      cleared with `unmarkModified('balance')` before the save;
//   3. the flow never saves that document at all — the grind services mutate a
//      user their command later reconciles.
//
// Static rather than behavioural on purpose: the sites worth catching are the
// branches nobody drives in a test — a reel-in miss, a cave-in penalty, the one
// quest that happened to complete on this message.

const fs   = require('fs');
const path = require('path');
// Ships with jest (jest → babel-jest → @babel/core → @babel/parser), so it is
// always present when this suite runs and is not declared separately.
const { parse } = require('@babel/parser');

const SRC = path.join(__dirname, '..', 'src');

const FUNCTION_TYPES = new Set([
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
    'ObjectMethod', 'ClassMethod',
]);

// Verified by hand, and only these. Each one moves coins as a delta through a
// helper this scan cannot follow, so the lexical pairing it sees is not the
// write that actually lands.
const REVIEWED = {
    // saveRobState turns the robber's and victim's in-memory changes into
    // guarded `$inc`s. The `robber.save()` calls live on the branches that
    // absorbed the fine and moved no coins at all.
    'commands/economy/rob.js': 'coin movement goes through saveRobState as $inc deltas',
};

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, visit));
    if (typeof node.type === 'string') visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
        walk(node[key], visit);
    }
}

/** `user.balance = …` / `+=` / `-=` — the identifier being written, or null. */
function balanceAssignmentTarget(node) {
    if (node.type !== 'AssignmentExpression') return null;
    const left = node.left;
    if (left.type !== 'MemberExpression' || left.computed) return null;
    if (left.property.type !== 'Identifier' || left.property.name !== 'balance') return null;
    return left.object.type === 'Identifier' ? left.object.name : null;
}

/** `user.save()` — the identifier being saved, or null. */
function saveTarget(node) {
    if (node.type !== 'CallExpression') return null;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.computed) return null;
    if (callee.property.type !== 'Identifier' || callee.property.name !== 'save') return null;
    return callee.object.type === 'Identifier' ? callee.object.name : null;
}

/**
 * Identifiers whose balance this node takes back out of the save:
 * `user.unmarkModified('balance')`, `detachBalanceDelta(user, …)`, or
 * `saveWithBalanceDelta(Model, user, …)`.
 */
function neutralizedTarget(node) {
    if (node.type !== 'CallExpression') return null;
    const callee = node.callee;

    if (callee.type === 'MemberExpression' && !callee.computed &&
        callee.property.type === 'Identifier' && callee.property.name === 'unmarkModified') {
        const arg = node.arguments[0];
        const clearsBalance = arg?.type === 'StringLiteral' && arg.value === 'balance';
        return clearsBalance && callee.object.type === 'Identifier' ? callee.object.name : null;
    }

    if (callee.type !== 'Identifier') return null;
    const docArg = callee.name === 'detachBalanceDelta'   ? node.arguments[0]
                 : callee.name === 'saveWithBalanceDelta' ? node.arguments[1]
                 : null;
    return docArg?.type === 'Identifier' ? docArg.name : null;
}

/**
 * Every function in the file, each with the identifiers assigned, saved and
 * neutralized anywhere in its subtree. Nested functions count toward their
 * enclosing ones so that a mutation before an `await` and the save inside the
 * collector callback that follows are seen together.
 */
function scopesIn(ast) {
    const scopes = [];
    walk(ast.program, node => {
        if (!FUNCTION_TYPES.has(node.type)) return;
        const assigned = new Set(), saved = new Set(), cleared = new Set();
        walk(node.body, inner => {
            const a = balanceAssignmentTarget(inner); if (a) assigned.add(a);
            const s = saveTarget(inner);              if (s) saved.add(s);
            const c = neutralizedTarget(inner);       if (c) cleared.add(c);
        });
        if (assigned.size && saved.size) scopes.push({ node, assigned, saved, cleared });
    });
    return scopes;
}

const risky = [];   // every function pairing a balance write with a save
const unsafe = [];  // …of those, the ones that never take balance back out

for (const file of sourceFiles(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'script', errorRecovery: true });

    for (const scope of scopesIn(ast)) {
        for (const name of scope.assigned) {
            if (!scope.saved.has(name)) continue;
            const where = `${relative}:${scope.node.loc.start.line} (${name})`;
            risky.push(where);
            if (!scope.cleared.has(name) && !REVIEWED[relative]) unsafe.push(where);
        }
    }
}

describe('`balance` is never a modified path on a save()', () => {
    test('the scan found the read-modify-write sites rather than matching nothing', () => {
        // Every conversion keeps its in-memory arithmetic and adds a helper call,
        // so these pairings still exist — they are just neutralized now. If this
        // drops to zero the scan has stopped seeing the code and every assertion
        // below is vacuous.
        expect(risky.length).toBeGreaterThan(5);
    });

    test('every flow that mutates a balance and saves takes it back out first', () => {
        // The innermost frame reported is the one to fix: either fold the change
        // into `saveWithBalanceDelta`, or clear the path after a guarded debit.
        expect(unsafe).toEqual([]);
    });

    test('the hand-reviewed exemptions still exist and still move coins as deltas', () => {
        // An exemption that outlives the file it excuses silently widens the rule.
        for (const relative of Object.keys(REVIEWED)) {
            const full = path.join(SRC, relative);
            expect(fs.existsSync(full)).toBe(true);
            expect(fs.readFileSync(full, 'utf8')).toMatch(/\$inc: *\{? *balance|balance: *robberBalDelta|robberInc\.balance/);
        }
    });
});
