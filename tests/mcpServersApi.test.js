'use strict';

// The dashboard is where a guild admin types an OAuth token, so these cover the
// two things that matter at that boundary: what gets stored, and what is allowed
// back out to the browser.

const { validateServerInput, publicServer, PRESETS } = require('../src/dashboard/routes/api/mcpServers');

describe('validateServerInput', () => {
    const ok = { url: 'https://api.githubcopilot.com/mcp/' };

    test('accepts a minimal https server', () => {
        const result = validateServerInput(ok, 'github');
        expect(result.error).toBeUndefined();
        expect(result.value).toEqual({
            name: 'github',
            url: 'https://api.githubcopilot.com/mcp/',
            enabled: true,
            allowedTools: [],
            blockedTools: [],
            confirmTools: [],
            resources: false
        });
    });

    test.each([
        ['a name with spaces', 'my server', ok],
        ['an empty name', '', ok],
        ['a name over 64 characters', 'x'.repeat(65), ok],
        ['a missing url', 'github', {}],
        ['a plaintext url', 'github', { url: 'http://api.example.com/mcp/' }],
        ['a non-url', 'github', { url: 'not a url' }]
    ])('rejects %s', (_label, name, body) => {
        expect(validateServerInput(body, name).error).toBeTruthy();
    });

    test('rejects a url that is not http(s) at all', () => {
        expect(validateServerInput({ url: 'file:///etc/passwd' }, 'local').error).toMatch(/https/);
    });

    // The url is listed back to the dashboard, so a credential hidden in it
    // would be readable there — unlike the token, which is write-only.
    test.each([
        ['a username and password', 'https://user:pass@mcp.example.com/sse'],
        ['a username alone', 'https://token@mcp.example.com/sse'],
        ['an empty username with a password', 'https://:pass@mcp.example.com/sse']
    ])('rejects a url carrying %s', (_label, url) => {
        expect(validateServerInput({ url }, 'github').error).toMatch(/username or password/);
    });

    test('still accepts a url with a port, path and query', () => {
        const result = validateServerInput({ url: 'https://mcp.example.com:8443/mcp/sse?v=2' }, 'custom');
        expect(result.error).toBeUndefined();
        expect(result.value.url).toBe('https://mcp.example.com:8443/mcp/sse?v=2');
    });

    test('trims, dedupes and keeps tool names', () => {
        const result = validateServerInput(
            { ...ok, allowedTools: [' search_repos ', 'search_repos', 'get_file'], blockedTools: ['delete_file'] },
            'github'
        );
        expect(result.value.allowedTools).toEqual(['search_repos', 'get_file']);
        expect(result.value.blockedTools).toEqual(['delete_file']);
    });

    test('rejects tool lists that are not arrays of strings', () => {
        expect(validateServerInput({ ...ok, allowedTools: 'search' }, 'github').error).toBeTruthy();
        expect(validateServerInput({ ...ok, blockedTools: [{ name: 'x' }] }, 'github').error).toBeTruthy();
    });

    test('caps the number of tool names', () => {
        const many = Array.from({ length: 51 }, (_, i) => `tool_${i}`);
        expect(validateServerInput({ ...ok, allowedTools: many }, 'github').error).toMatch(/limited to/);
    });

    test('rejects an oversized token rather than storing it', () => {
        expect(validateServerInput({ ...ok, authorizationToken: 'x'.repeat(4097) }, 'github').error).toMatch(/too long/);
    });

    test('honours enabled: false', () => {
        expect(validateServerInput({ ...ok, enabled: false }, 'github').value.enabled).toBe(false);
    });
});

describe('publicServer', () => {
    test('reports that a token exists without ever returning it', () => {
        const shaped = publicServer({
            name: 'github',
            url: 'https://api.githubcopilot.com/mcp/',
            enabled: true,
            authorizationToken: 'ghp_supersecret',
            allowedTools: [],
            blockedTools: ['delete_file']
        });

        expect(shaped.hasToken).toBe(true);
        expect(shaped).not.toHaveProperty('authorizationToken');
        expect(JSON.stringify(shaped)).not.toContain('ghp_supersecret');
    });

    test('reports a missing token as hasToken false', () => {
        expect(publicServer({ name: 'docs', url: 'https://docs.example.com/mcp' }).hasToken).toBe(false);
    });
});

describe('presets', () => {
    const hosted = PRESETS.filter(p => p.url);
    const bringYourOwn = PRESETS.filter(p => !p.url);

    test('every preset has a name the API accepts and something to say about itself', () => {
        const { NAME_PATTERN } = require('../src/config/mcpServers');
        expect(PRESETS.length).toBeGreaterThan(0);
        for (const preset of PRESETS) {
            expect(NAME_PATTERN.test(preset.name)).toBe(true);
            expect(preset.hint).toBeTruthy();
            expect(typeof preset.requiresToken).toBe('boolean');
        }
    });

    test('preset ids and names are unique, so one cannot quietly shadow another', () => {
        expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
        expect(new Set(PRESETS.map(p => p.name)).size).toBe(PRESETS.length);
    });

    test('a hosted preset points at https and survives validation unchanged', () => {
        expect(hosted.length).toBeGreaterThan(0);
        for (const preset of hosted) {
            expect(new URL(preset.url).protocol).toBe('https:');
            expect(validateServerInput({ url: preset.url }, preset.name).error).toBeUndefined();
        }
    });

    // Gmail and Spotify have no single hosted endpoint to point at: the server
    // is one the operator runs or a hosting provider spins up per account. The
    // preset fills in everything except the address, so it has to show what
    // kind of address to type and explain why it is asking.
    test('a preset with no endpoint says so and shows the shape of one', () => {
        for (const preset of bringYourOwn) {
            expect(preset.urlPlaceholder).toMatch(/^https:\/\//);
            expect(preset.hint).toMatch(/paste that URL here/);
            expect(preset.label).toMatch(/your own endpoint/);
        }
    });

    test('an empty endpoint is still rejected on save rather than stored', () => {
        for (const preset of bringYourOwn) {
            expect(validateServerInput({ url: preset.url }, preset.name).error).toBeTruthy();
        }
    });

    test('a preset that wants no token does not ask for one', () => {
        for (const preset of PRESETS.filter(p => p.requiresToken === false)) {
            expect(preset.tokenHint).toBeTruthy();
        }
    });
});
