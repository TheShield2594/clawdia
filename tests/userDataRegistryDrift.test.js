'use strict';

// The member-data registry (src/utils/userDataRegistry.js) is only as trustworthy
// as its completeness: an access or erasure request that walks it silently omits
// any collection nobody remembered to register. So this holds the registry to
// the models the same way tests/envExampleDrift.test.js holds `.env.example` to
// the code — a new model that stores member data turns `npm test` red until a
// deliberate decision about export and erasure has been recorded for it.
//
// The trigger is a top-level `userId` path, which is how every member-owned
// collection in src/models keys its rows. A model that keys members by another
// field (a case's `targetUserId`, a listing's `sellerId`) is registered too, but
// cannot be discovered by a scan of field names without guessing, so those are
// pinned by name below rather than left to drift.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    USER_DATA_ENTRIES, REGISTERED_MODELS, pseudonymize, REDACTED_PREFIX,
} = require('../src/utils/userDataRegistry');

const MODELS_DIR = path.join(__dirname, '..', 'src', 'models');

// Models that store member data under a field other than `userId`, so the
// top-level-`userId` scan cannot find them. Pinned so that removing one from the
// registry (or the codebase) is a visible edit here, not a silent gap.
const KEYED_BY_OTHER_FIELD = ['Case', 'MarketListing', 'Syndicate', 'DmSession', 'FishingTournament', 'SeasonRecord'];

/** Every mongoose model defined under src/models, by model name. */
function loadModels() {
    const models = {};
    for (const file of fs.readdirSync(MODELS_DIR)) {
        if (!file.endsWith('.js')) continue;
        let mod;
        try {
            mod = require(path.join(MODELS_DIR, file));
        } catch {
            continue;
        }
        if (mod && mod.schema && typeof mod.schema.path === 'function' && mod.modelName) {
            models[mod.modelName] = mod;
        }
    }
    return models;
}

describe('user-data registry covers every member-keyed collection', () => {
    const models = loadModels();

    test('every model with a top-level userId path is registered', () => {
        const owning = Object.values(models)
            .filter(model => model.schema.path('userId'))
            .map(model => model.modelName);

        // A sanity floor: if the scan finds nothing, it has broken, and a broken
        // scan passes this test trivially while guarding nothing.
        expect(owning.length).toBeGreaterThan(5);

        const missing = owning.filter(name => !REGISTERED_MODELS.has(name));
        expect(missing).toEqual([]);
    });

    test('the models keyed by another field are still registered', () => {
        const missing = KEYED_BY_OTHER_FIELD.filter(name => !REGISTERED_MODELS.has(name));
        expect(missing).toEqual([]);
    });

    test('the other-field list only names models that exist', () => {
        const unknown = KEYED_BY_OTHER_FIELD.filter(name => !models[name]);
        expect(unknown).toEqual([]);
    });
});

describe('every registry entry is well-formed', () => {
    test('keys are unique', () => {
        const keys = USER_DATA_ENTRIES.map(e => e.key);
        expect(keys.length).toBe(new Set(keys).size);
    });

    test('behaviours are one of the three, and collect/remove are callable', () => {
        for (const entry of USER_DATA_ENTRIES) {
            expect(['delete', 'pseudonymize', 'retain']).toContain(entry.behavior);
            expect(typeof entry.collect).toBe('function');
            expect(typeof entry.remove).toBe('function');
        }
    });

    // A pseudonymise or retain that keeps a member's row is a choice that owes an
    // explanation, exactly like an env var held back from `.env.example`.
    test('anything that keeps a row records why', () => {
        for (const entry of USER_DATA_ENTRIES) {
            if (entry.behavior === 'delete') continue;
            expect(typeof entry.reason).toBe('string');
            expect(entry.reason.length).toBeGreaterThan(20);
        }
    });
});

describe('pseudonymize', () => {
    test('is a keyed HMAC, not a bare hash of the public id', () => {
        // A plain sha256 of a Discord id can be reversed by hashing known ids;
        // the token must not equal that (#1013 review). It is keyed, so it does
        // not — whether the key is DATA_PSEUDONYM_SECRET or the per-process
        // random fallback.
        const bareHash = REDACTED_PREFIX
            + crypto.createHash('sha256').update('123456789012345678').digest('hex').slice(0, 16);
        expect(pseudonymize('123456789012345678')).not.toBe(bareHash);
    });

    test('is stable within a process and distinct per id', () => {
        expect(pseudonymize('123456789012345678')).toBe(pseudonymize('123456789012345678'));
        expect(pseudonymize('123456789012345678')).not.toBe(pseudonymize('876543210987654321'));
    });

    test('is prefixed and never looks like a snowflake', () => {
        const token = pseudonymize('123456789012345678');
        expect(token.startsWith(REDACTED_PREFIX)).toBe(true);
        expect(/^\d{17,20}$/.test(token)).toBe(false);
    });
});
