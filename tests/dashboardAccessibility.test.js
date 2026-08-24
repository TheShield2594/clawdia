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
