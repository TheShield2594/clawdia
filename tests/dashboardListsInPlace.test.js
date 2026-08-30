/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #689. Adding or removing one RSS feed, and publishing or deleting one
 * reaction-role panel, each answered with `location.reload()` — re-downloading
 * and re-parsing the whole ~450 KB settings page to show a single row appear or
 * disappear. All four now patch their list from the mutation's own response.
 *
 * The list markup exists twice, once in the panel's EJS and once in the
 * renderer here, so the interesting assertion is not "a row appeared" but "the
 * row matches what a reload would have produced". Each test therefore compares
 * the patched list against the server-rendered one for the same data.
 */
const { bootPage, renderPanel, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');
const { guildSettingsLocals } = require('./helpers/guildSettingsLocals');
const { groupReactionRolePanels } = require('../src/dashboard/lib/reactionRolePanels');

// The panel templates read a dozen keys off `settings`; overriding the object
// wholesale would leave the rest undefined, so each case merges into the base.
const BASE_SETTINGS = guildSettingsLocals().settings;

const CHANNEL_ID = '10';          // "general" in the test locals
const ROLE_ID = '40';             // "Member"
const FEED_URL = 'https://example.com/feed.xml';

/** The API responses each mutation is answered with, keyed by URL fragment. */
let apiResponses;

function stubApi() {
    const realFetch = window.fetch;
    window.fetch = jest.fn(async (url, init) => {
        const key = Object.keys(apiResponses).find(fragment => String(url).includes(fragment));
        if (key) {
            const entry = apiResponses[key];
            entry.calls.push({ url: String(url), init });
            return { ok: entry.ok !== false, status: entry.ok === false ? 400 : 200, json: async () => entry.body };
        }
        return realFetch(url, init);
    });
}

/** Renders a panel through EJS with the same data, for a like-for-like diff. */
function serverRendered(panel, overrides) {
    const holder = document.createElement('div');
    holder.innerHTML = renderPanel(panel, overrides);
    return holder;
}

// EJS indents its output and the DOM renderer emits none, so the whitespace
// *between* tags is the one difference that is not a difference. Whitespace
// inside a tag's text is left alone — "→ #general" has to survive intact.
const markup = el => el.innerHTML.replace(/>\s+</g, '><').trim();

/** Clicks the confirm dialog's OK button and lets the promise settle. */
async function confirmDialog() {
    await settle();
    document.getElementById('confirm-modal-ok').dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle();
}

function clickAction(action) {
    const button = document.querySelector(`[data-action="${action}"]`);
    expect(button).not.toBeNull();
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
}

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    apiResponses = {};
    document.body.innerHTML = '';
    bootPage();
    stubApi();
});

afterEach(() => {
    forgetDocumentListeners();
    jest.restoreAllMocks();
});

describe('nothing reloads the page any more', () => {
    it('is gone from the script entirely', () => {
        const fs = require('fs');
        const path = require('path');
        const script = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'dashboard', 'public', 'guild-settings.js'), 'utf8');
        // Comments explaining what was removed are fine, and there are several,
        // so they come out before the search. Crude — it takes the `//` out of
        // a URL in a string too — which costs nothing here, since what is being
        // looked for is a call.
        const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/location\.reload\s*\(/);
    });
});

describe('RSS feeds', () => {
    beforeEach(async () => {
        clickTab('rss');
        await settle();
    });

    it('starts on the empty state the panel renders', () => {
        expect(document.querySelector('#rss-feeds .empty-state h3').textContent).toBe('No feeds yet');
    });

    it('adds a row without reloading, and matches what a reload would render', async () => {
        apiResponses['/rss/add'] = { calls: [], body: { success: true, feeds: [{ url: FEED_URL, channelId: CHANNEL_ID }] } };

        document.getElementById('rss-url').value = FEED_URL;
        document.getElementById('rss-channel').value = CHANNEL_ID;
        await window.addRssFeed();

        const row = document.querySelector('#rss-feeds .list-item');
        expect(row).not.toBeNull();
        expect(row.querySelector('.url').textContent).toBe(FEED_URL);
        // Resolved through the bootstrap's channel map, not left as a snowflake.
        expect(row.querySelector('.rss-feed-target').textContent).toBe('→ #general');
        expect(document.querySelector('#rss-feeds .empty-state')).toBeNull();

        const expected = serverRendered('rss', { settings: { ...BASE_SETTINGS, rssFeeds: [{ url: FEED_URL, channelId: CHANNEL_ID }] } });
        expect(markup(document.getElementById('rss-feeds'))).toBe(markup(expected.querySelector('#rss-feeds')));
    });

    it('empties the fields, so the feed just added cannot be added twice', async () => {
        apiResponses['/rss/add'] = { calls: [], body: { success: true, feeds: [{ url: FEED_URL, channelId: CHANNEL_ID }] } };

        document.getElementById('rss-url').value = FEED_URL;
        document.getElementById('rss-channel').value = CHANNEL_ID;
        await window.addRssFeed();

        expect(document.getElementById('rss-url').value).toBe('');
        expect(document.getElementById('rss-channel').value).toBe('');
    });

    it('renumbers the remaining rows, so the next Remove deletes the right feed', async () => {
        const three = [
            { url: 'https://a.example/feed', channelId: CHANNEL_ID },
            { url: 'https://b.example/feed', channelId: CHANNEL_ID },
            { url: 'https://c.example/feed', channelId: CHANNEL_ID },
        ];
        window.renderRssFeeds(three);
        expect([...document.querySelectorAll('#rss-feeds [data-action="rss-remove"]')].map(b => b.dataset.index))
            .toEqual(['0', '1', '2']);

        // Removing the first feed leaves b and c at positions 0 and 1. Before
        // this change the page reloaded and the server renumbered them; a list
        // patched in place that kept the old indices would delete c on the next
        // click of what is now b's button.
        apiResponses['/rss/'] = { calls: [], body: { success: true, feeds: three.slice(1) } };
        clickAction('rss-remove');
        await confirmDialog();

        expect(apiResponses['/rss/'].calls[0].url).toMatch(/\/rss\/0$/);
        const rows = [...document.querySelectorAll('#rss-feeds .list-item')];
        expect(rows.map(r => r.querySelector('.url').textContent)).toEqual(['https://b.example/feed', 'https://c.example/feed']);
        expect(rows.map(r => r.querySelector('[data-action="rss-remove"]').dataset.index)).toEqual(['0', '1']);
    });

    it('comes back to the empty state when the last feed goes', async () => {
        window.renderRssFeeds([{ url: FEED_URL, channelId: CHANNEL_ID }]);
        apiResponses['/rss/'] = { calls: [], body: { success: true, feeds: [] } };

        clickAction('rss-remove');
        await confirmDialog();

        expect(document.querySelector('#rss-feeds .empty-state h3').textContent).toBe('No feeds yet');
    });

    it('leaves the list alone when the mutation fails', async () => {
        window.renderRssFeeds([{ url: FEED_URL, channelId: CHANNEL_ID }]);
        apiResponses['/rss/'] = { calls: [], ok: false, body: { error: 'No feed at that position. Reload the page and try again.' } };

        clickAction('rss-remove');
        await confirmDialog();

        // A failed delete must not drop the row: the feed is still subscribed.
        expect(document.querySelectorAll('#rss-feeds .list-item')).toHaveLength(1);
    });

    it('puts a feed URL in as text, never as markup', () => {
        window.renderRssFeeds([{ url: '<img src=x onerror=alert(1)>', channelId: CHANNEL_ID }]);
        const url = document.querySelector('#rss-feeds .url');
        expect(url.querySelector('img')).toBeNull();
        expect(url.textContent).toBe('<img src=x onerror=alert(1)>');
    });
});

describe('reaction role panels', () => {
    const panel = { messageId: '333444555666777888', channelId: CHANNEL_ID, mappings: [{ emoji: '👍', roleId: ROLE_ID }] };
    const flatRows = [{ messageId: panel.messageId, channelId: CHANNEL_ID, emoji: '👍', roleId: ROLE_ID }];

    beforeEach(async () => {
        clickTab('reactionroles');
        await settle();
    });

    it('starts on the empty state the panel renders', () => {
        expect(document.querySelector('#rr-panels-list .empty-state h3').textContent).toBe('No reaction role panels yet');
    });

    it('adds the card without reloading, and matches what a reload would render', async () => {
        apiResponses['/reactionrole/panel'] = { calls: [], body: { success: true, messageId: panel.messageId, panels: [panel] } };

        document.getElementById('rr-channel').value = CHANNEL_ID;
        window.addRrMapping();
        document.querySelector('#rr-mappings-list .rr-emoji').value = '👍';
        document.querySelector('#rr-mappings-list .rr-role').value = ROLE_ID;
        await window.publishRrPanel();

        const card = document.querySelector('#rr-panels-list .store-card');
        expect(card).not.toBeNull();
        expect(card.querySelector('.store-card-name').textContent).toBe('#general');
        expect(card.querySelector('.store-meta-tag').textContent).toBe('👍 → @Member');
        expect(card.querySelector('.rr-panel-message-id').textContent).toBe(`Message ID: ${panel.messageId}`);

        const expected = serverRendered('reactionroles', {
            settings: { ...BASE_SETTINGS, reactionRoles: flatRows },
            reactionRolePanels: groupReactionRolePanels(flatRows),
        });
        expect(markup(document.getElementById('rr-panels-list'))).toBe(markup(expected.querySelector('#rr-panels-list')));
    });

    it('empties the create form, so a second click cannot publish a duplicate', async () => {
        apiResponses['/reactionrole/panel'] = { calls: [], body: { success: true, messageId: panel.messageId, panels: [panel] } };

        document.getElementById('rr-channel').value = CHANNEL_ID;
        document.getElementById('rr-title').value = 'Roles';
        document.getElementById('rr-description').value = 'Pick one';
        window.addRrMapping();
        document.querySelector('#rr-mappings-list .rr-emoji').value = '👍';
        document.querySelector('#rr-mappings-list .rr-role').value = ROLE_ID;
        await window.publishRrPanel();

        expect(document.getElementById('rr-channel').value).toBe('');
        expect(document.getElementById('rr-title').value).toBe('');
        expect(document.getElementById('rr-description').value).toBe('');
        expect(document.getElementById('rr-mappings-list').children).toHaveLength(0);
    });

    it('deletes through the delegated button and redraws from the response', async () => {
        window.renderRrPanels([panel]);
        apiResponses['/reactionrole/panel/'] = { calls: [], body: { success: true, panels: [] } };

        clickAction('rr-panel-delete');
        await confirmDialog();

        expect(apiResponses['/reactionrole/panel/'].calls[0].url).toContain(panel.messageId);
        expect(document.querySelector('#rr-panels-list .empty-state h3').textContent).toBe('No reaction role panels yet');
    });

    it('leaves the list alone when the delete fails', async () => {
        window.renderRrPanels([panel]);
        apiResponses['/reactionrole/panel/'] = { calls: [], ok: false, body: { error: 'Internal server error' } };

        clickAction('rr-panel-delete');
        await confirmDialog();

        expect(document.querySelectorAll('#rr-panels-list .store-card')).toHaveLength(1);
    });

    it('puts an emoji field in as text, never as markup', () => {
        window.renderRrPanels([{ ...panel, mappings: [{ emoji: '<b>x</b>', roleId: ROLE_ID }] }]);
        const tag = document.querySelector('#rr-panels-list .store-meta-tag');
        expect(tag.querySelector('b')).toBeNull();
        expect(tag.textContent).toBe('<b>x</b> → @Member');
    });
});

describe('groupReactionRolePanels', () => {
    it('collects one entry per message, in the order the rows were stored', () => {
        expect(groupReactionRolePanels([
            { messageId: 'm1', channelId: 'c1', emoji: '👍', roleId: 'r1' },
            { messageId: 'm2', channelId: 'c2', emoji: '🎉', roleId: 'r2' },
            { messageId: 'm1', channelId: 'c1', emoji: '👎', roleId: 'r3' },
        ])).toEqual([
            { messageId: 'm1', channelId: 'c1', mappings: [{ emoji: '👍', roleId: 'r1' }, { emoji: '👎', roleId: 'r3' }] },
            { messageId: 'm2', channelId: 'c2', mappings: [{ emoji: '🎉', roleId: 'r2' }] },
        ]);
    });

    it('answers with an empty list for nothing at all', () => {
        expect(groupReactionRolePanels(undefined)).toEqual([]);
        expect(groupReactionRolePanels([])).toEqual([]);
    });
});
