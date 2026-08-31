/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #679. There is one <form> in the whole dashboard and it answers
// `return false`, so Enter did nothing in any of the ~130 text fields across
// the panels — in a page whose save button is often several screens down from
// the field being edited.
//
// The rule Enter follows is the one the unsaved-changes banner already
// follows: same save scope, same exclusions. A field the banner would never
// light up for is not a setting, and Enter in it does nothing — which is what
// it did before, so nothing inert becomes surprising.
const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

function press(el, key = 'Enter', init = {}) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
}

/**
 * Open a panel and put a spy on the button that saves it. Clicking that real
 * button is what Enter must do — the in-flight guard, the re-baseline and the
 * toast all hang off it — so the spy sits on the button's own click rather
 * than standing in for it.
 *
 * Starboard by default: one text field, one number field, one checkbox and one
 * save button, which is the whole shape this behaviour is about.
 */
async function openPanel(id = 'starboard') {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '';
    bootPage();
    clickTab(id);
    await settle();

    const panel = document.getElementById(id);
    const save = Array.from(panel.querySelectorAll('[onclick]'))
        .find(el => /saveSettings\(/.test(el.getAttribute('onclick')));
    expect(save).toBeTruthy();
    const clicked = jest.fn();
    save.addEventListener('click', clicked);
    return { panel, save, clicked };
}

const textField = panel => panel.querySelector('input[type="text"]:not([data-no-dirty])');

afterEach(async () => {
    await settle();
    forgetDocumentListeners();
    jest.restoreAllMocks();
});

describe('Enter in a settings field', () => {
    it('presses the save button that owns the section', async () => {
        const { panel, clicked } = await openPanel();
        const field = textField(panel);
        expect(field).toBeTruthy();

        const event = press(field);
        expect(clicked).toHaveBeenCalledTimes(1);
        // The implicit submission the one <form> on the page would otherwise
        // have to keep swallowing.
        expect(event.defaultPrevented).toBe(true);
    });

    it('does nothing for any other key', async () => {
        const { panel, clicked } = await openPanel();
        const field = textField(panel);

        press(field, 'a');
        press(field, 'Escape');
        press(field, 'Tab');
        expect(clicked).not.toHaveBeenCalled();
    });

    // Ctrl+Enter is the prompt editor's commit, and an Enter that closes an
    // IME candidate list must never reach the page as a keystroke.
    it.each([
        ['ctrlKey', { ctrlKey: true }],
        ['metaKey', { metaKey: true }],
        ['altKey', { altKey: true }],
        ['shiftKey', { shiftKey: true }],
    ])('stands aside for %s', async (_name, init) => {
        const { panel, clicked } = await openPanel();
        const field = textField(panel);

        press(field, 'Enter', init);
        expect(clicked).not.toHaveBeenCalled();
    });

    it('stands aside mid-IME-composition', async () => {
        const { panel, clicked } = await openPanel();
        const field = textField(panel);

        press(field, 'Enter', { isComposing: true });
        expect(clicked).not.toHaveBeenCalled();
    });
});

describe('Enter where it already means something', () => {
    it('is still a newline in a textarea', async () => {
        const { panel, clicked } = await openPanel('welcome');
        const area = panel.querySelector('textarea');
        expect(area).toBeTruthy();

        const event = press(area);
        expect(clicked).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('still commits an open dropdown on a select', async () => {
        const { panel, clicked } = await openPanel('welcome');
        const select = panel.querySelector('select');
        expect(select).toBeTruthy();

        const event = press(select);
        expect(clicked).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('leaves a checkbox to the Space bar', async () => {
        const { panel, clicked } = await openPanel();
        const box = panel.querySelector('input[type="checkbox"]');
        expect(box).toBeTruthy();

        press(box);
        expect(clicked).not.toHaveBeenCalled();
    });
});

describe('Enter in something that is not a setting', () => {
    it('does nothing in the sidebar search', async () => {
        const { clicked } = await openPanel();
        const search = document.getElementById('sidebar-search');

        const event = press(search);
        expect(clicked).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    // data-no-dirty marks the "pick one to add" selects and one-shot admin
    // fields that live inside a panel but that saveSettings() never reads.
    it('does nothing in a data-no-dirty field', async () => {
        const { panel, clicked } = await openPanel('antinuke');
        const field = panel.querySelector('input[data-no-dirty]');
        expect(field).toBeTruthy();

        const event = press(field);
        expect(clicked).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('does nothing in a modal, which has its own commit button', async () => {
        const { clicked } = await openPanel();
        const input = document.getElementById('confirm-type-input');
        expect(input.closest('.modal-overlay')).not.toBeNull();

        press(input);
        expect(clicked).not.toHaveBeenCalled();
    });

    it('does nothing in a disabled or readonly field', async () => {
        const { panel, clicked } = await openPanel();
        const field = textField(panel);

        field.disabled = true;
        press(field);
        field.disabled = false;
        field.readOnly = true;
        press(field);
        expect(clicked).not.toHaveBeenCalled();
    });
});

// A save scope with no saveSettings button of its own — the RSS feed URL, the
// member admin lookups, anything committed by its own POST — is left alone
// deliberately. Enter there would fire a section save rather than the Add the
// reader was reaching for, and a key that does the wrong thing is worse than a
// key that does nothing.
describe('a field whose section has no save button', () => {
    it('leaves Enter inert rather than guessing at an action', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
        clickTab('rss');
        await settle();

        const url = document.getElementById('rss-url');
        expect(url).toBeTruthy();
        const fetchesBefore = window.fetch.mock.calls.length;

        const event = press(url);
        await settle();
        expect(event.defaultPrevented).toBe(false);
        expect(window.fetch.mock.calls.length).toBe(fetchesBefore);
    });
});
