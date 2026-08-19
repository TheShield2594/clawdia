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
        case '$add':
            return args().reduce((sum, n) => sum + (n ?? 0), 0);
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
    for (const stage of stages) {
        const set = stage.$set ?? stage.$addFields;
        if (!set) throw new Error(`pipelineUpdate: unsupported stage ${Object.keys(stage).join(', ')}`);
        // Every field of one stage reads the document as it was before that
        // stage, so the values are computed first and written afterwards.
        const computed = Object.entries(set).map(([path, expr]) => [path, evaluate(expr, doc)]);
        for (const [path, value] of computed) setPath(doc, path, value);
    }
    return doc;
}

module.exports = { applyPipelineUpdate, evaluate, getPath, setPath };
