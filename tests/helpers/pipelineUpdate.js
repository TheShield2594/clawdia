'use strict';

/**
 * A very small aggregation-expression evaluator, enough to apply the
 * pipeline-form updates this codebase issues against a plain JS object.
 *
 * Several writes have to decide something about a document and act on that
 * decision inside one atomic update — crediting an inventory slot that may or
 * may not exist is the main one. Mongo expresses that as an aggregation
 * pipeline passed where an update document would normally go, and none of the
 * hand-rolled model mocks in these tests could apply one, so the behaviour went
 * untested. This closes that gap: mocks call `applyPipelineUpdate` when the
 * update they were handed is an array.
 *
 * Only the operators the source actually uses are implemented, and an unknown
 * one throws rather than silently evaluating to undefined — a pipeline that
 * grows a new operator should fail loudly here, not quietly pass.
 */

function getPath(doc, path) {
    // A dotted path that crosses an array yields the array of that field's
    // values, the way Mongo resolves `$inventory.itemId`.
    return path.split('.').reduce((cur, key) => {
        if (cur === undefined || cur === null) return undefined;
        if (Array.isArray(cur)) {
            return cur.map(el => el?.[key]).filter(v => v !== undefined);
        }
        return cur[key];
    }, doc);
}

function setPath(doc, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let cur = doc;
    for (const key of keys) {
        if (cur[key] === undefined || cur[key] === null) cur[key] = {};
        cur = cur[key];
    }
    cur[last] = value;
}

function evaluate(expr, doc, vars = {}) {
    if (typeof expr === 'string' && expr.startsWith('$$')) {
        const [name, ...rest] = expr.slice(2).split('.');
        if (!(name in vars)) throw new Error(`pipelineUpdate: unbound variable ${expr}`);
        return rest.length ? getPath(vars[name], rest.join('.')) : vars[name];
    }
    if (typeof expr === 'string' && expr.startsWith('$')) {
        return getPath(doc, expr.slice(1));
    }
    if (Array.isArray(expr)) return expr.map(e => evaluate(e, doc, vars));
    // A `Date` is an operand, not an expression object. Falling through would find
    // no `$`-prefixed key on it and rebuild it as an empty literal, so every
    // comparison against a date would quietly evaluate against `{}`.
    if (expr instanceof Date) return expr;
    if (expr === null || typeof expr !== 'object') return expr;

    const keys = Object.keys(expr);
    const op = keys.find(k => k.startsWith('$'));
    if (!op) {
        // A plain object literal — evaluate each of its values.
        const out = {};
        for (const [k, v] of Object.entries(expr)) out[k] = evaluate(v, doc, vars);
        return out;
    }
    if (keys.length > 1) throw new Error(`pipelineUpdate: mixed operator object ${keys.join(', ')}`);

    const arg = expr[op];
    const args = () => (Array.isArray(arg) ? arg.map(a => evaluate(a, doc, vars)) : [evaluate(arg, doc, vars)]);

    switch (op) {
        case '$literal':
            return arg;
        case '$ifNull': {
            const [value, fallback] = args();
            return value === undefined || value === null ? fallback : value;
        }
        case '$cond': {
            if (Array.isArray(arg)) {
                const [test, thenExpr, elseExpr] = arg;
                return evaluate(test, doc, vars) ? evaluate(thenExpr, doc, vars) : evaluate(elseExpr, doc, vars);
            }
            return evaluate(arg.if, doc, vars)
                ? evaluate(arg.then, doc, vars)
                : evaluate(arg.else, doc, vars);
        }
        case '$map': {
            const input = evaluate(arg.input, doc, vars) ?? [];
            const as = arg.as ?? 'this';
            return input.map(el => evaluate(arg.in, doc, { ...vars, [as]: el }));
        }
        case '$in': {
            const [needle, haystack] = args();
            return (haystack ?? []).some(v => sameValue(v, needle));
        }
        case '$eq': {
            const [a, b] = args();
            return sameValue(a, b);
        }
        case '$ne': {
            const [a, b] = args();
            return !sameValue(a, b);
        }
        case '$gt': {
            const [a, b] = args();
            return a > b;
        }
        case '$gte': {
            const [a, b] = args();
            return a >= b;
        }
        case '$lte': {
            const [a, b] = args();
            return a <= b;
        }
        case '$add': {
            // Mongo propagates null: `$add` over a missing or null operand is
            // null, not a silent zero. Treating it as zero here would hide the
            // bug where a legacy slot without a quantity gets wiped.
            const operands = args();
            if (operands.some(n => n === null || n === undefined)) return null;
            return operands.reduce((sum, n) => sum + n, 0);
        }
        case '$subtract': {
            const [a, b] = args();
            if (a === null || a === undefined || b === null || b === undefined) return null;
            return a - b;
        }
        case '$max':
            return args().reduce((best, n) => (n === null || n === undefined ? best : Math.max(best, n)), -Infinity);
        // Mongo's `$min` ignores null operands rather than propagating them,
        // which is what lets `$min: [<cap>, <add that went null>]` answer the
        // cap — but an expression whose operands are *all* null answers null,
        // not the identity the fold started from. Returning Infinity there
        // would write a number no document should ever hold.
        case '$min': {
            const usable = args().filter(n => n !== null && n !== undefined);
            return usable.length ? Math.min(...usable) : null;
        }
        case '$not':
            return !args()[0];
        case '$and':
            return (Array.isArray(arg) ? arg : [arg]).every(e => Boolean(evaluate(e, doc, vars)));
        case '$or':
            return (Array.isArray(arg) ? arg : [arg]).some(e => Boolean(evaluate(e, doc, vars)));
        case '$mergeObjects':
            return args().reduce((out, obj) => Object.assign(out, obj ?? {}), {});
        case '$let': {
            const bound = { ...vars };
            for (const [name, expr2] of Object.entries(arg.vars ?? {})) {
                bound[name] = evaluate(expr2, doc, bound);
            }
            return evaluate(arg.in, doc, bound);
        }
        case '$reduce': {
            const input = evaluate(arg.input, doc, vars) ?? [];
            let value = evaluate(arg.initialValue, doc, vars);
            for (const element of input) {
                value = evaluate(arg.in, doc, { ...vars, this: element, value });
            }
            return value;
        }
        case '$concatArrays':
            return args().reduce((out, arr) => out.concat(arr ?? []), []);
        case '$setUnion': {
            const out = [];
            for (const arr of args()) {
                for (const v of arr ?? []) if (!out.some(x => sameValue(x, v))) out.push(v);
            }
            return out;
        }
        case '$size':
            return (args()[0] ?? []).length;
        case '$filter': {
            const input = evaluate(arg.input, doc, vars) ?? [];
            const as = arg.as ?? 'this';
            return input.filter(el => Boolean(evaluate(arg.cond, doc, { ...vars, [as]: el })));
        }
        // `{ $slice: [<array>, <n>] }` and the three-argument form. A negative
        // `n` in the two-argument form counts from the end, which is what the
        // payout-key cap in src/utils/payoutKey.js relies on to evict the
        // oldest keys rather than the newest.
        case '$slice': {
            const [array, a, b] = args();
            const list = array ?? [];
            if (b === undefined) return a < 0 ? list.slice(a) : list.slice(0, a);
            const from = a < 0 ? Math.max(0, list.length + a) : a;
            return list.slice(from, from + b);
        }
        default:
            throw new Error(`pipelineUpdate: unsupported operator ${op}`);
    }
}

function sameValue(a, b) {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return a === b;
}

/**
 * Applies pipeline `stages` to `doc` in place. Stages run in order and each one
 * sees the previous stage's output, which is what lets several credits
 * accumulate in a single update.
 */
function applyPipelineUpdate(doc, stages) {
    // `$$NOW` is the server's clock, and Mongo holds it fixed for the whole
    // update — every stage of one update sees the same instant. Bound once here
    // for the same reason: the payout-key append stamps an entry with it and
    // prunes by it in the same expression, and two clocks there would be a
    // window, however small, in which an entry could be written already expired.
    const vars = { NOW: new Date() };
    for (const stage of stages) {
        const set = stage.$set ?? stage.$addFields;
        if (!set) throw new Error(`pipelineUpdate: unsupported stage ${Object.keys(stage).join(', ')}`);
        // Every field of one stage reads the document as it was before that
        // stage, so the values are computed first and written afterwards.
        const computed = Object.entries(set).map(([path, expr]) => [path, evaluate(expr, doc, vars)]);
        for (const [path, value] of computed) setPath(doc, path, value);
    }
    return doc;
}

module.exports = { applyPipelineUpdate, evaluate, getPath, setPath };
