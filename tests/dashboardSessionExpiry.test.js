/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
'use strict';

process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #878. The dashboard session idles out after four hours, and until now nothing
// on the guild-settings page knew what that looked like. The two kinds of
// request it makes failed in two different misleading ways:
//
//   * an API route answers 401 `{ error: 'Unauthorized' }`, which the save
//     handler reported as a bare "Unauthorized" toast — on a section the user
//     plainly does administer;
//   * a panel fragment comes from a page route, which answers 302 to
//     /auth/login and on to Discord, where the cross-origin hop dies in CORS
//     and read as "Could not load this section".
//
// Both point at the wrong problem, neither offers a way back, and whatever was
// typed into the form is still sitting there unsaved. What follows drives the
// real page and asserts the behaviour that replaces it: one banner that names
// the actual cause, no generic error on top of it, nothing thrown away, and the
// banner gone again once a request succeeds.

const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const fs = require('fs');
const path = require('path');

const banner = () => document.getElementById('session-expired');
const toastText = () => document.getElementById('toast-message').textContent;

/** What an expired session looks like on an API route. */
const unauthorized = () => ({
    ok: false, status: 401, type: 'basic', redirected: false, url: '',
    json: async () => ({ error: 'Unauthorized' }),
    text: async () => '{"error":"Unauthorized"}',
});

/**
 * What an expired session looks like on a page route with `redirect: 'manual'`
 * in force: the 302 to /auth/login comes back as an opaque redirect rather than
 * being followed off-origin into a CORS failure.
 */
const opaqueRedirect = () => ({
    ok: false, status: 0, type: 'opaqueredirect', redirected: false, url: '',
    text: async () => '',
});

const ok = payload => ({
    ok: true, status: 200, type: 'basic', redirected: false, url: '',
    json: async () => payload, text: async () => JSON.stringify(payload),
});

afterEach(() => {
    forgetDocumentListeners();
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('an expired session is recognised and named', () => {
    it('raises the banner when an API route answers 401', async () => {
        bootPage();
        await settle();
        expect(banner().hidden).toBe(true);

        window.fetch = jest.fn(async () => unauthorized());
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });

        expect(banner().hidden).toBe(false);
        expect(banner().textContent).toMatch(/session expired/i);
    });

    it('offers a way back that does not navigate this tab away from the form', async () => {
        bootPage();
        await settle();

        const link = banner().querySelector('a');
        expect(link.getAttribute('href')).toBe('/auth/login');
        // A same-tab navigation to the OAuth flow is what would discard the
        // unsaved edits this whole change exists to keep.
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener');
    });

    it('announces itself rather than waiting to be tabbed past', async () => {
        bootPage();
        await settle();

        expect(banner().getAttribute('role')).toBe('alert');
    });

    it('says it once, however many requests fail after it', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => unauthorized());
        await window.apiFetch('/api/v1/guild/1/stats');
        await window.apiFetch('/api/v1/guild/1/insights');

        expect(document.querySelectorAll('#session-expired').length).toBe(1);
        expect(banner().hidden).toBe(false);
    });
});

describe('it replaces the misleading message rather than adding to it', () => {
    it('swallows the "Unauthorized" toast the 401 would otherwise produce', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => unauthorized());
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });
        // What saveSettings() does with the body it just read.
        window.toast('Unauthorized', 'error');

        expect(toastText()).not.toMatch(/unauthorized/i);
        expect(document.getElementById('toast').className).not.toMatch(/\bshow\b/);
    });

    it('still shows a message that is not an error', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => unauthorized());
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });
        window.toast('Settings saved', 'success');

        expect(toastText()).toMatch(/Settings saved/);
    });

    it('tells a failed panel to say what will load it, not that it is broken', async () => {
        bootPage({ panelFetch: name => (name === 'starboard' ? opaqueRedirect() : ok({})) });

        clickTab('starboard');
        await settle();

        const stub = document.querySelector('.panel-stub[data-panel="starboard"]');
        expect(banner().hidden).toBe(false);
        expect(stub.textContent).toMatch(/Sign in again/i);
        expect(stub.textContent).not.toMatch(/Could not load/i);
    });

    it('leaves the ordinary panel failure exactly as it was', async () => {
        bootPage({
            panelFetch: name => (name === 'starboard'
                ? { ok: false, status: 500, type: 'basic', redirected: false, url: '', text: async () => '' }
                : ok({})),
        });

        clickTab('starboard');
        await settle();

        const stub = document.querySelector('.panel-stub[data-panel="starboard"]');
        expect(banner().hidden).toBe(true);
        expect(stub.textContent).toMatch(/Could not load this section/i);
        expect(toastText()).toMatch(/Could not load that section/i);
    });
});

describe('nothing is thrown away, and the retry clears it', () => {
    it('leaves unsaved edits in the form', async () => {
        bootPage();
        clickTab('ai');
        await settle();

        const prompt = document.getElementById('ai-prompt');
        prompt.value = 'half-written system prompt';

        window.fetch = jest.fn(async () => unauthorized());
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });

        expect(document.getElementById('ai-prompt').value).toBe('half-written system prompt');
    });

    it('takes the banner down as soon as a request succeeds again', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => unauthorized());
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });
        expect(banner().hidden).toBe(false);

        // The cookie is set for the whole site, so signing in beside this tab
        // is all it takes — this tab never reloaded.
        window.fetch = jest.fn(async () => ok({}));
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });

        expect(banner().hidden).toBe(true);
    });

    // The page fires requests in parallel — the overview panel asks for stats
    // and insights at once — so a request dispatched while the session was
    // still good can land after a neighbour's 401. Its 200 describes the
    // session as it was before the expiry, not the one the banner is about.
    it('is not taken down by a success that was already in flight when it went up', async () => {
        bootPage();
        await settle();

        let releaseSlow;
        const slow = new Promise(resolve => { releaseSlow = resolve; });

        window.fetch = jest.fn(async url => (String(url).includes('slow') ? slow : unauthorized()));

        const inFlight = window.apiFetch('/api/v1/guild/1/slow');
        await window.apiFetch('/api/v1/guild/1/stats');
        expect(banner().hidden).toBe(false);

        releaseSlow(ok({}));
        await inFlight;

        expect(banner().hidden).toBe(false);
    });

    it('does not raise the banner for a plain server error', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => ({
            ok: false, status: 500, type: 'basic', redirected: false, url: '',
            json: async () => ({ error: 'Internal server error' }),
        }));
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });

        expect(banner().hidden).toBe(true);
    });
});

describe('the wrapper behaves like the fetch it replaced', () => {
    it('stops before the off-origin hop so the redirect is readable', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => ok({}));
        await window.apiFetch('/api/v1/guild/1/stats');

        expect(window.fetch.mock.calls[0][1].redirect).toBe('manual');
    });

    it('passes the caller\'s own options through', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => ok({}));
        const controller = new AbortController();
        await window.apiFetch('/api/v1/x', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: controller.signal,
        });

        const [, init] = window.fetch.mock.calls[0];
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(init.body).toBe('{}');
        expect(init.signal).toBe(controller.signal);
    });

    it('returns the response untouched, so call sites read it as before', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => ok({ total: 7 }));
        const res = await window.apiFetch('/api/v1/guild/1/stats');

        expect(res.ok).toBe(true);
        expect(await res.json()).toEqual({ total: 7 });
    });

    it('still rejects when the network does, so an aborted search aborts', async () => {
        bootPage();
        await settle();

        window.fetch = jest.fn(async () => { throw new DOMException('aborted', 'AbortError'); });

        await expect(window.apiFetch('/api/v1/x')).rejects.toThrow(/aborted/);
        expect(banner().hidden).toBe(true);
    });
});

// The detection is only worth having if every request goes through it, and this
// page has fifty-odd of them. A bare `fetch(` added later is a call site that
// silently opts out.
describe('every request the page makes goes through it', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'dashboard', 'public', 'guild-settings.js'), 'utf8',
    );

    it('leaves no bare fetch() call outside the wrapper itself', () => {
        const bare = source
            .split('\n')
            .map((line, i) => [i + 1, line])
            // Comment lines describe the wrapper; they are not call sites.
            .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .filter(([, line]) => /(?<![\w.$])fetch\(/.test(line) && !/window\.fetch\(/.test(line));

        expect(bare).toEqual([]);
    });

    it('and routes a good few of them', () => {
        expect((source.match(/apiFetch\(/g) || []).length).toBeGreaterThan(40);
    });
});
