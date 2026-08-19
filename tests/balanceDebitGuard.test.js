'use strict';

// Nothing may debit a balance it hasn't first proven is there.
//
// The runtime rule across the whole codebase is that a coin debit is a
// conditional update: `{ ...filter, balance: { $gte: cost } }` paired with
// `{ $inc: { balance: -cost } }`. If the balance moved between reading it and
// writing, the filter no longer matches, the update returns null, and the
// caller backs out — that is the only thing keeping a balance from going
// negative under concurrency, since `$inc` itself will happily go below zero.
//
// 41 source files mutate `balance` and the guard is spelled out by hand at
// every one of them, so this walks all of them and checks each debit carries a
// guard for the amount it takes. Static rather than behavioural on purpose: a
// runtime test can only cover the debits it happens to drive, and the ones
// worth catching are in the branches nobody drove.

const fs   = require('fs');
const path = require('path');
// Ships with jest (jest → babel-jest → @babel/core → @babel/parser), so it is
// always present when this suite runs and is not declared separately.
const { parse } = require('@babel/parser');

const SRC = path.join(__dirname, '..', 'src');
const WRITE_METHODS = new Set(['findOneAndUpdate', 'updateOne', 'updateMany', 'findOneAndReplace']);

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

const snippet = (code, node) => code.slice(node.start, node.end);

function isKey(node, name) {
    return node.type === 'ObjectProperty' &&
        ((node.key.type === 'Identifier' && !node.computed && node.key.name === name) ||
         (node.key.type === 'StringLiteral' && node.key.value === name));
}

// Finds a property by key name in an object expression, ignoring spreads.
function prop(objectNode, name) {
    if (objectNode?.type !== 'ObjectExpression') return null;
    return objectNode.properties.find(p => isKey(p, name)) ?? null;
}

/**
 * Finds a property anywhere in a subtree, not just as a direct child.
 *
 * A debit is often not written flat — `{ $set: {...}, ...(fine > 0 ? { $inc: {
 * balance: -fine } } : {}) }` buries it inside a spread of a conditional, and
 * looking only at direct properties walked straight past it. That miss hid a
 * real unguarded debit in /heist, so the scan reaches all the way down.
 */
function deepProp(node, name) {
    let found = null;
    walk(node, n => {
        if (!found && isKey(n, name)) found = n;
    });
    return found;
}

/**
 * The amount a `$inc: { balance: <expr> }` takes away, as source text, or null
 * when the update isn't a balance debit. `-bet` yields `bet`; a debit written
 * as anything other than a negation is reported as unrecognised so it shows up
 * rather than being waved through.
 */
function debitAmount(code, updateNode) {
    const inc = deepProp(updateNode, '$inc');
    if (!inc) return null;
    const balance = prop(inc.value, 'balance');
    if (!balance) return null;

    const value = balance.value;
    if (value.type === 'UnaryExpression' && value.operator === '-') {
        return snippet(code, value.argument);
    }
    // A literal or a plain identifier here is a credit, or an amount whose sign
    // isn't visible in the source; neither is a debit this rule can check.
    return null;
}

/** The amount a filter proves is available, as source text, or null if unguarded. */
function guardAmount(code, filterNode) {
    const balance = deepProp(filterNode, 'balance');
    if (!balance) return null;
    const gte = prop(balance.value, '$gte');
    return gte ? snippet(code, gte.value) : null;
}

const debits = [];

for (const file of sourceFiles(SRC)) {
    const code = fs.readFileSync(file, 'utf8');
    const ast = parse(code, { sourceType: 'script', errorRecovery: true });

    walk(ast.program, node => {
        if (node.type !== 'CallExpression') return;
        if (node.callee.type !== 'MemberExpression') return;
        if (node.callee.property.type !== 'Identifier') return;
        if (!WRITE_METHODS.has(node.callee.property.name)) return;

        const [filterNode, updateNode] = node.arguments;
        if (!filterNode || !updateNode) return;

        const takes = debitAmount(code, updateNode);
        if (!takes) return;

        debits.push({
            where: `${path.relative(SRC, file)}:${node.loc.start.line}`,
            takes,
            guards: guardAmount(code, filterNode),
        });
    });
}

describe('balance debits are guarded', () => {
    test('the scan found the debit sites rather than silently matching nothing', () => {
        // A refactor that changes how debits are written should fail loudly here
        // instead of leaving every assertion below vacuously true.
        expect(debits.length).toBeGreaterThan(20);
    });

    test('every balance debit carries a `balance: { $gte }` guard', () => {
        const unguarded = debits.filter(d => d.guards === null).map(d => `${d.where} takes ${d.takes}`);
        expect(unguarded).toEqual([]);
    });

    test('each guard covers the amount its debit actually takes', () => {
        const mismatched = debits
            .filter(d => d.guards !== null && d.guards !== d.takes)
            .map(d => `${d.where} takes ${d.takes} but only guards ${d.guards}`);
        expect(mismatched).toEqual([]);
    });
});
