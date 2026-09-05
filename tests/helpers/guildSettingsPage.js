// Boots views/guild-settings.ejs inside jsdom the way a browser would: render
// the page, put its body in the document, then run esc-html.js, the inline
// bootstrap block and the page's dozen scripts, in the order the view loads
// them.
//
// Shared by every suite that exercises the dashboard page, so the panel tests
// and the accessibility tests boot the same way rather than each keeping its
// own copy of the setup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ejs = require('ejs');
const { guildSettingsLocals } = require('./guildSettingsLocals');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'dashboard', 'views');
const PUBLIC = path.join(__dirname, '..', '..', 'src', 'dashboard', 'public');

// The page's scripts, in the order views/guild-settings.ejs loads them (#935);
// esc-html.js runs before the inline bootstrap block and is handled separately
// below. Evaluated one at a time rather than concatenated, so a panel reaching
// for a `const` in a sibling script fails here the way it would in a browser
// that ran them as the separate scripts they are — the rule that keeps every
// cross-file name a `var` or a function declaration.
const PAGE_SCRIPTS = require('./dashboardScripts').PAGE_SCRIPTS.filter(file => file !== 'esc-html.js');

function renderPage(overrides) {
    const file = path.join(VIEWS, 'guild-settings.ejs');
    return ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(overrides), { filename: file });
}

// `overrides` is for the suites that compare a panel rendered by the server
// against the same list patched in place by guild-settings.js (#689): the two
// have to be given the same data to be worth comparing.
function renderPanel(name, overrides) {
    const file = path.join(VIEWS, 'partials', 'panels', `${name}.ejs`);
    return ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(overrides), { filename: file });
}

// The script wires delegated handlers onto `document` and an unsaved-changes
// guard onto `window`, both of which survive a body swap. Record them so each
// test starts from a clean page rather than inheriting the last one's
// listeners — a stale guard still holding the previous document's fields would
// otherwise answer for the fresh one.
const pageListeners = [];
// Set by bootPage; puts the native addEventListener back once the page's
// listeners have been removed.
let restoreAddListener = null;

function forgetDocumentListeners() {
    while (pageListeners.length) {
        const [target, type, fn, opts] = pageListeners.pop();
        target.removeEventListener(type, fn, opts);
    }
    if (restoreAddListener) {
        restoreAddListener();
        restoreAddListener = null;
    }
}

/** Let the fetch chain inside loadPanel() settle. */
async function settle() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

// jsdom has no matchMedia at all, so the page's own `media()` helper would
// answer null for every query and the viewport-dependent behaviour (#674) and
// the motion preference (#675) would be untestable. This is the smallest thing
// that behaves like one: queries answer from `state`, and `set()` flips a query
// and notifies its listeners the way a browser does when the window is resized
// or the preference is changed mid-session.
function installMatchMedia(initial) {
    // `false` is "this browser has no matchMedia" — the fail-safe the page's
    // own `media()` helper is written around, and worth being able to boot.
    if (initial === false) {
        delete window.matchMedia;
        return { set() {} };
    }

    const state = new Map(Object.entries(initial || {}));
    const lists = new Map();

    window.matchMedia = query => {
        if (lists.has(query)) return lists.get(query);
        const listeners = [];
        const mql = {
            media: query,
            get matches() { return state.get(query) === true; },
            addEventListener: (type, fn) => { if (type === 'change') listeners.push(fn); },
            removeEventListener: (type, fn) => {
                const at = listeners.indexOf(fn);
                if (at !== -1) listeners.splice(at, 1);
            },
            notify: () => listeners.slice().forEach(fn => fn({ matches: mql.matches, media: query })),
        };
        lists.set(query, mql);
        return mql;
    };

    return {
        set(query, matches) {
            state.set(query, matches);
            lists.get(query)?.notify();
        },
    };
}

// The image serves the minified twins scripts/build-assets.js produces, not the
// files in this directory (#905), and the one thing minification could break on
// this page is invisible until something is clicked: it is a classic script, so
// the inline handlers reach its top-level functions by name. Booting the whole
// page from the minified files is what turns that into a test failure.
//
// The build runs in a child process rather than in-process, because esbuild
// refuses to load inside jsdom: the suites that boot this page shim Node's
// TextEncoder into the jsdom global, which then produces a Uint8Array from the
// wrong realm and fails an invariant esbuild checks on require. The child gets
// a plain Node global. It runs once per worker, on the first suite that asks
// for it, and writes into a temp directory rather than into src/.
let minifiedDir = null;

function minifiedPublic() {
    if (minifiedDir) return minifiedDir;
    minifiedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-min-'));
    execFileSync(
        process.execPath,
        [path.join(__dirname, '..', '..', 'scripts', 'build-assets.js'), '--out', minifiedDir],
        { stdio: 'ignore' },
    );
    // The worker owns the directory for its lifetime; nothing outside reads it.
    process.on('exit', () => fs.rmSync(minifiedDir, { recursive: true, force: true }));
    return minifiedDir;
}

function script(file, minified) {
    if (!minified) return fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    const ext = path.extname(file);
    const twin = `${file.slice(0, -ext.length)}.min${ext}`;
    return fs.readFileSync(path.join(minifiedPublic(), twin), 'utf8');
}

/**
 * Boot the page. `media` seeds the matchMedia stub — `{ '(max-width: 768px)':
 * true }` for a phone — and the returned handle flips a query afterwards.
 * `media: false` boots with no matchMedia at all. `minified: true` runs the
 * page's scripts through the minifier the image build uses first.
 */
function bootPage({ panelFetch, media, minified } = {}) {
    const html = renderPage();
    const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
    document.body.innerHTML = body.replace(/^<body[^>]*>/, '');

    // jsdom has no CSS.escape; every browser that can run this page does.
    window.CSS = window.CSS || {};
    window.CSS.escape = value => String(value).replace(/[^\w-]/g, c => '\\' + c);

    const mediaControl = installMatchMedia(media);

    window.fetch = jest.fn(async url => {
        const panel = /\/panel\/([a-z]+)(?:$|\?)/.exec(String(url));
        if (panel) {
            if (panelFetch) return panelFetch(panel[1]);
            return { ok: true, status: 200, text: async () => renderPanel(panel[1]) };
        }
        // Every other call is one of the panels' own data endpoints. Most cope
        // with an empty object; the AI usage widget reads into nested keys.
        const payload = /\/ai\/usage/.test(String(url))
            ? { today: {}, week: {}, month: {}, daily: [], byModel: [], rateLimit: {} }
            : {};
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    });

    // The page's own per-request data block, found by what it defines rather
    // than by being first: the shared head partial carries a nonce'd script of
    // its own now (the CDN image fallback of #946), and it comes earlier in the
    // document.
    const bootstrap = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)]
        .map(match => match[1])
        .find(body => body.includes('window.CLAWDIA_BOOTSTRAP'));
    const addDocumentListener = document.addEventListener.bind(document);
    const addWindowListener = window.addEventListener.bind(window);
    document.addEventListener = (type, fn, opts) => {
        pageListeners.push([document, type, fn, opts]);
        addDocumentListener(type, fn, opts);
    };
    window.addEventListener = (type, fn, opts) => {
        pageListeners.push([window, type, fn, opts]);
        addWindowListener(type, fn, opts);
    };
    // Left in place rather than restored once the scripts have run: the page
    // registers listeners after boot too — openPromptEditor() adds a document
    // keydown handler when the editor opens — and one registered through the
    // restored method is invisible to forgetDocumentListeners(), so it leaks
    // into whatever test runs next. Uninstalled by forgetDocumentListeners().
    restoreAddListener = () => {
        document.addEventListener = addDocumentListener;
        window.addEventListener = addWindowListener;
    };
    window.eval(script('esc-html.js', minified));
    window.eval(bootstrap);
    for (const file of PAGE_SCRIPTS) window.eval(script(file, minified));

    return { media: mediaControl };
}

function clickTab(id) {
    document.querySelector(`.nav-item[data-tab="${id}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
}

module.exports = { VIEWS, PUBLIC, PAGE_SCRIPTS, renderPage, renderPanel, bootPage, clickTab, settle, forgetDocumentListeners };
