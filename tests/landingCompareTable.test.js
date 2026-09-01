/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #912. The bot comparison was twenty-eight `<div>`s in a CSS grid — no table,
 * no rows, no headers. Sighted readers got a table; everyone else got a flat run
 * of words and symbols with nothing tying "● included" to either the feature it
 * describes or the bot it describes it for (WCAG 1.3.1). It is the landing
 * page's main argument, so it is the part a screen-reader user most needs.
 *
 * The visual design did not have to change and did not: the layout is still one
 * four-column grid. That is what makes the roles below load-bearing rather than
 * decoration — `display: grid` on the table and `display: contents` on its rows
 * take the elements out of table layout, and a browser that is not laying an
 * element out as a table stops reporting it as one.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { asset } = require('../src/dashboard/lib/assets');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'dashboard', 'views');
const STYLES = path.join(ROOT, 'src', 'dashboard', 'public', 'styles.css');

function compareTable() {
    const file = path.join(VIEWS, 'index.ejs');
    const html = ejs.render(
        fs.readFileSync(file, 'utf8'),
        { user: null, stats: { servers: 4, members: 120, uptime: '3d' }, version: '1.2.3', asset },
        { filename: file },
    );
    document.documentElement.innerHTML = html;
    return document.querySelector('.cw-compare');
}

describe('the landing page comparison', () => {
    let table;
    beforeEach(() => { table = compareTable(); });

    it('is a real table, not a pile of divs in a grid', () => {
        expect(table).not.toBeNull();
        expect(table.tagName).toBe('TABLE');
        // The shape the old markup could not express at all.
        expect(table.querySelector('thead')).not.toBeNull();
        expect(table.querySelector('tbody')).not.toBeNull();
        expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
        expect(table.querySelectorAll(':scope > div').length).toBe(0);
    });

    it('names itself, so the table is findable rather than just present', () => {
        const caption = table.querySelector('caption');
        expect(caption).not.toBeNull();
        expect(caption.textContent).toMatch(/Clawdia/);
        // Clipped, not `display: none` — a hidden caption is no caption.
        expect(caption.className).toBe('sr-only');
    });

    it('scopes a header to every column and every row', () => {
        const columns = [...table.querySelectorAll('thead th')];
        expect(columns.map(th => th.textContent.trim()))
            .toEqual(['Feature', 'Clawdia', 'MEE6 Pro', 'Carl-bot Premium']);
        expect(columns.every(th => th.getAttribute('scope') === 'col')).toBe(true);

        // The feature name leads its row as a header of its own, which is what
        // gives "● included" something to be announced against on both axes.
        for (const row of table.querySelectorAll('tbody tr')) {
            const [first, ...cells] = [...row.children];
            expect([first.tagName, first.getAttribute('scope')]).toEqual(['TH', 'row']);
            expect(first.textContent.trim()).not.toBe('');
            expect(cells.map(c => c.tagName)).toEqual(['TD', 'TD', 'TD']);
        }
    });

    it('states the roles the grid layout would otherwise take away', () => {
        // Not belt and braces: the CSS below re-lays this out as a grid, and
        // browsers compute table semantics from the layout they perform.
        expect(table.getAttribute('role')).toBe('table');
        expect([...table.querySelectorAll('thead, tbody')].map(el => el.getAttribute('role')))
            .toEqual(['rowgroup', 'rowgroup']);
        expect([...table.querySelectorAll('tr')].every(tr => tr.getAttribute('role') === 'row')).toBe(true);
        expect([...table.querySelectorAll('thead th')].every(th => th.getAttribute('role') === 'columnheader')).toBe(true);
        expect([...table.querySelectorAll('tbody th')].every(th => th.getAttribute('role') === 'rowheader')).toBe(true);
        expect([...table.querySelectorAll('td')].every(td => td.getAttribute('role') === 'cell')).toBe(true);
    });

    it('keeps Clawdia flagged as the highlighted column in every row', () => {
        // The `.hi` column tint used to be hand-placed on every fourth div, so
        // an inserted row shifted it. Now it is one cell per row and countable.
        const rows = [...table.querySelectorAll('tr')];
        expect(rows.map(tr => [...tr.children].findIndex(c => c.classList.contains('hi'))))
            .toEqual(rows.map(() => 1));
    });

    it('still lays out as the four-column grid it looked like before', () => {
        const styles = fs.readFileSync(STYLES, 'utf8');
        const rule = /\.cw-compare\s*\{([^}]*)\}/.exec(styles);
        expect(rule).not.toBeNull();
        expect(rule[1]).toMatch(/display:\s*grid/);
        expect(rule[1]).toMatch(/grid-template-columns:\s*1\.4fr 1fr 1fr 1fr/);
        // Rows and row groups have to drop out of the box tree for the cells to
        // become grid items of the table itself.
        expect(styles).toMatch(/\.cw-compare thead,\s*\.cw-compare tbody,\s*\.cw-compare tr\s*\{[^}]*display:\s*contents/);
    });
});
