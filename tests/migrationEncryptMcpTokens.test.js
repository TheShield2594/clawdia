'use strict';

// #1146. Dashboard MCP tokens gained `set: encryptSecret`, which covers what is
// written from now on; migration 027 covers what was already stored. A fake
// collection, as in encryptStoredSecrets.test.js: what is under test is which
// values the sweep rewrites, leaves, and refuses.

const collection = { docs: [] };

jest.mock('mongoose', () => ({
    connection: {
        db: {
            collection: () => ({
                find: () => ({
                    async *[Symbol.asyncIterator]() {
                        for (const doc of JSON.parse(JSON.stringify(collection.docs))) yield doc;
                    },
                }),
                // Honours the name and the expected value, which is what makes
                // the compare-and-set mean anything.
                updateOne: async (filter, update) => {
                    const doc = collection.docs.find(d => d._id === filter._id);
                    const { name, authorizationToken } = filter['ai.mcpServers'].$elemMatch;
                    const server = doc?.ai.mcpServers.find(s => s.name === name && s.authorizationToken === authorizationToken);
                    if (!server) return { matchedCount: 0 };
                    server.authorizationToken = update.$set['ai.mcpServers.$.authorizationToken'];
                    return { matchedCount: 1 };
                },
            }),
        },
    },
}));

const {
    encryptStoredMcpTokens, decryptStoredMcpTokens, countPlaintextMcpTokens,
} = require('../src/migrations/027_encrypt_mcp_tokens');
const { encryptSecret, decryptSecret, isEncrypted, _resetSecretBox } = require('../src/config/secretBox');

function setKey(value) {
    if (value === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = value;
    _resetSecretBox();
}

const tokenOf = (guildId, name) => collection.docs
    .find(d => d.guildId === guildId).ai.mcpServers.find(s => s.name === name).authorizationToken;

let savedKey;
beforeAll(() => { savedKey = process.env.SECRET_ENCRYPTION_KEY; });
afterAll(() => setKey(savedKey));

beforeEach(() => {
    setKey('a-test-encryption-key');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    collection.docs = [
        { _id: 'g1', guildId: 'g1', ai: { mcpServers: [
            { name: 'github', authorizationToken: 'ghp_plain' },
            { name: 'docs', authorizationToken: null },
        ] } },
        { _id: 'g2', guildId: 'g2', ai: { mcpServers: [
            { name: 'fastmail', authorizationToken: encryptSecret('fm_sealed') },
        ] } },
    ];
});
afterEach(() => jest.restoreAllMocks());

test('encrypts the plaintext tokens and leaves the rest', async () => {
    expect(await countPlaintextMcpTokens()).toBe(1);

    await expect(encryptStoredMcpTokens()).resolves.toEqual({ guilds: 1, tokens: 1, skipped: 0 });

    expect(isEncrypted(tokenOf('g1', 'github'))).toBe(true);
    expect(decryptSecret(tokenOf('g1', 'github'))).toBe('ghp_plain');
    expect(tokenOf('g1', 'docs')).toBeNull();
    expect(decryptSecret(tokenOf('g2', 'fastmail'))).toBe('fm_sealed');
    expect(await countPlaintextMcpTokens()).toBe(0);
});

test('is idempotent', async () => {
    await encryptStoredMcpTokens();
    await expect(encryptStoredMcpTokens()).resolves.toEqual({ guilds: 0, tokens: 0, skipped: 0 });
});

test('rolls back to plaintext with the same key', async () => {
    await encryptStoredMcpTokens();
    await expect(decryptStoredMcpTokens()).resolves.toEqual({ tokens: 2, skipped: 0 });
    expect(tokenOf('g1', 'github')).toBe('ghp_plain');
    expect(tokenOf('g2', 'fastmail')).toBe('fm_sealed');
});

test('refuses to run without a key', async () => {
    setKey(undefined);
    await expect(encryptStoredMcpTokens()).rejects.toThrow(/SECRET_ENCRYPTION_KEY/);
});
