// Boots views/guild-settings.ejs inside jsdom the way a browser would: render
// the page, put its body in the document, then run esc-html.js, the inline
// bootstrap block and guild-settings.js in order.
//
// Shared by every suite that exercises the dashboard page, so the panel tests
// and the accessibility tests boot the same way rather than each keeping its
// own copy of the setup.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { guildSettingsLocals } = require('./guildSettingsLocals');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'dashboard', 'views');
const PUBLIC = path.join(__dirname, '..', '..', 'src', 'dashboard', 'public');

function renderPage(overrides) {
    const file = path.join(VIEWS, 'guild-settings.ejs');
    return ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(overrides), { filename: file });
}

function renderPanel(name) {
    const file = path.join(VIEWS, 'partials', 'panels', `${name}.ejs`);
    return ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(), { filename: file });
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

function bootPage({ panelFetch } = {}) {
    const html = renderPage();
    const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
    document.body.innerHTML = body.replace(/^<body[^>]*>/, '');

    // jsdom has no CSS.escape; every browser that can run this page does.
    window.CSS = window.CSS || {};
    window.CSS.escape = value => String(value).replace(/[^\w-]/g, c => '\\' + c);

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

    const bootstrap = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)[1];
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
    window.eval(fs.readFileSync(path.join(PUBLIC, 'esc-html.js'), 'utf8'));
    window.eval(bootstrap);
    window.eval(fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8'));
}

function clickTab(id) {
    document.querySelector(`.nav-item[data-tab="${id}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
}

module.exports = { VIEWS, PUBLIC, renderPage, renderPanel, bootPage, clickTab, settle, forgetDocumentListeners };
