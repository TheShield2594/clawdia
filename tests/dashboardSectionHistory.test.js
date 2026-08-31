/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #679. Every section change was a replaceState, so the whole dashboard
// occupied one history entry: after opening ten panels, Back left the
// dashboard altogether rather than returning to the ninth. Each section is an
// entry of its own now, and Back walks them.
const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const active = () => document.querySelector('.panel.active')?.id || null;

/** Go back one entry and let the popstate handler's panel fetch land. */
function back() {
    return new Promise(resolve => {
        window.addEventListener('popstate', async () => {
            await settle();
            resolve();
        }, { once: true });
        window.history.back();
    });
}

async function boot() {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // Each test starts from a URL of its own, so the entries one pushes are
    // never the entries the next one walks back through.
    window.history.pushState(null, '', `/dashboard/guild/1?t=${Math.random()}`);
    document.body.innerHTML = '';
    bootPage();
    await settle();
}

afterEach(async () => {
    await settle();
    forgetDocumentListeners();
    jest.restoreAllMocks();
});

describe('choosing a section', () => {
    beforeEach(boot);

    it('names it in the URL', async () => {
        clickTab('welcome');
        await settle();
        expect(location.hash).toBe('#welcome');
    });

    it('adds an entry rather than overwriting the last one', async () => {
        const before = history.length;
        clickTab('welcome');
        await settle();
        clickTab('farewell');
        await settle();
        expect(history.length).toBe(before + 2);
    });

    // An entry that restores what is already on screen is a Back press that
    // does nothing, which is worse than no entry at all.
    it('adds nothing for re-choosing the section already open', async () => {
        clickTab('welcome');
        await settle();
        const before = history.length;
        clickTab('welcome');
        await settle();
        expect(history.length).toBe(before);
        expect(location.hash).toBe('#welcome');
    });
});

describe('the Back button', () => {
    beforeEach(boot);

    it('returns to the previous section instead of leaving the dashboard', async () => {
        clickTab('welcome');
        await settle();
        clickTab('farewell');
        await settle();
        expect(active()).toBe('farewell');

        await back();
        expect(location.hash).toBe('#welcome');
        expect(active()).toBe('welcome');
    });

    it('walks all the way back to the section the page opened on', async () => {
        const landed = active();
        clickTab('welcome');
        await settle();
        clickTab('farewell');
        await settle();

        await back();
        await back();
        expect(location.hash).toBe('');
        expect(active()).toBe(landed);
    });

    // Writing to history from the popstate handler would append the entry the
    // reader just stepped off, and Back would stop going anywhere.
    it('does not grow the history it is walking', async () => {
        clickTab('welcome');
        await settle();
        clickTab('farewell');
        await settle();
        const length = history.length;

        await back();
        expect(history.length).toBe(length);
    });

    it('goes forward again', async () => {
        clickTab('welcome');
        await settle();
        clickTab('farewell');
        await settle();
        await back();
        expect(active()).toBe('welcome');

        await new Promise(resolve => {
            window.addEventListener('popstate', async () => { await settle(); resolve(); }, { once: true });
            window.history.forward();
        });
        expect(active()).toBe('farewell');
    });
});

// '#knowledgebase' is a place inside the AI panel, so arriving at it — or
// coming back to it — has to open 'ai' and then the tab within it, and must
// not rewrite the hash to '#ai' on the way.
describe('a hash that names an inner tab', () => {
    it('opens the panel and the tab inside it, keeping the hash', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        window.history.pushState(null, '', `/dashboard/guild/1?t=${Math.random()}#knowledgebase`);
        document.body.innerHTML = '';
        bootPage();
        await settle();
        await settle();

        expect(active()).toBe('ai');
        expect(location.hash).toBe('#knowledgebase');
        expect(document.getElementById('ai-knowledgebase').classList.contains('active')).toBe(true);
    });

    // The reader is already here; an entry for it would put a Back press
    // between them and the page they actually came from.
    it('replaces rather than pushes the entry it arrived on', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        window.history.pushState(null, '', `/dashboard/guild/1?t=${Math.random()}#welcome`);
        const before = history.length;
        document.body.innerHTML = '';
        bootPage();
        await settle();
        await settle();

        expect(active()).toBe('welcome');
        expect(history.length).toBe(before);
    });
});
