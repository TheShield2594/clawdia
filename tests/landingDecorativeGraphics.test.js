/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #936. Two graphics on the landing page carry no information a screen reader
 * can use: the hero's claw mark, and the "active hours" heatmap, whose 168 cells
 * are illustrative demo data drawn as background colours with no text in them.
 *
 * The heatmap is the one that costs something. It is built at runtime, so the
 * markup check alone would not catch a regression that stopped hiding it — the
 * script is run here, and what is asserted is that every cell it appends is
 * inside a subtree assistive tech is told to skip.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { asset } = require('../src/dashboard/lib/assets');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'src', 'dashboard', 'views', 'index.ejs');

/** Renders the landing page, then runs its inline scripts by hand — jsdom does
 *  not execute a script assigned through `innerHTML`. `window.eval` is how
 *  tests/helpers/guildSettingsPage.js boots the settings page, for the same
 *  reason: the script has to see the document it is being run against. */
function renderLanding() {
    const html = ejs.render(
        fs.readFileSync(VIEW, 'utf8'),
        { user: null, stats: { servers: 4, members: 120, uptime: '3d' }, version: '1.2.3', asset },
        { filename: VIEW },
    );
    document.documentElement.innerHTML = html;
    for (const script of document.querySelectorAll('script:not([src])')) {
        window.eval(script.textContent);
    }
}

/** True if `el` or any ancestor of it is hidden from assistive technology. */
const hiddenFromAT = el => !!el.closest('[aria-hidden="true"]');

describe('the landing page\'s decorative graphics', () => {
    beforeEach(renderLanding);

    test('the hero claw mark is hidden from assistive technology', () => {
        const art = document.querySelector('.cw-hero-art');

        expect(art).not.toBeNull();
        expect(art.getAttribute('aria-hidden')).toBe('true');
    });

    test('the heatmap demo renders its cells, and hides all of them', () => {
        const heatmap = document.getElementById('insights-heatmap');

        // Seven days by twenty-four hours: the script really did run, so the
        // assertion below is about the cells rather than about an empty div.
        const cells = heatmap.querySelectorAll('.cell');
        expect(cells).toHaveLength(168);
        expect(heatmap.getAttribute('aria-hidden')).toBe('true');
        expect([...cells].every(hiddenFromAT)).toBe(true);
    });

    test('no cell carries text of its own, which is why hiding it loses nothing', () => {
        const cells = [...document.querySelectorAll('#insights-heatmap .cell')];

        expect(cells.map(cell => cell.textContent.trim()).filter(Boolean)).toEqual([]);
        expect(cells.every(cell => cell.getAttribute('aria-label') === null)).toBe(true);
    });
});
