'use strict';

// The guild's `ai.rateLimitPerUser` / `rateLimitPerChannel` settings are the
// only thing standing between a slash command and an unbounded provider bill.
// They used to be applied by the messageCreate transport alone, so /questgen,
// /forge and the DM campaign commands spent tokens without ever consulting
// them. These tests hold the line at the dispatch layer instead: nothing
// reaches a provider without passing through it.

const fs = require('fs');
const path = require('path');

jest.mock('../src/services/ai/providers', () => {
    const complete = jest.fn(async () => ({ text: 'ok', usage: null }));
    const stream = jest.fn(async function* () { yield 'ok'; });
    const provider = {
        name: 'mock', label: 'Mock', defaultModel: 'mock-1',
        resolveAuth: () => ({ apiKey: 'k' }),
        complete, stream,
    };
    return {
        providers: new Map([['mock', provider]]),
        getProvider: () => provider,
        DEFAULT_MODELS: { mock: 'mock-1' },
        __complete: complete,
        __stream: stream,
    };
});

const providersMock = require('../src/services/ai/providers');
const { resolveProviderConfig, getCompletion, streamCompletion } = require('../src/services/ai');

const SETTINGS = {
    provider: 'mock',
    model: 'mock-1',
    rateLimitPerUser: 2,
    rateLimitPerChannel: 3,
    rateLimitWindowMin: 10,
};

// Fresh key per test so the module-level sliding windows never leak between them.
let seq = 0;
const nextUser = () => `user-${++seq}`;
const nextChannel = () => `chan-${++seq}`;

async function drain(iterable) {
    const out = [];
    for await (const piece of iterable) out.push(piece);
    return out;
}

beforeEach(() => {
    providersMock.__complete.mockClear();
    providersMock.__stream.mockClear();
});

describe('resolveProviderConfig', () => {
    it('carries the guild\'s limits with the provider config', () => {
        expect(resolveProviderConfig(SETTINGS).rateLimit)
            .toEqual({ perUser: 2, perChannel: 3, windowMin: 10 });
    });

    it('defaults to no limit rather than to an accidental one', () => {
        expect(resolveProviderConfig({ provider: 'mock' }).rateLimit)
            .toEqual({ perUser: 0, perChannel: 0, windowMin: 10 });
    });
});

describe('getCompletion', () => {
    it('refuses once the per-user limit is spent, without calling the provider', async () => {
        const config = resolveProviderConfig(SETTINGS);
        const userId = nextUser();
        const call = () => getCompletion({ ...config, userId, prompt: 'hi' });

        await call();
        await call();
        await expect(call()).rejects.toMatchObject({ rateLimited: true, scope: 'user', limit: 2 });
        expect(providersMock.__complete).toHaveBeenCalledTimes(2);
    });

    it('refuses on the per-channel limit too', async () => {
        const config = resolveProviderConfig({ ...SETTINGS, rateLimitPerUser: 0 });
        const channelId = nextChannel();
        const call = () => getCompletion({ ...config, userId: nextUser(), channelId, prompt: 'hi' });

        await call();
        await call();
        await call();
        await expect(call()).rejects.toMatchObject({ rateLimited: true, scope: 'channel', limit: 3 });
        expect(providersMock.__complete).toHaveBeenCalledTimes(3);
    });

    it('does not spend a user slot when the channel is the one that is full', async () => {
        const config = resolveProviderConfig({ ...SETTINGS, rateLimitPerChannel: 1 });
        const channelId = nextChannel();
        const userA = nextUser();
        const userB = nextUser();

        await getCompletion({ ...config, userId: userA, channelId, prompt: 'hi' });
        await expect(getCompletion({ ...config, userId: userB, channelId, prompt: 'hi' }))
            .rejects.toMatchObject({ scope: 'channel' });

        // userB was refused by the channel, so their own window is untouched:
        // their full per-user allowance must still be available elsewhere.
        await getCompletion({ ...config, userId: userB, channelId: nextChannel(), prompt: 'hi' });
        await getCompletion({ ...config, userId: userB, channelId: nextChannel(), prompt: 'hi' });
        await expect(getCompletion({ ...config, userId: userB, channelId: nextChannel(), prompt: 'hi' }))
            .rejects.toMatchObject({ scope: 'user' });
        expect(providersMock.__complete).toHaveBeenCalledTimes(3);
    });

    it('leaves an unattributed call — the scheduled jobs — unbounded', async () => {
        const config = resolveProviderConfig({ ...SETTINGS, rateLimitPerUser: 1 });
        for (let i = 0; i < 5; i++) await getCompletion({ ...config, prompt: 'hi' });
        expect(providersMock.__complete).toHaveBeenCalledTimes(5);
    });

    it('does not bound a guild that has left the limits off', async () => {
        const config = resolveProviderConfig({ provider: 'mock' });
        const userId = nextUser();
        for (let i = 0; i < 5; i++) await getCompletion({ ...config, userId, prompt: 'hi' });
        expect(providersMock.__complete).toHaveBeenCalledTimes(5);
    });
});

describe('streamCompletion', () => {
    it('refuses before the caller pulls a chunk, so no placeholder is posted for a denied turn', async () => {
        const config = resolveProviderConfig({ ...SETTINGS, rateLimitPerUser: 1 });
        const userId = nextUser();
        await drain(streamCompletion({ ...config, userId, prompt: 'hi' }));

        // The throw has to happen on the call, not on the first next().
        expect(() => streamCompletion({ ...config, userId, prompt: 'hi' }))
            .toThrow(expect.objectContaining({ rateLimited: true }));
        expect(providersMock.__stream).toHaveBeenCalledTimes(1);
    });
});

describe('call sites', () => {
    const SRC = path.join(__dirname, '..', 'src');

    // Every provider call that a user can trigger has to say who it is for,
    // or the limits above have nothing to bill it to.
    const USER_TRIGGERED = [
        'commands/community/questgen.js',
        'commands/economy/forge.js',
        'services/dmService.js',
        'services/ai/discordChat.js',
    ];

    it.each(USER_TRIGGERED)('%s names a userId in every inline provider call', file => {
        const src = fs.readFileSync(path.join(SRC, file), 'utf8');
        const calls = src.match(/(?:getCompletion|streamCompletion)\(\{[\s\S]*?\n\s*\}\)/g) || [];
        for (const call of calls) expect(call).toMatch(/userId:/);
        // The config the call spreads has to be the one carrying the limits.
        expect(src).toMatch(/rateLimit/);
    });

    it('builds discordChat\'s prepared args with the attribution too', () => {
        // The one call site that passes a prebuilt object rather than a literal.
        const src = fs.readFileSync(path.join(SRC, 'services/ai/discordChat.js'), 'utf8');
        const callArgs = /const callArgs = \{[\s\S]*?\n\s*\};/.exec(src);
        expect(callArgs).not.toBeNull();
        expect(callArgs[0]).toMatch(/userId: message\.author\.id/);
        expect(callArgs[0]).toMatch(/channelId: message\.channel\.id/);
        expect(callArgs[0]).toMatch(/rateLimit/);
    });

    it('covers every user-triggered provider call in the tree', () => {
        // A new command that calls a provider without attribution is exactly
        // the regression this whole file exists for, so enumerate the callers
        // rather than trusting the list above to stay complete.
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(path.join(dir, e.name))
                : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);

        // Where a provider call is legitimately unattributed, and why.
        const SCHEDULED = new Set([
            'services/summaryService.js',    // cron: scheduled digests
            'services/newspaperService.js',  // cron, plus an attributed preview
        ]);

        const unattributed = walk(SRC)
            .map(f => path.relative(SRC, f).split(path.sep).join('/'))
            .filter(rel => rel !== 'services/ai/index.js' && rel !== 'services/aiService.js')
            .filter(rel => {
                const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
                return /\b(?:getCompletion|streamCompletion)\(/.test(src) && !/userId/.test(src);
            })
            .filter(rel => !SCHEDULED.has(rel));

        expect(unattributed).toEqual([]);
    });

    it('keeps the enforcement in the dispatch layer, not the transports', () => {
        const dispatch = fs.readFileSync(path.join(SRC, 'services/ai/index.js'), 'utf8');
        expect(dispatch).toMatch(/enforceRateLimit\(\{ userId, channelId, rateLimit \}\)/);

        // The transport may peek to refuse early, but it must not be the thing
        // that spends the slot — that would double-count against the dispatch.
        const chat = fs.readFileSync(path.join(SRC, 'services/ai/discordChat.js'), 'utf8');
        expect(chat).not.toMatch(/\bcheckRateLimit\(|\bcheckChannelRateLimit\(/);
        expect(chat).toMatch(/peekRateLimit\(/);
    });
});
