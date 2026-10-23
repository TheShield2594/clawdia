'use strict';

// #1147. A guild with no key of its own fell back to the operator's bot-wide
// key, and the only limits on that spend were the guild's own settings, where
// 0 means unlimited. So an admin of any guild the bot was invited to could
// switch AI on, zero the limits, and run up the operator's bill. These hold
// the three halves of the fix: the operator names the guilds, the operator's
// ceilings bind environment spend whatever the guild set, and a guild key that
// will not open is reported rather than quietly swapped for the operator's.

const {
    resolveApiKey, envKeyAllowed, envKeyCeilings, applyEnvKeyCeilings,
    missingKeyMessage, ENV_KEY_DEFAULTS, _resetApiKeyWarnings,
} = require('../src/services/ai/apiKeys');
const { encryptSecret, _resetSecretBox } = require('../src/config/secretBox');
const { resolveProviderConfig } = require('../src/services/ai');

const VARS = [
    'AI_ENV_KEY_GUILDS', 'AI_ENV_KEY_USER_LIMIT', 'AI_ENV_KEY_MONTHLY_COST',
    'AI_ENV_KEY_MONTHLY_TOKENS', 'OPENAI_API_KEY', 'SECRET_ENCRYPTION_KEY',
];
let saved;

beforeEach(() => {
    saved = Object.fromEntries(VARS.map(name => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    _resetApiKeyWarnings();
    _resetSecretBox();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    _resetSecretBox();
    jest.restoreAllMocks();
});

const openai = (settings, guildId) =>
    resolveApiKey(settings, { field: 'openaiKey', envKey: process.env.OPENAI_API_KEY, guildId });

describe('who may spend the operator key', () => {
    test('nobody, when AI_ENV_KEY_GUILDS is unset', () => {
        process.env.OPENAI_API_KEY = 'sk-operator';

        expect(openai({}, 'g1')).toEqual({ apiKey: null, keySource: null, keyError: 'env-not-allowed' });
    });

    test('the guilds it lists, comma- or space-separated', () => {
        process.env.AI_ENV_KEY_GUILDS = '111, 222  333';

        expect(['111', '222', '333'].map(envKeyAllowed)).toEqual([true, true, true]);
        expect(envKeyAllowed('444')).toBe(false);
        // Not a substring match: a guild ID that contains a listed one is not it.
        expect(envKeyAllowed('1111')).toBe(false);
    });

    test('every guild, with `*`', () => {
        process.env.AI_ENV_KEY_GUILDS = '*';
        process.env.OPENAI_API_KEY = 'sk-operator';

        expect(openai({}, 'any')).toEqual({ apiKey: 'sk-operator', keySource: 'env' });
    });

    test('not a request that names no guild, unless every guild is allowed', () => {
        process.env.AI_ENV_KEY_GUILDS = '111';
        expect(envKeyAllowed(undefined)).toBe(false);
    });

    test('a guild with its own key uses it, listed or not', () => {
        process.env.OPENAI_API_KEY = 'sk-operator';

        expect(openai({ openaiKey: 'sk-guild' }, 'g1')).toEqual({ apiKey: 'sk-guild', keySource: 'guild' });
    });

    test('no operator key at all is plain "no key", not a refusal', () => {
        expect(openai({}, 'g1')).toEqual({ apiKey: null, keySource: null });
    });
});

describe('a stored key that will not open', () => {
    // Swapping in the operator's key would move this guild's spend onto the
    // operator's bill with nobody having decided it should.
    test('is reported, and does not fall back to the operator key', () => {
        process.env.SECRET_ENCRYPTION_KEY = 'one-key';
        _resetSecretBox();
        const sealed = encryptSecret('sk-guild');
        process.env.SECRET_ENCRYPTION_KEY = 'another-key';
        _resetSecretBox();
        process.env.OPENAI_API_KEY = 'sk-operator';
        process.env.AI_ENV_KEY_GUILDS = '*';

        expect(openai({ openaiKey: sealed }, 'g1')).toEqual({ apiKey: null, keySource: null, keyError: 'undecryptable' });
    });

    test('is described to the person asking as something an admin can fix', () => {
        expect(missingKeyMessage('OpenAI', 'undecryptable')).toMatch(/saved OpenAI key could not be read/);
        expect(missingKeyMessage('OpenAI', 'env-not-allowed')).toMatch(/OpenAI is not configured/);
        expect(missingKeyMessage('OpenAI', null)).toMatch(/OpenAI is not configured/);
    });
});

describe('the operator ceilings', () => {
    const limits = (over = {}) => ({
        perUser: 0, perChannel: 0, windowMin: 10, monthlyTokens: 0, monthlyCost: 0, ...over,
    });

    test('default when unset, and 0 lifts one', () => {
        expect(envKeyCeilings()).toEqual(ENV_KEY_DEFAULTS);

        process.env.AI_ENV_KEY_MONTHLY_COST = '0';
        expect(envKeyCeilings().monthlyCost).toBe(0);
    });

    test('a malformed value is the default, said once', () => {
        process.env.AI_ENV_KEY_USER_LIMIT = 'lots';

        expect(envKeyCeilings().userLimit).toBe(ENV_KEY_DEFAULTS.userLimit);
        envKeyCeilings();
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    // The whole attack: every guild limit set to 0, meaning unlimited.
    test('bind a guild that set no limits at all', () => {
        expect(applyEnvKeyCeilings(limits(), { userLimit: 20, monthlyCost: 10, monthlyTokens: 1000 }))
            .toMatchObject({ perUser: 20, windowMin: 10, monthlyCost: 10, monthlyTokens: 1000 });
    });

    test('leave a guild its own tighter limits', () => {
        const own = limits({ perUser: 5, windowMin: 60, monthlyCost: 2, monthlyTokens: 500 });

        expect(applyEnvKeyCeilings(own, { userLimit: 20, monthlyCost: 10, monthlyTokens: 1000 }))
            .toEqual(own);
    });

    // A rate is compared as a rate: 100 a minute is past 20 per 10 minutes even
    // though "100" and "1" are both numbers a guild may choose.
    test('hold a guild whose own rate is looser to the ceiling', () => {
        const capped = applyEnvKeyCeilings(limits({ perUser: 100, windowMin: 1 }), { userLimit: 20, monthlyCost: 0, monthlyTokens: 0 });

        expect(capped).toMatchObject({ perUser: 20, windowMin: 10 });
    });

    test('rescale the channel limit when they move the window, rounding down', () => {
        const capped = applyEnvKeyCeilings(
            limits({ perUser: 0, perChannel: 60, windowMin: 60 }),
            { userLimit: 20, monthlyCost: 0, monthlyTokens: 0 });

        // 60 an hour is 10 per 10 minutes, not 60 per 10 minutes.
        expect(capped).toMatchObject({ windowMin: 10, perChannel: 10 });
    });

    test('lifted ceilings leave the guild limits alone', () => {
        const own = limits({ perUser: 0, monthlyCost: 0 });
        expect(applyEnvKeyCeilings(own, { userLimit: 0, monthlyCost: 0, monthlyTokens: 0 })).toEqual(own);
    });
});

describe('resolveProviderConfig', () => {
    const unlimited = {
        provider: 'openai', rateLimitPerUser: 0, rateLimitWindowMin: 10,
        monthlyCostLimit: 0, monthlyTokenLimit: 0,
    };

    test('applies the ceilings when the operator key is in use', () => {
        process.env.OPENAI_API_KEY = 'sk-operator';
        process.env.AI_ENV_KEY_GUILDS = 'g1';

        const config = resolveProviderConfig(unlimited, { guildId: 'g1' });

        expect(config.keySource).toBe('env');
        expect(config.rateLimit).toMatchObject({
            perUser: ENV_KEY_DEFAULTS.userLimit,
            monthlyCost: ENV_KEY_DEFAULTS.monthlyCost,
            monthlyTokens: ENV_KEY_DEFAULTS.monthlyTokens,
        });
    });

    test('leaves a guild on its own key to its own limits', () => {
        process.env.OPENAI_API_KEY = 'sk-operator';
        process.env.AI_ENV_KEY_GUILDS = 'g1';

        const config = resolveProviderConfig({ ...unlimited, openaiKey: 'sk-guild' }, { guildId: 'g1' });

        expect(config.keySource).toBe('guild');
        expect(config.rateLimit).toMatchObject({ perUser: 0, monthlyCost: 0, monthlyTokens: 0 });
    });

    test('carries the reason there is no key', () => {
        process.env.OPENAI_API_KEY = 'sk-operator';

        const config = resolveProviderConfig(unlimited, { guildId: 'g1' });

        expect(config).toMatchObject({ apiKey: null, keySource: null, keyError: 'env-not-allowed' });
    });
});
