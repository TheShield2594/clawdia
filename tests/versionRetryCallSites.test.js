'use strict';

// The replay contract of withVersionRetry, checked at the callers.
//
// tests/versionRetry.test.js covers the primitive: how many attempts it makes,
// the backoff, that a `false` from mutate aborts, that a non-version error
// propagates. It imports the util and nothing else. But the primitive was never
// the risk — retrying is exactly what it is supposed to do. The risk is a
// caller that hands it a block which cannot survive being run twice, and the
// primitive has no way to tell.
//
// The rule is in the primitive's own docstring:
//
//   Only use this where the mutation is a pure function of the freshly loaded
//   document. A handler that has already rolled dice, awarded a reward, or sent
//   a message cannot be replayed — its mutation is not derivable from the
//   document alone, and re-running it would roll or award twice.
//
// Nothing enforced it. A `mutate` that credits coins double-credits the moment
// a version race happens, which is both rare enough to survive review and
// expensive enough to matter — and the losing attempt is the one that retries,
// so it only ever misfires under the concurrency nobody tests by hand.
//
// This is the "every caller must spell this correctly" shape, so it is a static
// sweep like tests/balanceDebitGuard.test.js, with negative controls at the
// bottom proving each check can still fail.
//
// tests/petRenameRetry.test.js is the behavioural half: it drives /pet rename
// and /pet release through a model whose save() loses a version race.

const fs   = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const SRC = path.join(__dirname, '..', 'src');
const PRIMITIVE = path.join(SRC, 'utils', 'versionRetry.js');

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

/** Every `withVersionRetry(load, mutate, opts)` call in one source. */
function retriesInCode(code, file) {
    const found = [];
    const ast = parse(code, { sourceType: 'unambiguous', plugins: ['classProperties'] });
    walk(ast, node => {
        if (node.type !== 'CallExpression') return;
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'withVersionRetry') return;
        found.push({
            file,
            line: node.loc?.start.line,
            load:   node.arguments[0],
            mutate: node.arguments[1],
            opts:   node.arguments[2],
            args:   node.arguments,
            code,
        });
    });
    return found;
}

function collect() {
    const found = [];
    for (const file of sourceFiles(SRC)) {
        if (file === PRIMITIVE) continue;
        const code = fs.readFileSync(file, 'utf8');
        if (!code.includes('withVersionRetry')) continue;
        found.push(...retriesInCode(code, path.relative(SRC, file)));
    }
    return found;
}

const RETRIES = collect();
const where = r => `${r.file}:${r.line}`;
const text  = (r, node) => r.code.slice(node.start, node.end);

// ─── The checks ──────────────────────────────────────────────────────────────

/** Calls inside a subtree, as `object.property` / `name` strings. */
function callNames(node) {
    const names = [];
    walk(node, n => {
        if (n.type !== 'CallExpression') return;
        const c = n.callee;
        if (c.type === 'Identifier') names.push(c.name);
        else if (c.type === 'MemberExpression' && c.property.type === 'Identifier') {
            const object = c.object.type === 'Identifier' ? c.object.name : '';
            names.push(object ? `${object}.${c.property.name}` : c.property.name);
        }
    });
    return names;
}

// Anything whose second run would produce a different world than its first.
const NON_REPLAYABLE = {
    'Math.random':        'rolls dice again on every retry',
    randInt:              'rolls dice again on every retry',
    randomFrom:           'rolls dice again on every retry',
    weightedRoll:         'rolls dice again on every retry',
    grantInventoryItem:   'awards the item again on every retry',
    logTransaction:       'writes a second ledger entry on every retry',
    logBigWin:            'announces the win again on every retry',
    saveWithBalanceDelta: 'commits a second write inside a block the primitive will save itself',
};

const REPLIES = /\.(reply|editReply|followUp|update|send|deferUpdate|deferReply)$/;

/** A mutate callback that cannot survive being run twice. */
function nonReplayableMutations(retries) {
    const offenders = [];
    for (const retry of retries) {
        if (!retry.mutate) continue;
        for (const name of callNames(retry.mutate)) {
            if (NON_REPLAYABLE[name]) offenders.push(`${where(retry)} → ${name} (${NON_REPLAYABLE[name]})`);
            if (REPLIES.test(name))   offenders.push(`${where(retry)} → ${name} (messages the player again on every retry)`);
            // The primitive saves the document itself once mutate returns. A
            // mutate that also saves writes twice per attempt, and the second
            // write is the one whose VersionError the retry loop then catches —
            // so the block retries against a document it has already committed.
            if (name === 'save' || name.endsWith('.save')) {
                offenders.push(`${where(retry)} → ${name} (the primitive saves after mutate returns; this saves again)`);
            }
        }
    }
    return offenders;
}

/** A mutate callback that moves coins — the double-credit the issue names. */
function coinMutations(retries) {
    const offenders = [];
    for (const retry of retries) {
        if (!retry.mutate) continue;
        walk(retry.mutate, node => {
            // `doc.balance += x`, `doc.balance = ...`, `doc.bank -= x`
            if (node.type !== 'AssignmentExpression') return;
            const left = node.left;
            if (left.type !== 'MemberExpression' || left.property.type !== 'Identifier') return;
            if (['balance', 'bank'].includes(left.property.name)) {
                offenders.push(`${where(retry)} → ${text(retry, node)}`);
            }
        });
    }
    return offenders;
}

// Calls that hand back whatever they were given. A loader whose returned
// expression is one of these is doing no re-reading, however call-shaped it
// looks: `() => Promise.resolve(user)` re-wraps the stale document every time.
const PASS_THROUGH = ['Promise.resolve', 'Promise.reject', 'Promise.all', 'Promise.race'];

/** The expression a loader hands back, or null if it never returns one. */
function returnedExpression(fn) {
    if (fn.body.type !== 'BlockStatement') return fn.body; // () => expr
    let returned = null;
    walk(fn.body, node => {
        // The first return wins; a loader with several is unusual enough that
        // treating the first as representative is fine, and a loader with none
        // returns undefined, which the caller reads as "found nothing".
        if (!returned && node.type === 'ReturnStatement' && node.argument) returned = node.argument;
    });
    return returned;
}

/**
 * A load callback that does not actually re-read.
 *
 * `withVersionRetry(() => user, ...)` closes over the document that already
 * lost the race and hands it back on every attempt, so the retry loop burns all
 * three attempts against the same stale version and then throws — the exact
 * failure the retry existed to avoid, dressed up as an unavoidable conflict.
 *
 * Judged on what the loader *returns*, not on whether its body contains a call
 * anywhere: a body can log, count attempts or build a filter and still hand
 * back the same document it was closed over.
 */
function staleLoaders(retries) {
    return retries.filter(retry => {
        const load = retry.load;
        if (!load) return true;
        if (load.type !== 'ArrowFunctionExpression' && load.type !== 'FunctionExpression') {
            // A bare identifier (`load`) or a member expression is a function
            // reference; it is re-invoked per attempt, which is the point.
            return false;
        }

        const returned = returnedExpression(load);
        if (!returned) return true;
        return !isReload(returned, load);
    }).map(where);
}

/**
 * Whether `node` is the expression that re-reads the document.
 *
 * Handles the shapes a loader is actually written in: the call itself, an await
 * of it, a member access off it, and — the common one — a local binding that
 * the body awaited into and then returns. A returned identifier with no such
 * binding in the body is something the loader closed over, which is the stale
 * case this exists to catch.
 */
function isReload(node, fn) {
    let current = node;
    if (current?.type === 'AwaitExpression') current = current.argument;
    // `(await load()).doc` and `load().then(...)` both re-read; walk down to the
    // call that does it.
    while (current?.type === 'MemberExpression') current = current.object;

    if (current?.type === 'Identifier') {
        // `const u = await User.findOne(f); return u;` — resolve the binding
        // inside this loader. Anything not bound here was closed over.
        let bound = null;
        walk(fn.body, n => {
            if (!bound && n.type === 'VariableDeclarator'
                && n.id.type === 'Identifier' && n.id.name === current.name && n.init) {
                bound = n.init;
            }
        });
        return bound ? isReload(bound, fn) : false;
    }

    if (current?.type !== 'CallExpression') return false;

    const callee = current.callee;
    const name = callee.type === 'Identifier'
        ? callee.name
        : (callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
            ? `${callee.object.type === 'Identifier' ? `${callee.object.name}.` : ''}${callee.property.name}`
            : '');
    return !PASS_THROUGH.includes(name);
}

// Node types that are definitely not a function. A call the primitive will
// invoke has to be one, and `!node` only catches the argument being absent.
const NOT_CALLABLE = ['NullLiteral', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral',
                      'ObjectExpression', 'ArrayExpression', 'TemplateLiteral'];

const isUndefinedLiteral = node =>
    node?.type === 'Identifier' && node.name === 'undefined';

/** A call that does not give the primitive both halves it needs, as callables. */
function malformedCalls(retries) {
    return retries.filter(r => {
        if (r.args.length < 2) return true;
        for (const arg of [r.load, r.mutate]) {
            if (!arg) return true;
            if (isUndefinedLiteral(arg)) return true;
            if (NOT_CALLABLE.includes(arg.type)) return true;
        }
        return false;
    }).map(where);
}

/** A retry with no usable label — the give-up warning would name nothing. */
function unlabelled(retries) {
    return retries.filter(retry => {
        if (!retry.opts || retry.opts.type !== 'ObjectExpression') return true;
        const label = retry.opts.properties.find(p =>
            p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.key.name === 'label');
        if (!label) return true;
        // Present but empty is the same as absent once it reaches the log line,
        // and worse to read in review — it looks answered.
        const value = label.value;
        if (isUndefinedLiteral(value)) return true;
        if (value.type === 'NullLiteral') return true;
        if (value.type === 'StringLiteral' && value.value.trim() === '') return true;
        if (value.type === 'TemplateLiteral'
            && value.expressions.length === 0
            && value.quasis.every(q => q.value.cooked.trim() === '')) return true;
        return false;
    }).map(where);
}

// ─── The real tree ───────────────────────────────────────────────────────────

describe('the sweep is actually sweeping', () => {
    it('finds the retry call sites it claims to check', () => {
        expect(RETRIES.length).toBeGreaterThanOrEqual(2);
    });
});

describe('every retried block can survive being run twice', () => {
    it('rolls no dice, awards nothing and messages nobody inside a mutate', () => {
        // The primitive replays `mutate` verbatim on each attempt. Anything in
        // there with an effect the document does not describe happens again.
        expect(nonReplayableMutations(RETRIES)).toEqual([]);
    });

    it('moves no coins inside a mutate', () => {
        // The double-credit. A retried `doc.balance += reward` pays twice, and
        // only ever under the concurrency that makes it hard to notice.
        expect(coinMutations(RETRIES)).toEqual([]);
    });
});

describe('every retry re-reads what it is retrying against', () => {
    it('loads the document afresh on each attempt', () => {
        expect(staleLoaders(RETRIES)).toEqual([]);
    });

    it('passes both a loader and a mutation', () => {
        expect(malformedCalls(RETRIES)).toEqual([]);
    });

    it('labels itself, so a give-up warning names the flow', () => {
        expect(unlabelled(RETRIES)).toEqual([]);
    });
});

// ─── Negative controls ───────────────────────────────────────────────────────

describe('each check can still fail', () => {
    const bad = code => retriesInCode(code, 'synthetic.js');

    it('catches a mutate that rolls dice', () => {
        expect(nonReplayableMutations(bad(
            `withVersionRetry(() => load(), doc => { doc.roll = Math.random(); }, { label: 'x' });`
        ))).toHaveLength(1);
    });

    it('catches a mutate that awards an item', () => {
        expect(nonReplayableMutations(bad(
            `withVersionRetry(() => load(), async doc => { await grantInventoryItem(u, g, 'x', 1); }, { label: 'x' });`
        ))).toHaveLength(1);
    });

    it('catches a mutate that talks to the player', () => {
        expect(nonReplayableMutations(bad(
            `withVersionRetry(() => load(), async doc => { await interaction.followUp('done'); }, { label: 'x' });`
        ))).toHaveLength(1);
    });

    it('catches a mutate that saves the document itself', () => {
        // The primitive saves once mutate returns. Saving inside it writes twice
        // per attempt, and it is the second write whose VersionError the loop
        // catches — so the retry replays a block that already committed.
        expect(nonReplayableMutations(bad(
            `withVersionRetry(() => load(), async doc => { doc.a = 1; await doc.save(); }, { label: 'x' });`
        ))).toHaveLength(1);
        // markModified is the correct way to tell mongoose about the change.
        expect(nonReplayableMutations(bad(
            `withVersionRetry(() => load(), doc => { doc.a = 1; doc.markModified('a'); }, { label: 'x' });`
        ))).toEqual([]);
    });

    it('catches a mutate that credits coins', () => {
        expect(coinMutations(bad(
            `withVersionRetry(() => load(), doc => { doc.balance += reward; }, { label: 'x' });`
        ))).toHaveLength(1);
        expect(coinMutations(bad(
            `withVersionRetry(() => load(), doc => { doc.hunt.dailyCoins += n; }, { label: 'x' });`
        ))).toEqual([]);
    });

    it('catches a loader that hands back the same stale document', () => {
        for (const stale of [
            // Closed over outright.
            `withVersionRetry(() => user, doc => { doc.name = n; }, { label: 'x' });`,
            // Call-shaped, but the call only re-wraps the same stale document —
            // the case a body-wide "does it contain a call" check waves through.
            `withVersionRetry(() => Promise.resolve(user), doc => { doc.name = n; }, { label: 'x' });`,
            // A body that does work and still hands back what it closed over.
            `withVersionRetry(() => { attempts++; return user; }, doc => { doc.a = 1; }, { label: 'x' });`,
            // Never returns anything at all.
            `withVersionRetry(() => { load(); }, doc => { doc.a = 1; }, { label: 'x' });`,
        ]) {
            expect(staleLoaders(bad(stale))).toHaveLength(1);
        }
        for (const fresh of [
            `withVersionRetry(() => resolveUser(interaction), doc => { doc.name = n; }, { label: 'x' });`,
            `withVersionRetry(async () => { const u = await User.findOne(f); return u; }, d => { d.a = 1; }, { label: 'x' });`,
            `withVersionRetry(() => User.findOne(f).exec(), d => { d.a = 1; }, { label: 'x' });`,
            // A function reference is re-invoked per attempt, which is the point.
            `withVersionRetry(loadUser, d => { d.a = 1; }, { label: 'x' });`,
            `withVersionRetry(deps.loadUser, d => { d.a = 1; }, { label: 'x' });`,
        ]) {
            expect(staleLoaders(bad(fresh))).toEqual([]);
        }
    });

    it('catches a call whose halves are not callable', () => {
        // Presence is not enough: the primitive invokes both, so a null or a
        // literal in either slot is a TypeError on the first attempt.
        expect(malformedCalls(bad(`withVersionRetry(() => load());`))).toHaveLength(1);
        expect(malformedCalls(bad(`withVersionRetry(null, d => { d.a = 1; }, { label: 'x' });`))).toHaveLength(1);
        expect(malformedCalls(bad(`withVersionRetry(() => load(), null, { label: 'x' });`))).toHaveLength(1);
        expect(malformedCalls(bad(`withVersionRetry(() => load(), undefined, { label: 'x' });`))).toHaveLength(1);
        expect(malformedCalls(bad(`withVersionRetry(() => load(), {}, { label: 'x' });`))).toHaveLength(1);
        expect(malformedCalls(bad(`withVersionRetry(loadUser, mutateUser, { label: 'x' });`))).toEqual([]);
    });

    it('catches a label that is present but says nothing', () => {
        // A label that reaches the give-up warning as an empty string names the
        // flow no better than a missing one, and reads in review as answered.
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; });`))).toHaveLength(1);
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; }, { label: undefined });`))).toHaveLength(1);
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; }, { label: null });`))).toHaveLength(1);
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; }, { label: '' });`))).toHaveLength(1);
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; }, { label: '   ' });`))).toHaveLength(1);
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; }, { label: 'pet release' });`))).toEqual([]);
        expect(unlabelled(bad("withVersionRetry(() => load(), d => { d.a = 1; }, { label: `pet ${verb}` });"))).toEqual([]);
    });

    it('accepts the shape the primitive documents', () => {
        // Lifted from src/commands/economy/pet.js: a re-read, a mutation that is
        // a pure function of what came back, an abort when the precondition no
        // longer holds, and a label. No check here may reject this.
        const good = bad(
            `withVersionRetry(
                 () => resolveUser(interaction),
                 fresh => { const t = find(fresh.pets, id); if (!t) return false; fresh.pets.splice(t.index, 1); fresh.markModified('pets'); },
                 { label: 'pet release' },
             );`
        );
        expect(nonReplayableMutations(good)).toEqual([]);
        expect(coinMutations(good)).toEqual([]);
        expect(staleLoaders(good)).toEqual([]);
        expect(malformedCalls(good)).toEqual([]);
        expect(unlabelled(good)).toEqual([]);
    });
});
