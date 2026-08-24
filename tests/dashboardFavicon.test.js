'use strict';

/**
 * #688. public/ held nothing but styles.css and no view linked an icon, so
 * every fresh page load spent a request on /favicon.ico that fell through the
 * static handler and all three routers to a default 404 — and the tab showed a
 * blank page glyph.
 *
 * Both halves are guarded here: the files exist and are what they claim to be,
 * and every view links them. A view added without the icons is the case that
 * brings the 404 back, so the view list is read off disk rather than listed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'src', 'dashboard', 'public');
const VIEWS = path.join(ROOT, 'src', 'dashboard', 'views');

const views = fs.readdirSync(VIEWS).filter(f => f.endsWith('.ejs'));
const read = p => fs.readFileSync(p, 'utf8');

describe('the dashboard ships a tab icon', () => {
    test('every top-level view pulls in the icon links', () => {
        // Not a copy in each head: one partial, so the three cannot drift and
        // #690's shared head has one thing to absorb rather than three.
        expect(views.length).toBeGreaterThan(0);
        for (const view of views) {
            expect([view, read(path.join(VIEWS, view)).includes("include('partials/favicon')")])
                .toEqual([view, true]);
        }
    });

    test('the partial links both files, through the hashing asset helper', () => {
        const partial = read(path.join(VIEWS, 'partials', 'favicon.ejs'));

        // Safari reads no SVG icon, and a browser with no icon it can use is
        // the one that falls back to requesting /favicon.ico.
        expect(partial).toContain("asset('/favicon.ico')");
        expect(partial).toContain("asset('/favicon.svg')");
        expect(partial).toContain('type="image/svg+xml"');
        // A bare href would be cached for a year under the static handler's
        // immutable policy with no way to bust it.
        expect(partial).not.toMatch(/href="\/favicon/);
    });

    test('both icons are on disk, where a bare /favicon.ico request lands', () => {
        for (const file of ['favicon.ico', 'favicon.svg']) {
            expect([file, fs.existsSync(path.join(PUBLIC, file))]).toEqual([file, true]);
        }
    });

    test('the SVG carries the intrinsic size a rasteriser needs', () => {
        const svg = read(path.join(PUBLIC, 'favicon.svg'));
        expect(svg).toMatch(/width="32"/);
        expect(svg).toMatch(/height="32"/);
        expect(svg).toMatch(/viewBox="0 0 32 32"/);
    });

    // Structure, not bytes: librsvg and libpng render the same drawing to
    // slightly different bytes across versions, so comparing against a freshly
    // rendered file would fail on a machine whose only difference is its
    // system libraries. A truncated or hand-edited ICO still fails here.
    test('the ICO is a well-formed single 32x32 icon', () => {
        execFileSync('node', [path.join(ROOT, 'scripts', 'make-favicon.js'), '--check'], { cwd: ROOT });
    });
});
