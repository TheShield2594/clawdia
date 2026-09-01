'use strict';

// #874. The optional hooks are read by exact key name and were validated by
// nothing, so `requiredPermissons` was not an error — it was a key nobody read.
// The command loaded, deployed and ran, and the permission gate it was supposed
// to declare silently did not exist. `setDefaultMemberPermissions` on the
// builder is only a default a guild admin can reassign, so that gate is the
// whole check: a one-character slip turned a moderation command into an open
// one, with no error, no warning and no failing test.
//
// The loader compares exported keys against the contract now and fails startup
// on a near miss. This covers both halves of that: the typos it has to catch,
// and the deliberate extra exports it must not — several commands export their
// own button and modal handlers, and a check that broke those would be reverted
// rather than fixed.

const { contractKeyTypos, loadCommandModules, CONTRACT_KEYS } = require('../src/utils/commandLoader');

const stub = extra => ({
    data: { toJSON: () => ({}) },
    execute: async () => {},
    ...extra,
});

describe('contractKeyTypos', () => {
    test.each([
        ['requiredPermissons', 'requiredPermissions'],   // dropped letter, the #874 case
        ['requiredpermissions', 'requiredPermissions'],  // wrong case
        ['cooldownkey', 'cooldownKey'],
        ['autoComplete', 'autocomplete'],
        ['cooldwonAmount', 'cooldownAmount'],
        ['exceute', 'execute'],                          // transposition
    ])('catches %s and names %s', (typo, intended) => {
        const [problem] = contractKeyTypos(stub({ [typo]: () => {} }));

        expect(problem).toContain(`\`${typo}\``);
        expect(problem).toContain(`\`${intended}\``);
    });

    test.each(CONTRACT_KEYS)('leaves the contract key %s alone', key => {
        expect(contractKeyTypos(stub({ [key]: 1 }))).toEqual([]);
    });

    test.each([
        'handleSyndicateButton',
        'grantWarPoints',
        'isEightBallButton',
        'handleMap',
    ])('leaves the deliberate export %s alone', key => {
        expect(contractKeyTypos(stub({ [key]: () => {} }))).toEqual([]);
    });

    test('leaves anything under a leading underscore alone', () => {
        // The escape hatch, for a deliberate field that does read like a near
        // miss. Without one the check would have no answer for a command that
        // genuinely wants `_cooldowns`.
        expect(contractKeyTypos(stub({ __test__: {}, _cooldowns: {} }))).toEqual([]);
    });

    test('reports every typo on a module, not just the first', () => {
        expect(contractKeyTypos(stub({ cooldownkey: () => {}, autoComplete: () => {} })))
            .toHaveLength(2);
    });
});

describe('the shipped commands', () => {
    // The check is only worth having if the tree it guards is clean, and this
    // is where a near miss introduced by a new command surfaces in CI rather
    // than at the boot that would have deployed it.
    test('load with no suspected typos', () => {
        expect(loadCommandModules().failures).toEqual([]);
    });
});
