'use strict';

/**
 * The one invariant every coin-moving path shares: a user's balance never goes
 * below zero.
 *
 * 41 source files mutate `balance` and exactly one test asserted this, in
 * exploreService.test.js. Every debit in the codebase is meant to be guarded —
 * either by a `balance: { $gte: cost }` filter on the update or by a clamp
 * against the current balance — and the whole point of a guard is that nothing
 * proves it is there except a test that would notice its absence.
 *
 * The helpers below take whatever shape a test already has (a single user
 * document, a list, or the `userId -> doc` mock stores most of these tests
 * build) so applying the invariant to an existing test is one line, and label
 * the failure with which user broke it and where.
 */

// Pulls user-shaped objects out of a doc, an array of docs, or a keyed store.
function collectUsers(subject) {
    if (subject === null || subject === undefined) return [];
    if (Array.isArray(subject)) return subject.flatMap(collectUsers);
    if (typeof subject !== 'object') return [];
    if ('balance' in subject) return [subject];
    return Object.values(subject).flatMap(collectUsers);
}

function label(user, context) {
    const who = user.userId ?? user.id ?? 'user';
    return context ? `${context}: ${who}` : who;
}

/**
 * Asserts every balance reachable from `subject` is a non-negative finite
 * number. `context` names the path under test, so a failure names which payout
 * or penalty produced it and for which user rather than just printing a number.
 */
function expectNonNegativeBalance(subject, context = '') {
    const users = collectUsers(subject);
    // A store that yielded nothing would make this assertion vacuously pass.
    expect(users.length).toBeGreaterThan(0);

    const violations = users
        .filter(u => !(Number.isFinite(u.balance) && u.balance >= 0))
        .map(u => `${label(u, context)} balance=${u.balance}`);
    expect(violations).toEqual([]);
}

/**
 * Same for banked coins, which are debited by the same guarded-update pattern.
 * Users with no `bank` field are skipped rather than treated as violations.
 */
function expectNonNegativeBank(subject, context = '') {
    const violations = collectUsers(subject)
        .filter(u => u.bank !== undefined && !(Number.isFinite(u.bank) && u.bank >= 0))
        .map(u => `${label(u, context)} bank=${u.bank}`);
    expect(violations).toEqual([]);
}

/**
 * Runs `fn` and asserts the invariant afterwards, whether it returned or threw —
 * a path that throws halfway through a debit is exactly the one that leaves a
 * balance negative. Returns whatever `fn` returned.
 */
async function withBalanceInvariant(subject, context, fn) {
    try {
        return await fn();
    } finally {
        expectNonNegativeBalance(subject, context);
        expectNonNegativeBank(subject, context);
    }
}

module.exports = { expectNonNegativeBalance, expectNonNegativeBank, withBalanceInvariant, collectUsers };
