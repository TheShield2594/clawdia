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

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PUBLIC = path.join(__dirname, '..', 'src', 'dashboard', 'public');

// A Discord role name is chosen by whoever can manage roles in the guild, and
// it lands in the dashboard verbatim. This one is a role name that renders as
// markup the moment it reaches innerHTML.
const PAYLOAD_ROLE = { id: '42', name: '<img src=x onerror="window.__xss=1">' };
const MALICIOUS_ROLE_NAME = PAYLOAD_ROLE.name;

const documentListeners = [];
const addDocumentListener = document.addEventListener.bind(document);

function forgetDocumentListeners() {
    while (documentListeners.length) {
        const [type, fn, opts] = documentListeners.pop();
        document.removeEventListener(type, fn, opts);
    }
}

function locals(overrides = {}) {
    const base = guildSettingsLocals();
    return guildSettingsLocals({
        roles: [...base.roles, PAYLOAD_ROLE],
        ...overrides,
    });
}

function renderPage(overrides) {
    const file = path.join(VIEWS, 'guild-settings.ejs');
    return ejs.render(fs.readFileSync(file, 'utf8'), locals(overrides), { filename: file });
}

function renderPanel(name, overrides) {
    const file = path.join(VIEWS, 'partials', 'panels', `${name}.ejs`);
    return ejs.render(fs.readFileSync(file, 'utf8'), locals(overrides), { filename: file });
}

/** Put the rendered page in the document and run its scripts, as a browser would. */
function bootPage(overrides) {
    const html = renderPage(overrides);
    const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
    document.body.innerHTML = body.replace(/^<body[^>]*>/, '');

    window.CSS = window.CSS || {};
    window.CSS.escape = value => String(value).replace(/[^\w-]/g, c => '\\' + c);

    window.fetch = jest.fn(async url => {
        const panel = /\/panel\/([a-z]+)(?:$|\?)/.exec(String(url));
        if (panel) {
            return { ok: true, status: 200, text: async () => renderPanel(panel[1], overrides) };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });

    // Found by what it defines, not by being first: the shared head partial
    // carries a nonce'd script of its own now (the CDN image fallback of #946).
    const bootstrap = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)]
        .map(match => match[1])
        .find(body => body.includes('window.CLAWDIA_BOOTSTRAP'));
    document.addEventListener = (type, fn, opts) => {
        documentListeners.push([type, fn, opts]);
        addDocumentListener(type, fn, opts);
    };
    try {
        window.eval(fs.readFileSync(path.join(PUBLIC, 'esc-html.js'), 'utf8'));
        window.eval(bootstrap);
        window.eval(fs.readFileSync(path.join(PUBLIC, 'settings-payload.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8'));
    } finally {
        document.addEventListener = addDocumentListener;
    }
}

const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
};

async function openWelcomePanel() {
    bootPage();
    document.querySelector('.nav-item[data-tab="welcome"]')
        .dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle();
}

describe('autorole chip', () => {
    let errors;

    beforeEach(() => {
        errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        delete window.__xss;
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        errors.mockRestore();
        jest.restoreAllMocks();
    });

    it('renders a role name as text, not markup, when a role is added', async () => {
        await openWelcomePanel();

        const select = document.getElementById('autorole-select');
        select.value = PAYLOAD_ROLE.id;
        await window.addAutoRole();
        await settle();

        const chip = document.querySelector(`#autorole-list [data-role-id="${PAYLOAD_ROLE.id}"]`);
        expect(chip).not.toBeNull();
        // The payload survives as the visible name and nothing else.
        expect(chip.textContent).toContain(MALICIOUS_ROLE_NAME);
        expect(chip.querySelector('img')).toBeNull();
        expect(window.__xss).toBeUndefined();
    });

    it('wires the chip\'s remove button through dataset, not an inline handler', async () => {
        await openWelcomePanel();

        const select = document.getElementById('autorole-select');
        select.value = PAYLOAD_ROLE.id;
        await window.addAutoRole();
        await settle();

        const chip = document.querySelector(`#autorole-list [data-role-id="${PAYLOAD_ROLE.id}"]`);
        const button = chip.querySelector('button');
        expect(button.getAttribute('onclick')).toBeNull();
        expect(button.dataset.action).toBe('autorole-remove');
        expect(button.dataset.roleId).toBe(PAYLOAD_ROLE.id);

        window.fetch.mockClear();
        button.dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        // Removing an auto-role asks first now (#677), like every other
        // destructive action on the page. The dialog is not what this test is
        // about — the wiring above is — so it is answered and the DELETE it
        // releases is what gets checked.
        expect(document.getElementById('confirm-modal').style.display).toBe('flex');
        window._confirmResolve(true);
        await settle();

        const removeCall = window.fetch.mock.calls
            .find(c => String(c[0]).includes(`/autorole/${PAYLOAD_ROLE.id}`));
        expect(removeCall).toBeDefined();
        expect(removeCall[1].method).toBe('DELETE');
        expect(document.querySelector(`#autorole-list [data-role-id="${PAYLOAD_ROLE.id}"]`)).toBeNull();
    });

    it('renders server-side chips through dataset too', async () => {
        const panel = renderPanel('welcome', {
            settings: { ...guildSettingsLocals().settings, autoRoles: [{ roleId: PAYLOAD_ROLE.id }] },
        });
        expect(panel).toContain('data-action="autorole-remove"');
        expect(panel).not.toMatch(/onclick="removeAutoRole/);
    });

    it('escapes the role name in a server-side chip, so the payload stays text', () => {
        // The template renders these on first page load, before any JS runs —
        // a second, independent path to the same sink as addAutoRole.
        const panel = renderPanel('welcome', {
            settings: { ...guildSettingsLocals().settings, autoRoles: [{ roleId: PAYLOAD_ROLE.id }] },
        });

        // The raw payload must not survive into the markup as markup.
        expect(panel).not.toContain(MALICIOUS_ROLE_NAME);
        expect(panel).toContain('&lt;img src=x onerror=');

        // And parsed as a browser would: the name is text, with no element and
        // no event handler recovered from it.
        document.body.innerHTML = panel;
        const chip = document.querySelector(`[data-role-id="${PAYLOAD_ROLE.id}"]`);
        expect(chip).not.toBeNull();
        expect(chip.textContent).toContain(MALICIOUS_ROLE_NAME);
        expect(chip.querySelector('img')).toBeNull();
        expect(document.querySelector('img')).toBeNull();
        expect(window.__xss).toBeUndefined();
    });

    it('never builds an autorole chip with innerHTML', () => {
        const script = fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8');
        // The whole class of bug: a role name concatenated into markup.
        expect(script).not.toMatch(/chip\.innerHTML/);
    });
});
