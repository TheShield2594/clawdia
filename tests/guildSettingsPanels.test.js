/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { guildSettingsLocals } = require('./helpers/guildSettingsLocals');
const { PANELS, DEFAULT_PANEL } = require('../src/dashboard/lib/panels');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PUBLIC = path.join(__dirname, '..', 'src', 'dashboard', 'public');

function renderPage() {
    const file = path.join(VIEWS, 'guild-settings.ejs');
    return ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(), { filename: file });
}

function renderPanel(name) {
    const file = path.join(VIEWS, 'partials', 'panels', `${name}.ejs`);
    return ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(), { filename: file });
}

// The script wires delegated handlers onto `document`, which survives a body
// swap. Record them at boot so each test can start from a clean document.
const documentListeners = [];
const addDocumentListener = document.addEventListener.bind(document);

function forgetDocumentListeners() {
    while (documentListeners.length) {
        const [type, fn, opts] = documentListeners.pop();
        document.removeEventListener(type, fn, opts);
    }
}

/** Put the rendered page in the document and run its scripts, as a browser would. */
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
        const body = /\/ai\/usage/.test(String(url))
            ? { today: {}, week: {}, month: {}, daily: [], byModel: [], rateLimit: {} }
            : {};
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    });

    const bootstrap = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)[1];
    document.addEventListener = (type, fn, opts) => {
        documentListeners.push([type, fn, opts]);
        addDocumentListener(type, fn, opts);
    };
    try {
        window.eval(fs.readFileSync(path.join(PUBLIC, 'esc-html.js'), 'utf8'));
        window.eval(bootstrap);
        window.eval(fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8'));
    } finally {
        document.addEventListener = addDocumentListener;
    }
}

/** Let the fetch chain inside loadPanel() settle. */
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
};

function clickTab(id) {
    document.querySelector(`.nav-item[data-tab="${id}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
}

describe('lazily loaded settings panels', () => {
    let errors;

    beforeEach(() => {
        errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
    });

    afterEach(async () => {
        // Drain anything still in flight before the next test replaces the DOM.
        await settle();
        forgetDocumentListeners();
        errors.mockRestore();
        jest.restoreAllMocks();
    });

    it('ships only the default panel, and a stub for every other one', () => {
        bootPage();
        expect(document.querySelectorAll('.panel')).toHaveLength(1);
        expect(document.getElementById(DEFAULT_PANEL)).not.toBeNull();
        expect(document.querySelectorAll('.panel-stub')).toHaveLength(PANELS.length - 1);
    });

    it('runs the default panel\'s setup at load', () => {
        bootPage();
        // The Getting Started checklist is filled in by overview's init hook.
        expect(document.getElementById('gs-subtitle').textContent).toMatch(/of \d+ steps complete/);
    });

    it('fetches a panel the first time its tab is opened, and only once', async () => {
        bootPage();
        clickTab('economy');
        await settle();

        const panel = document.getElementById('economy');
        expect(panel).not.toBeNull();
        expect(panel.style.display).toBe('block');
        expect(panel.classList.contains('active')).toBe(true);
        expect(document.querySelector('.panel-stub[data-panel="economy"]')).toBeNull();

        const panelFetches = () => window.fetch.mock.calls.filter(c => String(c[0]).includes('/panel/')).length;
        expect(panelFetches()).toBe(1);

        clickTab('overview');
        clickTab('economy');
        await settle();
        expect(panelFetches()).toBe(1);
    });

    it('runs the arriving panel\'s setup hooks', async () => {
        bootPage();
        clickTab('economy');
        await settle();
        // renderStoreItems/renderJobs only run from economy's hook.
        expect(document.getElementById('store-items-grid').children.length).toBeGreaterThan(0);
        expect(document.getElementById('jobs-list').children.length).toBeGreaterThan(0);

        clickTab('achievements');
        await settle();
        expect(document.getElementById('builtin-ach-list').children.length).toBeGreaterThan(0);

        clickTab('moderation');
        await settle();
        expect(document.getElementById('mod-escalation-ladder').children.length).toBeGreaterThan(0);
    });

    it('opens every panel without an error', async () => {
        bootPage();
        for (const panel of PANELS) {
            clickTab(panel);
            await settle();
            expect([panel, document.getElementById(panel) !== null]).toEqual([panel, true]);
        }
        expect(errors.mock.calls.map(call => String(call[0]))).toEqual([]);
    });

    it('wires inner tabs inside a panel that arrived late', async () => {
        bootPage();
        clickTab('economy');
        await settle();

        const health = document.querySelector('.eco-inner-tab[data-eco-tab="eco-tab-health"]');
        health.dispatchEvent(new window.Event('click', { bubbles: true }));
        expect(health.classList.contains('active')).toBe(true);
        expect(document.getElementById('eco-tab-health').classList.contains('active')).toBe(true);
    });

    it('shows a placeholder while a panel is in flight', async () => {
        bootPage();
        clickTab('leveling');
        const stub = document.querySelector('.panel-stub[data-panel="leveling"]');
        expect(stub.style.display).toBe('block');
        expect(stub.textContent).toContain('Loading');
        await settle();   // drain the fetch before the next test swaps the stub
    });

    it('offers a retry when a panel fails to load, and the retry works', async () => {
        let attempt = 0;
        bootPage({
            panelFetch: name => {
                if (name !== 'starboard') return { ok: true, status: 200, text: async () => renderPanel(name) };
                attempt++;
                if (attempt === 1) return { ok: false, status: 500, text: async () => '' };
                return { ok: true, status: 200, text: async () => renderPanel(name) };
            },
        });

        clickTab('starboard');
        await settle();
        const stub = document.querySelector('.panel-stub[data-panel="starboard"]');
        expect(stub).not.toBeNull();
        expect(stub.textContent).toMatch(/retry/i);
        expect(document.getElementById('starboard')).toBeNull();

        clickTab('starboard');
        await settle();
        expect(document.getElementById('starboard')).not.toBeNull();
    });

    it('opens the panel named by the URL hash, and its inner tab', async () => {
        window.location.hash = '#aipersonas';
        try {
            bootPage();
            await settle();

            const ai = document.getElementById('ai');
            expect(ai).not.toBeNull();
            expect(ai.style.display).toBe('block');
            expect(document.getElementById('ai-personas').classList.contains('active')).toBe(true);
            // The AI panel's own hooks ran: the prompt counter is filled in.
            expect(document.getElementById('ai-prompt-count').textContent).toMatch(/\d+ \/ \d+/);
        } finally {
            window.location.hash = '';
        }
    });

    it('never lets a slow panel steal the view from a later click', async () => {
        const gates = {};
        bootPage({
            panelFetch: name => new Promise(resolve => {
                gates[name] = () => resolve({ ok: true, status: 200, text: async () => renderPanel(name) });
            }),
        });

        clickTab('quests');
        clickTab('starboard');
        gates.starboard();
        await settle();
        gates.quests();
        await settle();

        expect(document.getElementById('starboard').style.display).toBe('block');
        expect(document.getElementById('starboard').classList.contains('active')).toBe(true);
        expect(document.getElementById('quests').style.display).toBe('none');
        expect(document.getElementById('quests').classList.contains('active')).toBe(false);
    });
});
