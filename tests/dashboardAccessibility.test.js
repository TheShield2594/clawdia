/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #660 and #659. The sidebar used to be 25 <li> elements that the script gave
// role="button" and a tabindex at runtime — which took `listitem` off the list,
// left the nav inert without JS, and reported the selected section with
// aria-pressed. The toast, the dashboard's only feedback channel, was not a
// live region and told success from failure by border colour alone.
const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

describe('sidebar navigation', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    it('is a navigation landmark with a name of its own', () => {
        const nav = document.querySelector('nav.dash-side-nav');
        expect(nav).not.toBeNull();
        expect(nav.getAttribute('aria-label')).toBeTruthy();
        expect(nav.querySelectorAll('.nav-item').length).toBe(document.querySelectorAll('.nav-item').length);
    });

    it('keeps every list a list of list items', () => {
        for (const list of document.querySelectorAll('ul.dash-nav')) {
            expect([...list.children].map(el => el.tagName)).toEqual([...list.children].map(() => 'LI'));
            expect(list.getAttribute('aria-labelledby')).toBeTruthy();
            expect(document.getElementById(list.getAttribute('aria-labelledby'))).not.toBeNull();
        }
    });

    it('ships focusable buttons rather than dressing list items up at runtime', () => {
        const items = [...document.querySelectorAll('.nav-item')];
        expect(items.length).toBeGreaterThan(0);

        for (const item of items) {
            expect([item.dataset.tab, item.tagName]).toEqual([item.dataset.tab, 'BUTTON']);
            expect(item.getAttribute('type')).toBe('button');
            expect(item.parentElement.tagName).toBe('LI');
            // The runtime ARIA the script used to inject, and must not any more.
            expect(item.getAttribute('role')).toBeNull();
            expect(item.getAttribute('tabindex')).toBeNull();
            expect(item.getAttribute('aria-pressed')).toBeNull();
        }
    });

    it('reports the open section with aria-current, and moves it on navigation', async () => {
        const current = () => [...document.querySelectorAll('.nav-item[aria-current="page"]')].map(i => i.dataset.tab);
        expect(current()).toEqual(['overview']);

        clickTab('economy');
        await settle();

        expect(current()).toEqual(['economy']);
        expect(document.querySelector('.nav-item[data-tab="economy"]').classList.contains('active')).toBe(true);
    });

    it('offers a skip link as the first focusable thing on the page', () => {
        const focusable = document.querySelectorAll('a[href], button, input, select, textarea');
        const skip = document.querySelector('.skip-link');

        expect(skip).not.toBeNull();
        expect(focusable[0]).toBe(skip);

        const target = document.getElementById(skip.getAttribute('href').slice(1));
        expect(target).not.toBeNull();
        expect(target.tagName).toBe('MAIN');
        // -1 so it can take focus without becoming a tab stop of its own.
        expect(target.getAttribute('tabindex')).toBe('-1');
    });

    it('lands keyboard focus in the section a nav item opened', async () => {
        const item = document.querySelector('.nav-item[data-tab="leveling"]');
        item.focus();
        item.dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        expect(document.activeElement).toBe(document.getElementById('dash-main-content'));
    });

    it('still filters the sidebar, hiding the list item and not just the button', () => {
        const search = document.getElementById('sidebar-search');
        search.value = 'starboard';
        search.dispatchEvent(new window.Event('input', { bubbles: true }));

        const visible = [...document.querySelectorAll('.nav-item')]
            .filter(item => item.closest('li').style.display !== 'none')
            .map(item => item.dataset.tab);
        expect(visible).toEqual(['starboard']);
        expect(document.getElementById('sidebar-no-results').style.display).toBe('none');

        search.value = '';
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect([...document.querySelectorAll('.dash-nav li')].every(li => li.style.display === '')).toBe(true);
    });

    it('reports no matches through a live region', () => {
        const search = document.getElementById('sidebar-search');
        search.value = 'nothing matches this';
        search.dispatchEvent(new window.Event('input', { bubbles: true }));

        const noResults = document.getElementById('sidebar-no-results');
        expect(noResults.style.display).toBe('');
        expect(noResults.getAttribute('aria-live')).toBe('polite');
    });
});

describe('toast', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    const toastEl = () => document.getElementById('toast');

    it('is a polite live region, so a save is announced at all', () => {
        expect(toastEl().getAttribute('role')).toBe('status');
        expect(toastEl().getAttribute('aria-live')).toBe('polite');
        expect(toastEl().getAttribute('aria-atomic')).toBe('true');
    });

    it('says which outcome it is in text, not only in the border colour', () => {
        window.toast('Settings saved', 'success');
        const saved = toastEl().textContent;
        expect(saved).toContain('Success');
        expect(saved).toContain('Settings saved');
        expect(document.getElementById('toast-icon').textContent).toBe('✓');

        window.toast('Settings saved', 'error');
        const failed = toastEl().textContent;
        expect(failed).toContain('Error');
        expect(document.getElementById('toast-icon').textContent).toBe('⚠');

        // The point of the issue: the two must differ with the classes ignored.
        expect(failed).not.toBe(saved);
    });

    it('can be dismissed instead of only timing out', () => {
        window.toast('Settings saved', 'success');
        expect(toastEl().classList.contains('show')).toBe(true);

        const close = document.getElementById('toast-close');
        expect(close.getAttribute('aria-label')).toBeTruthy();
        close.dispatchEvent(new window.Event('click', { bubbles: true }));

        expect(toastEl().classList.contains('show')).toBe(false);
    });

    it('leaves an error up longer than a success', () => {
        jest.useFakeTimers();
        try {
            window.toast('Failed to save settings', 'error');
            jest.advanceTimersByTime(2800);
            expect(toastEl().classList.contains('show')).toBe(true);

            window.toast('Settings saved', 'success');
            jest.advanceTimersByTime(2800);
            expect(toastEl().classList.contains('show')).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not swallow clicks on the page while it is hidden', () => {
        // The element is fixed in the corner at all times; only `.show` may
        // make it interactive, or it covers whatever sits underneath it.
        expect(toastEl().classList.contains('show')).toBe(false);
        expect(toastEl().className).toBe('toast');
    });
});
