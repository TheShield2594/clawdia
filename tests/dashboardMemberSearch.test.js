/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #691 and #678. Both member-search dropdowns debounced their keystrokes and
// then let every surviving request race: the answer to "ali" arriving after the
// answer to "alice" repainted the list with results for a prefix the user had
// already typed past. Debouncing cannot fix that — it thins the requests out,
// it does not order the responses — so each widget now cancels the request it
// is replacing. The avatars those lists inject also had no alt, leaving a
// screen reader to read a CDN URL out beside the name it belongs to.

const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

/**
 * A fetch that hands back a handle per call instead of an answer, so a test can
 * choose the order the responses land in. Aborting a signal rejects that call's
 * promise with an AbortError, which is what the real fetch does.
 */
function controllableFetch() {
    const calls = [];
    window.fetch = jest.fn((url, opts = {}) => {
        const call = { url: String(url), signal: opts.signal };
        call.promise = new Promise((resolve, reject) => {
            call.respondWith = items => resolve({ ok: true, status: 200, json: async () => ({ items }) });
            if (opts.signal) {
                opts.signal.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted.');
                    err.name = 'AbortError';
                    reject(err);
                });
            }
        });
        // Nothing here rejects unhandled: every caller in the page awaits it.
        calls.push(call);
        return call.promise;
    });
    return calls;
}

const MEMBERS = [{ id: '42', username: 'alice', displayName: 'Alice', avatarURL: 'https://cdn.discordapp.com/avatars/42/a.png' }];

/** Every avatar the widget injected, so alt can be asserted over all of them. */
const avatarsIn = el => [...el.querySelectorAll('img')];

describe('achievement grant member search', () => {
    beforeEach(async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
        clickTab('achievements');
        await settle();
    });

    afterEach(async () => {
        forgetDocumentListeners();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    const results = () => document.getElementById('grant-member-results');
    const search = value => {
        document.getElementById('grant-member-search').value = value;
        return window.runMemberSearch();
    };

    it('cancels the request a newer keystroke supersedes', async () => {
        const calls = controllableFetch();

        const stale = search('ali');
        expect(calls).toHaveLength(1);
        expect(calls[0].signal).toBeDefined();
        expect(calls[0].signal.aborted).toBe(false);

        const fresh = search('alice');
        // The point of the issue: the older request is cancelled as the newer
        // one goes out, so it cannot come back later and win.
        expect(calls[0].signal.aborted).toBe(true);
        expect(calls[1].signal.aborted).toBe(false);
        expect(calls[1].url).toContain('q=alice');

        calls[1].respondWith(MEMBERS);
        await Promise.all([stale, fresh]);

        expect(results().textContent).toContain('Alice');
    });

    it('does not report a failure when it cancels its own search', async () => {
        const calls = controllableFetch();

        const stale = search('ali');
        const fresh = search('alice');
        calls[1].respondWith(MEMBERS);
        await Promise.all([stale, fresh]);

        // The cancelled request rejects with an AbortError. Treated as a
        // failure it would paint "Search failed" over the results of the search
        // that is still perfectly fine.
        expect(results().textContent).not.toContain('Search failed');
        expect(results().style.display).toBe('');
    });

    it('still reports a real failure', async () => {
        window.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));

        await search('alice');

        expect(results().textContent).toContain('Search failed');
    });

    it('cancels an in-flight search when the modal closes', async () => {
        const calls = controllableFetch();

        const pending = search('alice');
        window.closeAchGrantModal();

        expect(calls[0].signal.aborted).toBe(true);
        await pending;
    });

    it('gives each injected avatar an empty alt, next to the name it belongs to', async () => {
        const calls = controllableFetch();

        const pending = search('alice');
        calls[0].respondWith(MEMBERS);
        await pending;

        const avatars = avatarsIn(results());
        expect(avatars).toHaveLength(1);
        // Decorative: the display name is right beside it, so a screen reader
        // announcing anything here repeats it — or reads out the CDN URL.
        expect(avatars.map(img => img.getAttribute('alt'))).toEqual(['']);
        expect(results().textContent).toContain('Alice');
    });
});

describe('user-search widget', () => {
    beforeEach(async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
        clickTab('antinuke');
        await settle();
    });

    afterEach(async () => {
        forgetDocumentListeners();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    const dropdown = () => document.getElementById('an-whitelist-users-dropdown');
    const type = value => {
        const input = document.querySelector('.user-search-input[data-widget="an-whitelist-users"]');
        input.value = value;
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    it('cancels the request a newer keystroke supersedes', async () => {
        const calls = controllableFetch();
        jest.useFakeTimers();

        type('ali');
        jest.advanceTimersByTime(280);
        expect(calls).toHaveLength(1);

        type('alice');
        expect(calls[0].signal.aborted).toBe(true);

        jest.advanceTimersByTime(280);
        expect(calls[1].url).toContain('q=alice');
        calls[1].respondWith(MEMBERS);

        jest.useRealTimers();
        await settle();

        expect(dropdown().style.display).toBe('');
        expect(dropdown().textContent).toContain('Alice');
    });

    it('leaves the newer search\'s dropdown alone when the older one is cancelled', async () => {
        const calls = controllableFetch();
        jest.useFakeTimers();

        type('ali');
        jest.advanceTimersByTime(280);
        type('alice');
        jest.advanceTimersByTime(280);
        calls[1].respondWith(MEMBERS);

        jest.useRealTimers();
        await settle();

        // Hiding the dropdown on an abort would close the list the surviving
        // search had just filled.
        expect(dropdown().style.display).toBe('');
        expect(avatarsIn(dropdown()).map(img => img.getAttribute('alt'))).toEqual(['']);
    });
});
