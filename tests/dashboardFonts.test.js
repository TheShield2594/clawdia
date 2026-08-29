/**
 * #681. styles.css pulled Instrument Serif, Inter Tight and JetBrains Mono from
 * fonts.googleapis.com while the dashboard serves `style-src 'self'` and
 * `font-src 'self'`. The browser blocked the stylesheet and the font files, so
 * all three families silently fell back to Georgia / system-ui / monospace and
 * the intended typography never rendered for anybody.
 *
 * The families are now vendored under public/fonts/. These tests guard the two
 * halves of that: nothing may reach off-origin for a font again, and every face
 * the stylesheet declares must actually be on disk — a declared-but-missing
 * file renders as the same silent fallback the issue was about.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'src', 'dashboard', 'public');
const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const FONTS = path.join(PUBLIC, 'fonts');

const read = p => fs.readFileSync(p, 'utf8');
const stylesCss = read(path.join(PUBLIC, 'styles.css'));
const fontsCss = read(path.join(FONTS, 'fonts.css'));
// The three pages plus the head partial they all now include (#690) — the
// stylesheet <link> lives in the partial, so a sweep over the pages alone
// would have nothing left to look at.
const views = ['index.ejs', 'dashboard.ejs', 'guild-settings.ejs', 'partials/head.ejs'];

describe('web fonts load under the dashboard\'s own CSP', () => {
    it('asks for no stylesheet, font or preconnect from a third-party origin', () => {
        const offenders = [];
        for (const [name, css] of [['styles.css', stylesCss], ['fonts/fonts.css', fontsCss]]) {
            for (const m of css.matchAll(/(?:@import\s+)?url\(\s*['"]?(https?:)?\/\/[^)]+\)/g)) {
                offenders.push(`${name}: ${m[0]}`);
            }
        }
        for (const view of views) {
            const html = read(path.join(VIEWS, view));
            for (const m of html.matchAll(/<link[^>]+href="(?:https?:)?\/\/[^"]*fonts[^"]*"[^>]*>/g)) {
                offenders.push(`${view}: ${m[0]}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('declares every family styles.css asks for', () => {
        const declared = new Set(
            [...fontsCss.matchAll(/font-family:\s*'([^']+)'/g)].map(m => m[1]),
        );
        for (const family of ['Instrument Serif', 'Inter Tight', 'JetBrains Mono']) {
            expect([family, declared.has(family)]).toEqual([family, true]);
            // The family is only worth vendoring if something still uses it.
            expect([family, stylesCss.includes(`'${family}'`)]).toEqual([family, true]);
        }
    });

    it('covers every weight the stylesheet sets, so none falls back to a synthesised face', () => {
        const wanted = new Set(
            [...stylesCss.matchAll(/font-weight:\s*(\d{3})/g)].map(m => m[1]),
        );
        const shipped = new Set(
            [...fontsCss.matchAll(/font-weight:\s*(\d{3})/g)].map(m => m[1]),
        );
        // Inter Tight is the body font, so it is the family that has to carry
        // every weight the design system uses.
        const interWeights = new Set(
            [...fontsCss.matchAll(/font-family: 'Inter Tight';\s*font-style: \w+;\s*font-weight: (\d{3})/g)]
                .map(m => m[1]),
        );
        expect([...wanted].filter(w => !shipped.has(w))).toEqual([]);
        expect([...wanted].filter(w => !interWeights.has(w))).toEqual([]);
    });

    it('points every @font-face at a file that is actually on disk', () => {
        const srcs = [...fontsCss.matchAll(/src:\s*url\('([^']+)'\)/g)].map(m => m[1]);
        expect(srcs.length).toBeGreaterThan(0);

        const missing = srcs.filter(src => {
            const file = path.join(PUBLIC, src.replace(/^\//, ''));
            return !fs.existsSync(file) || fs.statSync(file).size === 0;
        });
        expect(missing).toEqual([]);
    });

    it('ships woff2 and nothing heavier', () => {
        const files = fs.readdirSync(FONTS).filter(f => f !== 'fonts.css');
        expect(files.length).toBeGreaterThan(0);
        expect(files.filter(f => !f.endsWith('.woff2'))).toEqual([]);

        // The first four bytes of a woff2 file are the signature 'wOF2'. A
        // truncated or HTML-error-page download would sail past a size check.
        const badSignature = files.filter(f => {
            const head = Buffer.alloc(4);
            const fd = fs.openSync(path.join(FONTS, f), 'r');
            try {
                fs.readSync(fd, head, 0, 4, 0);
            } finally {
                fs.closeSync(fd);
            }
            return head.toString('latin1') !== 'wOF2';
        });
        expect(badSignature).toEqual([]);
    });

    it('keeps each face on a unicode-range, so a browser downloads only the subsets it renders', () => {
        const faces = fontsCss.match(/@font-face\s*\{[^}]*\}/g) || [];
        expect(faces.length).toBeGreaterThan(0);
        expect(faces.filter(face => !/unicode-range:/.test(face))).toEqual([]);
        expect(faces.filter(face => !/font-display:\s*swap/.test(face))).toEqual([]);
    });

    it('links the font stylesheet from the head every page includes', () => {
        const head = read(path.join(VIEWS, 'partials', 'head.ejs'));
        expect(/href="<%= asset\('\/fonts\/fonts\.css'\) %>"/.test(head)).toBe(true);

        // And every page that renders text in those families pulls that head
        // in, which is the half a link-in-the-partial check cannot see.
        for (const view of ['index.ejs', 'dashboard.ejs', 'guild-settings.ejs']) {
            const html = read(path.join(VIEWS, view));
            expect([view, /include\('partials\/head'/.test(html)]).toEqual([view, true]);
        }
    });
});
