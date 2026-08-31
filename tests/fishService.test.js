'use strict';

const fs   = require('fs');
const path = require('path');
// Ships with jest (jest → babel-jest → @babel/core → @babel/parser), so it is
// always present when this suite runs and is not declared separately.
const { parse } = require('@babel/parser');

const {
    applyPayoutModifiers,
    ensureFishingData,
    executeCast,
    quoteRepair,
    applyRepair,
} = require('../src/services/fishService');
const { addEffect, consumeEffect, refundEffectCharge, getEffect, EFFECT_CONFIGS } = require('../src/services/effectsService');
const { LOCATIONS, LIMITS, ROD_TIERS } = require('../src/data/fishData');
const { useFixedClock, advanceClock, DAY, WEEK } = require('./helpers/fixedClock');

const pond = LOCATIONS.pond;

function makeUser(fishingOverrides = {}) {
    const bamboo = ROD_TIERS[0];
    const user = {
        userId:  'u1',
        guildId: 'g1',
        balance: 0,
        activeEffects: [],
        quests: [],
        fishing: {
            level: 1,
            prestige: 0,
            xp: 0,
            stamina: 10,
            dailyCoins: 0,
            dailyCasts: 0,
            totalCasts: 0,
            successfulCasts: 0,
            totalEarned: 0,
            consecutiveFails: 0,
            bestPayout: 0,
            legendaryCatches: 0,
            eventCatches: 0,
            activeLocation: 'pond',
            unlockedLocations: ['pond'],
            equippedRodIndex: 0,
            rods: [{
                name:              bamboo.name,
                tier:              bamboo.tier,
                slug:              bamboo.slug,
                currentDurability: bamboo.baseDurability,
                maxDurability:     bamboo.baseDurability,
                baseDurability:    bamboo.baseDurability,
                repairCount:       0,
                upgrade:           null,
                status:            'good',
            }],
            bait: {},
            consumables: {},
            materials: {},
            activeBait: null,
            activeBaitCastsLeft: 0,
            activeLuck: false,
            activeXpScroll: false,
            luckyHook: false,
            personalBest: { fish: null, weight: 0, payout: 0 },
            weeklyRecord: { fish: null, weight: 0, userId: null, username: null, weekStart: null },
            trophies: [],
            ...fishingOverrides,
        },
        markModified: () => {},
    };
    return user;
}

/**
 * Casts until `predicate` accepts a result, and returns that result, topping up
 * the resources a cast spends. Lets RNG-driven tests assert on outcomes without
 * depending on the internal order of Math.random() calls.
 *
 * Exhausting `maxCasts` throws. It used to return `null`, and three of the
 * seven call sites below never looked at what came back (#633) — they cast,
 * then asserted against the fixture. A `null` there is not a failure: the
 * fixture is simply unchanged, which is exactly what "a lighter fish did not
 * take the record" looks like, so the test passed without a fish ever having
 * been caught. The assertions were green because nothing had happened.
 *
 * Guarding each call site with `expect(...).not.toBeNull()` was the obvious fix
 * and is the one this replaced: it leaves the same trap set for the eighth call
 * site. A helper that cannot hand back a non-answer needs no discipline at the
 * call sites at all, and the throw names what it was looking for, which `null`
 * never did.
 */
function castUntil(user, predicate, { maxCasts = 4000, username = 'angler' } = {}) {
    for (let i = 0; i < maxCasts; i++) {
        user.fishing.stamina = 10;
        user.fishing.rods[0].currentDurability = user.fishing.rods[0].maxDurability;
        user.fishing.rods[0].status = 'good';
        const result = executeCast(user, 'pond', { reactionFactor: 1.0, username });
        if (predicate(result)) return result;
    }
    throw new Error(
        `castUntil: ${predicate.name || 'the predicate'} matched nothing in ${maxCasts} casts. ` +
        'The catch tables or the cast path changed; the assertions after this call never ran.',
    );
}

const isWeighedFish = r => r.success && r.catchType === 'fish' && r.weightLbs > 0;

// ─── Cast helper ─────────────────────────────────────────────────────────────
// The helper's own guarantee (#633). Every weeklyRecord test below leans on it
// instead of checking a return value, so it is worth one test of its own: a
// predicate that never matches must stop the run, not hand back a value the
// assertions can pass against.
describe('castUntil', () => {
    test('exhausting the casts throws, naming the predicate', () => {
        const neverMatches = () => false;
        expect(() => castUntil(makeUser(), neverMatches, { maxCasts: 5 }))
            .toThrow(/neverMatches matched nothing in 5 casts/);
    });

    test('a matching predicate returns the result it matched', () => {
        const caught = castUntil(makeUser(), isWeighedFish);
        expect(caught.catchType).toBe('fish');
        expect(caught.weightLbs).toBeGreaterThan(0);
    });
});

// ─── Reference guard ─────────────────────────────────────────────────────────
// Two shipped features were dead because a function was called but never added
// to its require() destructure: applyPayoutModifiers (boss payouts) and
// startTournament (/fish tournament start). Both are single-line omissions that
// only surface at runtime, so guard the whole fishing surface against the class.

const JS_GLOBALS = new Set([
    'require', 'module', 'exports', 'process', 'console', 'Buffer', 'globalThis',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
    'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
    'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
    'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
    'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
    'decodeURIComponent', 'encodeURI', 'decodeURI', 'ArrayBuffer', 'DataView',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
]);

// Collects every identifier the file binds anywhere (declarations, params,
// catch clauses, destructuring). Deliberately flat rather than scope-aware:
// a flat set can only produce false negatives, never false positives.
function collectBindingsAndCalls(ast) {
    const bound  = new Set();
    const called = new Set();

    const bindPattern = node => {
        if (!node) return;
        switch (node.type) {
            case 'Identifier':          bound.add(node.name); break;
            case 'ObjectPattern':       node.properties.forEach(p => bindPattern(p.type === 'RestElement' ? p.argument : p.value)); break;
            case 'ArrayPattern':        node.elements.forEach(bindPattern); break;
            case 'AssignmentPattern':   bindPattern(node.left); break;
            case 'RestElement':         bindPattern(node.argument); break;
            default: break;
        }
    };

    const visit = node => {
        if (!node || typeof node.type !== 'string') return;

        if (node.type === 'VariableDeclarator') bindPattern(node.id);
        if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') bindPattern(node.id);
        if (node.type === 'CatchClause') bindPattern(node.param);
        if (/Function(Declaration|Expression)$/.test(node.type) || node.type === 'ArrowFunctionExpression') {
            bindPattern(node.id);
            node.params.forEach(bindPattern);
        }
        if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.callee?.type === 'Identifier') {
            called.add(node.callee.name);
        }

        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
            const child = node[key];
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child.type === 'string') visit(child);
        }
    };

    visit(ast.program);
    return { bound, called };
}

// Every file of every grind command, plus the service. /fish, /hunt and /mine
// are folders (#721), and each of their files is scanned on its own so a
// failure names the file rather than the command.
const { grindCommandRelPaths } = require('./helpers/grindSources');

const GRIND_FILES = [
    ...['fish', 'hunt', 'mine', 'explore'].flatMap(grindCommandRelPaths),
    'src/services/fishService.js',
];

const readAst = relPath => parse(
    fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8'),
    { sourceType: 'script', allowReturnOutsideFunction: true },
);

describe('grind modules reference only names they define or import', () => {
    test.each(GRIND_FILES)('%s calls no undefined function', relPath => {
        const { bound, called } = collectBindingsAndCalls(readAst(relPath));

        const undefinedCalls = [...called].filter(name => !bound.has(name) && !JS_GLOBALS.has(name));
        expect(undefinedCalls).toEqual([]);
    });
});

// The four grind systems moved off the User document into GrindProfile
// (migration 005). A guard written against User silently matches every document
// on the now-missing path and rejects nothing, which is how the fishing and
// hunting cooldown claims both shipped doing nothing. Any dotted grind path in
// a command is a query built against the wrong collection.
describe('grind commands query no User-level grind paths', () => {
    const GRIND_PATH = /^(fishing|hunt|mining|exploration)\./;

    test.each(GRIND_FILES)('%s uses no "<system>.<field>" query path', relPath => {
        const ast = readAst(relPath);
        const offenders = [];

        const visit = node => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'StringLiteral' && GRIND_PATH.test(node.value)) {
                offenders.push(`${node.value} (line ${node.loc?.start.line})`);
            }
            for (const key of Object.keys(node)) {
                if (key === 'loc') continue;
                const child = node[key];
                if (Array.isArray(child)) child.forEach(visit);
                else if (child && typeof child.type === 'string') visit(child);
            }
        };
        visit(ast.program);

        expect(offenders).toEqual([]);
    });
});

// ─── Gathering-yield charges ─────────────────────────────────────────────────

describe('applyPayoutModifiers gathering-yield charges', () => {
    test('a worthless pull does not burn a Silvered Talisman charge', () => {
        const user = makeUser();
        addEffect(user, 'silvered_talisman');
        const before = getEffect(user, 'silvered_talisman').charges;

        const { adjustedPayout, gatheringYield } = applyPayoutModifiers(user, 0, pond);

        expect(adjustedPayout).toBe(0);
        expect(gatheringYield).toBeNull();
        expect(getEffect(user, 'silvered_talisman').charges).toBe(before);
    });

    test('a paying catch spends exactly one charge and doubles the payout', () => {
        const user = makeUser();
        addEffect(user, 'silvered_talisman');
        const before = getEffect(user, 'silvered_talisman').charges;

        const { adjustedPayout, gatheringYield } = applyPayoutModifiers(user, 100, pond);

        expect(adjustedPayout).toBe(200);
        expect(gatheringYield.effect).toBe('silvered_talisman');
        expect(getEffect(user, 'silvered_talisman').charges).toBe(before - 1);
    });

    test('no charge is spent once the daily hard cap is reached', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP });
        addEffect(user, 'voidsteel_cache');
        const before = getEffect(user, 'voidsteel_cache').charges;

        const { adjustedPayout, cappedByHard } = applyPayoutModifiers(user, 5000, pond);

        expect(adjustedPayout).toBe(0);
        expect(cappedByHard).toBe(true);
        expect(getEffect(user, 'voidsteel_cache').charges).toBe(before);
    });

    test('never pushes dailyCoins past the hard cap', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP - 1 });
        const { adjustedPayout } = applyPayoutModifiers(user, 50_000, pond);
        expect(adjustedPayout).toBeLessThanOrEqual(1);
    });

    // #892. This copy used to spend a charge whenever the payout was non-zero,
    // where hunt and mine spent one only when doubling actually paid more — so
    // an angler one coin under the hard cap lost a charge to a bonus the
    // headroom clamp then swallowed whole. All three go through the engine's
    // one rule now.
    test('spends no charge when the headroom clamp would swallow the bonus', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP - 1 });
        addEffect(user, 'silvered_talisman');
        const before = getEffect(user, 'silvered_talisman').charges;

        const { adjustedPayout, gatheringYield } = applyPayoutModifiers(user, 50_000, pond);

        expect(adjustedPayout).toBe(1);
        expect(gatheringYield).toBeNull();
        expect(getEffect(user, 'silvered_talisman').charges).toBe(before);
    });
});

describe('refundEffectCharge', () => {
    test('restores a charge consumed on a reversed action', () => {
        const user = makeUser();
        addEffect(user, 'silvered_talisman');
        const full = getEffect(user, 'silvered_talisman').charges;

        consumeEffect(user, 'silvered_talisman');
        expect(getEffect(user, 'silvered_talisman').charges).toBe(full - 1);

        refundEffectCharge(user, 'silvered_talisman');
        expect(getEffect(user, 'silvered_talisman').charges).toBe(full);
    });

    test('re-adds the effect when the refunded charge was its last', () => {
        const user = makeUser();
        addEffect(user, 'silvered_talisman');
        const full = getEffect(user, 'silvered_talisman').charges;
        for (let i = 0; i < full; i++) consumeEffect(user, 'silvered_talisman');
        expect(getEffect(user, 'silvered_talisman')).toBeNull();

        refundEffectCharge(user, 'silvered_talisman');
        expect(getEffect(user, 'silvered_talisman').charges).toBe(1);
    });

    test('cannot refund past the configured charge count', () => {
        const user = makeUser();
        addEffect(user, 'voidsteel_cache');
        refundEffectCharge(user, 'voidsteel_cache');
        expect(getEffect(user, 'voidsteel_cache').charges).toBe(EFFECT_CONFIGS.voidsteel_cache.charges);
    });

    test('is a no-op for unlimited-charge effects', () => {
        const user = makeUser();
        addEffect(user, 'lucky_charm'); // charges: -1
        expect(refundEffectCharge(user, 'lucky_charm')).toBe(false);
        expect(getEffect(user, 'lucky_charm').charges).toBe(-1);
    });
});

// ─── Weekly record ───────────────────────────────────────────────────────────

describe('weeklyRecord', () => {
    // fishService stamps and compares `weekStart` with its own `new Date()` /
    // `Date.now()` (fishService.js:779-790), so a fixture built from the real
    // clock races the service's read of it across any day boundary the run
    // happens to straddle (#632). Pinned to the last Sunday in March, half an
    // hour before midnight UTC: the fixtures below reach back into the previous
    // month and forward through a DST change without any of it depending on
    // when CI runs.
    useFixedClock();

    test('a stale week is cleared so a lighter fish can take the record', () => {
        const user = makeUser({
            weeklyRecord: {
                fish: 'Ancient Leviathan', weight: 9999,
                userId: 'u1', username: 'angler',
                weekStart: new Date(Date.now() - 8 * DAY),
            },
        });

        const caught = castUntil(user, isWeighedFish);

        expect(user.fishing.weeklyRecord.weight).toBe(caught.weightLbs);
        expect(user.fishing.weeklyRecord.weight).toBeLessThan(9999);
        expect(Date.now() - new Date(user.fishing.weeklyRecord.weekStart).getTime()).toBeLessThan(DAY);
    });

    test('within the same week a lighter fish does not take the record', () => {
        const user = makeUser({
            weeklyRecord: {
                fish: 'Ancient Leviathan', weight: 9999,
                userId: 'u1', username: 'angler',
                weekStart: new Date(Date.now() - 2 * DAY),
            },
        });

        castUntil(user, isWeighedFish);

        expect(user.fishing.weeklyRecord.fish).toBe('Ancient Leviathan');
        expect(user.fishing.weeklyRecord.weight).toBe(9999);
    });

    test('a record set just under a week ago still stands', () => {
        const user = makeUser({
            weeklyRecord: {
                fish: 'Ancient Leviathan', weight: 9999,
                userId: 'u1', username: 'angler',
                weekStart: new Date(Date.now() - (WEEK - 1)),
            },
        });

        castUntil(user, isWeighedFish);

        expect(user.fishing.weeklyRecord.weight).toBe(9999);
    });

    test('a week expires on elapsed time, not on the calendar turning over', () => {
        // The record is set now; the clock then crosses midnight UTC, a month
        // end and the EU spring-forward. None of those is seven days, so the
        // week has not expired and a lighter fish must not take the record.
        const user = makeUser();
        castUntil(user, isWeighedFish);
        user.fishing.weeklyRecord.weight = 9999;

        advanceClock(2 * DAY);
        castUntil(user, isWeighedFish);
        expect(user.fishing.weeklyRecord.weight).toBe(9999);

        // Past seven days from the original stamp, the week is stale and the
        // next weighed fish takes it.
        advanceClock(6 * DAY);
        const later = castUntil(user, isWeighedFish);
        expect(user.fishing.weeklyRecord.weight).toBe(later.weightLbs);
    });

    test('a new record records who set it', () => {
        const user = makeUser();
        const caught = castUntil(user, isWeighedFish, { username: 'reelbigfish' });

        // The catch this names is the one that set it: castUntil returns on the
        // first weighed fish, and on a user with no record that fish takes it.
        expect(user.fishing.weeklyRecord.weight).toBe(caught.weightLbs);
        expect(user.fishing.weeklyRecord.userId).toBe('u1');
        expect(user.fishing.weeklyRecord.username).toBe('reelbigfish');
        expect(user.fishing.weeklyRecord.weekStart).toBeTruthy();
    });
});

// ─── Repair ──────────────────────────────────────────────────────────────────

describe('quoteRepair', () => {
    const worn = () => ({
        name: 'Bamboo Rod', tier: 1,
        currentDurability: 10, maxDurability: 80, baseDurability: 80,
        repairCount: 0, upgrade: null, status: 'degraded',
    });

    test('pricing a repair leaves the rod untouched', () => {
        const rod = worn();
        const before = JSON.stringify(rod);

        const quote = quoteRepair(rod, null);

        expect(quote.cost).toBeGreaterThan(0);
        expect(JSON.stringify(rod)).toBe(before);
    });

    test('applying charges exactly what was quoted and degrades max durability once', () => {
        const rod   = worn();
        const quote = quoteRepair(rod, null);
        const result = applyRepair(rod, null);

        expect(result.cost).toBe(quote.cost);
        expect(result.restoredAmount).toBe(quote.restoredAmount);
        expect(rod.maxDurability).toBe(quote.newMax);
        expect(rod.maxDurability).toBeLessThan(80);
        expect(rod.repairCount).toBe(1);
    });

    test('a condemned rod is refused without being mutated', () => {
        const rod = { ...worn(), status: 'condemned' };
        const before = JSON.stringify(rod);

        expect(quoteRepair(rod, null).error).toBeTruthy();
        expect(applyRepair(rod, null).error).toBeTruthy();
        expect(JSON.stringify(rod)).toBe(before);
    });
});

// ─── Initialisation ──────────────────────────────────────────────────────────

describe('ensureFishingData', () => {
    test('initialises trophies, which profile and prestige both read', () => {
        const user = { markModified: () => {} };
        ensureFishingData(user);
        expect(Array.isArray(user.fishing.trophies)).toBe(true);
    });

    test('leaves existing trophies untouched', () => {
        const user = { fishing: { trophies: ['🥉 Bronze Angler'] }, markModified: () => {} };
        ensureFishingData(user);
        expect(user.fishing.trophies).toEqual(['🥉 Bronze Angler']);
    });
});
