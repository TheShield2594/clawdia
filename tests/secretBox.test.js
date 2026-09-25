'use strict';

// #564. The per-guild AI provider keys were plain strings in MongoDB, and the
// compose stack writes unencrypted mongodump archives into a host bind mount
// every night and keeps a month of them — so "you need database access to read
// them" quietly meant "you need read access to ./backups".
//
// Three things have to hold for the fix to be worth anything, and each has a
// section below: values written go in encrypted, values read come back out, and
// an install that never configured a key keeps working exactly as before.

const {
    encryptSecret,
    decryptSecret,
    isEncrypted,
    encryptionEnabled,
    _resetSecretBox,
    guildSecretBinding,
    isBound,
    PREFIX,
    PREFIX_BOUND,
} = require('../src/config/secretBox');

const KEY = 'a-test-encryption-key';

function withKey(value, fn) {
    const saved = process.env.SECRET_ENCRYPTION_KEY;
    if (value === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = value;
    _resetSecretBox();
    try {
        return fn();
    } finally {
        if (saved === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
        else process.env.SECRET_ENCRYPTION_KEY = saved;
        _resetSecretBox();
    }
}

beforeEach(() => {
    _resetSecretBox();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('with a key configured', () => {
    test('round-trips a secret', () => withKey(KEY, () => {
        const sealed = encryptSecret('sk-ant-live-credential');

        expect(sealed).not.toContain('sk-ant-live-credential');
        expect(isEncrypted(sealed)).toBe(true);
        expect(decryptSecret(sealed)).toBe('sk-ant-live-credential');
    }));

    // A deterministic ciphertext would leak that two guilds pasted the same
    // key, and reusing an IV under one key is how GCM stops being secure.
    test('encrypts the same value differently every time', () => withKey(KEY, () => {
        const a = encryptSecret('sk-same');
        const b = encryptSecret('sk-same');

        expect(a).not.toBe(b);
        expect([decryptSecret(a), decryptSecret(b)]).toEqual(['sk-same', 'sk-same']);
    }));

    // The setter runs on every write, including a document being re-saved with
    // the value it already had.
    test('is idempotent — encrypting ciphertext returns it unchanged', () => withKey(KEY, () => {
        const once = encryptSecret('sk-abc');

        expect(encryptSecret(once)).toBe(once);
        expect(decryptSecret(encryptSecret(once))).toBe('sk-abc');
    }));

    test('leaves the empty and absent cases alone', () => withKey(KEY, () => {
        expect(encryptSecret(null)).toBeNull();
        expect(encryptSecret('')).toBe('');
        expect(encryptSecret(undefined)).toBeUndefined();
    }));

    // GCM's authentication tag, which is the reason for choosing it: a modified
    // ciphertext must fail to open rather than decrypt to some other key.
    test('refuses a tampered value instead of returning something else', () => withKey(KEY, () => {
        const sealed = encryptSecret('sk-abc');
        const [iv, tag, ct] = sealed.slice(PREFIX.length).split('.');
        const bytes = Buffer.from(ct, 'base64url');
        bytes[0] ^= 0xff;
        const flipped = `${PREFIX}${iv}.${tag}.${bytes.toString('base64url')}`;

        expect(decryptSecret(flipped)).toBeNull();
    }));

    test('refuses a value sealed under a different key', () => {
        const sealed = withKey(KEY, () => encryptSecret('sk-abc'));

        expect(withKey('a-completely-different-key', () => decryptSecret(sealed))).toBeNull();
    });

    // #1152. Node accepts a GCM tag as short as four bytes unless told
    // otherwise, and a truncated tag is a far cheaper forgery target.
    test('refuses a value whose tag has been truncated', () => withKey(KEY, () => {
        const sealed = encryptSecret('sk-abc');
        const [iv, tag, ct] = sealed.slice(PREFIX.length).split('.');
        const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');

        expect(decryptSecret(`${PREFIX}${iv}.${short}.${ct}`)).toBeNull();
    }));

    // Pre-#564 rows. They keep working until something rewrites them, which is
    // what makes the change deployable without a flag day.
    test('reads a plaintext key written before encryption was configured', () => withKey(KEY, () => {
        expect(decryptSecret('sk-legacy-plaintext')).toBe('sk-legacy-plaintext');
    }));
});

// #1152: a bound value carries its guild and field as GCM additional data, so
// a sealed key copied into another guild's document, or another field, fails
// to open instead of being spent by the wrong guild.
describe('a value sealed to a binding', () => {
    const G1 = guildSecretBinding('g1', 'ai.openaiKey');

    test('round-trips under the same binding, in the v2 format', () => withKey(KEY, () => {
        const sealed = encryptSecret('sk-abc', G1);

        expect(sealed.startsWith(PREFIX_BOUND)).toBe(true);
        expect(isBound(sealed)).toBe(true);
        expect(isEncrypted(sealed)).toBe(true);
        expect(decryptSecret(sealed, G1)).toBe('sk-abc');
    }));

    test.each([
        ['another guild', guildSecretBinding('g2', 'ai.openaiKey')],
        ['another field', guildSecretBinding('g1', 'ai.geminiKey')],
        ['no binding at all', null],
    ])('does not open under %s', (_label, binding) => withKey(KEY, () => {
        expect(decryptSecret(encryptSecret('sk-abc', G1), binding)).toBeNull();
    }));

    test('an unbound value still opens, whatever binding it is read with', () => withKey(KEY, () => {
        expect(decryptSecret(encryptSecret('sk-abc'), G1)).toBe('sk-abc');
    }));

    test('there is no binding without a guild', () => {
        expect(guildSecretBinding(null, 'ai.openaiKey')).toBeNull();
        expect(guildSecretBinding('', 'ai.openaiKey')).toBeNull();
    });
});

describe('with no key configured', () => {
    test('stores the value as it always did', () => withKey(undefined, () => {
        expect(encryptionEnabled()).toBe(false);
        expect(encryptSecret('sk-abc')).toBe('sk-abc');
        expect(decryptSecret('sk-abc')).toBe('sk-abc');
    }));

    test('treats a blank key as no key, rather than deriving from ""', () => withKey('   ', () => {
        expect(encryptionEnabled()).toBe(false);
        expect(encryptSecret('sk-abc')).toBe('sk-abc');
    }));

    // The rotated-away or forgotten key. Null is the useful answer because
    // every caller falls back to the bot-wide environment key; returning the
    // ciphertext would send it to the provider as a credential.
    test('answers null for a value it cannot open, and says so once', () => {
        const sealed = withKey(KEY, () => encryptSecret('sk-abc'));

        withKey(undefined, () => {
            expect(decryptSecret(sealed)).toBeNull();
            expect(decryptSecret(sealed)).toBeNull();
        });

        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(console.warn.mock.calls[0][0]).toContain('SECRET_ENCRYPTION_KEY');
    });

    test('never logs the value it could not read', () => {
        const sealed = withKey(KEY, () => encryptSecret('sk-ant-live-credential'));

        withKey(undefined, () => decryptSecret(sealed));

        const logged = console.warn.mock.calls.flat().join(' ');
        expect(logged).not.toContain('sk-ant');
        expect(logged).not.toContain(sealed);
    });
});

describe('the Guild schema stores provider keys sealed', () => {
    // The real model, unconnected: Mongoose runs setters when a path is set, so
    // this is the write path the dashboard takes without needing a server.
    const Guild = require('../src/models/Guild');
    const FIELDS = ['openaiKey', 'geminiKey', 'anthropicKey', 'openrouterKey'];

    test.each(FIELDS)('ai.%s is ciphertext in the document', field => withKey(KEY, () => {
        const guild = new Guild({ guildId: '1', ai: { [field]: 'sk-plain-secret' } });

        expect(guild.ai[field]).not.toBe('sk-plain-secret');
        expect(isEncrypted(guild.ai[field])).toBe(true);
        expect(decryptSecret(guild.ai[field], guildSecretBinding('1', `ai.${field}`))).toBe('sk-plain-secret');
        // Sealed to this guild: it will not open as anyone else's.
        expect(decryptSecret(guild.ai[field], guildSecretBinding('2', `ai.${field}`))).toBeNull();
    }));

    // The dashboard writes dotted paths through `guildSettings.set(key, value)`.
    test('a dotted set() from the settings route is sealed too', () => withKey(KEY, () => {
        const guild = new Guild({ guildId: '1' });
        guild.set('ai.openaiKey', 'sk-from-dashboard');

        expect(isEncrypted(guild.ai.openaiKey)).toBe(true);
        expect(decryptSecret(guild.ai.openaiKey, guildSecretBinding('1', 'ai.openaiKey'))).toBe('sk-from-dashboard');
    }));

    test('clearing a key still clears it', () => withKey(KEY, () => {
        const guild = new Guild({ guildId: '1', ai: { openaiKey: 'sk-abc' } });
        guild.set('ai.openaiKey', null);

        expect(guild.ai.openaiKey).toBeNull();
    }));

    test('an install with no key configured stores what it always did', () => withKey(undefined, () => {
        const guild = new Guild({ guildId: '1', ai: { openaiKey: 'sk-abc' } });

        expect(guild.ai.openaiKey).toBe('sk-abc');
    }));
});

describe('the AI providers read the sealed value back', () => {
    // The read side of the same write. These documents reach the AI path as
    // plain objects via toObject(), which does not run getters — so the decrypt
    // has to be here, and a missing one would send ciphertext to the provider.
    const CASES = [
        ['openai', require('../src/services/ai/providers/openai'), 'openaiKey', 'OPENAI_API_KEY'],
        ['gemini', require('../src/services/ai/providers/gemini'), 'geminiKey', 'GEMINI_API_KEY'],
        ['anthropic', require('../src/services/ai/providers/anthropic'), 'anthropicKey', 'ANTHROPIC_API_KEY'],
        ['openrouter', require('../src/services/ai/providers/openrouter'), 'openrouterKey', 'OPENROUTER_API_KEY'],
    ];

    test.each(CASES)('%s decrypts the guild key', (_name, provider, field) => withKey(KEY, () => {
        const settings = { [field]: encryptSecret('sk-guild-key') };

        expect(provider.resolveAuth(settings).apiKey).toBe('sk-guild-key');
    }));

    test.each(CASES)('%s opens a key bound to its guild, given the guild', (_name, provider, field) => withKey(KEY, () => {
        const settings = { [field]: encryptSecret('sk-guild-key', guildSecretBinding('g1', `ai.${field}`)) };

        expect(provider.resolveAuth(settings, { guildId: 'g1' }).apiKey).toBe('sk-guild-key');
    }));

    test.each(CASES)('%s still takes a plaintext guild key', (_name, provider, field) => withKey(KEY, () => {
        expect(provider.resolveAuth({ [field]: 'sk-legacy' }).apiKey).toBe('sk-legacy');
    }));

    // Losing the key must degrade to the bot-wide credential, not to an auth
    // failure against a provider that was handed a base64 blob.
    test.each(CASES)('%s falls back to the environment when the guild key cannot be opened', (_name, provider, field, envVar) => {
        const sealed = withKey(KEY, () => encryptSecret('sk-unreadable'));
        const saved = process.env[envVar];
        process.env[envVar] = 'sk-bot-wide';

        try {
            withKey(undefined, () => {
                expect(provider.resolveAuth({ [field]: sealed }).apiKey).toBe('sk-bot-wide');
            });
        } finally {
            if (saved === undefined) delete process.env[envVar];
            else process.env[envVar] = saved;
        }
    });
});
