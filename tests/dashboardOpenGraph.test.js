/**
 * #687. Links to a Discord bot are shared in Discord, and Discord unfurls Open
 * Graph tags — so the landing page's card is how the product looks in its own
 * main distribution channel, not an SEO detail.
 *
 * Two halves are guarded here, because either one alone renders nothing:
 * the tags on index.ejs, and the PNG they point at. An og:image URL that 404s
 * unfurls exactly like no og:image at all.
 *
 * The view is rendered rather than read as text: the tags interpolate `baseUrl`
 * and `asset()`, and a template can carry the right markup and still emit
 * `content="undefined"` for a local nobody passed.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { asset } = require('../src/dashboard/lib/assets');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const BASE = 'https://bot.example.com';

const render = (view, locals) => {
    const file = path.join(VIEWS, view);
    return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
};

const landing = (extra = {}) => render('index.ejs', {
    user: null,
    stats: { servers: 4, members: 120, uptime: '3d' },
    version: '1.2.3',
    asset,
    baseUrl: BASE,
    ...extra,
});

const attr = (html, re) => (html.match(re) || [])[1];

describe('the landing page unfurls', () => {
    const html = landing();

    it.each([
        ['og:type', 'website'],
        ['og:site_name', 'Clawdia'],
        ['og:title', 'Clawdia — A chill Discord bot with serious teeth'],
        ['og:url', `${BASE}/`],
        ['og:image:width', '1200'],
        ['og:image:height', '630'],
    ])('sets %s', (property, value) => {
        expect(attr(html, new RegExp(`<meta property="${property}" content="([^"]*)">`))).toBe(value);
    });

    it('describes the page with the same sentence the meta description uses', () => {
        const description = attr(html, /<meta name="description" content="([^"]*)">/);
        expect(description).toContain('self-hosted Discord bot');
        expect(attr(html, /<meta property="og:description" content="([^"]*)">/)).toBe(description);
        expect(attr(html, /<meta name="twitter:description" content="([^"]*)">/)).toBe(description);
    });

    it('titles the card with the same sentence the <title> uses', () => {
        const title = attr(html, /<title>([^<]*)<\/title>/);
        expect(attr(html, /<meta property="og:title" content="([^"]*)">/)).toBe(title);
        expect(attr(html, /<meta name="twitter:title" content="([^"]*)">/)).toBe(title);
    });

    it('asks for the wide card, since the square crop cuts the wordmark off', () => {
        expect(attr(html, /<meta name="twitter:card" content="([^"]*)">/)).toBe('summary_large_image');
    });

    it('gives the card alt text', () => {
        expect(attr(html, /<meta property="og:image:alt" content="([^"]*)">/)).toContain('Clawdia');
    });

    it('points og:image at an absolute, content-hashed URL', () => {
        const image = attr(html, /<meta property="og:image" content="([^"]*)">/);
        // Absolute: an unfurler resolves nothing against the page it fetched.
        expect(image).toBe(`${BASE}${asset('/og-image.png')}`);
        expect(image).toMatch(/^https:\/\/[^/]+\/og-image\.png\?v=[0-9a-f]{10}$/);
    });

    it('canonicalises to the configured host, not the request\'s', () => {
        expect(attr(html, /<link rel="canonical" href="([^"]*)">/)).toBe(`${BASE}/`);
    });

    it('emits no half-formed absolute tag when there is no base URL', () => {
        // checkDashboardUrl returns null only in a misconfiguration that already
        // refuses to start; dropping the tags beats `content="undefined"`.
        const withoutBase = landing({ baseUrl: null });
        expect(withoutBase).not.toContain('og:url');
        expect(withoutBase).not.toContain('og:image');
        expect(withoutBase).not.toContain('rel="canonical"');
        // The tags that need no host still go out.
        expect(withoutBase).toContain('<meta property="og:title"');
        expect(withoutBase).toContain('<meta name="twitter:card"');
    });
});

describe('the pages behind the login do not', () => {
    // Explicitly out of scope in #687: both sit behind checkAuth, so no crawler
    // or unfurler can reach them and a card for them would describe a redirect.
    const authed = {
        'dashboard.ejs': () => render('dashboard.ejs', {
            user: { id: '1', username: 'tester', avatar: null }, guilds: [], version: '1.2.3', asset,
        }),
        'guild-settings.ejs': () => render('guild-settings.ejs', require('./helpers/guildSettingsLocals').guildSettingsLocals()),
    };

    it.each(Object.keys(authed))('%s carries no Open Graph or canonical tag', view => {
        const html = authed[view]();
        expect(html).not.toContain('property="og:');
        expect(html).not.toContain('name="twitter:');
        expect(html).not.toContain('rel="canonical"');
    });
});

describe('the card the tags point at', () => {
    it('is on disk at the size the tags promise', () => {
        // Structural, not byte-for-byte: libpng and the installed fonts render
        // the same drawing differently across machines. Same reasoning as the
        // favicon check in scripts/make-favicon.js.
        execFileSync('node', [path.join(__dirname, '..', 'scripts', 'make-og-image.js'), '--check'], {
            stdio: 'pipe',
        });
    });

    it('is served out of public/, where express.static can find it', () => {
        expect(fs.existsSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'og-image.png'))).toBe(true);
    });
});
