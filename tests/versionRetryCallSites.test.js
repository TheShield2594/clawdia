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

/**
 * A load callback that does not actually re-read.
 *
 * `withVersionRetry(() => user, ...)` closes over the document that already
 * lost the race and hands it back on every attempt, so the retry loop burns all
 * three attempts against the same stale version and then throws — the exact
 * failure the retry existed to avoid, dressed up as an unavoidable conflict.
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
        return callNames(load).length === 0;
    }).map(where);
}

/** A call that does not give the primitive both halves it needs. */
function malformedCalls(retries) {
    return retries.filter(r => r.args.length < 2 || !r.load || !r.mutate).map(where);
}

/** A retry with no label — the give-up warning would name nothing. */
function unlabelled(retries) {
    return retries.filter(retry => {
        if (!retry.opts || retry.opts.type !== 'ObjectExpression') return true;
        return !retry.opts.properties.some(p =>
            p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.key.name === 'label');
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

    it('catches a mutate that credits coins', () => {
        expect(coinMutations(bad(
            `withVersionRetry(() => load(), doc => { doc.balance += reward; }, { label: 'x' });`
        ))).toHaveLength(1);
        expect(coinMutations(bad(
            `withVersionRetry(() => load(), doc => { doc.hunt.dailyCoins += n; }, { label: 'x' });`
        ))).toEqual([]);
    });

    it('catches a loader that hands back the same stale document', () => {
        expect(staleLoaders(bad(
            `withVersionRetry(() => user, doc => { doc.name = n; }, { label: 'x' });`
        ))).toHaveLength(1);
        expect(staleLoaders(bad(
            `withVersionRetry(() => resolveUser(interaction), doc => { doc.name = n; }, { label: 'x' });`
        ))).toEqual([]);
    });

    it('catches a call missing a half, and an unlabelled one', () => {
        expect(malformedCalls(bad(`withVersionRetry(() => load());`))).toHaveLength(1);
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; });`))).toHaveLength(1);
        expect(unlabelled(bad(`withVersionRetry(() => load(), d => { d.a = 1; }, { label: 'x' });`))).toEqual([]);
    });

    it('accepts the shape the primitive documents', () => {
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
