'use strict';

// #564. The schema setter covers keys written from now on. Keys already in the
// database when SECRET_ENCRYPTION_KEY was set are not written by anything, so
// without this sweep they sit in the clear — in the document and in every
// nightly mongodump — and the fix covers only new installs.
//
// The collection is a fake rather than a real mongod: what is under test is the
// sweep's decisions (what it rewrites, what it leaves, what it refuses), and
// those are the same against either. tests/integration/migrations.test.js runs
// migration 018 itself against a server.

const collection = { docs: [], updates: [], onBeforeUpdate: null };

const fieldOf = path => path.replace('ai.', '');

jest.mock('mongoose', () => ({
    connection: {
        db: {
            collection: () => ({
                find: () => ({
                    async *[Symbol.asyncIterator]() {
                        // A copy, so a rewrite mid-iteration cannot be read back
                        // as though the sweep had found it already encrypted.
                        for (const doc of JSON.parse(JSON.stringify(collection.docs))) yield doc;
                    },
                }),
                // Honours the whole filter, not just `_id`. That is the point of
                // the mock: the sweep's compare-and-set is only worth anything if
                // a non-matching expected value actually declines the write.
                updateOne: async (filter, update) => {
                    collection.onBeforeUpdate?.(filter, update);
                    collection.updates.push({ filter, update });

                    const doc = collection.docs.find(d => d._id === filter._id);
                    const matches = doc && Object.entries(filter)
                        .filter(([key]) => key !== '_id')
                        .every(([path, expected]) => doc.ai[fieldOf(path)] === expected);
                    if (!matches) return { matchedCount: 0, modifiedCount: 0 };

                    for (const [path, value] of Object.entries(update.$set)) {
                        doc.ai[fieldOf(path)] = value;
                    }
                    return { matchedCount: 1, modifiedCount: 1 };
                },
            }),
        },
    },
}));

const {
    encryptStoredGuildKeys,
    decryptStoredGuildKeys,
    countPlaintextGuildKeys,
} = require('../src/migrations/018_encrypt_guild_ai_keys');
const { encryptSecret, decryptSecret, isEncrypted, _resetSecretBox } = require('../src/config/secretBox');

const KEY = 'a-test-encryption-key';

function setKey(value) {
    if (value === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = value;
    _resetSecretBox();
}

const guild = (guildId, ai) => ({ _id: guildId, guildId, ai });
const stored = (guildId, field) => collection.docs.find(d => d.guildId === guildId).ai[field];

let savedKey;
beforeAll(() => { savedKey = process.env.SECRET_ENCRYPTION_KEY; });
afterAll(() => setKey(savedKey));

beforeEach(() => {
    collection.docs = [];
    collection.updates = [];
    collection.onBeforeUpdate = null;
    setKey(KEY);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('encryptStoredGuildKeys', () => {
    test('rewrites plaintext keys as ciphertext, across guilds and fields', async () => {
        collection.docs = [
            guild('g1', { openaiKey: 'sk-one', anthropicKey: 'sk-ant-two' }),
            guild('g2', { geminiKey: 'AIza-three', openrouterKey: 'sk-or-four' }),
        ];

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 2, keys: 4, skipped: 0 });

        expect(decryptSecret(stored('g1', 'openaiKey'))).toBe('sk-one');
        expect(decryptSecret(stored('g1', 'anthropicKey'))).toBe('sk-ant-two');
        expect(decryptSecret(stored('g2', 'geminiKey'))).toBe('AIza-three');
        expect(decryptSecret(stored('g2', 'openrouterKey'))).toBe('sk-or-four');
    });

    test('is idempotent — a second pass rewrites nothing', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-one' })];
        await encryptStoredGuildKeys();
        const afterFirst = stored('g1', 'openaiKey');
        collection.updates = [];

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 0, keys: 0, skipped: 0 });

        expect(collection.updates).toEqual([]);
        expect(stored('g1', 'openaiKey')).toBe(afterFirst);
    });

    test('touches only the fields that need it', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-plain', geminiKey: encryptSecret('sk-already') })];
        const untouched = stored('g1', 'geminiKey');

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 1, keys: 1, skipped: 0 });

        expect(collection.updates).toHaveLength(1);
        expect(Object.keys(collection.updates[0].update.$set)).toEqual(['ai.openaiKey']);
        expect(stored('g1', 'geminiKey')).toBe(untouched);
    });

    test('leaves empty and absent keys alone rather than encrypting ""', async () => {
        collection.docs = [guild('g1', { openaiKey: '', geminiKey: null })];

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 0, keys: 0, skipped: 0 });

        expect(stored('g1', 'openaiKey')).toBe('');
        expect(stored('g1', 'geminiKey')).toBeNull();
    });

    // The race `npm run secrets:encrypt` is exposed to: it is documented as safe
    // to run against a live bot, so an admin can save a key between the cursor
    // read and the update. Filtering on `_id` alone would put the encrypted
    // *old* key back, quietly reverting that server to a credential it stopped
    // using.
    test('does not overwrite a key saved while the sweep was running', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-old' })];
        const savedMeanwhile = encryptSecret('sk-new-from-dashboard');
        collection.onBeforeUpdate = () => {
            collection.onBeforeUpdate = null; // once, just before the first write
            collection.docs[0].ai.openaiKey = savedMeanwhile;
        };

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 0, keys: 0, skipped: 1 });

        expect(stored('g1', 'openaiKey')).toBe(savedMeanwhile);
        expect(decryptSecret(stored('g1', 'openaiKey'))).toBe('sk-new-from-dashboard');
    });

    // One field changing underneath the sweep must not cost the other three,
    // which is why the compare-and-set is per field rather than per document.
    test('a key that changed does not block the others on the same guild', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-one', geminiKey: 'AIza-two', anthropicKey: 'sk-ant-three' })];
        collection.onBeforeUpdate = () => {
            collection.onBeforeUpdate = null;
            collection.docs[0].ai.openaiKey = encryptSecret('sk-replaced');
        };

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 1, keys: 2, skipped: 1 });

        expect(decryptSecret(stored('g1', 'openaiKey'))).toBe('sk-replaced');
        expect(decryptSecret(stored('g1', 'geminiKey'))).toBe('AIza-two');
        expect(decryptSecret(stored('g1', 'anthropicKey'))).toBe('sk-ant-three');
    });

    // Silently doing nothing would report as success and leave the operator
    // believing the keys were protected.
    test('refuses when no encryption key is configured', async () => {
        setKey(undefined);
        collection.docs = [guild('g1', { openaiKey: 'sk-one' })];

        await expect(encryptStoredGuildKeys()).rejects.toThrow('SECRET_ENCRYPTION_KEY');
        expect(stored('g1', 'openaiKey')).toBe('sk-one');
    });
});

describe('decryptStoredGuildKeys', () => {
    test('unwinds the sweep, which is what rolling migration 018 back means', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-one', geminiKey: 'AIza-two' })];
        await encryptStoredGuildKeys();

        await expect(decryptStoredGuildKeys()).resolves.toEqual({ keys: 2, skipped: 0 });

        expect(stored('g1', 'openaiKey')).toBe('sk-one');
        expect(stored('g1', 'geminiKey')).toBe('AIza-two');
    });

    // Overwriting a credential with something that is not the credential
    // destroys it, so a rollback that cannot read a value must stop.
    test('refuses rather than overwriting a key it cannot open', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-one' })];
        await encryptStoredGuildKeys();
        const sealed = stored('g1', 'openaiKey');
        setKey('a-completely-different-key');

        await expect(decryptStoredGuildKeys()).rejects.toThrow('Cannot decrypt ai.openaiKey');
        expect(stored('g1', 'openaiKey')).toBe(sealed);
    });

    // Same race, unwinding. Here the skipped count is what the caller acts on:
    // a key left sealed is one a pre-#564 image cannot read, so the rollback is
    // not finished and migration 018's down() throws on it.
    test('does not unseal over a key saved while the rollback was running', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-one' })];
        await encryptStoredGuildKeys();
        const savedMeanwhile = encryptSecret('sk-new-from-dashboard');
        collection.onBeforeUpdate = () => {
            collection.onBeforeUpdate = null;
            collection.docs[0].ai.openaiKey = savedMeanwhile;
        };

        await expect(decryptStoredGuildKeys()).resolves.toEqual({ keys: 0, skipped: 1 });

        expect(stored('g1', 'openaiKey')).toBe(savedMeanwhile);
    });

    test('refuses with no encryption key at all', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-one' })];
        await encryptStoredGuildKeys();
        setKey(undefined);

        await expect(decryptStoredGuildKeys()).rejects.toThrow('SECRET_ENCRYPTION_KEY');
    });
});

describe('countPlaintextGuildKeys', () => {
    test('counts what is still in the clear, and nothing else', async () => {
        collection.docs = [
            guild('g1', { openaiKey: 'sk-plain', geminiKey: encryptSecret('sk-sealed') }),
            guild('g2', { anthropicKey: 'sk-ant-plain', openrouterKey: '' }),
        ];

        await expect(countPlaintextGuildKeys()).resolves.toBe(2);
    });

    // This is what migration 018 reports on an install that declined
    // encryption, so it must work with no key configured.
    test('works with no encryption key configured', async () => {
        setKey(undefined);
        collection.docs = [guild('g1', { openaiKey: 'sk-plain' })];

        await expect(countPlaintextGuildKeys()).resolves.toBe(1);
    });

    test('is zero once the sweep has run', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-plain' })];
        await encryptStoredGuildKeys();

        expect(isEncrypted(stored('g1', 'openaiKey'))).toBe(true);
        await expect(countPlaintextGuildKeys()).resolves.toBe(0);
    });
});
