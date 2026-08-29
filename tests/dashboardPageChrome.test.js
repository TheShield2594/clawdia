/**
 * #690. The six-line <head> block was copy-pasted into all three top-level
 * views and the cream `cw-nav` — brand SVG included — into two of them, so the
 * font <link> of #681 and the favicon of #688 each had to be applied three
 * times. It is now `partials/head.ejs`, `partials/nav.ejs` and
 * `partials/brand-mark.ejs`.
 *
 * These render the real views rather than reading them as text, because the
 * failure the extraction is guarding against is a page that comes out missing
 * its stylesheet or its nav, and a view can include the right partial and
 * still render nothing if a local the partial reads was never passed.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { asset } = require('../src/dashboard/lib/assets');
const { guildSettingsLocals } = require('./helpers/guildSettingsLocals');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');

const render = (view, locals) => {
    const file = path.join(VIEWS, view);
    return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
};

const USER = { id: '1', username: 'tester', avatar: null };
const STATS = { servers: 4, members: 120, uptime: '3d' };

const pages = {
    'index.ejs': () => render('index.ejs', { user: null, stats: STATS, version: '1.2.3', asset }),
    'dashboard.ejs': () => render('dashboard.ejs', { user: USER, guilds: [], version: '1.2.3', asset }),
    'guild-settings.ejs': () => render('guild-settings.ejs', guildSettingsLocals()),
};

describe('every top-level view gets its head from one partial', () => {
    it.each(Object.keys(pages))('%s renders the shared head', view => {
        const html = pages[view]();

        expect(html).toContain('<meta charset="UTF-8">');
        expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
        expect(html).toContain(`href="${asset('/fonts/fonts.css')}"`);
        expect(html).toContain(`href="${asset('/styles.css')}"`);
        // Both favicon forms, which is the whole point of #688's partial.
        expect(html).toContain(`href="${asset('/favicon.ico')}"`);
        expect(html).toContain(`href="${asset('/favicon.svg')}"`);
    });

    it('keeps each page\'s own title, and only one of them', () => {
        const titles = {
            'index.ejs': 'Clawdia — A chill Discord bot with serious teeth',
            'dashboard.ejs': 'Dashboard — Clawdia',
            'guild-settings.ejs': 'Test Guild · Dashboard — Clawdia',
        };
        for (const [view, title] of Object.entries(titles)) {
            const found = [...pages[view]().matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]);
            expect([view, found]).toEqual([view, [title]]);
        }
    });

    it('emits the description meta only where there is one to emit', () => {
        // The partial reads it off `locals`, so the two logged-in pages must
        // render no empty tag rather than `content=""`.
        expect(pages['index.ejs']()).toContain('<meta name="description" content="Moderation,');
        expect(pages['dashboard.ejs']()).not.toContain('<meta name="description"');
        expect(pages['guild-settings.ejs']()).not.toContain('<meta name="description"');
    });

    it('leaves the one script only guild-settings wants where it was', () => {
        expect(pages['guild-settings.ejs']()).toContain(`<script src="${asset('/esc-html.js')}"></script>`);
        expect(pages['index.ejs']()).not.toContain('esc-html.js');
    });

    it('no longer repeats the head block in the views themselves', () => {
        for (const view of Object.keys(pages)) {
            const src = fs.readFileSync(path.join(VIEWS, view), 'utf8');
            expect([view, src.includes('<meta charset=')]).toEqual([view, false]);
            expect([view, src.includes('fonts/fonts.css')]).toEqual([view, false]);
        }
    });
});

describe('the landing page and the server picker share one nav', () => {
    it('renders the same bar on both', () => {
        for (const view of ['index.ejs', 'dashboard.ejs']) {
            const html = pages[view]();
            expect([view, html.includes('<nav class="cw-nav">')]).toEqual([view, true]);
            expect([view, html.includes('<span class="cw-wordmark">Clawdia</span>')]).toEqual([view, true]);
        }
    });

    it('shows the section links and the signed-out CTA on the landing page only', () => {
        const home = pages['index.ejs']();
        expect(home).toContain('class="cw-nav-links"');
        expect(home).toContain('href="/auth/login"');
        expect(home).toContain('Add to Discord');

        const dash = pages['dashboard.ejs']();
        expect(dash).not.toContain('class="cw-nav-links"');
        expect(dash).not.toContain('Add to Discord');
    });

    it('swaps the landing CTA for the dashboard link once there is a user', () => {
        const html = render('index.ejs', { user: USER, stats: STATS, version: '1.2.3', asset });
        expect(html).toContain('Open Dashboard');
        expect(html).not.toContain('Add to Discord');
    });

    it('shows the signed-in user and a logout form on the server picker', () => {
        const html = pages['dashboard.ejs']();
        expect(html).toContain('<span class="cw-nav-username">tester</span>');
        expect(html).toContain('action="/auth/logout"');
        // No avatar on this user, so the initial stands in for one.
        expect(html).toContain('<div class="cw-dash-avatar-fallback">T</div>');
    });

    it('renders the avatar when the user has one', () => {
        const html = render('dashboard.ejs', {
            user: { ...USER, avatar: 'abc' }, guilds: [], version: '1.2.3', asset,
        });
        expect(html).toContain('https://cdn.discordapp.com/avatars/1/abc.png');
        expect(html).not.toContain('cw-dash-avatar-fallback');
    });

    it('links the brand home from the dashboard and not from the home page', () => {
        expect(pages['dashboard.ejs']()).toContain('<a href="/" class="cw-brand-link">');
        // index's brand sits inside .cw-brand with no anchor of its own.
        const brand = pages['index.ejs']().match(/<div class="cw-brand">[\s\S]*?<\/div>/)[0];
        expect(brand).not.toContain('<a ');
    });
});

describe('the paw mark comes from one file', () => {
    const paw = /<ellipse cx="16" cy="22" rx="8\.5" ry="6" fill="([^"]+)"\/>/g;

    it('is no longer pasted into any view', () => {
        // The whole tree, not just the three pages: the fifth copy of the mark
        // was in the overview panel's "Ask Clawdia" card.
        const all = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ejs')) all.push(path.relative(VIEWS, full));
            }
        })(VIEWS);
        expect(all.length).toBeGreaterThan(3);

        const pasted = all.filter(view => {
            paw.lastIndex = 0;
            return paw.test(fs.readFileSync(path.join(VIEWS, view), 'utf8'));
        });
        expect(pasted).toEqual([path.join('partials', 'brand-mark.ejs')]);
    });

    it('takes its size and colourway from the call site', () => {
        const file = path.join(VIEWS, 'partials', 'brand-mark.ejs');
        const src = fs.readFileSync(file, 'utf8');
        const one = data => ejs.render(src, data, { filename: file });

        expect(one({})).toContain('width="28" height="28"');
        expect(one({})).toContain('fill="#14110d"');
        expect(one({})).toContain('stroke="#d97742"');

        const sidebar = one({ size: 24, fill: '#ece4d2', accent: '#e89163' });
        expect(sidebar).toContain('width="24" height="24"');
        expect(sidebar).toContain('stroke="#e89163"');
        // Every ellipse takes the fill, not just the first.
        expect([...sidebar.matchAll(/fill="#ece4d2"/g)]).toHaveLength(5);
        expect(sidebar).not.toContain('#14110d');
    });

    it('is hidden from assistive tech, since the wordmark next to it says the name', () => {
        for (const view of ['index.ejs', 'dashboard.ejs', 'guild-settings.ejs']) {
            const html = pages[view]();
            const svgs = html.match(/<svg[^>]*viewBox="0 0 32 32"[^>]*>/g) || [];
            expect([view, svgs.length]).not.toEqual([view, 0]);
            expect([view, svgs.filter(s => !s.includes('aria-hidden="true"'))]).toEqual([view, []]);
        }
    });
});
