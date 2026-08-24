/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #662. 22 panels carry 28 "Save changes" buttons and nothing tracked whether
 * what was on screen had been saved, so leaving the page threw away every
 * unsaved edit without a word.
 *
 * A note on what the issue said and what turned out to be true: switching
 * panels does *not* discard edits. activateTab() sets display:none on the
 * panel it leaves and the fields keep their values, which the round-trip test
 * below pins down. So there is nothing to block on a panel switch — a
 * confirmation there would fire every time and be wrong every time. What was
 * missing is a visible reminder while the reader is elsewhere in the page, and
 * a guard on the navigation that really does lose the edits.
 */
const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

/** Let the click-driven re-check (a setTimeout 0) land. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function navItem(tab) {
    return document.querySelector(`.nav-item[data-tab="${tab}"]`);
}

function banner() {
    return document.getElementById('unsaved-banner');
}

describe('unsaved changes', () => {
    let fetchCalls;

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        bootPage();
        fetchCalls = [];
        const passthrough = window.fetch;
        window.fetch = jest.fn(async (url, opts) => {
            fetchCalls.push([String(url), opts]);
            return passthrough(url, opts);
        });
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    it('starts clean, with nothing marked and no banner', () => {
        expect(banner().hidden).toBe(true);
        expect(document.querySelectorAll('.nav-item.has-unsaved')).toHaveLength(0);
        expect(document.querySelectorAll('.btn.has-unsaved')).toHaveLength(0);
    });

    it('marks the section, its save button and the banner once a field changes', async () => {
        clickTab('welcome');
        await settle();

        const message = document.getElementById('welcome-message');
        message.value = 'Hello there, {user}';
        fire(message, 'input');

        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(true);
        expect(document.querySelector('#welcome .btn.has-unsaved')).not.toBeNull();
        expect(banner().hidden).toBe(false);
        expect(document.getElementById('unsaved-banner-sections').textContent).toBe('Welcome');
    });

    it('goes clean again when the value is typed back to what it was', async () => {
        clickTab('welcome');
        await settle();

        const message = document.getElementById('welcome-message');
        const original = message.value;
        message.value = original + '!';
        fire(message, 'input');
        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(true);

        // A flag raised on the first keystroke would stay raised here, and a
        // warning that fires when nothing changed is one people learn to
        // click through.
        message.value = original;
        fire(message, 'input');
        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(false);
        expect(banner().hidden).toBe(true);
    });

    it('notices a checkbox, not only a text field', async () => {
        clickTab('welcome');
        await settle();

        const toggle = document.getElementById('welcome-enabled');
        toggle.checked = !toggle.checked;
        fire(toggle, 'change');

        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(true);
    });

    it('does not treat a search box or an add-picker as an edit', async () => {
        clickTab('leveling');
        await settle();

        // The select feeds an "Add role" button; the chip list it adds to is
        // the actual setting, and that is what the signature reads.
        const picker = document.getElementById('level-no-xp-roles-select');
        expect(picker.hasAttribute('data-no-dirty')).toBe(true);
        picker.value = picker.options[picker.options.length - 1].value;
        fire(picker, 'change');
        expect(navItem('leveling').classList.contains('has-unsaved')).toBe(false);

        // Same for the one-shot admin fields, which saveSettings never reads.
        const amount = document.getElementById('level-admin-amount');
        amount.value = '500';
        fire(amount, 'input');
        expect(navItem('leveling').classList.contains('has-unsaved')).toBe(false);
    });

    it('notices a repeater row being removed, which fires no input event', async () => {
        clickTab('season');
        await settle();

        const list = document.getElementById('season-tier-rewards-list');
        list.insertAdjacentHTML('beforeend',
            '<div class="season-tier-row"><input type="number" class="season-tier-num" value="1">' +
            '<button type="button" class="btn btn-danger">x</button></div>');
        // The row arrived through a click on "+ Add tier reward" in the real
        // page; the delegated click re-check is what sees the result.
        fire(list.querySelector('.btn-danger'), 'click');
        await tick();

        expect(navItem('season').classList.contains('has-unsaved')).toBe(true);
    });

    it('keeps edits when the reader moves between sections and back', async () => {
        clickTab('welcome');
        await settle();
        const message = document.getElementById('welcome-message');
        message.value = 'still here';
        fire(message, 'input');

        clickTab('farewell');
        await settle();
        clickTab('welcome');
        await settle();

        // The premise the issue reported. The panel is hidden, not discarded.
        expect(document.getElementById('welcome-message').value).toBe('still here');
        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(true);
    });

    it('keeps naming the section while the reader is in another one', async () => {
        clickTab('welcome');
        await settle();
        const message = document.getElementById('welcome-message');
        message.value = 'edited';
        fire(message, 'input');

        clickTab('farewell');
        await settle();

        expect(banner().hidden).toBe(false);
        expect(document.getElementById('unsaved-banner-sections').textContent).toBe('Welcome');
        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(true);
    });

    it('names every unsaved section, not just the one in view', async () => {
        clickTab('welcome');
        await settle();
        const welcome = document.getElementById('welcome-message');
        welcome.value = 'a';
        fire(welcome, 'input');

        clickTab('farewell');
        await settle();
        const farewell = document.getElementById('farewell-message');
        farewell.value = 'b';
        fire(farewell, 'input');

        expect(document.getElementById('unsaved-banner-sections').textContent)
            .toBe('Welcome, Farewell');
    });

    it('clears the section after a save that reached the server', async () => {
        clickTab('welcome');
        await settle();
        const message = document.getElementById('welcome-message');
        message.value = 'saved value';
        fire(message, 'input');
        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(true);

        await window.saveSettings('welcome');

        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(false);
        expect(banner().hidden).toBe(true);
        expect(fetchCalls.some(([url, o]) => /\/settings$/.test(url) && o?.method === 'POST')).toBe(true);
    });

    it('leaves the section marked when the save fails', async () => {
        clickTab('welcome');
        await settle();
        const message = document.getElementById('welcome-message');
        message.value = 'not going to land';
        fire(message, 'input');

        window.fetch = jest.fn(async () => ({
            ok: false, status: 500, json: async () => ({ error: 'nope' }), text: async () => '',
        }));
        await window.saveSettings('welcome');

        // The edit is still only in the browser, so the mark has to stay.
        expect(navItem('welcome').classList.contains('has-unsaved')).toBe(true);
        expect(banner().hidden).toBe(false);
    });

    it('clears every tab of a section, because one POST saves all of them', async () => {
        clickTab('moderation');
        await settle();

        const automod = document.getElementById('mod-spam-threshold');
        automod.value = '9';
        fire(automod, 'input');
        expect(navItem('moderation').classList.contains('has-unsaved')).toBe(true);

        // saveSettings('moderation') reads fields from every moderation inner
        // tab, so saving from any one of them saves the lot.
        await window.saveSettings('moderation');
        expect(navItem('moderation').classList.contains('has-unsaved')).toBe(false);
    });

    it('does not let one section\'s save clear another sharing its tab', async () => {
        clickTab('moderation');
        await settle();

        // mod-tab-logging holds moderation's fields and caseSettings' fields
        // side by side, with a save button each. Without the data-save-scope
        // split, saving one would silently mark the other clean and the next
        // navigation would drop it.
        const sla = document.getElementById('cs-sla-hours');
        sla.value = String(Number(sla.value) + 5);
        fire(sla, 'input');
        expect(navItem('moderation').classList.contains('has-unsaved')).toBe(true);

        await window.saveSettings('moderation');
        expect(navItem('moderation').classList.contains('has-unsaved')).toBe(true);

        await window.saveSettings('casesettings');
        expect(navItem('moderation').classList.contains('has-unsaved')).toBe(false);
    });

    it('warns before a navigation that really would lose the edits', async () => {
        clickTab('welcome');
        await settle();
        const message = document.getElementById('welcome-message');
        message.value = 'about to be lost';
        fire(message, 'input');

        const event = new window.Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('says nothing on unload when everything is saved', () => {
        const event = new window.Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });

    it('asks before following "← All servers", naming what would be lost', async () => {
        clickTab('welcome');
        await settle();
        const message = document.getElementById('welcome-message');
        message.value = 'unsaved';
        fire(message, 'input');

        const link = document.querySelector('a[href="/dashboard"]');
        expect(link).not.toBeNull();
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(click);
        await tick();

        expect(click.defaultPrevented).toBe(true);
        const modal = document.getElementById('confirm-modal');
        expect(modal.style.display).toBe('flex');
        expect(document.getElementById('confirm-modal-body').textContent).toContain('Welcome');
    });

    it('lets the link through untouched when nothing is unsaved', async () => {
        const link = document.querySelector('a[href="/dashboard"]');
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(click);
        await tick();

        expect(click.defaultPrevented).toBe(false);
        expect(document.getElementById('confirm-modal').style.display).not.toBe('flex');
    });

    // The failure mode that would make this feature worse than nothing: a
    // panel that reads as dirty the moment it opens trains people to dismiss
    // the warning, and then it protects nothing. Anything that populates
    // fields after the baseline is taken would show up here.
    it('opens every panel clean', async () => {
        const tabs = [...document.querySelectorAll('.nav-item')].map(item => item.dataset.tab);
        expect(tabs.length).toBeGreaterThan(20);

        const dirtyOnArrival = [];
        for (const tab of tabs) {
            clickTab(tab);
            await settle();
            await tick();
            if (document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.contains('has-unsaved')) {
                dirtyOnArrival.push(tab);
            }
        }
        expect(dirtyOnArrival).toEqual([]);
        expect(banner().hidden).toBe(true);
    });

    it('does not interrupt the skip link, which goes nowhere', async () => {
        clickTab('welcome');
        await settle();
        const message = document.getElementById('welcome-message');
        message.value = 'unsaved';
        fire(message, 'input');

        const skip = document.querySelector('.skip-link');
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        skip.dispatchEvent(click);
        await tick();

        expect(click.defaultPrevented).toBe(false);
    });
});

describe('the markup the tracking rests on', () => {
    const fs = require('fs');
    const path = require('path');
    const ejs = require('ejs');
    const { guildSettingsLocals } = require('./helpers/guildSettingsLocals');
    const PANELS = path.join(__dirname, '..', 'src', 'dashboard', 'views', 'partials', 'panels');

    const render = file => ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(), { filename: file });

    function scopesIn(doc) {
        const scopes = new Map();
        for (const btn of doc.querySelectorAll('[onclick]')) {
            const onclick = btn.getAttribute('onclick') || '';
            const match = /saveSettings\(\s*'([^']+)'/.exec(onclick);
            if (!match) continue;
            const scope = btn.closest('[data-save-scope]')
                || btn.closest('.ai-inner-panel')
                || btn.closest('section.panel');
            const section = btn.closest('[data-save-scope]')?.dataset.saveScope || match[1];
            if (!scopes.has(scope)) scopes.set(scope, new Set());
            scopes.get(scope).add(section);
        }
        return scopes;
    }

    it('gives every save button a scope owned by exactly one section', () => {
        const shared = [];
        let found = 0;
        for (const file of fs.readdirSync(PANELS).filter(f => f.endsWith('.ejs'))) {
            const host = document.createElement('div');
            host.innerHTML = render(path.join(PANELS, file));
            for (const [scope, sections] of scopesIn(host)) {
                found++;
                // Two sections in one scope means saving either would clear
                // the other's dirty state and lose the edits it covers.
                if (sections.size > 1) {
                    shared.push(`${file}: ${scope?.id || scope?.className} → ${[...sections].join(', ')}`);
                }
            }
        }
        // The scopes are discovered by walking the rendered panels, so a
        // changed class or a move from inline onclick to addEventListener
        // would empty the set and leave this reporting clean forever. The
        // panels carry 28 save buttons; a floor well under that still catches
        // the sweep going blind.
        expect(found).toBeGreaterThan(20);
        expect(shared).toEqual([]);
    });

    it('finds a save scope for every save button', () => {
        const orphaned = [];
        for (const file of fs.readdirSync(PANELS).filter(f => f.endsWith('.ejs'))) {
            const host = document.createElement('div');
            host.innerHTML = render(path.join(PANELS, file));
            for (const [scope] of scopesIn(host)) {
                if (!scope) orphaned.push(file);
            }
        }
        expect(orphaned).toEqual([]);
    });
});

// The page keeps registering document listeners after boot — openPromptEditor()
// adds a keydown handler when the editor opens. bootPage() used to put the
// native addEventListener back as soon as the scripts had run, so those escaped
// the helper's bookkeeping and survived into the next test's document.
describe('test isolation', () => {
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

    it('removes a document listener the page registers after boot', () => {
        const seen = [];
        const handler = () => seen.push('fired');
        // Stands in for openPromptEditor's keydown: registered by page code
        // once the document is already live.
        document.addEventListener('keydown', handler);

        document.dispatchEvent(new window.Event('keydown', { bubbles: true }));
        expect(seen).toEqual(['fired']);

        forgetDocumentListeners();
        document.dispatchEvent(new window.Event('keydown', { bubbles: true }));
        expect(seen).toEqual(['fired']);
    });

    it('hands addEventListener back once the page is torn down', () => {
        forgetDocumentListeners();
        // Anything registered after teardown is the next test's business, and
        // must not accumulate in the helper's list.
        const handler = () => {};
        document.addEventListener('keydown', handler);
        forgetDocumentListeners();
        document.removeEventListener('keydown', handler);
    });
});
