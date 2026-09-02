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
const fs = require('fs');
const path = require('path');
const { PUBLIC, renderPanel, bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

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
        expect(close.hidden).toBe(false);
        close.dispatchEvent(new window.Event('click', { bubbles: true }));

        expect(toastEl().classList.contains('show')).toBe(false);
    });

    // The toast is faded out rather than display:none, so its button would
    // otherwise be a tab stop on every page that dismisses nothing.
    it('keeps the dismiss button out of the tab order with nothing to dismiss', () => {
        expect(document.getElementById('toast-close').hidden).toBe(true);

        window.toast('Settings saved', 'success');
        expect(document.getElementById('toast-close').hidden).toBe(false);

        jest.useFakeTimers();
        try {
            window.toast('Settings saved', 'success');
            jest.advanceTimersByTime(2800);
            expect(document.getElementById('toast-close').hidden).toBe(true);
        } finally {
            jest.useRealTimers();
        }
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

// #879. `.ai-inner-tabs` was a nowrap flex row and `body` is
// `overflow-x: hidden`, so the Economy panel's nine tabs ran past a phone's
// viewport and the rightmost ones were clipped away — no scroll, no wrap, and
// no other route to the panels behind them. Same bug class as the wide tables
// below; a different fix, because a wrapped row needs no scroll affordance.
describe('inner tab strips', () => {
    const styles = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

    it('wraps rather than running off the side of the screen', () => {
        const rule = /\.ai-inner-tabs\s*\{([^}]*)\}/.exec(styles);
        expect(rule).not.toBeNull();
        expect(rule[1]).toMatch(/flex-wrap:\s*wrap/);
    });

    it.each(['economy', 'moderation', 'ai', 'rss'])(
        'puts every tab in the %s panel inside one of those strips',
        panel => {
            document.body.innerHTML = renderPanel(panel);

            const strips = [...document.querySelectorAll('.ai-inner-tabs')];
            expect(strips.length).toBeGreaterThan(0);

            // A strip that reaches for its own layout instead of the class is
            // back outside the rule above, which is how the clipping got in.
            for (const tab of document.querySelectorAll('[class*="-inner-tab"]:not(.ai-inner-tabs)')) {
                expect([tab.textContent.trim(), tab.closest('.ai-inner-tabs') !== null])
                    .toEqual([tab.textContent.trim(), true]);
            }
        },
    );
});

// #880. Shop and game item images are uploaded through a <label> wrapping a
// `display: none` file input. A label is not a tab stop and a hidden input
// cannot take focus, and there was no other control bound to either action —
// so for a keyboard-only or screen-reader user the feature was not awkward,
// it was unreachable. WCAG 2.1.1.
describe('image upload controls', () => {
    const styles = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

    /** Every file input in a panel, with the label that wraps it. */
    const uploads = panel => {
        document.body.innerHTML = renderPanel(panel);
        return [...document.querySelectorAll('input[type="file"]')]
            .map(input => [input, input.closest('label')]);
    };

    it.each(['economy'])('leaves no file input in the %s panel hidden', panel => {
        const found = uploads(panel);
        expect(found.length).toBeGreaterThan(0);

        for (const [input] of found) {
            // The two shapes that take an element out of the tab order. Either
            // one puts the upload back out of reach.
            expect([input.id, /display\s*:\s*none/.test(input.getAttribute('style') || '')])
                .toEqual([input.id, false]);
            expect([input.id, input.hasAttribute('hidden')]).toEqual([input.id, false]);
            // Clipped instead, which is invisible and still focusable.
            expect([input.id, input.classList.contains('sr-only')]).toEqual([input.id, true]);
        }
    });

    it('gives every upload a name of its own, not a column of "Upload"', () => {
        for (const [input, label] of uploads('economy')) {
            const name = input.getAttribute('aria-label') || label?.textContent.trim();
            expect([input.id, Boolean(name)]).toEqual([input.id, true]);
        }
        // The per-item cards all read "Upload", so the item is what tells them
        // apart — and it has to be on the input, where the name is read from.
        const cards = [...document.querySelectorAll('.game-item-card input[type="file"]')];
        expect(cards.length).toBeGreaterThan(1);
        const names = cards.map(input => input.getAttribute('aria-label'));
        expect(names.every(Boolean)).toBe(true);
        expect(new Set(names).size).toBe(names.length);
    });

    it('keeps the input inside the label that labels it', () => {
        // The click target and the focus target are the same control; a label
        // that lost its input would leave a button that does nothing.
        for (const [input, label] of uploads('economy')) {
            expect([input.id, label !== null]).toEqual([input.id, true]);
        }
    });

    it('shows the focus on the label, since the input itself is invisible', () => {
        // `.sr-only` is a 1px clipped box — a ring drawn on it is a ring nobody
        // sees, which is WCAG 2.4.7 failed a second way.
        for (const cls of ['game-item-upload-btn', 'shop-img-upload-btn']) {
            const rule = new RegExp(`\\.${cls}:focus-within[^{]*\\{([^}]*)\\}`);
            const match = rule.exec(styles) || new RegExp(
                `\\.${cls}:focus-within\\s*,[\\s\\S]{0,200}?\\{([^}]*)\\}`,
            ).exec(styles);
            expect([cls, match !== null]).toEqual([cls, true]);
            expect([cls, /outline/.test(match[1])]).toEqual([cls, true]);
        }
    });
});

// #668. `.cases-table` is up to seven columns wide and `body` is
// `overflow-x: hidden`, so on a narrow screen the right-hand columns — the
// Actions column on three of these four — were clipped with nothing that could
// scroll to them.
describe('wide tables', () => {
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

    const styles = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

    it('gives every wide table a container that can actually scroll', () => {
        const rule = /\.table-scroll\s*\{([^}]*)\}/.exec(styles);
        expect(rule).not.toBeNull();
        expect(rule[1]).toMatch(/overflow-x:\s*auto/);

        // Without a min-width the table is width:100% inside an auto-overflow
        // parent, so it shrinks to fit and squeezes the columns rather than
        // overflowing — nothing to scroll, and the clipping just moves inside
        // the cells.
        expect(styles).toMatch(/\.table-scroll\s*>\s*\.cases-table\s*\{[^}]*min-width:/);
    });

    it.each(['moderation', 'economy', 'leveling'])('wraps every table in the %s panel', panel => {
        document.body.insertAdjacentHTML('beforeend', renderPanel(panel));
        const tables = [...document.querySelectorAll('table.cases-table')];
        expect(tables.length).toBeGreaterThan(0);

        for (const table of tables) {
            const wrap = table.parentElement;
            expect([table.id, wrap.classList.contains('table-scroll')]).toEqual([table.id, true]);
            // Scrollable by keyboard and not only by touch, and named so the
            // region it becomes says which table it holds.
            expect(wrap.getAttribute('tabindex')).toBe('0');
            expect(wrap.getAttribute('role')).toBe('region');
            expect(wrap.getAttribute('aria-label')).toBeTruthy();
        }
    });

    it('hides the wrapper with the table, leaving no empty region in the tab order', async () => {
        document.body.insertAdjacentHTML('beforeend', renderPanel('moderation'));
        const wrap = document.getElementById('cases-table').closest('.table-scroll');

        // The three data tables start hidden behind their empty states, and a
        // focusable labelled region announcing a table that is not rendered is
        // worse than no region at all.
        expect(wrap.style.display).toBe('none');

        window.setTableVisible('cases-table', true);
        expect(wrap.style.display).toBe('');

        window.setTableVisible('cases-table', false);
        expect(wrap.style.display).toBe('none');
    });
});

// #669. Six analytics charts, plus the economy command breakdown, drew into
// bare <canvas> elements: no role, no label, no fallback and no table. A canvas
// is an opaque bitmap, so the whole Insights panel was announced as nothing at
// all — WCAG 1.1.1.
describe('analytics charts', () => {
    const ANALYTICS = {
        analytics: {
            memberGrowth:    [{ date: '2026-08-01', joins: 4, leaves: 1 }, { date: '2026-08-02', joins: 6, leaves: 2 }],
            commandDaily:    [{ date: '2026-08-01', count: 30 }, { date: '2026-08-02', count: 12 }],
            economyDaily:    [{ date: '2026-08-01', earned: 500, spent: 200 }],
            xpDaily:         [{ date: '2026-08-01', xp: 900, levelUps: 3 }],
            aiRequestsDaily: [{ date: '2026-08-01', count: 7 }],
        },
    };
    const INSIGHTS = { retention: { retained7Pct: 61, retained30Pct: 44 } };

    const CANVASES = [
        'chart-member-growth', 'chart-command-activity', 'chart-retention',
        'chart-economy', 'chart-leveling', 'chart-ai-requests',
    ];

    /** Chart.js stands in for the real library, which jsdom cannot run. */
    function stubChartJs() {
        window.Chart = function Chart() { this.destroy = () => {}; };
    }

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        bootPage();
        document.body.insertAdjacentHTML('beforeend', renderPanel('analytics'));
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        delete window.Chart;
        jest.restoreAllMocks();
    });

    it('ships every canvas already labelled, before any data arrives', () => {
        for (const id of CANVASES) {
            const canvas = document.getElementById(id);
            expect([id, canvas.getAttribute('role')]).toEqual([id, 'img']);
            expect(canvas.getAttribute('aria-label')).toBeTruthy();
            // The table alternative has somewhere to land.
            expect(document.getElementById(`${id}-data`)).not.toBeNull();
        }
    });

    it('names each chart with the numbers it is drawing, not just its title', async () => {
        stubChartJs();
        await window.renderAnalyticsCharts(ANALYTICS, INSIGHTS);

        const label = id => document.getElementById(id).getAttribute('aria-label');
        expect(label('chart-member-growth')).toMatch(/10 joins.*3 leaves/);
        expect(label('chart-command-activity')).toMatch(/42 commands/);
        expect(label('chart-retention')).toMatch(/61%.*44%/);
        expect(label('chart-economy')).toMatch(/500 coins earned.*200 spent/);
        expect(label('chart-leveling')).toMatch(/900 XP awarded.*3 level-ups/);
        expect(label('chart-ai-requests')).toMatch(/7 in total/);
    });

    it('puts the series itself beside the canvas as a real table', async () => {
        stubChartJs();
        await window.renderAnalyticsCharts(ANALYTICS, INSIGHTS);

        const table = document.querySelector('#chart-member-growth-data table');
        expect(table).not.toBeNull();
        expect(table.querySelector('caption').textContent).toMatch(/Member growth/);
        expect([...table.querySelectorAll('thead th')].map(th => th.textContent))
            .toEqual(['Date', 'Joins', 'Leaves']);
        // Every column header scoped, and the date leading each row a header of
        // its own, so the numbers are announced with what they belong to.
        expect([...table.querySelectorAll('thead th')].every(th => th.getAttribute('scope') === 'col')).toBe(true);
        expect([...table.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.textContent)))
            .toEqual([['2026-08-01', '4', '1'], ['2026-08-02', '6', '2']]);
        expect(table.querySelector('tbody th').getAttribute('scope')).toBe('row');

        for (const id of CANVASES) {
            expect([id, !!document.querySelector(`#${id}-data table`)]).toEqual([id, true]);
        }
    });

    it('hides the tables from sight without hiding them from the reader', () => {
        // `display: none` would take the table out of the accessibility tree
        // along with everything in it, which is the whole point of having it.
        const styles = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
        const rule = /\.chart-a11y-data\s*\{([^}]*)\}/.exec(styles);
        expect(rule).not.toBeNull();
        expect(rule[1]).not.toMatch(/display:\s*none/);
        expect(rule[1]).not.toMatch(/visibility:\s*hidden/);
        expect(rule[1]).toMatch(/clip-path:|clip:/);
    });

    it('still gives the numbers when Chart.js does not load', async () => {
        // The reader who needs the table is exactly the one who gets nothing
        // from the canvas, so a failed script fetch must not take it with it.
        const render = window.renderAnalyticsCharts(ANALYTICS, INSIGHTS);
        const script = [...document.head.querySelectorAll('script[src]')].pop();
        script.onerror(new window.Event('error'));
        await render;

        expect(document.querySelector('#chart-member-growth-data table')).not.toBeNull();
        expect(document.getElementById('chart-member-growth').getAttribute('aria-label')).toMatch(/10 joins/);
    });

    it('covers the economy panel\'s command chart too', async () => {
        document.body.insertAdjacentHTML('beforeend', renderPanel('economy'));
        const canvas = document.getElementById('eco-cmd-chart');
        expect(canvas.getAttribute('role')).toBe('img');
        expect(document.getElementById('eco-cmd-chart-data')).not.toBeNull();

        window.fetch = jest.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({ topEarners: [], commandFrequency: [{ cmd: 'daily', count: 91 }] }),
        }));
        stubChartJs();
        await window.loadEcoHealth();

        expect(canvas.getAttribute('aria-label')).toMatch(/\/daily, 91 uses/);
        expect([...document.querySelectorAll('#eco-cmd-chart-data tbody tr')]
            .map(tr => [...tr.children].map(c => c.textContent))).toEqual([['/daily', '91']]);
    });

    it('says so in the label when a chart has no data at all', async () => {
        stubChartJs();
        await window.renderAnalyticsCharts({ analytics: {} }, {});

        const canvas = document.getElementById('chart-economy');
        expect(canvas.getAttribute('aria-label')).toMatch(/no data/i);
        expect(document.querySelector('#chart-economy-data table')).toBeNull();
        expect(document.getElementById('chart-economy-data').textContent).toMatch(/no data/i);
    });
});

// #882. The Getting Started collapse was a `.dash-card-header` div with
// `cursor:pointer` and an onclick: not focusable, not announced as a control,
// and its open/closed state carried only by a ▾/▸ glyph. Keyboard users could
// not toggle it at all (WCAG 2.1.1), and a screen reader had nothing to report
// (4.1.2).
describe('the Getting Started collapse', () => {
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

    const toggle = () => document.getElementById('gs-toggle');

    it('is a button that owns the section it opens', () => {
        const btn = toggle();
        expect(btn).not.toBeNull();
        expect([btn.tagName, btn.getAttribute('type')]).toEqual(['BUTTON', 'button']);
        // A button is focusable and activated by Enter and Space for free; the
        // runtime role/tabindex patch-up the sidebar had to shed must not
        // reappear here.
        expect(btn.getAttribute('role')).toBeNull();
        expect(btn.getAttribute('tabindex')).toBeNull();

        expect(btn.getAttribute('aria-controls')).toBe('getting-started-body');
        expect(document.getElementById('getting-started-body')).not.toBeNull();
    });

    it('keeps the heading a heading rather than swallowing it into the control', () => {
        // The card still has to appear in a heading list; the disclosure lives
        // inside the h2 rather than replacing it.
        const heading = toggle().closest('h2');
        expect(heading).not.toBeNull();
        expect(heading.textContent).toMatch(/Getting started/);
    });

    it('reports its state with aria-expanded, and moves it on every toggle', () => {
        const btn = toggle();
        const body = document.getElementById('getting-started-body');

        expect(btn.getAttribute('aria-expanded')).toBe('true');

        btn.click();
        expect([btn.getAttribute('aria-expanded'), body.style.display]).toEqual(['false', 'none']);

        btn.click();
        expect([btn.getAttribute('aria-expanded'), body.style.display]).toEqual(['true', '']);
    });

    it('toggles from a click anywhere in the header, subtitle included', () => {
        // The whole header was the click target before this was a button, so a
        // subtitle left outside it would be the one part of the header that
        // silently stopped working.
        const btn = toggle();
        const subtitle = document.getElementById('gs-subtitle');
        expect(subtitle).not.toBeNull();
        expect(btn.contains(subtitle)).toBe(true);

        subtitle.click();
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        expect(document.getElementById('getting-started-body').style.display).toBe('none');
    });

    it('leaves the glyph to the eye only', () => {
        // ▾/▸ is the state for a sighted reader and noise for everyone else —
        // aria-expanded above is what carries it now, so the glyph is hidden
        // rather than read out as a symbol with no name.
        const icon = document.getElementById('gs-toggle-icon');
        expect(icon.getAttribute('aria-hidden')).toBe('true');

        toggle().click();
        expect(icon.textContent).toBe('\u25b8');
    });
});

// #678. Six avatars were injected without an alt attribute, so a screen reader
// fell back to reading the CDN URL out beside the username already sitting next
// to it. They are decorative — the name is the content — which makes `alt=""`
// the fix, and a missing attribute the failure. The sweep is over the source
// rather than the rendered page because three of the six are drawn from data
// only a live moderation or economy panel has.
describe('injected images', () => {
    const script = fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8');

    it('every <img> the script writes carries an alt', () => {
        const withoutAlt = [...script.matchAll(/<img\b[^>]*>/g)]
            .map(m => m[0])
            // An `<img` with no src is one of the two the comments above
            // openStoreImagePicker and the autorole chip escape talk about, not
            // markup the script writes.
            .filter(tag => /\bsrc=/.test(tag) && !/\balt=/.test(tag));

        expect(withoutAlt).toEqual([]);
    });

    it('sets alt on the one avatar built as an element rather than markup', () => {
        // createElement('img') takes no HTML attribute list, so the sweep above
        // cannot see it — it is asserted by name instead.
        expect(script).toMatch(/imgEl\.alt\s*=/);
    });
});

// #944. On a guild the bot is not in and cannot be invited to, the server
// picker rendered "Not configured" as a <span> carrying .cw-btn dimmed to 45%
// opacity: a non-interactive element dressed as a button, whose text landed
// below AA at that opacity. It is plain muted text now.
describe('the server picker\'s unconfigured guild', () => {
    const ejs = require('ejs');
    const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
    const { asset } = require('../src/dashboard/lib/assets');

    const render = guild => {
        const file = path.join(VIEWS, 'dashboard.ejs');
        return ejs.render(fs.readFileSync(file, 'utf8'), {
            user: { id: '1', username: 'tester', avatar: null },
            guilds: [guild],
            version: '1.2.3',
            asset,
        }, { filename: file });
    };

    const UNCONFIGURED = { id: '7', name: 'No invite', icon: null, botPresent: false, inviteUrl: null };

    it('does not dress the label as a button', () => {
        const html = render(UNCONFIGURED);

        expect(html).toContain('Not configured');
        const tag = /<span[^>]*>Not configured<\/span>/.exec(html)[0];
        expect([tag, /cw-btn/.test(tag)]).toEqual([tag, false]);
        expect([tag, /opacity/.test(tag)]).toEqual([tag, false]);
    });

    it('still renders a real link when the guild can be acted on', () => {
        // The two live branches are what the span is the fallback for; a fix
        // that flattened them all to text would pass the assertion above.
        expect(render({ ...UNCONFIGURED, botPresent: true })).toMatch(/<a[^>]+href="\/dashboard\/guild\/7"/);
        expect(render({ ...UNCONFIGURED, inviteUrl: 'https://example.invalid/invite' })).toContain('Invite bot');
    });

    it('colours the label at a ratio that passes AA against the card', () => {
        // The card is #fff and the label is 13px, so it needs 4.5:1. --ink-400,
        // the other muted token, is 3.7:1 there and would not do.
        const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
        const rule = /\.cw-dash-lp-unavailable\s*\{([^}]*)\}/.exec(css);
        expect(rule).not.toBeNull();

        const token = /color:\s*var\((--[\w-]+)\)/.exec(rule[1])[1];
        const hex = new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, 'i').exec(css)[1];

        const channel = c => {
            const s = parseInt(c, 16) / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const luminance = 0.2126 * channel(hex.slice(1, 3))
            + 0.7152 * channel(hex.slice(3, 5))
            + 0.0722 * channel(hex.slice(5, 7));

        expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    });
});
