/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #658 and #656. Eight of the page's nine dialogs were opened with a bare
// `style.display = 'flex'`: unannounced, no Escape, no focus trap, focus
// dropped on <body> when they closed. And `.modal-box` was `overflow: hidden`
// with no `max-height` inside a centred fixed overlay, so a tall dialog ran off
// a short viewport with its Save button unreachable and nothing to scroll.
const fs = require('fs');
const path = require('path');
const { PUBLIC, renderPage, bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const CSS = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

// Every dialog on the page: the panel it lives in (null = always present on the
// page shell), the id of its overlay, the global that opens it with the
// arguments a real caller passes, and the field it should open focused on.
const DIALOGS = [
    { panel: 'commandpolicies', id: 'cp-rule-modal',        open: ['openCpRuleModal', -1],                     focus: 'cp-r-command' },
    { panel: 'commandpolicies', id: 'cp-cooldown-modal',    open: ['openCpCooldownModal', -1],                 focus: 'cp-cd-command' },
    { panel: 'moderation',      id: 'case-note-modal',      open: ['openCaseNoteModal', '7', 'add_note'],      focus: 'case-note-content' },
    { panel: 'ai',              id: 'prompt-editor-modal',  open: ['openPromptEditor', 'ai-prompt', 'Prompt'], focus: 'prompt-editor-textarea' },
    { panel: 'achievements',    id: 'ach-modal',            open: ['openAchModal', -1],                        focus: 'modal-ach-name' },
    { panel: 'achievements',    id: 'ach-grant-modal',      open: ['openAchGrantModal', 'a1', 'First Steps'],  focus: 'grant-member-search' },
    { panel: 'economy',         id: 'item-modal',           open: ['openItemModal', -1],                       focus: 'modal-item-name' },
    { panel: 'economy',         id: 'job-modal',            open: ['openJobModal', -1],                        focus: 'modal-job-name' },
];

/** Boots the page, loads `panel` if the dialog lives in one, and opens it. */
async function openDialog(dialog) {
    if (dialog.panel) {
        clickTab(dialog.panel);
        await settle();
    }
    const [fn, ...args] = dialog.open;
    window[fn](...args);
    return document.getElementById(dialog.id);
}

function press(el, key, init) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
}

describe('dialog accessibility', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        // A real page load starts unlocked; the body element survives the swap.
        document.body.style.overflow = '';
        bootPage();
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    it.each(DIALOGS)('$id announces itself as a dialog with a name', async dialog => {
        const modal = await openDialog(dialog);

        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-hidden')).toBe('false');

        const label = document.getElementById(modal.getAttribute('aria-labelledby'));
        expect(label).not.toBeNull();
        expect(label.textContent.trim()).not.toBe('');
    });

    it.each(DIALOGS)('$id opens with focus on its first field', async dialog => {
        await openDialog(dialog);
        expect(document.activeElement.id).toBe(dialog.focus);
    });

    it.each(DIALOGS)('$id closes on Escape and hands focus back', async dialog => {
        if (dialog.panel) {
            clickTab(dialog.panel);
            await settle();
        }
        // Whatever had focus when the dialog opened is where focus has to land
        // when it closes; anything else strands a keyboard user.
        const opener = document.querySelector(`.nav-item[data-tab="${dialog.panel}"]`) || document.body;
        opener.focus();

        const [fn, ...args] = dialog.open;
        window[fn](...args);
        const modal = document.getElementById(dialog.id);
        expect(modal.style.display).not.toBe('none');

        press(document.activeElement, 'Escape');

        expect(modal.style.display).toBe('none');
        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(document.activeElement).toBe(opener);
    });

    it.each(DIALOGS)('$id closes on a click on the backdrop but not inside the box', async dialog => {
        const modal = await openDialog(dialog);

        modal.querySelector('.modal-box').dispatchEvent(new window.Event('click', { bubbles: true }));
        expect(modal.style.display).not.toBe('none');

        modal.dispatchEvent(new window.Event('click', { bubbles: true }));
        expect(modal.style.display).toBe('none');
    });

    it.each(DIALOGS)('$id keeps Tab inside the dialog', async dialog => {
        const modal = await openDialog(dialog);
        const focusables = window._modalFocusables(modal);
        expect(focusables.length).toBeGreaterThan(1);

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        last.focus();
        expect(press(last, 'Tab').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(first);

        expect(press(first, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(last);

        // A Tab in the middle of the dialog is the browser's to handle.
        focusables[0].focus();
        expect(press(focusables[0], 'Tab').defaultPrevented).toBe(false);
    });

    it('locks the page behind the dialog and unlocks it again', async () => {
        const modal = await openDialog(DIALOGS[0]);
        expect(document.body.style.overflow).toBe('hidden');

        press(document.activeElement, 'Escape');
        expect(modal.style.display).toBe('none');
        expect(document.body.style.overflow).toBe('');
    });

    it('returns focus to the dialog underneath when a confirm stacks on one', async () => {
        clickTab('economy');
        await settle();
        window.openItemModal(-1);
        const itemModal = document.getElementById('item-modal');
        const opener = document.getElementById('modal-item-name');
        opener.focus();

        const answered = window.showConfirm({ title: 'Remove image', body: 'Remove it?' });
        const confirm = document.getElementById('confirm-modal');
        expect(confirm.style.display).toBe('flex');
        expect(document.activeElement.id).toBe('confirm-modal-ok');
        // The dialog underneath is still open, so the page stays locked.
        expect(itemModal.style.display).not.toBe('none');
        expect(document.body.style.overflow).toBe('hidden');

        press(document.activeElement, 'Escape');
        await expect(answered).resolves.toBe(false);
        expect(confirm.style.display).toBe('none');
        expect(document.activeElement).toBe(opener);
        expect(document.body.style.overflow).toBe('hidden');
    });

    it('leaves no dialog opened by hand', () => {
        const script = fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8');
        const raw = [...script.matchAll(/getElementById\('([\w-]+-modal)'\)\.style\.display\s*=/g)];
        expect(raw.map(m => m[1])).toEqual([]);
    });

    it('marks every dialog in the markup, not only at runtime', () => {
        // The attributes have to ship in the HTML: a screen reader that reaches
        // the element before the script runs still has to see a dialog.
        const overlays = [...renderPage().matchAll(/<div[^>]*class="modal-overlay[^"]*"[^>]*>/g)].map(m => m[0]);
        expect(overlays.length).toBeGreaterThan(0);
        for (const overlay of overlays) {
            expect(overlay).toContain('role="dialog"');
            expect(overlay).toContain('aria-modal="true"');
            expect(overlay).toMatch(/aria-labelledby="[\w-]+"/);
        }
    });
});

describe('dialog sizing', () => {
    // #656: the Save button has to stay on screen on a short viewport.
    const block = name => {
        const match = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(CSS);
        expect(match).not.toBeNull();
        return match[1];
    };

    it('caps the box at the viewport and scrolls its body', () => {
        const box = block('modal-box');
        expect(box).toMatch(/max-height:\s*calc\(100dvh - 3rem\)/);
        expect(box).toMatch(/max-height:\s*calc\(100vh - 3rem\)/);   // fallback first
        expect(box).toMatch(/flex-direction:\s*column/);

        expect(block('modal-body')).toMatch(/overflow-y:\s*auto/);
    });

    it('keeps the header and the action bar out of the scroll', () => {
        expect(block('modal-head')).toMatch(/flex-shrink:\s*0/);
        expect(block('modal-actions')).toMatch(/flex-shrink:\s*0/);
    });

    it('leaves the overlay itself scrollable and its top edge reachable', () => {
        const overlay = block('modal-overlay');
        expect(overlay).toMatch(/overflow-y:\s*auto/);
        expect(overlay).toMatch(/align-items:\s*safe center/);
    });

    it('styles every footer the dialogs actually use', () => {
        // `.modal-foot` was in the markup of three dialogs and in no stylesheet,
        // so their buttons rendered as a bare unpadded row.
        const views = path.join(__dirname, '..', 'src', 'dashboard', 'views');
        const files = fs.readdirSync(path.join(views, 'partials', 'panels'))
            .map(f => path.join(views, 'partials', 'panels', f))
            .concat(path.join(views, 'guild-settings.ejs'));
        for (const file of files) {
            const markup = fs.readFileSync(file, 'utf8');
            for (const [, cls] of markup.matchAll(/class="(modal-[\w-]+)"/g)) {
                expect([cls, CSS.includes(`.${cls}`)]).toEqual([cls, true]);
            }
        }
    });
});
