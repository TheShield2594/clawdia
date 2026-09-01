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

// #905. The image serves the minified twins, so the minified twins are what the
// deployed dashboard runs — and the way this page could break under a minifier
// is invisible until someone clicks something. It is a classic script: the
// inline bootstrap block, the EJS `onclick` attributes and the other two files
// all reach guild-settings.js's top-level functions off the global object, so a
// renamed binding is a dead button rather than a failing build.
//
// tests/dashboardMinifiedAssets.test.js checks the names survive. This boots
// the whole page from the minified files and uses it, which is the check that
// does not depend on having thought of the right property to assert.

const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

afterEach(() => {
    forgetDocumentListeners();
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('the page still works when it is minified', () => {
    it('boots and renders the panel it ships with', async () => {
        bootPage({ minified: true });
        await settle();

        expect(document.getElementById('overview')).not.toBeNull();
        expect(document.getElementById('overview').style.display).toBe('block');
    });

    it('loads a lazy panel on click', async () => {
        bootPage({ minified: true });
        await settle();

        clickTab('starboard');
        await settle();

        expect(document.getElementById('starboard')).not.toBeNull();
        expect(document.getElementById('starboard').style.display).toBe('block');
    });

    it('runs a panel\'s own init hooks, not just its markup', async () => {
        bootPage({ minified: true });
        clickTab('ai');
        await settle();

        // updatePromptCount() is wired by the AI panel's onPanel() callback.
        expect(document.getElementById('ai-prompt-count').textContent).toMatch(/\d+ \/ \d+/);
    });

    it('keeps the functions the views call from inline attributes reachable', async () => {
        bootPage({ minified: true });
        await settle();

        // Named in the panels' markup; a minifier that renamed top-level
        // bindings would leave these undefined and every button carrying them
        // inert, with nothing failing until someone clicked one.
        for (const name of ['saveSettings', 'addAutoRole', 'addRssFeed', 'closeItemModal', 'loadCaseHistory']) {
            expect(typeof window[name]).toBe('function');
        }
        // The confirm modal's `onclick="_confirmResolve(false)"` reaches a
        // top-level `var` that only holds a function while a dialog is open —
        // so what matters is that the binding is still there under its name.
        expect('_confirmResolve' in window).toBe(true);
    });

    it('still recognises an expired session', async () => {
        bootPage({ minified: true });
        await settle();

        window.fetch = jest.fn(async () => ({
            ok: false, status: 401, type: 'basic', redirected: false, url: '',
            json: async () => ({ error: 'Unauthorized' }),
        }));
        await window.apiFetch('/api/v1/guild/1/settings', { method: 'POST' });

        expect(document.getElementById('session-expired').hidden).toBe(false);
    });

    it('still reports through the toast', async () => {
        bootPage({ minified: true });
        await settle();

        window.toast('Settings saved', 'success');

        expect(document.getElementById('toast-message').textContent).toMatch(/Settings saved/);
        expect(document.getElementById('toast').className).toMatch(/\bshow\b/);
    });
});
