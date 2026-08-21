'use strict';

// Every caller of the inventory credit primitive, checked at the call site.
//
// tests/inventoryGrant.test.js covers `grantInventoryItem` and
// `inventoryAddExpr` themselves — the fold, the duplicate-slot handling, the
// `$ifNull` on a legacy quantity. It imports the util and nothing else, so no
// call site is loaded by it, and a caller that spells the contract wrong is
// invisible to it. That is the gap #736 is about, and the primitive is subtle
// enough that a bug once survived in it *and* in its own test.
//
// The contract is "every caller must spell this correctly", the branches are
// hard to drive (most of these are seasonal commands, boss drops and market
// flows), and there are 18 of them across 15 files — so this is a static sweep
// rather than a behavioural test, the same shape as
// tests/balanceDebitGuard.test.js.
//
// What a call-site bug costs, in order of how quietly it does it:
//
//   - Swapped userId/guildId credits nobody's inventory and returns null; the
//     item is simply gone, and only a caller that checks the return value
//     notices.
//   - A negative or zero quantity turns a credit into an unguarded debit. This
//     primitive has no `$gte` guard — it cannot have one, since the slot may
//     not exist — so a negative quantity drives the count below zero.
//   - An update operator inside `extraSet` is the silent one. `extraSet` fields
//     are *aggregation* expressions spliced into a pipeline `$set`, so
//     `{ $addToSet: ... }` there is not the update operator of the same name;
//     it is read as an accumulator and writes something else entirely.
//   - A floating promise loses the item on a failed write and can take the
//     process down with an unhandled rejection.

const fs   = require('fs');
const path = require('path');
// Ships with jest (jest → babel-jest → @babel/core → @babel/parser).
const { parse } = require('@babel/parser');

const SRC = path.join(__dirname, '..', 'src');
const PRIMITIVE = path.join(SRC, 'utils', 'inventoryGrant.js');

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

function walk(node, visit, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, visit, parent));
    if (typeof node.type === 'string') visit(node, parent);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
        walk(node[key], visit, typeof node.type === 'string' ? node : parent);
    }
}

function isKey(node, name) {
    return node.type === 'ObjectProperty' &&
        ((node.key.type === 'Identifier' && !node.computed && node.key.name === name) ||
         (node.key.type === 'StringLiteral' && node.key.value === name));
}

function prop(objectNode, name) {
    if (objectNode?.type !== 'ObjectExpression') return null;
    return objectNode.properties.find(p => isKey(p, name)) ?? null;
}

const HELPERS = ['grantInventoryItem', 'inventoryAddExpr', 'inventoryAddStages'];

/**
 * Every call to one of the credit helpers in one source, with its arguments,
 * the source text and the parent node — the last so a floating promise can be
 * told from an awaited or returned one.
 *
 * Takes the code rather than reading it, so the same extraction runs against
 * the synthetic call sites the negative controls at the bottom of this file
 * use to prove each check can actually fail.
 */
function callsInCode(code, file) {
    const calls = [];
    const ast = parse(code, { sourceType: 'unambiguous', plugins: ['classProperties'] });
    walk(ast, (node, parent) => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;
        const name = callee.type === 'Identifier' ? callee.name : null;
        if (!HELPERS.includes(name)) return;
        calls.push({ name, file, line: node.loc?.start.line, args: node.arguments, node, parent, code });
    });
    return calls;
}

function collectCalls() {
    const calls = [];
    for (const file of sourceFiles(SRC)) {
        if (file === PRIMITIVE) continue; // the primitive's own internal use
        const code = fs.readFileSync(file, 'utf8');
        if (!HELPERS.some(h => code.includes(h))) continue;
        calls.push(...callsInCode(code, path.relative(SRC, file)));
    }
    return calls;
}

const CALLS  = collectCalls();
const GRANTS = CALLS.filter(c => c.name === 'grantInventoryItem');
const where  = c => `${c.file}:${c.line}`;
const text   = (c, node) => c.code.slice(node.start, node.end);

// ─── The checks ──────────────────────────────────────────────────────────────
//
// Each returns the offending call sites. Named and exported to the tests below
// so the same predicate runs against the real tree and against the synthetic
// bad call sites at the bottom — a static sweep that cannot be shown to fail is
// indistinguishable from one that isn't running.

const UPDATE_OPERATORS = ['$addToSet', '$push', '$inc', '$pull', '$pop', '$unset', '$pullAll', '$setOnInsert'];
const ACCUMULATORS = /\$add|\$concatArrays|\$setUnion|\$subtract|\$max|\$min/;

/** (userId, guildId, ...) passed the other way round. */
function swappedIds(grants) {
    return grants.filter(c => {
        if (c.args.length < 2) return false;
        const first  = text(c, c.args[0]);
        const second = text(c, c.args[1]);
        return /guild/i.test(first) && /user|seller|buyer|member/i.test(second);
    }).map(where);
}

/** Fewer than the user, guild and item the primitive needs. */
function tooFewArgs(grants) {
    return grants.filter(c => c.args.length < 3).map(where);
}

/** A spread in the positional ids defeats every other check here. */
function spreadArgs(grants) {
    return grants.filter(c => c.args.some(a => a.type === 'SpreadElement')).map(where);
}

/** A quantity that is not a positive whole count. */
function badQuantity(grants) {
    return grants.filter(c => {
        const qty = c.args[3];
        if (!qty) return false; // defaults to 1
        if (qty.type === 'NumericLiteral') return qty.value <= 0 || !Number.isInteger(qty.value);
        if (qty.type === 'UnaryExpression' && qty.operator === '-') return true;
        return false;
    }).map(where);
}

/** An update operator where an aggregation expression belongs. */
function updateOperatorInExtraSet(grants) {
    const offenders = [];
    for (const call of grants) {
        const extra = prop(call.args[4], 'extraSet');
        if (!extra) continue;
        walk(extra.value, node => {
            for (const op of UPDATE_OPERATORS) {
                if (isKey(node, op)) offenders.push(`${where(call)} → ${op}`);
            }
        });
    }
    return offenders;
}

/** An accumulating extraSet expression that reads a field without $ifNull. */
function unguardedAccumulator(grants) {
    return grants.filter(call => {
        const extra = prop(call.args[4], 'extraSet');
        if (!extra) return false;
        const src = text(call, extra.value);
        if (!ACCUMULATORS.test(src)) return false;
        return !src.includes('$ifNull');
    }).map(where);
}

/** A grant whose promise nobody awaits, returns or handles. */
function floatingGrants(grants) {
    return grants.filter(call => {
        const parentType = call.parent?.type;
        return !['AwaitExpression', 'ReturnStatement', 'ArrowFunctionExpression',
                 'VariableDeclarator', 'MemberExpression'].includes(parentType);
    }).map(where);
}

/** inventoryAddStages spread into an update *object* rather than a pipeline array. */
function stagesSpreadIntoObject(code, file) {
    const found = [];
    const ast = parse(code, { sourceType: 'unambiguous', plugins: ['classProperties'] });
    walk(ast, node => {
        if (node.type !== 'ObjectExpression') return;
        for (const property of node.properties) {
            if (property.type !== 'SpreadElement') continue;
            const arg = property.argument;
            if (arg?.type === 'CallExpression'
                && arg.callee.type === 'Identifier'
                && arg.callee.name === 'inventoryAddStages') {
                found.push(`${file}:${property.loc?.start.line}`);
            }
        }
    });
    return found;
}

// ─── The real tree ───────────────────────────────────────────────────────────

describe('the sweep is actually sweeping', () => {
    it('finds the call sites it claims to check', () => {
        // A refactor that renames the helper, or a parse that silently returns
        // nothing, must fail here rather than pass by finding zero problems.
        expect(GRANTS.length).toBeGreaterThanOrEqual(15);
        expect(new Set(GRANTS.map(c => c.file)).size).toBeGreaterThanOrEqual(12);
    });

    it('covers services and commands alike, not just one folder', () => {
        const areas = new Set(GRANTS.map(c => c.file.split(path.sep)[0]));
        expect(areas).toContain('commands');
        expect(areas).toContain('services');
    });
});

describe('every credit names the right user in the right order', () => {
    it('passes userId then guildId then itemId', () => {
        // The signature is (userId, guildId, itemId, quantity). Swapping the
        // first two matches no document, credits nobody, and returns null —
        // which most call sites do not check.
        expect(swappedIds(GRANTS)).toEqual([]);
    });

    it('gives every credit a user, a guild and an item', () => {
        expect(tooFewArgs(GRANTS)).toEqual([]);
    });

    it('never passes a spread where the primitive expects positional ids', () => {
        expect(spreadArgs(GRANTS)).toEqual([]);
    });
});

describe('a credit is a credit', () => {
    it('never passes a quantity that is not a positive count', () => {
        // The primitive has no `$gte` guard and cannot have one — the slot may
        // not exist yet — so a negative quantity drives the count below zero
        // with nothing to stop it. Item removals go through their own guarded
        // update, not through here.
        expect(badQuantity(GRANTS)).toEqual([]);
    });
});

describe('extraSet carries aggregation expressions, not update operators', () => {
    it('uses no update operator inside an extraSet value', () => {
        // The one that fails silently. `extraSet` is spliced into a pipeline
        // `$set`, where `$addToSet`, `$inc` and `$push` are not the update
        // operators of the same name. The primitive's docstring spells the
        // correct form out (`{ $setUnion: [{ $ifNull: ['$path', []] }, [v]] }`).
        expect(updateOperatorInExtraSet(GRANTS)).toEqual([]);
    });

    it('reads the field it accumulates onto with $ifNull', () => {
        // A pipeline expression that reads `$xp` on a document without one gets
        // null, and `$add` on null is null — which writes the field away rather
        // than leaving it alone.
        expect(unguardedAccumulator(GRANTS)).toEqual([]);
    });
});

describe('no credit is left floating', () => {
    it('awaits, returns, or explicitly handles every grant', () => {
        // An unhandled rejection here loses the item silently and can take the
        // process with it.
        expect(floatingGrants(GRANTS)).toEqual([]);
    });
});

describe('inventoryAddStages is used as a pipeline', () => {
    it('is passed as an update argument, never spread into an operator object', () => {
        // Spread into a pipeline array (`[...inventoryAddStages(items), { $set }]`)
        // is exactly right — src/utils/starterKit.js does it to fold the kit's
        // coins into the same atomic write. Spread into an ordinary *update
        // object* it produces `{ 0: {...}, 1: {...} }`, which is not an update.
        const misused = [];
        for (const file of new Set(CALLS.filter(c => c.name === 'inventoryAddStages').map(c => c.file))) {
            misused.push(...stagesSpreadIntoObject(fs.readFileSync(path.join(SRC, file), 'utf8'), file));
        }
        expect(misused).toEqual([]);
    });

    it('is given one object per item, each carrying an itemId', () => {
        const bad = CALLS
            .filter(c => c.name === 'inventoryAddStages')
            .filter(c => {
                const arg = c.args[0];
                if (arg?.type !== 'ArrayExpression') return false; // computed elsewhere
                return arg.elements.some(el => el?.type === 'ObjectExpression' && !prop(el, 'itemId'));
            })
            .map(where);
        expect(bad).toEqual([]);
    });
});

// ─── Negative controls ───────────────────────────────────────────────────────
//
// Every check above passes today, which is only reassuring if each one can
// still fail. These run the same predicates against call sites written the
// wrong way: a check that stops detecting its own bug goes green here first.

describe('each check can still fail', () => {
    const bad = code => callsInCode(code, 'synthetic.js').filter(c => c.name === 'grantInventoryItem');

    it('catches swapped ids', () => {
        expect(swappedIds(bad(
            `await grantInventoryItem(interaction.guild.id, interaction.user.id, 'relic', 1);`
        ))).toHaveLength(1);
    });

    it('catches a call that forgot the item', () => {
        expect(tooFewArgs(bad(
            `await grantInventoryItem(userId, guildId);`
        ))).toHaveLength(1);
    });

    it('catches a spread that hides the arguments', () => {
        expect(spreadArgs(bad(
            `await grantInventoryItem(...args);`
        ))).toHaveLength(1);
    });

    it('catches a negative, zero and fractional quantity', () => {
        expect(badQuantity(bad(`await grantInventoryItem(u, g, 'x', -1);`))).toHaveLength(1);
        expect(badQuantity(bad(`await grantInventoryItem(u, g, 'x', 0);`))).toHaveLength(1);
        expect(badQuantity(bad(`await grantInventoryItem(u, g, 'x', 1.5);`))).toHaveLength(1);
        expect(badQuantity(bad(`await grantInventoryItem(u, g, 'x', qty);`))).toEqual([]);
        expect(badQuantity(bad(`await grantInventoryItem(u, g, 'x');`))).toEqual([]);
    });

    it('catches an update operator smuggled into extraSet', () => {
        expect(updateOperatorInExtraSet(bad(
            `await grantInventoryItem(u, g, 'x', 1, { extraSet: { tags: { $addToSet: 'a' } } });`
        ))).toHaveLength(1);
        expect(updateOperatorInExtraSet(bad(
            `await grantInventoryItem(u, g, 'x', 1, { extraSet: { tags: { $setUnion: [{ $ifNull: ['$tags', []] }, ['a']] } } });`
        ))).toEqual([]);
    });

    it('catches an accumulator that would null out the field it reads', () => {
        expect(unguardedAccumulator(bad(
            `await grantInventoryItem(u, g, 'x', 1, { extraSet: { xp: { $add: ['$xp', 5] } } });`
        ))).toHaveLength(1);
        expect(unguardedAccumulator(bad(
            `await grantInventoryItem(u, g, 'x', 1, { extraSet: { xp: { $add: [{ $ifNull: ['$xp', 0] }, 5] } } });`
        ))).toEqual([]);
        // A plain literal assignment reads nothing and needs no guard.
        expect(unguardedAccumulator(bad(
            `await grantInventoryItem(u, g, 'x', 1, { extraSet: { claimed: true } });`
        ))).toEqual([]);
    });

    it('catches a grant nobody waits for', () => {
        expect(floatingGrants(bad(
            `async function f() { grantInventoryItem(u, g, 'x', 1); }`
        ))).toHaveLength(1);
        for (const handled of [
            `async function f() { await grantInventoryItem(u, g, 'x', 1); }`,
            `async function f() { return grantInventoryItem(u, g, 'x', 1); }`,
            `const f = () => grantInventoryItem(u, g, 'x', 1);`,
            `const p = grantInventoryItem(u, g, 'x', 1);`,
            `grantInventoryItem(u, g, 'x', 1).catch(() => null);`,
        ]) {
            expect(floatingGrants(bad(handled))).toEqual([]);
        }
    });

    it('catches stages spread into an update object but not into a pipeline', () => {
        expect(stagesSpreadIntoObject(
            `User.updateOne(f, { ...inventoryAddStages(items), $set: { a: 1 } });`, 'synthetic.js'
        )).toHaveLength(1);
        expect(stagesSpreadIntoObject(
            `User.updateOne(f, [...inventoryAddStages(items), { $set: { a: 1 } }]);`, 'synthetic.js'
        )).toEqual([]);
    });
});
