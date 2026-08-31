/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #674. Below 768px the sidebar stops being a column beside the content and
// becomes a block on top of it, so 25 nav items, a search box and the user
// footer sat between the reader and the panel they had just opened — on every
// visit. It folds away now, and the rules that matter are the ones that keep
// it openable: the toggle only exists where the viewport is narrow, and it
// unfolds again the moment the viewport is not.
const fs = require('fs');
const path = require('path');
const { PUBLIC, bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const NARROW = '(max-width: 768px)';

const side = () => document.querySelector('.dash-side');
const toggle = () => document.getElementById('dash-nav-toggle');
const collapsed = () => side().classList.contains('nav-collapsed');

function boot(media) {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '';
    return bootPage({ media });
}

afterEach(async () => {
    await settle();
    forgetDocumentListeners();
    jest.restoreAllMocks();
});

describe('on a desktop viewport', () => {
    beforeEach(() => boot({ [NARROW]: false }));

    it('has no toggle and shows the whole sidebar', () => {
        expect(toggle().hidden).toBe(true);
        expect(collapsed()).toBe(false);
    });

    it('leaves the nav open after a section is chosen', async () => {
        clickTab('welcome');
        await settle();
        expect(collapsed()).toBe(false);
    });
});

describe('on a narrow viewport', () => {
    beforeEach(() => boot({ [NARROW]: true }));

    it('folds the nav away and offers a control to open it', () => {
        expect(collapsed()).toBe(true);
        expect(toggle().hidden).toBe(false);
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('opens and closes on the toggle, reporting the state it is in', () => {
        toggle().click();
        expect(collapsed()).toBe(false);
        expect(toggle().getAttribute('aria-expanded')).toBe('true');

        toggle().click();
        expect(collapsed()).toBe(true);
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('names both of the regions it folds away', () => {
        const controls = toggle().getAttribute('aria-controls').split(/\s+/);
        expect(controls).toContain('dash-side-nav');
        expect(controls).toContain('dash-side-footer');
        for (const id of controls) expect(document.getElementById(id)).not.toBeNull();
    });

    // The whole point: the reader picked a section, so the nav standing
    // between them and it has done its job.
    it('folds away again once a section has been chosen', async () => {
        toggle().click();
        expect(collapsed()).toBe(false);

        clickTab('welcome');
        await settle();
        expect(collapsed()).toBe(true);
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('scrolls the panel into view when it folds, since the nav above it just went', async () => {
        const main = document.getElementById('dash-main-content');
        main.scrollIntoView = jest.fn();
        toggle().click();

        clickTab('welcome');
        await settle();
        expect(main.scrollIntoView).toHaveBeenCalled();
    });
});

// A tablet turned sideways crosses the breakpoint mid-session. A folded nav
// with no control to open it is the one state this must never leave behind.
describe('when the viewport changes under it', () => {
    it('puts the sidebar back and drops the toggle on widening', () => {
        const page = boot({ [NARROW]: true });
        expect(collapsed()).toBe(true);

        page.media.set(NARROW, false);
        expect(collapsed()).toBe(false);
        expect(toggle().hidden).toBe(true);
    });

    it('folds it away and offers the toggle on narrowing', () => {
        const page = boot({ [NARROW]: false });
        expect(collapsed()).toBe(false);

        page.media.set(NARROW, true);
        expect(collapsed()).toBe(true);
        expect(toggle().hidden).toBe(false);
    });
});

// The collapse is script-driven precisely so that a browser that never ran the
// script — or never answered the query — is left with the sidebar it has
// always had, rather than one folded shut with nothing to open it.
describe('without matchMedia', () => {
    it('leaves the nav open and the toggle hidden', () => {
        boot(false);
        expect(window.matchMedia).toBeUndefined();
        expect(collapsed()).toBe(false);
        expect(toggle().hidden).toBe(true);
    });

    it('still navigates, so the sidebar is no worse than it was', async () => {
        boot(false);
        clickTab('welcome');
        await settle();
        expect(document.getElementById('welcome').classList.contains('active')).toBe(true);
        expect(collapsed()).toBe(false);
    });

    it('ships the toggle hidden, so the stylesheet alone never reveals it', () => {
        const markup = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'dashboard', 'views', 'guild-settings.ejs'), 'utf8');
        expect(markup).toMatch(/id="dash-nav-toggle"[^>]*\shidden/);

        const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
        expect(css).toMatch(/\.dash-nav-toggle\[hidden\]\s*\{\s*display:\s*none/);
    });
});
