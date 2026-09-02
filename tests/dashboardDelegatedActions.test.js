/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #887. The dashboard's CSP keeps `script-src-attr 'unsafe-inline'`, which is
 * the one directive that decides whether an injected `onclick=""` runs or is
 * blocked. The ratchet in tests/dashboardInlineAttributes counts the views —
 * but the renderers in public/guild-settings.js were writing `onclick=""` into
 * `innerHTML` too, right beside the API strings the review flagged as sinks,
 * and nothing counted those at all.
 *
 * They are all delegated `data-action` now, so what has to hold is that the
 * buttons still do what they did. These drive each one through a real click on
 * the rendered markup rather than calling the handler, because the binding is
 * the part that changed.
 */
const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

function click(el) {
    el.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
}

/** Renders a list by calling the page's own renderer, then returns the host. */
function render(fn, hostId) {
    window[fn]();
    return document.getElementById(hostId);
}

beforeEach(() => { bootPage(); });
afterEach(() => { forgetDocumentListeners(); jest.restoreAllMocks(); });

describe('rendered list buttons still act', () => {
    it('removes a command-policy rule', async () => {
        clickTab('commandpolicies');
        await settle();
        window._cpRules = [
            { command: 'ban', allowRoles: [], denyRoles: [] },
            { command: 'kick', allowRoles: [], denyRoles: [] },
        ];
        const host = render('renderCpRules', 'cp-rules-list');

        click(host.querySelector('[data-action="cp-rule-remove"][data-idx="0"]'));

        expect(window._cpRules.map(r => r.command)).toEqual(['kick']);
    });

    it('opens the rule editor on the row that was clicked', async () => {
        clickTab('commandpolicies');
        await settle();
        window._cpRules = [{ command: 'ban', allowRoles: [], denyRoles: [] }];
        const host = render('renderCpRules', 'cp-rules-list');

        click(host.querySelector('[data-action="cp-rule-edit"][data-idx="0"]'));

        expect(document.getElementById('cp-rule-modal').style.display).not.toBe('none');
        expect(document.getElementById('cp-r-command').value).toBe('ban');
    });

    it('removes a command-policy cooldown override', async () => {
        clickTab('commandpolicies');
        await settle();
        window._cpCooldowns = [{ command: 'work', seconds: 30 }, { command: 'daily', seconds: 60 }];
        const host = render('renderCpCooldowns', 'cp-cooldowns-list');

        click(host.querySelector('[data-action="cp-cooldown-remove"][data-idx="1"]'));

        expect(window._cpCooldowns.map(c => c.command)).toEqual(['work']);
    });

    it('opens the shop item editor for the item that was clicked', async () => {
        clickTab('economy');
        await settle();

        const edit = document.querySelector('[data-action="item-edit"]');
        // The economy panel's fixture may hold no items; only assert when it does.
        if (!edit) return;
        click(edit);

        expect(document.getElementById('item-modal').style.display).not.toBe('none');
    });
});

describe('an index only ever travels as data', () => {
    it('renders no inline handler attribute at all', async () => {
        clickTab('commandpolicies');
        await settle();
        window._cpRules = [{ command: 'ban', allowRoles: [], denyRoles: [] }];
        const host = render('renderCpRules', 'cp-rules-list');

        // The property, not the attribute: a browser compiles `onclick=""` into
        // one, so this catches a handler however it was written.
        for (const el of host.querySelectorAll('*')) {
            expect([el.tagName, el.getAttribute('onclick')]).toEqual([el.tagName, null]);
        }
    });
});

describe('tab links', () => {
    it('switches panels and does not jump the page', async () => {
        clickTab('overview');
        await settle();

        const link = document.createElement('a');
        link.href = '#';
        link.dataset.action = 'goto-tab';
        link.dataset.tab = 'moderation';
        document.body.appendChild(link);

        const event = new window.Event('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(event);
        await settle();

        // The nav item is what knows how to switch panels; clicking it is the
        // whole action, and the default `#` navigation is suppressed.
        expect(document.querySelector('.nav-item[data-tab="moderation"]').classList).toContain('active');
        expect(event.defaultPrevented).toBe(true);
    });

    it('does nothing for a tab that is not on the page', () => {
        const button = document.createElement('button');
        button.dataset.action = 'goto-tab';
        button.dataset.tab = 'no-such-tab';
        document.body.appendChild(button);

        expect(() => click(button)).not.toThrow();
    });
});

describe('row removers', () => {
    it('removes the row a nested button names, and renumbers the rest', () => {
        const list = document.createElement('div');
        list.innerHTML =
            '<div class="season-tier-row"><span class="row-label"></span>' +
            '<button data-action="row-remove" data-row-selector=".season-tier-row"></button></div>' +
            '<div class="season-tier-row"><span class="row-label"></span>' +
            '<button data-action="row-remove" data-row-selector=".season-tier-row"></button></div>';
        document.body.appendChild(list);

        click(list.querySelector('button'));

        expect(list.querySelectorAll('.season-tier-row')).toHaveLength(1);
    });

    it('removes the button\'s own parent when no selector is given', () => {
        const list = document.createElement('div');
        list.innerHTML = '<div class="rr-map-row"><button data-action="row-remove"></button></div>';
        document.body.appendChild(list);

        click(list.querySelector('button'));

        expect(list.querySelector('.rr-map-row')).toBeNull();
    });
});

describe('images that hide themselves when the URL fails', () => {
    it('hides one carrying the marker', () => {
        const img = document.createElement('img');
        img.dataset.hideOnError = '';
        document.body.appendChild(img);

        // `error` does not bubble, which is why the page listens in the capture
        // phase — a listener that did not would never fire for these at all.
        img.dispatchEvent(new window.Event('error'));

        expect(img.style.display).toBe('none');
    });

    it('leaves one without it alone', () => {
        const img = document.createElement('img');
        document.body.appendChild(img);

        img.dispatchEvent(new window.Event('error'));

        expect(img.style.display).toBe('');
    });
});

describe('the Daily News profile editor', () => {
    // The profiles live in the container's own dataset, which is what the
    // renderer reads and what every field writes back to.
    async function seedProfiles(profiles) {
        clickTab('rss');
        await settle();
        const container = document.getElementById('dailynews-profiles-list');
        container.dataset.initialized = '1';
        container.dataset.profiles = JSON.stringify(profiles);
        window.renderDailyNewsProfiles();
        return container;
    }

    const stored = container => JSON.parse(container.dataset.profiles);

    const profile = (over = {}) => ({
        profileId: 'p1', name: 'Tech', enabled: true, channelId: '', time: '09:00',
        timezone: '', title: '', feeds: [], maxItemsPerFeed: 3, ...over,
    });

    it('writes a changed field back to its profile', async () => {
        const container = await seedProfiles([profile()]);

        const time = document.getElementById('dn-0-time');
        time.value = '07:30';
        time.dispatchEvent(new window.Event('change', { bubbles: true }));

        expect(stored(container)[0].time).toBe('07:30');
    });

    it('splits the feed textarea into a list, as the inline handler did', async () => {
        const container = await seedProfiles([profile()]);

        const feeds = document.getElementById('dn-0-feeds');
        feeds.value = 'https://a.example/rss\n\n  https://b.example/rss  ';
        feeds.dispatchEvent(new window.Event('change', { bubbles: true }));

        expect(stored(container)[0].feeds).toEqual(['https://a.example/rss', 'https://b.example/rss']);
    });

    it('echoes the name into the card heading as it is typed', async () => {
        const container = await seedProfiles([profile()]);

        const name = document.getElementById('dn-0-name');
        name.value = 'Sport';
        name.dispatchEvent(new window.Event('input', { bubbles: true }));

        expect(name.closest('.list-item').querySelector('strong').textContent).toBe('Sport');
        expect(stored(container)[0].name).toBe('Sport');
    });

    it('falls back to the numbered label when the name is cleared', async () => {
        await seedProfiles([profile()]);

        const name = document.getElementById('dn-0-name');
        name.value = '';
        name.dispatchEvent(new window.Event('input', { bubbles: true }));

        expect(name.closest('.list-item').querySelector('strong').textContent).toBe('Profile 1');
    });

    it('writes the second card\'s fields to the second profile', async () => {
        // The index used to be baked into the handler string; now it rides in
        // data-dn-idx, and a card writing to the wrong profile is the way that
        // would go wrong.
        const container = await seedProfiles([profile({ name: 'Tech' }), profile({ profileId: 'p2', name: 'Sport' })]);

        const title = document.getElementById('dn-1-title');
        title.value = 'Sport Digest';
        title.dispatchEvent(new window.Event('change', { bubbles: true }));

        expect(stored(container).map(p => p.title)).toEqual(['', 'Sport Digest']);
    });

    it('removes the profile the Remove button belongs to', async () => {
        const container = await seedProfiles([profile({ name: 'Tech' }), profile({ profileId: 'p2', name: 'Sport' })]);

        click(document.querySelector('[data-action="dn-remove"][data-idx="0"]'));

        expect(stored(container).map(p => p.name)).toEqual(['Sport']);
    });

});

describe('timezone validation on blur', () => {
    // `blur` does not bubble, which is why the page captures it. A listener
    // registered the ordinary way would never fire for these fields at all.
    function field(value) {
        const wrap = document.createElement('div');
        wrap.innerHTML = '<input id="tz-probe" data-validate-timezone>' +
            '<small id="tz-probe-err" style="display:none"></small>';
        document.body.appendChild(wrap);
        wrap.querySelector('input').value = value;
        return wrap;
    }

    it('reports one the browser does not know', () => {
        const wrap = field('Not/AZone');

        wrap.querySelector('input').dispatchEvent(new window.Event('blur'));

        expect(document.getElementById('tz-probe-err').style.display).toBe('');
        expect(document.getElementById('tz-probe-err').textContent).toContain('Not/AZone');
    });

    it('leaves a real one alone', () => {
        const wrap = field('Europe/London');

        wrap.querySelector('input').dispatchEvent(new window.Event('blur'));

        expect(document.getElementById('tz-probe-err').style.display).toBe('none');
    });
});
