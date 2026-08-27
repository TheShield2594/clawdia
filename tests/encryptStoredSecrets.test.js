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

const collection = { docs: [], updates: [] };

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
                updateOne: async (filter, update) => {
                    collection.updates.push({ filter, update });
                    const doc = collection.docs.find(d => d._id === filter._id);
                    for (const [path, value] of Object.entries(update.$set)) {
                        doc.ai[path.replace('ai.', '')] = value;
                    }
                    return { modifiedCount: 1 };
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

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 2, keys: 4 });

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

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 0, keys: 0 });

        expect(collection.updates).toEqual([]);
        expect(stored('g1', 'openaiKey')).toBe(afterFirst);
    });

    test('touches only the fields that need it', async () => {
        collection.docs = [guild('g1', { openaiKey: 'sk-plain', geminiKey: encryptSecret('sk-already') })];
        const untouched = stored('g1', 'geminiKey');

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 1, keys: 1 });

        expect(collection.updates).toHaveLength(1);
        expect(Object.keys(collection.updates[0].update.$set)).toEqual(['ai.openaiKey']);
        expect(stored('g1', 'geminiKey')).toBe(untouched);
    });

    test('leaves empty and absent keys alone rather than encrypting ""', async () => {
        collection.docs = [guild('g1', { openaiKey: '', geminiKey: null })];

        await expect(encryptStoredGuildKeys()).resolves.toEqual({ guilds: 0, keys: 0 });

        expect(stored('g1', 'openaiKey')).toBe('');
        expect(stored('g1', 'geminiKey')).toBeNull();
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

        await expect(decryptStoredGuildKeys()).resolves.toEqual({ keys: 2 });

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
