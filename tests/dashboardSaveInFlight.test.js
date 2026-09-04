/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #663. Every "Save changes" button on the dashboard called an async
 * saveSettings() that kept no record of being busy and changed nothing on
 * screen while it ran. Two clicks meant two POSTs of the same section, free to
 * be answered in either order, and until the toast arrived the page looked as
 * though it had ignored the first click — which is what earns the second.
 *
 * The guard is keyed by section rather than by button because moderation
 * spreads three save buttons over three inner tabs and all three POST the same
 * section. These tests hold a POST open so the pending state can be observed
 * mid-flight, which is the only moment any of it is true.
 */
const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');
const { deferred } = require('./helpers/deferred');

function saveButtons(section) {
    return Array.from(document.querySelectorAll(`[data-action="save"][data-section="${section}"]`));
}

describe('save button in-flight guard', () => {
    let posts;
    /** Held open until the test releases it, so a save can be caught running. */
    let pending;

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
        posts = [];
        pending = null;

        const passthrough = window.fetch;
        window.fetch = jest.fn(async (url, opts) => {
            if (/\/settings$/.test(String(url)) && opts?.method === 'POST') {
                posts.push(String(url));
                if (pending) await pending.promise;
                return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
            }
            return passthrough(url, opts);
        });
    });

    afterEach(async () => {
        if (pending) pending.resolve();
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    it('disables the button and says what it is doing while the POST is open', async () => {
        clickTab('welcome');
        await settle();

        const [button] = saveButtons('welcome');
        const label = button.textContent;
        expect(button.disabled).toBe(false);

        pending = deferred();
        const save = window.saveSettings('welcome');
        await settle();

        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe('Saving…');
        expect(button.getAttribute('aria-busy')).toBe('true');

        pending.resolve();
        await save;

        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe(label);
        expect(button.hasAttribute('aria-busy')).toBe(false);
    });

    // Driven through window.saveSettings rather than by clicking, the way the
    // rest of the dashboard suites drive a save: loadPanel() moves panel markup
    // in through a <template>, and the buttons are delegated (#887), so
    // of elements that arrive from a document with no browsing context. The
    // hooked global is what those attributes call in the browser, so it is the
    // same entry point either way.
    it('sends one POST however many times a save is asked for', async () => {
        clickTab('welcome');
        await settle();
        const [button] = saveButtons('welcome');

        pending = deferred();
        const saves = [
            window.saveSettings('welcome'),
            window.saveSettings('welcome'),
            window.saveSettings('welcome'),
        ];
        await settle();

        expect(posts).toHaveLength(1);
        expect(button.disabled).toBe(true);

        pending.resolve();
        const [first, second, third] = await Promise.all(saves);
        // Only the save that actually ran reports one, so the two turned away
        // cannot re-baseline a section they did not send.
        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(third).toBe(false);
    });

    it('closes every button that saves the same section', async () => {
        clickTab('moderation');
        await settle();

        // Three inner tabs, three "Save changes", one section. A save started
        // from the automod tab has to close the other two as well, or the
        // second POST simply comes from a different tab.
        const moderation = saveButtons('moderation');
        expect(moderation.length).toBeGreaterThan(1);
        const [caseSettings] = saveButtons('casesettings');

        pending = deferred();
        const save = window.saveSettings('moderation');
        await settle();

        expect(moderation.every(btn => btn.disabled)).toBe(true);
        // A different section sharing the panel is a different POST, and
        // nothing about it is in flight.
        expect(caseSettings.disabled).toBe(false);

        pending.resolve();
        await save;
        expect(moderation.every(btn => btn.disabled)).toBe(false);
    });

    it('gives the button back when the save fails', async () => {
        clickTab('welcome');
        await settle();
        const [button] = saveButtons('welcome');
        const label = button.textContent;

        window.fetch = jest.fn(async () => ({
            ok: false, status: 500, json: async () => ({ error: 'nope' }), text: async () => '',
        }));
        await window.saveSettings('welcome');

        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe(label);
    });

    it('gives the button back when reading the section throws', async () => {
        clickTab('welcome');
        await settle();
        const [button] = saveButtons('welcome');
        const label = button.textContent;

        // saveSettings() only catches around its fetch, so a field that is not
        // in the document throws out of the half that reads the form. A button
        // stuck on "Saving…" forever would be worse than the error itself.
        document.getElementById('welcome-enabled').remove();
        await expect(window.saveSettings('welcome')).rejects.toThrow();

        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe(label);
        expect(posts).toHaveLength(0);
    });

    it('lets the reader save again once the first save has finished', async () => {
        clickTab('welcome');
        await settle();
        const [button] = saveButtons('welcome');

        pending = deferred();
        const first = window.saveSettings('welcome');
        await settle();
        pending.resolve();
        pending = null;
        await first;

        await window.saveSettings('welcome');
        expect(posts).toHaveLength(2);
        expect(button.disabled).toBe(false);
    });

    it('hands focus back to the button it took it from', async () => {
        clickTab('welcome');
        await settle();
        const [button] = saveButtons('welcome');

        button.focus();
        expect(document.activeElement).toBe(button);

        pending = deferred();
        const save = window.saveSettings('welcome');
        await settle();
        // Standing in for what the browser does on its own: disabling the
        // focused control drops focus off it, leaving a keyboard reader at the
        // top of a 25-section page. jsdom leaves focus on a disabled button and
        // ignores blur() there, so the move is made explicitly to give the
        // restore something to undo.
        document.getElementById('welcome-message').focus();
        expect(document.activeElement).not.toBe(button);

        pending.resolve();
        await save;
        expect(document.activeElement).toBe(button);
    });
});
