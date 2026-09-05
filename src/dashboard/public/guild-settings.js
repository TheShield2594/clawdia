// The guild settings page's shell (#935).
//
// What is left when each panel's behaviour moved into a panel-*.js of its own:
// the sidebar and its search, the tab routing and the history entries behind
// it, saving a section, and the unsaved-changes tracking that decides when a
// section is clean. Nothing here belongs to one panel, and nothing here names
// one — a panel's contribution arrives through the registries in
// dashboard-core.js.
//
// Loaded last, which is load-bearing rather than tidiness (see the order in
// views/guild-settings.ejs). onPanel() runs a callback immediately for the
// panel that shipped with the page, and several panels render into it as they
// load; the baseline at the bottom of this file has to be taken after all of
// that, or every list they drew would read as an unsaved edit.

// ── Sidebar tab navigation ────────────────────────────────────────────
const navItems = document.querySelectorAll('.nav-item');
const topbarSection = document.getElementById('topbar-section');

// The nav items used to be plain <li> elements that this file dressed up at
// runtime: role="button" and tabindex injected onto each one, plus a keydown
// handler standing in for Enter and Space. That stripped `listitem` off the
// <ul>'s children — role="button" replaces the implicit role rather than
// adding to it — and left the whole nav inert to the keyboard if the script
// failed to load. They are <button> elements in the markup now, so the roles,
// the focusability and the key handling are all the browser's (#660).
//
// The state they carry is aria-current="page", not aria-pressed: these select
// which section is being viewed, which is not the same claim as a toggle
// button being held down.
const mainContent = document.getElementById('dash-main-content');

// ── Narrow-viewport nav toggle (#674) ────────────────────────────────
// Below 768px the sidebar stops being a column beside the content and becomes
// a block on top of it, so the 25 nav items, the search box and the user
// footer all sat between the reader and the panel they had just opened — on
// every visit, in both directions, because picking a section from the top of
// the page leaves the settings below the fold.
//
// So on a narrow viewport the nav starts folded and the reader unfolds it to
// move. The width is the same 768px the stylesheet stacks at, and it is asked
// rather than assumed: a tablet turned sideways crosses it mid-session, and
// the toggle has to disappear again when it does — a hidden nav with no
// control to open it is the one state this must never leave behind.
//
// Nothing here runs without matchMedia: `media()` answers null, `isNarrow`
// reads false, the button stays `hidden`, and the sidebar keeps the shape it
// has always had.
const dashSide = document.querySelector('.dash-side');
const navToggle = document.getElementById('dash-nav-toggle');
const narrowViewport = media('(max-width: 768px)');

function isNarrow() {
    return !!narrowViewport?.matches;
}

function setNavOpen(open) {
    if (!dashSide) return;
    dashSide.classList.toggle('nav-collapsed', !open);
    if (navToggle) navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** Fold the nav away after the reader has chosen where to go. Narrow only. */
function collapseNavAfterNavigation() {
    if (!isNarrow() || !dashSide || dashSide.classList.contains('nav-collapsed')) return;
    setNavOpen(false);
    // The nav was the top of the page and is now gone, so without this the
    // reader is left scrolled to where it used to be — which is now somewhere
    // in the middle of the panel. Focus has already moved to the main content
    // with preventScroll, precisely so this is the call that decides where the
    // page lands. jsdom has no scrollIntoView, and neither did the browsers
    // that would not have got here anyway.
    if (mainContent && typeof mainContent.scrollIntoView === 'function') {
        mainContent.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
}

function syncNavToggle() {
    const narrow = isNarrow();
    if (navToggle) navToggle.hidden = !narrow;
    // Widening puts the nav back unconditionally: at desktop width the
    // collapsed class would hide a column that has no control to restore it.
    setNavOpen(!narrow);
}

if (navToggle && dashSide && narrowViewport) {
    navToggle.addEventListener('click', () => {
        setNavOpen(dashSide.classList.contains('nav-collapsed'));
    });
    // A plain addEventListener, with no `addListener` fallback beside it any
    // more. That fallback was for the Safari versions whose MediaQueryList was
    // an EventTarget in name only, and unlike the matchMedia guard above it was
    // genuinely reachable — those browsers parse this file's ES2020 without
    // complaint. It is dropped on the support floor rather than on the syntax:
    // that band is years below anything that also runs Discord, and a fallback
    // nobody here can test is one that rots in place (#948).
    narrowViewport.addEventListener('change', syncNavToggle);
    syncNavToggle();
}

// The section the server rendered active, which is what a Back press onto the
// entry the page loaded on has to restore.
const INITIAL_TAB = document.querySelector('.panel.active')?.id || null;

// The tab the reader last asked for. A panel that is still being fetched when
// the reader moves on must not steal the view when it finally arrives.
let requestedTab = INITIAL_TAB;

// The hashes that name an inner tab rather than a panel, and the panel each one
// lives in. '#knowledgebase' is a place in the AI panel, so arriving at it — or
// coming back to it — has to open 'ai' and then the tab inside it.
const INNER_TO_PARENT = { knowledgebase: 'ai', aisummaries: 'ai', aipersonas: 'ai', dailynews: 'rss' };
const AI_INNER_TABS = { knowledgebase: 'ai-knowledgebase', aisummaries: 'ai-summaries', aipersonas: 'ai-personas' };
const RSS_INNER_TABS = { dailynews: 'rss-tab-dailynews' };

/**
 * Record a section change in the browser's history.
 *
 * Every section change used to be a replaceState (#679), so the whole
 * dashboard occupied a single history entry: Back from the tenth panel a
 * reader had opened left the dashboard altogether rather than returning to the
 * ninth. Pushing gives each section an entry, which is what the button is for.
 *
 * Still replaced, not pushed, when the URL would not change — re-clicking the
 * section already open, or opening the panel that an inner tab's hash already
 * points into. Neither is a place a reader could come back to, and an entry
 * that restores what is already on screen is a Back press that does nothing.
 */
function writeTabHash(tab, mode) {
    if (!window.history || !history.pushState) return;
    const curInner = location.hash.slice(1);
    const newHash = (INNER_TO_PARENT[curInner] === tab) ? location.hash : '#' + tab;
    if (mode === 'push' && newHash !== location.hash) history.pushState(null, '', newHash);
    else history.replaceState(null, '', newHash);
}

/**
 * Show a section.
 *
 * `historyMode` is 'push' for a section the reader just chose, 'replace' for
 * the one the URL already named on arrival, and 'none' when the browser is
 * already doing the navigating and writing to history would fight it.
 */
async function activateTab(tab, { historyMode = 'push' } = {}) {
    if (!tab) return null;
    const item = document.querySelector(`.nav-item[data-tab="${CSS.escape(tab)}"]`);
    if (!item) return null;
    requestedTab = tab;

    navItems.forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
    document.querySelectorAll('.panel').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
    document.querySelectorAll('.panel-stub').forEach(p => { p.style.display = 'none'; });
    item.classList.add('active');
    item.setAttribute('aria-current', 'page');
    if (topbarSection) topbarSection.textContent = item.querySelector('span:last-child')?.textContent || tab;
    if (historyMode !== 'none') writeTabHash(tab, historyMode);

    // Leave the stub on screen while its markup is in flight, so the main area
    // shows "Loading…" rather than going blank.
    const stub = panelStub(tab);
    if (stub) {
        const message = stub.querySelector('.panel-stub-message');
        if (message) message.textContent = 'Loading…';
        stub.style.display = 'block';
    }

    const panel = await loadPanel(tab);
    if (requestedTab !== tab) {
        // The reader moved on while this was in flight; land it out of sight.
        if (stub && stub.isConnected) stub.style.display = 'none';
        if (panel) panel.style.display = 'none';
        return panel;
    }
    if (panel) { panel.classList.add('active'); panel.style.display = 'block'; }
    announceShown(tab);
    return panel;
}

navItems.forEach(item => {
    item.addEventListener('click', async () => {
        // Land the reader in the section they just opened. Without this, a
        // keyboard user picking the last item in the sidebar has to tab back
        // through every item below it to reach the settings — 25 stops on
        // every visit. `preventScroll` keeps the mouse path unchanged, and the
        // target is tabindex="-1", so this adds no tab stop of its own.
        if (mainContent && document.activeElement === item) {
            mainContent.focus({ preventScroll: true });
        }
        // Then fold the sidebar away, on a narrow viewport (#674) — before the
        // panel is fetched, not after, so the fold is not left waiting on a
        // network round trip. Strictly after the focus move above: folding
        // first would hide `item` while it is still the active element, and
        // the browser would drop focus to the body rather than hand it on.
        collapseNavAfterNavigation();
        await activateTab(item.dataset.tab);
    });
});

// Module card click-to-navigate. Delegated, because the cards sit inside a panel.
document.addEventListener('click', e => {
    const card = e.target.closest && e.target.closest('.dash-module[data-tab-link]');
    if (card) activateTab(card.dataset.tabLink);
});

// Hide all panels except the active one on load
document.querySelectorAll('.panel').forEach(p => {
    if (!p.classList.contains('active')) p.style.display = 'none';
});

// The selected state of an inner tab, in the three places it has to agree:
// the class the stylesheet paints from, the `aria-selected` a screen reader
// reads, and the roving tabindex that keeps one tab stop per strip (#909).
// The markup ships all three already set, so this only has to keep them in
// step as the reader moves around.
function markInnerTab(tab, selected) {
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.setAttribute('tabindex', selected ? '0' : '-1');
}

// AI inner tab navigation
function switchAiInnerTab(tabId) {
    document.querySelectorAll('#ai .ai-inner-tab').forEach(t => markInnerTab(t, false));
    document.querySelectorAll('#ai .ai-inner-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`.ai-inner-tab[data-ai-tab="${tabId}"]`);
    const panel = document.getElementById(tabId);
    if (btn) markInnerTab(btn, true);
    if (panel) panel.classList.add('active');
    announceShown(tabId);
}

// RSS inner tab navigation
function switchRssInnerTab(tabId) {
    document.querySelectorAll('.rss-inner-tab').forEach(t => markInnerTab(t, false));
    document.querySelectorAll('#rss .ai-inner-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`.rss-inner-tab[data-rss-tab="${tabId}"]`);
    const panel = document.getElementById(tabId);
    if (btn) markInnerTab(btn, true);
    if (panel) panel.classList.add('active');
    announceShown(tabId);
}

// Game inner tab navigation (Hunt / Fish / Mine)
function makeGameTabSwitcher(tabClass, panelSelector, dataAttr) {
    return function switchTab(tabId) {
        document.querySelectorAll('.' + tabClass).forEach(t => markInnerTab(t, false));
        document.querySelectorAll(panelSelector).forEach(p => p.classList.remove('active'));
        const btn = document.querySelector('.' + tabClass + '[data-' + dataAttr + '="' + tabId + '"]');
        const panel = document.getElementById(tabId);
        if (btn) markInnerTab(btn, true);
        if (panel) panel.classList.add('active');
        announceShown(tabId);
    };
}
const switchEcoTab = makeGameTabSwitcher('eco-inner-tab', '#economy > .ai-inner-panel', 'eco-tab');
const switchModTab = makeGameTabSwitcher('mod-inner-tab', '#moderation .ai-inner-panel', 'mod-tab');
const switchHuntTab = makeGameTabSwitcher('hunt-inner-tab', '#eco-tab-hunt .ai-inner-panel', 'hunt-tab');
const switchFishTab = makeGameTabSwitcher('fish-inner-tab', '#eco-tab-fish .ai-inner-panel', 'fish-tab');
const switchMineTab = makeGameTabSwitcher('mine-inner-tab', '#eco-tab-mine .ai-inner-panel', 'mine-tab');

// Every inner tab sits inside a panel that may not exist yet, so they are wired
// by delegation rather than bound to the elements at load.
document.addEventListener('click', e => {
    const tab = e.target.closest && e.target.closest(
        '.ai-inner-tab[data-ai-tab], .rss-inner-tab, .eco-inner-tab, .mod-inner-tab, ' +
        '.hunt-inner-tab, .fish-inner-tab, .mine-inner-tab');
    if (!tab) return;
    // The economy, moderation and RSS tabs also carry the shared `ai-inner-tab`
    // class for styling, so the specific ones have to be matched first.
    const cls = tab.classList;
    if (cls.contains('rss-inner-tab')) {
        switchRssInnerTab(tab.dataset.rssTab);
    } else if (cls.contains('eco-inner-tab')) {
        switchEcoTab(tab.dataset.ecoTab);
    } else if (cls.contains('mod-inner-tab')) {
        switchModTab(tab.dataset.modTab);
    } else if (cls.contains('hunt-inner-tab')) {
        switchHuntTab(tab.dataset.huntTab);
    } else if (cls.contains('fish-inner-tab')) {
        switchFishTab(tab.dataset.fishTab);
    } else if (cls.contains('mine-inner-tab')) {
        switchMineTab(tab.dataset.mineTab);
    } else if (cls.contains('ai-inner-tab')) {
        switchAiInnerTab(tab.dataset.aiTab);
    }
});

// Arrow-key navigation within a tab strip (#909). A tablist is one tab stop:
// Tab reaches the selected tab, and Left/Right move between the tabs in that
// strip. Delegated for the same reason the click handler above is — the strip
// may not have been fetched yet. Nested strips (the hunt/fish/mine item
// categories inside Economy) resolve to the closest tablist, so an arrow press
// stays inside the strip the reader is actually in.
const INNER_TAB_KEYS = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
document.addEventListener('keydown', e => {
    const step = INNER_TAB_KEYS[e.key];
    if (step === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
    const tab = e.target.closest && e.target.closest('[role="tab"]');
    const strip = tab && tab.closest('[role="tablist"]');
    if (!strip) return;

    const tabs = [...strip.querySelectorAll(':scope > [role="tab"]')];
    const at = tabs.indexOf(tab);
    if (at === -1) return;

    let next;
    if (step === 'first') next = tabs[0];
    else if (step === 'last') next = tabs[tabs.length - 1];
    // Wraps at both ends, which is what a tablist is expected to do.
    else next = tabs[(at + step + tabs.length) % tabs.length];

    e.preventDefault();
    // Activate as well as focus: these panels are already in the document, so
    // there is nothing to be gained by making the reader press Enter as well.
    next.focus();
    next.dispatchEvent(new Event('click', { bubbles: true }));
});

// An inner tab can only be selected once its parent panel has arrived, which is
// why this awaits the panel before reaching into it.
async function routeToHash(hash, opts) {
    if (AI_INNER_TABS[hash]) {
        if (await activateTab('ai', opts)) switchAiInnerTab(AI_INNER_TABS[hash]);
    } else if (RSS_INNER_TABS[hash]) {
        if (await activateTab('rss', opts)) switchRssInnerTab(RSS_INNER_TABS[hash]);
    } else {
        await activateTab(hash, opts);
    }
}

// The section named in the URL on arrival. Replaced rather than pushed: the
// reader is already here, and an entry for it would put a Back press between
// them and the page they actually came from.
if (location.hash) routeToHash(location.hash.slice(1), { historyMode: 'replace' });

// Back and Forward. The browser has already moved the URL by the time this
// runs, so the section is read out of it and nothing is written back — a push
// here would append the entry the reader just stepped off, and Back would
// stop going anywhere.
//
// An entry with no hash is the one the page loaded on, whose section is
// whatever the server rendered active.
window.addEventListener('popstate', () => {
    const hash = location.hash.slice(1);
    if (hash) routeToHash(hash, { historyMode: 'none' });
    else if (INITIAL_TAB) activateTab(INITIAL_TAB, { historyMode: 'none' });
});

// ── Sidebar search ────────────────────────────────────────────────────
(function() {
    const search = document.getElementById('sidebar-search');
    if (!search) return;
    const sp = new URLSearchParams(location.search);
    if (sp.get('search')) { search.value = sp.get('search'); filterSidebarNav(sp.get('search')); }
    search.addEventListener('input', () => filterSidebarNav(search.value));
    search.addEventListener('keydown', e => { if (e.key === 'Escape') { search.value = ''; filterSidebarNav(''); search.blur(); } });
    document.addEventListener('keydown', e => {
        const active = document.activeElement;
        const inField = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
        if ((e.ctrlKey && e.key === 'k') || (!e.ctrlKey && !e.metaKey && !e.altKey && !inField && e.key === '/')) {
            e.preventDefault();
            search.focus();
            search.select();
        }
    });
})();

function filterSidebarNav(query) {
    const q = (query || '').trim().toLowerCase();
    const sp = new URLSearchParams(location.search);
    if (q) sp.set('search', q); else sp.delete('search');
    if (history.replaceState) {
        const qs = sp.toString();
        history.replaceState(null, '', qs ? '?' + qs + location.hash : location.pathname + location.hash);
    }
    const labels = document.querySelectorAll('.dash-nav-label');
    const noResults = document.getElementById('sidebar-no-results');
    if (!q) {
        document.querySelectorAll('.dash-nav li').forEach(li => li.style.display = '');
        labels.forEach(l => l.style.display = '');
        if (noResults) { noResults.style.display = 'none'; noResults.setAttribute('aria-hidden', 'true'); }
        return;
    }
    let anyVisible = false;
    labels.forEach(label => {
        const navList = label.nextElementSibling;
        if (!navList) return;
        let groupVisible = false;
        navList.querySelectorAll('.nav-item').forEach(item => {
            const text = item.textContent.toLowerCase();
            const keywords = (item.dataset.keywords || '').toLowerCase();
            const matches = text.includes(q) || keywords.includes(q);
            // Hide the <li>, not the button: `display: none` on the list item
            // takes the button out of the tab order and the accessibility tree
            // with it, and leaves the list itself intact.
            item.closest('li').style.display = matches ? '' : 'none';
            if (matches) { groupVisible = true; anyVisible = true; }
        });
        label.style.display = groupVisible ? '' : 'none';
    });
    if (noResults) {
        noResults.style.display = anyVisible ? 'none' : '';
        noResults.setAttribute('aria-hidden', anyVisible ? 'true' : 'false');
    }
}

registerPanelActions({
    click: {
        // One action, the section in a data attribute. `saveSettings` alone was
        // twenty-five `onclick=""` across twenty-five panels.
        'save': (el, d) => saveSettings(d.section),

        // A row builder's own delete button. `data-row-selector` names the row
        // when the button is nested inside it; without one the row is the
        // button's parent, which is what `this.parentElement.remove()` meant.
        // Not any one panel's: four of them build repeaters and all four use it.
        'row-remove': (el, d) => {
            const row = d.rowSelector ? el.closest(d.rowSelector) : el.parentElement;
            const list = row && row.parentElement;
            if (row) row.remove();
            // The rows are numbered "Reward 1, Reward 2, …" for screen readers,
            // so removing one in the middle renumbers the rest.
            if (list) labelRepeatedRows(list);
        },

        // Jumps to another settings tab. The nav item is the thing that knows
        // how to switch panels, so this clicks it rather than reimplementing
        // the switch.
        'goto-tab': (el, d, e) => {
            const nav = document.querySelector('.nav-item[data-tab="' + CSS.escape(d.tab || '') + '"]');
            if (nav) nav.click();
            // These are `<a href="#">` as often as buttons, and the inline
            // versions all ended in `return false` to stop the jump to the top
            // of the page.
            e.preventDefault();
        },
    },
});

// Returns true when the settings reached the server, false when they did not.
// The unsaved-changes tracking below reads it: a section is only clean once a
// save has actually succeeded, so a failed POST must leave the dirty mark up.
async function saveSettings(section) {
    const guildId = BOOT.guildId;

    const blocked = SAVE_GUARDS[section] ? await SAVE_GUARDS[section]() : null;
    if (blocked) {
        toast(blocked, 'error');
        return;
    }

    // Which fields a section sends lives in settings-payload.js, where it can be
    // tested against the server's key whitelist (#788).
    const data = buildSettingsPayload(section, payloadSources());

    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            toast(err.error || 'Failed to save settings', 'error');
            return false;
        }

        // Work the section is not finished without — economy's pending shop
        // item images are the only one. A message back means the settings
        // landed and this did not, which is not a clean save: the unsaved mark
        // stays up because the pending image is still unsaved work.
        const followUp = SAVE_FOLLOW_UPS[section] ? await SAVE_FOLLOW_UPS[section]() : null;
        if (followUp) {
            toast('Settings saved, but ' + followUp, 'error');
            return false;
        }

        toast('Settings saved', 'success');
        return true;
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
        return false;
    }
}

// ── Repeated-row remove buttons ────────────────────────────────────────────
//
// #670 again. A repeater's remove button is one glyph, and giving every row in
// a list the same "Remove this level reward" names none of them — a reader
// tabbing a five-row list hears the identical thing five times. So each one is
// named after what is in its own row.
//
// Which means the label cannot be written once. The values it names are the
// row's own editable fields, so a label saying "level 5" is worse than a
// generic one the moment the input says 12. These are rewritten whenever a row
// changes, and after a removal, because the fallback names a row by position.

const ROW_LABELLERS = {
    'level-reward': (row, position) => {
        const level = (row.querySelector('.level-reward-level')?.value || '').trim();
        return level
            ? `Remove the level ${level} reward`
            : `Remove reward row ${position}, which has no level set`;
    },
    'season-tier': (row, position) => {
        const tier = (row.querySelector('.season-tier-num')?.value || '').trim();
        return tier
            ? `Remove the tier ${tier} reward`
            : `Remove tier row ${position}, which has no tier set`;
    },
    'rr-mapping': (row, position) => {
        const emoji  = (row.querySelector('.rr-emoji')?.value || '').trim();
        const select = row.querySelector('.rr-role');
        const role   = select?.value ? select.options[select.selectedIndex].text : '';
        if (!emoji && !role) return `Remove mapping row ${position}, which is empty`;
        return `Remove the ${emoji || 'no emoji'} → ${role || 'no role'} mapping`;
    },
};

/** Renames every remove button in one repeater after its own row's contents. */
function labelRepeatedRows(list) {
    if (!list) return;
    Array.from(list.children).forEach((row, index) => {
        const button = row.querySelector('[data-row-remove]');
        const label  = button && ROW_LABELLERS[button.dataset.rowRemove];
        if (label) button.setAttribute('aria-label', label(row, index + 1));
    });
}

/** Every repeater on the page, wherever an edit or a removal landed. */
function labelAllRepeatedRows() {
    document.querySelectorAll('[data-row-list]').forEach(labelRepeatedRows);
}

// Capture, so a label still follows the edit if something downstream stops the
// event — the same reasoning as the unsaved-changes tracker below.
document.addEventListener('input', e => {
    const list = e.target?.closest?.('[data-row-list]');
    if (list) labelRepeatedRows(list);
}, true);
document.addEventListener('change', e => {
    const list = e.target?.closest?.('[data-row-list]');
    if (list) labelRepeatedRows(list);
}, true);
// Adding or removing a row fires neither input nor change, and a removal
// renumbers everything after it. The click is the signal; the list it left
// behind exists a tick later, which is why the row is read from the event
// rather than from the button — by then the button's row is detached.
document.addEventListener('click', e => {
    if (!e.target?.closest?.('[data-row-list]')) return;
    setTimeout(labelAllRepeatedRows, 0);
}, true);

onPanel('leveling',      () => labelRepeatedRows(document.getElementById('level-role-rewards-list')));
onPanel('season',        () => labelRepeatedRows(document.getElementById('season-tier-rewards-list')));
onPanel('reactionroles', () => labelRepeatedRows(document.getElementById('rr-mappings-list')));

// ── User search widget ────────────────────────────────────────────────
(function() {
    const _gId = BOOT.guildId;

    function initUserSearchWidget(widgetId) {
        const textarea = document.getElementById(widgetId);
        const tagsEl   = document.getElementById(widgetId + '-tags');
        const dropdown = document.getElementById(widgetId + '-dropdown');
        const input    = document.querySelector(`.user-search-input[data-widget="${widgetId}"]`);
        if (!textarea || !tagsEl || !input || !dropdown) return;

        const existingIds = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
        if (existingIds.length) {
            apiFetch(`/api/v1/guild/${_gId}/members/resolve?ids=${existingIds.join(',')}`)
                .then(r => r.json())
                .then(map => {
                    for (const id of existingIds) {
                        const info = map[id];
                        _addUserTag(widgetId, id, info?.displayName || info?.username || id, info?.avatarURL || null);
                    }
                })
                .catch(() => { for (const id of existingIds) _addUserTag(widgetId, id, id, null); });
        }

        let _debounce;
        // The request this widget currently has out. The 280ms debounce keeps
        // the server from seeing every keystroke, but it says nothing about the
        // order the answers come back in: a slow response for an earlier, less
        // specific query resolves last and repaints the dropdown with results
        // for a prefix the user has already typed past. Each new search cancels
        // the one it replaces, so only the newest can paint (#691).
        let _inFlight = null;
        input.addEventListener('input', function() {
            clearTimeout(_debounce);
            if (_inFlight) { _inFlight.abort(); _inFlight = null; }
            const q = this.value.trim();
            if (q.length < 2) { dropdown.style.display = 'none'; return; }
            _debounce = setTimeout(async () => {
                const controller = new AbortController();
                _inFlight = controller;
                try {
                    const results = await apiFetch(`/api/v1/guild/${_gId}/members/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
                        .then(r => r.json())
                        .then(d => d.items);
                    if (!Array.isArray(results) || !results.length) { dropdown.style.display = 'none'; return; }
                    dropdown.innerHTML = results.map(u => {
                        const name = escHtml(u.displayName || u.username);
                        const id   = escHtml(u.id);
                        const av   = u.avatarURL ? escHtml(u.avatarURL) : '';
                        return `<div class="user-search-item" data-id="${id}" data-name="${name}" data-avatar="${av}">
                            ${av ? `<img src="${av}" alt="" style="width:20px;height:20px;border-radius:50%" data-hide-on-error>` : ''}
                            <span>${name}</span>
                            <span style="opacity:.5;font-size:.75em;margin-left:auto">${escHtml(u.username)}</span>
                        </div>`;
                    }).join('');
                    dropdown.style.display = '';
                    dropdown.querySelectorAll('.user-search-item').forEach(el => {
                        el.addEventListener('mousedown', function(e) {
                            e.preventDefault();
                            _addUserTag(widgetId, this.dataset.id, this.dataset.name, this.dataset.avatar || null);
                            input.value = '';
                            dropdown.style.display = 'none';
                        });
                    });
                } catch (err) {
                    // An abort means a newer search is already running; hiding
                    // the dropdown here would close what it is about to fill.
                    if (err && err.name === 'AbortError') return;
                    dropdown.style.display = 'none';
                } finally {
                    if (_inFlight === controller) _inFlight = null;
                }
            }, 280);
        });

        input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));
    }

    function _addUserTag(widgetId, id, name, avatarUrl) {
        const textarea = document.getElementById(widgetId);
        const tagsEl   = document.getElementById(widgetId + '-tags');
        if (!textarea || !tagsEl) return;
        const existing = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
        if (existing.includes(id)) return;
        const tag = document.createElement('span');
        tag.className = 'user-id-tag';
        tag.dataset.userId = id;
        const safeId   = escHtml(id);
        const safeName = escHtml(name);
        const safeAv   = avatarUrl ? escHtml(avatarUrl) : '';
        tag.innerHTML  = `${safeAv ? `<img src="${safeAv}" alt="" style="width:16px;height:16px;border-radius:50%" data-hide-on-error>` : ''}<span title="${safeId}">${safeName}</span><button type="button" title="Remove" aria-label="Remove ${safeName}">&times;</button>`;
        tag.querySelector('button').addEventListener('click', function() {
            const ta = document.getElementById(widgetId);
            if (ta) ta.value = ta.value.split('\n').map(s => s.trim()).filter(s => s && s !== id).join('\n');
            tag.remove();
        });
        tagsEl.appendChild(tag);
        textarea.value = [...existing, id].join('\n');
    }

    onPanel('antinuke', () => initUserSearchWidget('an-whitelist-users'));
    onPanel('commandpolicies', () => initUserSearchWidget('cp-exc-users'));
})();

// ── Unsaved-changes tracking (#662) ───────────────────────────────────
//
// 22 panels carry 28 "Save changes" buttons and nothing anywhere knew whether
// what was on screen had been saved. Leaving the page — the "← All servers"
// link, a reload, closing the tab — threw away every unsaved edit in silence.
//
// Switching sections does not, despite how it looks: activateTab() only sets
// display:none on the panel it leaves, so its fields and their values stay in
// the document and are still there when the reader comes back. What is missing
// there is not a barrier but a reminder, so a section holding unsaved edits is
// marked in the sidebar and named in a banner rather than trapping navigation
// behind a dialog that would be wrong every time it appeared.
//
// A *save scope* is the region of a panel owned by exactly one saveSettings()
// section — an inner tab, or the panel itself, or whatever data-save-scope
// marks where one container holds two sections' fields. One POST saves its
// whole section, so a successful save re-baselines every scope of that section
// however many tabs they are spread across.
//
// Dirty is decided by comparing a scope with a snapshot taken when its markup
// landed, not by a flag raised on the first keystroke: typing a character and
// deleting it again leaves the settings exactly as they were, and a warning
// there is how people learn to click through warnings.

// A save button used to be found by reading `onclick` and matching
// `saveSettings('x')` out of it. Both the attribute and the parse are gone with
// #887: the button carries `data-action="save" data-section="x"`, so the
// section is read rather than extracted, and the selector is a plain one.
const SAVE_BUTTON = '[data-action="save"][data-section]';
function saveButtonsIn(root) {
    return Array.from(root.querySelectorAll(SAVE_BUTTON));
}
// Search boxes, "pick one to add" selects and one-shot admin fields live
// inside panels but are not settings — saveSettings() never reads them.
const NOT_A_SETTING = '[data-no-dirty], [data-no-dirty] *';
// Unit separator. A value containing it would have to be typed on purpose;
// anything more ordinary could forge a boundary between two fields.
const FIELD_SEP = '\u001f';

// scope element -> { section, baseline }
const saveScopes = new Map();
// What the banner last said, so it is only rewritten — and only re-announced —
// when the set of unsaved sections actually changes.
let announcedSections = '';
let leavingDeliberately = false;

function saveScopeOf(el) {
    return el.closest('[data-save-scope]')
        || el.closest('.ai-inner-panel')
        || el.closest('section.panel');
}

function sectionOfSaveButton(btn) {
    const scoped = btn.closest('[data-save-scope]');
    if (scoped) return scoped.dataset.saveScope;
    return btn.dataset.section || null;
}

function scopeSignature(scope) {
    const parts = [];
    for (const el of scope.querySelectorAll('input, select, textarea')) {
        // A modal is a scratch editor for one row. The row it commits to is in
        // the scope already, so counting both would report an edit twice — and
        // would report a cancelled modal as an edit that never happened.
        if (el.closest('.modal-overlay')) continue;
        if (el.matches(NOT_A_SETTING)) continue;
        // A file input's value is a fake path the page cannot set back, so it
        // could never match a baseline and would pin the scope dirty forever.
        if (el.type === 'file') continue;
        if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? '1' : '0');
        else if (el.multiple) parts.push(Array.from(el.selectedOptions, o => o.value).join(','));
        else parts.push(el.value);
    }
    // Role, channel and member chips are spans rather than controls, and on
    // several panels they *are* the setting — removing one is an edit that no
    // amount of reading form controls would notice.
    for (const chip of scope.querySelectorAll('[data-role-id], [data-channel-id], [data-user-id]')) {
        parts.push(chip.dataset.roleId || chip.dataset.channelId || chip.dataset.userId);
    }
    // Whatever a panel says its scopes are also dirty on. A shop item's chosen
    // image is the one setting on this page that lives nowhere in the DOM — the
    // file input is skipped above, its value being a fake path — and without a
    // contribution from the panel that holds it, changing only an item's image
    // leaves every reachable value identical to the baseline: the scope reads
    // clean, the banner stays down, beforeunload allows the navigation, and the
    // upload is dropped.
    for (const extra of SIGNATURE_EXTRAS) {
        if (scope.querySelector(extra.selector)) parts.push(...extra.read());
    }
    return parts.join(FIELD_SEP);
}

function registerSaveScopes(root) {
    for (const btn of saveButtonsIn(root)) {
        const section = sectionOfSaveButton(btn);
        const scope = saveScopeOf(btn);
        if (!section || !scope || saveScopes.has(scope)) continue;
        // The button is kept, not just the section it saves: Enter in a field
        // presses it (#679), and pressing the real control means the save goes
        // through whatever that button does — the in-flight guard, the
        // re-baseline, the toast — rather than through a second path that
        // would have to keep up with it.
        saveScopes.set(scope, { section, baseline: scopeSignature(scope), saveButton: btn });
    }
    refreshUnsavedMarks();
}

function scopeIsDirty(scope) {
    const entry = saveScopes.get(scope);
    return !!entry && scopeSignature(scope) !== entry.baseline;
}

function unsavedScopes() {
    return Array.from(saveScopes.keys()).filter(scopeIsDirty);
}

/** Re-baseline a section's scopes. Only ever called after a save succeeded. */
function markSectionSaved(section) {
    for (const [scope, entry] of saveScopes) {
        if (entry.section === section) entry.baseline = scopeSignature(scope);
    }
    refreshUnsavedMarks();
}

function refreshUnsavedMarks() {
    const dirtyTabs = new Set();
    for (const [scope] of saveScopes) {
        const dirty = scopeIsDirty(scope);
        scope.classList.toggle('has-unsaved', dirty);
        for (const btn of saveButtonsIn(scope)) btn.classList.toggle('has-unsaved', dirty);
        const panel = scope.closest('.panel');
        if (dirty && panel) dirtyTabs.add(panel.id);
    }

    const names = [];
    for (const item of navItems) {
        const dirty = dirtyTabs.has(item.dataset.tab);
        // A CSS dot rather than an appended element, so the sidebar keeps the
        // shape both the nav tests and activateTab's label lookup rely on.
        item.classList.toggle('has-unsaved', dirty);
        if (dirty) names.push(item.querySelector('span:last-child')?.textContent?.trim() || item.dataset.tab);
    }

    // The dot on its own would be colour and shape carrying meaning, which
    // WCAG 1.4.1 rules out. The banner says it in words and names the sections,
    // which is also the only way to see an unsaved section that is scrolled
    // out of the sidebar.
    const banner = document.getElementById('unsaved-banner');
    if (!banner) return;
    const summary = names.join(', ');
    if (summary === announcedSections) return;
    announcedSections = summary;
    if (summary) document.getElementById('unsaved-banner-sections').textContent = summary;
    banner.hidden = !summary;
}

function noteEdit(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const scope = saveScopeOf(target);
    if (scope && saveScopes.has(scope)) refreshUnsavedMarks();
}

// Capture, so an edit still registers if something downstream stops the event.
document.addEventListener('input', noteEdit, true);
document.addEventListener('change', noteEdit, true);
// Adding or removing a chip or a repeater row changes what would be saved
// without any control firing input or change. The click that did it is the
// signal; the state it produces exists a tick later.
document.addEventListener('click', () => {
    if (saveScopes.size) setTimeout(refreshUnsavedMarks, 0);
}, true);

// ── Enter saves the section (#679) ───────────────────────────────────
// There is one <form> in the whole dashboard and it answers `return false`, so
// Enter did nothing in any of the ~130 text fields across the panels — a key
// every other settings page in the world responds to, in a page whose save
// button is often several screens down from the field being edited.
//
// What Enter saves is exactly what the unsaved-changes banner tracks: the same
// save scope, the same exclusions. A field the banner would never light up for
// is not a setting, and Enter in it does nothing — which is what it did
// before, so nothing that used to be inert becomes surprising.
//
// Fields whose scope has no saveSettings button of its own — the RSS feed URL,
// the member admin lookups, anything committed by its own POST — are left
// alone deliberately. Enter there would fire the section save rather than the
// Add the reader was reaching for, and a key that does the wrong thing is
// worse than a key that does nothing.

// Types where Enter is not a commit: a checkbox and a radio answer to Space, a
// file input opens a picker, and the rest are dragged or clicked.
const NO_ENTER_TYPES = new Set(['checkbox', 'radio', 'file', 'color', 'range', 'button', 'submit', 'reset', 'hidden', 'image']);

function enterSavesFrom(target) {
    // <textarea> keeps Enter — it is a newline there, and always was. <select>
    // keeps it too: it commits an open dropdown.
    if (!target || target.tagName !== 'INPUT') return null;
    if (NO_ENTER_TYPES.has(target.type) || target.disabled || target.readOnly) return null;
    // The same three exclusions scopeSignature() applies, for the same
    // reasons: a modal is a scratch editor with its own commit button, and a
    // data-no-dirty field is a search box or a "pick one to add", not a
    // setting.
    if (target.closest('.modal-overlay') || target.matches(NOT_A_SETTING)) return null;
    const scope = saveScopeOf(target);
    const entry = scope && saveScopes.get(scope);
    return entry?.saveButton || null;
}

document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.defaultPrevented) return;
    // A modifier means the reader asked for something else — Ctrl+Enter is the
    // prompt editor's commit — and `isComposing` is the Enter that closes an
    // IME candidate list, which must never reach the page as a keystroke.
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
    const button = enterSavesFrom(event.target);
    if (!button) return;
    // Stop the implicit submission the one <form> on the page would otherwise
    // have to keep swallowing.
    event.preventDefault();
    button.click();
});

// The one place edits are genuinely lost. Browsers ignore any message we pass
// and show their own wording, but returnValue still has to be set for Chrome
// and Safari to show the prompt at all.
window.addEventListener('beforeunload', event => {
    if (leavingDeliberately || !unsavedScopes().length) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
});

// "← All servers", and any other link that leaves this page. Intercepting it
// means the reader gets a dialog naming the unsaved sections rather than the
// browser's anonymous one.
document.addEventListener('click', async event => {
    if (event.defaultPrevented || event.button !== 0) return;
    // A modified click opens a new tab or a download; this page is not going
    // anywhere, so there is nothing to warn about.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    // In-page anchors (the skip link) and javascript: handlers go nowhere.
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return;
    if (!unsavedScopes().length) return;

    event.preventDefault();
    const sections = announcedSections || 'this page';
    const leave = await showConfirm({
        title: 'Leave without saving?',
        body: `Unsaved changes in ${sections} will be lost.`,
        okText: 'Leave without saving',
    });
    if (!leave) return;
    // Past the reader's own confirmation, so beforeunload must not ask again.
    leavingDeliberately = true;
    window.location.href = link.href;
});

// ── One save at a time, and a button that says so (#663) ──────────────────
//
// saveSettings() reads a whole section out of the page and POSTs it, and
// nothing stopped a second click starting a second POST while the first was
// still open. Two requests carrying the same body can be answered in either
// order, and for `economy` — which uploads pending shop images after the
// settings land — the second pass walks a `_shopItemPendingImages` map the
// first pass is in the middle of emptying.
//
// The other half of the problem is that the page said nothing while a save was
// running. The toast at the end was the only feedback, so on a slow connection
// the interface looked like it had ignored the click, which is what earns the
// second one. sendWelcomeCardPreview() has done this properly all along; this
// is that pattern applied to every save button at once.
//
// The section is the unit here, not the button. Moderation spreads three "Save
// changes" buttons across three inner tabs and all three POST the same
// section, so a save started from one has to close the other two as well.
const savesInFlight = new Set();
const SAVING_LABEL = 'Saving…';

/** The save buttons whose click calls saveSettings() for this section. */
function saveButtonsForSection(section) {
    return saveButtonsIn(document).filter(btn => btn.dataset.section === section);
}

/**
 * Put a section's save buttons into their pending state.
 *
 * @returns {() => void} restores every button to exactly what it was.
 */
function beginSave(section) {
    const restores = saveButtonsForSection(section).map(btn => {
        const label = btn.textContent;
        // Disabling the focused control moves focus to the body, which drops a
        // keyboard user at the top of a 25-section page. Noted now so it can be
        // handed back when the button comes alive again.
        const hadFocus = document.activeElement === btn;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = SAVING_LABEL;
        return () => {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = label;
            if (hadFocus) btn.focus();
        };
    });
    return () => { for (const restore of restores) restore(); };
}

// saveSettings is called straight from inline onclick attributes, so the hook
// goes on the global binding rather than on 28 buttons. The original is
// captured first: reassigning the name would otherwise make this recurse.
const saveSettingsUnhooked = saveSettings;
window.saveSettings = async function saveSettings(section) {
    // Not an error worth a toast — the reader clicked a button that was already
    // doing what they asked. The save in flight will report for both.
    if (savesInFlight.has(section)) return false;
    savesInFlight.add(section);
    const endSave = beginSave(section);
    try {
        const saved = await saveSettingsUnhooked(section);
        if (saved) markSectionSaved(section);
        return saved;
    } finally {
        // In a finally because saveSettings() only catches around its fetch. A
        // panel whose fields are not in the document throws out of the reading
        // half, and a button left disabled and reading "Saving…" forever is a
        // worse failure than the one that caused it.
        savesInFlight.delete(section);
        endSave();
    }
};

// The panel that shipped with the page has had its init callbacks run by now —
// they ran as the panel scripts above this one executed — so it can be
// baselined here. Every other panel is baselined by loadPanel() when its markup
// lands.
registerSaveScopes(document);
