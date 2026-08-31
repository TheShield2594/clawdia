/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #673. Thirteen footer entries were `<a>` with no `href`, styled
 * `cursor: pointer` — they looked clickable, were not focusable, were not
 * announced as links, and did nothing when clicked. Four of them named things
 * this project does not have (a Discord server, a sponsorship page, a privacy
 * policy, terms), which is why they had nowhere to point; those are gone. The
 * rest now point somewhere real.
 *
 * The nav had the matching problem in the other direction: "Features" and
 * "Modules" were two links to `#features`, so one of them silently did nothing
 * a reader could tell from the other.
 *
 * A link that resolves nowhere renders exactly like one that does, so these
 * check the destinations rather than the markup: every in-page anchor against
 * the ids the page actually has, and every repository link against the file on
 * disk it names.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { asset } = require('../src/dashboard/lib/assets');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'dashboard', 'views');
const STYLES = path.join(ROOT, 'src', 'dashboard', 'public', 'styles.css');

const REPO = 'https://github.com/TheShield2594/clawdia';

function landingPage(user = null) {
    const file = path.join(VIEWS, 'index.ejs');
    const html = ejs.render(
        fs.readFileSync(file, 'utf8'),
        { user, stats: { servers: 4, members: 120, uptime: '3d' }, version: '1.2.3', asset },
        { filename: file },
    );
    document.documentElement.innerHTML = html;
    return document;
}

describe('the landing page links somewhere', () => {
    let page;
    beforeAll(() => { page = landingPage(); });

    const anchors = () => [...page.querySelectorAll('a')];
    /** '' for an anchor with no href, so each check below reports its own
        failure rather than the first one throwing on a null. */
    const hrefs = () => anchors().map(a => a.getAttribute('href') || '');

    it('has no anchor without an href', () => {
        const dead = anchors()
            .filter(a => !a.getAttribute('href')?.trim())
            .map(a => a.textContent.trim());
        expect(dead).toEqual([]);
    });

    it('resolves every in-page anchor against a section that exists', () => {
        const fragments = hrefs().filter(href => href.startsWith('#'));

        // A sweep that finds nothing to check reports the same green as one
        // that finds everything in order.
        expect(fragments.length).toBeGreaterThan(3);
        expect(fragments.filter(href => !page.querySelector(`[id="${href.slice(1)}"]`))).toEqual([]);
    });

    it('points every repository link at a file that is actually there', () => {
        const missing = hrefs()
            .filter(href => href.startsWith(`${REPO}/blob/`))
            .map(href => href.replace(`${REPO}/blob/main/`, ''))
            .filter(file => !fs.existsSync(path.join(ROOT, file)));
        expect(missing).toEqual([]);
    });

    it('opens every off-site link with rel="noopener"', () => {
        const unsafe = anchors()
            .filter(a => a.getAttribute('target') === '_blank')
            .filter(a => !/\bnoopener\b/.test(a.getAttribute('rel') || ''))
            .map(a => a.getAttribute('href'));
        expect(unsafe).toEqual([]);
    });

    it('gives each nav link a destination of its own', () => {
        const links = [...page.querySelectorAll('.cw-nav-links a')];
        expect(links.length).toBeGreaterThan(3);

        const targets = links.map(a => a.getAttribute('href'));
        expect(targets).toEqual([...new Set(targets)]);
    });

    it('keeps the footer down to entries this project can stand behind', () => {
        const labels = [...page.querySelectorAll('.cw-footer ul a')].map(a => a.textContent.trim());
        expect(labels.length).toBeGreaterThan(0);
        // The four that named things that do not exist. They had no href
        // because there was none to give, so re-adding one is the regression.
        for (const gone of ['Discord', 'Sponsor', 'Privacy', 'Terms']) {
            expect(labels).not.toContain(gone);
        }
    });
});

describe('footer link styling', () => {
    const styles = fs.readFileSync(STYLES, 'utf8');
    const rule = name => new RegExp(`\\.cw-footer ul a${name}\\s*\\{([^}]*)\\}`).exec(styles)?.[1];

    it('no longer paints a hand cursor onto something that may not be a link', () => {
        // cursor: pointer is the browser's own default for an <a href>, so the
        // declaration only ever did anything for the ones that had no href.
        expect(rule('')).not.toMatch(/cursor:\s*pointer/);
    });

    it('shows keyboard focus, which a link with no href could never take', () => {
        expect(rule(':focus-visible')).toMatch(/outline:/);
    });
});
