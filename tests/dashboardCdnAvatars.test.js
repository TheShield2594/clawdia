/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
'use strict';

process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require,
// and guildSettingsLocals pulls the models in for its defaults.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #946 and #945 — what the dashboard's <head> asks the network for.
 *
 * Two failures the views could not see on their own:
 *
 *   1. Every Discord CDN image was requested at whatever size its owner had
 *      uploaded — routinely 1024px or larger, for a tile drawn at 34 to 52 — with
 *      no dimensions to reserve its box and no answer for a hash that no longer
 *      resolves. The last one is the visible half: a server that changed its icon
 *      since the OAuth session was minted 404s, and the markup's own letter tile
 *      never appeared because nothing was watching for the error.
 *
 *   2. `esc-html.js` was a synchronous <script> in <head> that nothing in <head>
 *      read, so it cost a round trip before first paint for no benefit, and the
 *      two faces rendered above the fold were three round trips deep (HTML →
 *      fonts.css → woff2) because a @font-face URL is not discoverable until the
 *      stylesheet declaring it has parsed.
 *
 * The fallback half is driven rather than read: the handler is registered by an
 * inline script in the head partial, and the property under test is that firing
 * a real `error` event at a real <img> replaces it with the letter tile. Reading
 * the markup for a `data-fallback-class` attribute would pass just as happily
 * with no handler at all.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { asset } = require('../src/dashboard/lib/assets');
const { guildSettingsLocals } = require('./helpers/guildSettingsLocals');
const { PAGE_SCRIPTS } = require('./helpers/dashboardScripts');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PUBLIC = path.join(__dirname, '..', 'src', 'dashboard', 'public');

const render = (view, locals) => {
    const file = path.join(VIEWS, view);
    return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
};

const USER = { id: '1', username: 'tester', avatar: 'abc' };

const pages = {
    'dashboard.ejs': () => render('dashboard.ejs', {
        user: USER,
        guilds: [{ id: '10', name: 'Guild One', icon: 'aaa', botPresent: true }],
        version: '1.2.3',
        asset,
        cspNonce: 'test-nonce',
    }),
    // The shared fixture has no icon or avatar hash, which is the branch that
    // renders the letter tile directly; this page's CDN images only exist on the
    // other branch, so both are supplied here.
    'guild-settings.ejs': () => render('guild-settings.ejs', {
        ...guildSettingsLocals(),
        user: { id: '1', username: 'tester', avatar: 'abc' },
        guild: { id: '123456789012345678', name: 'Test Guild', icon: 'aaa', ownerId: '1', owner: true },
    }),
};

/** Every <img> tag in the rendered page that points at Discord's CDN. */
const cdnImages = html => html.match(/<img[^>]*cdn\.discordapp\.com[^>]*>/g) || [];

describe('Discord CDN images are asked for at the size they are drawn', () => {
    it.each(Object.keys(pages))('%s sizes, dimensions and fallbacks every CDN image', view => {
        const images = cdnImages(pages[view]());
        // A page with no CDN image would pass every assertion below vacuously.
        expect(images.length).toBeGreaterThan(0);

        for (const img of images) {
            // 64 or 128 — the two Discord sizes that cover this dashboard's
            // 34-52px tiles at 2x. Anything else is a number someone guessed.
            expect([img, /\?size=(64|128)"/.test(img)]).toEqual([img, true]);
            expect([img, /\bwidth="\d+"/.test(img)]).toEqual([img, true]);
            expect([img, /\bheight="\d+"/.test(img)]).toEqual([img, true]);
            expect([img, /data-fallback-class="/.test(img)]).toEqual([img, true]);
        }
    });

    it('lazy-loads the server grid and only the server grid', () => {
        // The grid is as long as the member's server list and most of it starts
        // below the fold. The nav avatar and the sidebar switcher are in the
        // first viewport on every page, where `lazy` can only delay them.
        const grid = cdnImages(pages['dashboard.ejs']()).filter(img => img.includes('/icons/'));
        const chrome = cdnImages(pages['dashboard.ejs']()).filter(img => img.includes('/avatars/'));

        expect(grid.length).toBeGreaterThan(0);
        expect(chrome.length).toBeGreaterThan(0);
        for (const img of grid) expect([img, img.includes('loading="lazy"')]).toEqual([img, true]);
        for (const img of chrome) expect([img, img.includes('loading="lazy"')]).toEqual([img, false]);
    });

    it('names a fallback class the stylesheet actually defines', () => {
        // The swap is only a fallback if the class it lands on is styled; a
        // renamed tile class would otherwise degrade to unstyled text.
        const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
        const classes = Object.values(pages)
            .flatMap(page => cdnImages(page()))
            .map(img => img.match(/data-fallback-class="([^"]+)"/)[1]);

        expect(classes.length).toBeGreaterThan(0);
        for (const name of classes) expect([name, css.includes(`.${name}`)]).toEqual([name, true]);
    });
});

describe('a CDN image that fails is replaced by the letter tile', () => {
    /** Renders a page into jsdom and runs the head partial's inline script. */
    function boot(view) {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        const html = pages[view]();

        // The handler has to be installed before the images exist, which is why
        // it lives in <head>; installing it first here reproduces that order.
        const inline = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)]
            .map(m => m[1])
            .find(body => body.includes("addEventListener('error'"));
        expect(inline).toBeTruthy();
        // eslint-disable-next-line no-new-func
        new Function(inline).call(window);

        document.body.innerHTML = html;
    }

    afterEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
    });

    it('swaps the img for a div carrying the tile class and the initial', () => {
        boot('dashboard.ejs');

        const img = document.querySelector('img[data-fallback-class]');
        expect(img).not.toBeNull();
        const expected = { cls: img.dataset.fallbackClass, letter: img.dataset.fallbackText };
        const parent = img.parentElement;

        img.dispatchEvent(new window.Event('error'));

        expect(parent.querySelector('img[data-fallback-class]')).toBeNull();
        const tile = parent.querySelector(`.${expected.cls}`);
        expect(tile).not.toBeNull();
        expect(tile.tagName).toBe('DIV');
        expect(tile.textContent).toBe(expected.letter);
    });

    it('writes the initial as text, so a crafted guild name cannot inject markup', () => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        const html = render('dashboard.ejs', {
            user: USER,
            guilds: [{ id: '10', name: '<img src=x onerror=alert(1)>evil', icon: 'aaa', botPresent: true }],
            version: '1.2.3',
            asset,
            cspNonce: 'test-nonce',
        });
        const inline = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)]
            .map(m => m[1])
            .find(body => body.includes("addEventListener('error'"));
        // eslint-disable-next-line no-new-func
        new Function(inline).call(window);
        document.body.innerHTML = html;

        // The grid icon specifically: the nav avatar is earlier in the document
        // and carries a different tile class.
        const img = document.querySelector('img[data-fallback-class="cw-dash-lp-icon-fallback"]');
        const parent = img.parentElement;
        img.dispatchEvent(new window.Event('error'));

        const tile = parent.querySelector('.cw-dash-lp-icon-fallback');
        expect(tile.textContent).toBe('<');
        expect(tile.querySelector('img')).toBeNull();
        expect(tile.innerHTML).toBe('&lt;');
    });

    it('leaves an image with no fallback declared alone', () => {
        boot('dashboard.ejs');

        const plain = document.createElement('img');
        plain.src = 'https://cdn.discordapp.com/icons/1/nope.png';
        document.body.appendChild(plain);

        plain.dispatchEvent(new window.Event('error'));

        expect(plain.isConnected).toBe(true);
    });

    it('builds one tile even if the same image errors twice', () => {
        boot('dashboard.ejs');

        const img = document.querySelector('img[data-fallback-class]');
        const cls = img.dataset.fallbackClass;
        const parent = img.parentElement;

        img.dispatchEvent(new window.Event('error'));
        img.dispatchEvent(new window.Event('error'));

        expect(parent.querySelectorAll(`.${cls}`)).toHaveLength(1);
    });
});

describe('the head asks for its render-critical bytes up front', () => {
    const head = fs.readFileSync(path.join(VIEWS, 'partials', 'head.ejs'), 'utf8');

    it('preloads the two faces that render above the fold', () => {
        const preloads = [...head.matchAll(/<link rel="preload"[^>]*href="([^"]+)"/g)].map(m => m[1]);
        expect(preloads).toEqual([
            '/fonts/inter-tight-400-latin.woff2',
            '/fonts/inter-tight-600-latin.woff2',
        ]);
        for (const tag of head.match(/<link rel="preload"[^>]*>/g)) {
            // Fonts are fetched in CORS mode; a preload whose mode does not
            // match the fetch it is meant to satisfy downloads the file twice.
            expect([tag, tag.includes('crossorigin')]).toEqual([tag, true]);
            expect([tag, tag.includes('as="font"')]).toEqual([tag, true]);
        }
    });

    it('preloads exactly the URLs fonts.css goes on to request', () => {
        // The one rule a preload has to obey: same URL, or it is a second
        // download plus a console warning. fonts.css names its faces by bare
        // filename (the un-hashed font URLs of #903), so these must too.
        const css = fs.readFileSync(path.join(PUBLIC, 'fonts', 'fonts.css'), 'utf8');
        const declared = new Set([...css.matchAll(/src:\s*url\('([^']+)'\)/g)].map(m => m[1]));
        const preloads = [...head.matchAll(/<link rel="preload"[^>]*href="([^"]+)"/g)].map(m => m[1]);

        expect(preloads.filter(url => !declared.has(url))).toEqual([]);
        for (const url of preloads) {
            expect([url, fs.existsSync(path.join(PUBLIC, url.replace(/^\//, '')))]).toEqual([url, true]);
        }
    });

    it('leaves no parser-blocking script in the head', () => {
        // #945's other half: guild-settings pulled esc-html.js in synchronously,
        // and nothing in <head> read it. Deferring all three of that page's
        // external scripts keeps their execution order and stops the parse
        // waiting on any of them.
        const view = fs.readFileSync(path.join(VIEWS, 'guild-settings.ejs'), 'utf8');
        const headBlock = view.slice(0, view.indexOf('</head>'));

        const blocking = (headBlock.match(/<script[^>]*src=[^>]*>/g) || [])
            .filter(tag => !/\bdefer\b|\basync\b/.test(tag));
        expect(blocking).toEqual([]);

        // And ordering: deferred scripts run in document order after every
        // parser-executed one, so a single undeferred tag among them would run
        // *before* esc-html.js rather than after it.
        const external = view.match(/<script[^>]*\ssrc=[^>]*>/g) || [];
        expect(external.length).toBe(PAGE_SCRIPTS.length);
        for (const tag of external) expect([tag, tag.includes('defer')]).toEqual([tag, true]);
    });
});
