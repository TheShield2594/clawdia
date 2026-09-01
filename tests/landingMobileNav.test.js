/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #881. `.cw-nav-links` held five links beside the brand and the call to action
 * in a nowrap `space-between` row, and `body` is `overflow-x: hidden` — so on a
 * phone the links, and the "Add to Discord" button past them, were clipped off
 * the right-hand edge with no scroll and no other route to them. The landing
 * page is this project's only public page, so that was the first thing a
 * prospective self-hoster saw.
 *
 * The rules worth holding are the ones that keep the links reachable in each of
 * the three states the page can be in: no script at all, narrow with the script,
 * and a viewport that crosses the breakpoint mid-session.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { asset } = require('../src/dashboard/lib/assets');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'dashboard', 'views');
const styles = fs.readFileSync(path.join(ROOT, 'src', 'dashboard', 'public', 'styles.css'), 'utf8');

const NARROW = '(max-width: 768px)';

function render(page) {
    const file = path.join(VIEWS, `${page}.ejs`);
    return ejs.render(
        fs.readFileSync(file, 'utf8'),
        {
            user: page === 'dashboard' ? { id: '1', username: 'tester', avatar: null } : null,
            guilds: [],
            stats: { servers: 4, members: 120, uptime: '3d' },
            version: '1.2.3',
            asset,
            cspNonce: 'test-nonce',
        },
        { filename: file },
    );
}

/** The smallest thing that behaves like matchMedia: queries answer from
    `state`, and `set()` notifies the way a browser does on a resize. */
function installMatchMedia(initial) {
    if (initial === false) {
        delete window.matchMedia;
        return { set() {} };
    }
    const state = new Map(Object.entries(initial));
    const lists = new Map();
    window.matchMedia = query => {
        if (lists.has(query)) return lists.get(query);
        const listeners = [];
        const mql = {
            media: query,
            get matches() { return state.get(query) === true; },
            addEventListener: (type, fn) => { if (type === 'change') listeners.push(fn); },
            removeEventListener: () => {},
            notify: () => listeners.slice().forEach(fn => fn({ matches: mql.matches })),
        };
        lists.set(query, mql);
        return mql;
    };
    return {
        set(query, matches) {
            state.set(query, matches);
            lists.get(query)?.notify();
        },
    };
}

/** Put the landing page in the document and run the nav's own script. `media:
    false` boots with no matchMedia, which is the no-script path's twin. */
function bootLanding({ media } = {}) {
    const html = render('index');
    document.documentElement.innerHTML = html;
    const control = installMatchMedia(media === undefined ? { [NARROW]: false } : media);
    const script = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)]
        .map(m => m[1])
        .find(body => body.includes('cw-nav-toggle'));
    expect(script).toBeDefined();
    window.eval(script);
    return control;
}

const nav = () => document.querySelector('.cw-nav');
const toggle = () => document.getElementById('cw-nav-toggle');
const links = () => document.getElementById('cw-nav-links');
const collapsed = () => nav().classList.contains('nav-collapsed');

/** The body of the first rule whose selector is exactly `selector`. */
function rule(selector, media) {
    const scope = media
        ? styles.slice(styles.indexOf(`@media ${media}`)).match(/\{([\s\S]*?)\n\}/)[1]
        : styles;
    const at = scope.split('\n').find(line => line.trim().startsWith(`${selector} {`));
    return at ? at.slice(at.indexOf('{') + 1, at.lastIndexOf('}')) : null;
}

describe('before any script runs', () => {
    beforeEach(() => { document.documentElement.innerHTML = render('index'); });

    it('ships the disclosure button hidden', () => {
        // The links are only foldable because a script is there to unfold them.
        // Shipping the button visible would be a nav that folds shut for a
        // reader whose browser never ran it.
        expect(toggle().hasAttribute('hidden')).toBe(true);
        expect(nav().classList.contains('nav-collapsed')).toBe(false);
    });

    it('lets the row wrap on a phone rather than running off the side', () => {
        // The half of the fix that needs no script at all: without it, a
        // scriptless phone is back to clipped links.
        expect(rule('.cw-nav-inner', '(max-width: 768px)')).toMatch(/flex-wrap:\s*wrap/);
        expect(rule('.cw-nav-links', '(max-width: 768px)')).toMatch(/width:\s*100%/);
        expect(rule('.cw-nav-links', '(max-width: 768px)')).toMatch(/flex-wrap:\s*wrap/);
    });

    it('hides the links only for the class the script sets', () => {
        // A `display: none` that the stylesheet applies on its own would hide
        // them from every narrow viewport, script or no script.
        const collapse = /\.cw-nav\.nav-collapsed\s+\.cw-nav-links\s*\{([^}]*)\}/.exec(styles);
        expect(collapse).not.toBeNull();
        expect(collapse[1]).toMatch(/display:\s*none/);
    });

    it('keeps the call to action out of the fold', () => {
        // "Add to Discord" is what a first-time visitor came for; the collapse
        // rule above names the links and nothing else.
        expect(styles).not.toMatch(/\.cw-nav\.nav-collapsed[^{]*\.cw-nav-cta/);
    });
});

describe('on a desktop viewport', () => {
    beforeEach(() => bootLanding({ media: { [NARROW]: false } }));

    it('has no toggle and shows the links', () => {
        expect(toggle().hidden).toBe(true);
        expect(collapsed()).toBe(false);
        expect(toggle().getAttribute('aria-expanded')).toBe('true');
    });
});

describe('on a phone', () => {
    let media;
    beforeEach(() => { media = bootLanding({ media: { [NARROW]: true } }); });

    it('folds the links away behind a button that says so', () => {
        expect(toggle().hidden).toBe(false);
        expect(collapsed()).toBe(true);
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        // The button has to name what it controls, and that has to exist.
        expect(toggle().getAttribute('aria-controls')).toBe('cw-nav-links');
        expect(links()).not.toBeNull();
    });

    it('opens and closes on a click, reporting the state each time', () => {
        toggle().click();
        expect([collapsed(), toggle().getAttribute('aria-expanded')]).toEqual([false, 'true']);

        toggle().click();
        expect([collapsed(), toggle().getAttribute('aria-expanded')]).toEqual([true, 'false']);
    });

    it('folds away again once the reader has picked a section', () => {
        toggle().click();
        expect(collapsed()).toBe(false);

        links().querySelector('a[href="#features"]').click();
        expect(collapsed()).toBe(true);
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('puts the links back when the viewport widens mid-session', () => {
        // A tablet turned sideways. Leaving it folded would strand the links
        // behind a button that is no longer on the page.
        expect(collapsed()).toBe(true);

        media.set(NARROW, false);
        expect(collapsed()).toBe(false);
        expect(toggle().hidden).toBe(true);
    });

    it('folds again when it narrows back', () => {
        media.set(NARROW, false);
        media.set(NARROW, true);
        expect([collapsed(), toggle().hidden]).toEqual([true, false]);
    });
});

describe('a browser with no matchMedia', () => {
    it('leaves the button hidden and the links on the page', () => {
        // The fail-safe: nothing folds, and the wrapped row is what is left.
        bootLanding({ media: false });
        expect(toggle().hidden).toBe(true);
        expect(collapsed()).toBe(false);
    });
});

describe('the server picker, which shares the partial', () => {
    it('renders neither the links nor the toggle, and no script for them', () => {
        const html = render('dashboard');
        expect(html).not.toContain('cw-nav-toggle');
        expect(html).not.toContain('cw-nav-links');
    });
});
