// Guild settings dashboard behaviour.
//
// This file is static and content-addressed by the `asset()` helper, so a
// browser fetches it once and reuses it across every guild and every reload.
// Everything that varies per request arrives in the small inline bootstrap
// block that guild-settings.ejs renders just before this script.
const BOOT = window.CLAWDIA_BOOTSTRAP;

// Each server value used to be inlined as its own object literal, so two
// variables initialised from the same value were independent and safe to mutate
// separately. Reading straight off the shared bootstrap would alias them, so
// hand out a copy instead — the payload is plain JSON, and a stringify
// round-trip reproduces the old semantics exactly.
function boot(key) {
    return JSON.parse(JSON.stringify(BOOT[key]));
}

// ── Lazily loaded panels ─────────────────────────────────────────────
// The page ships only the panel that is open on arrival; the other two dozen
// come down as HTML fragments the first time their tab is clicked. So nothing
// that renders into a panel, or binds a listener to an element inside one, can
// run at load time. Register it with onPanel() instead: the callback runs as
// soon as that panel's markup is in the document — immediately, for the panel
// that came with the page — and is handed the panel element.
const PANEL_URL = '/dashboard/guild/' + encodeURIComponent(BOOT.guildId) + '/panel/';
const pendingPanelInit = new Map();   // panel id -> [callback]
const panelRequests = new Map();      // panel id -> Promise<Element|null>

function runPanelInit(id, fn) {
    try {
        fn(document.getElementById(id));
    } catch (err) {
        // One panel's setup blowing up must not take the others with it.
        console.error('[dashboard] init for panel "' + id + '" failed:', err);
    }
}

function onPanel(id, fn) {
    if (document.getElementById(id)) { runPanelInit(id, fn); return; }
    const queued = pendingPanelInit.get(id);
    if (queued) queued.push(fn);
    else pendingPanelInit.set(id, [fn]);
}

function panelStub(id) {
    return document.querySelector('.panel-stub[data-panel="' + CSS.escape(id) + '"]');
}

function loadPanel(id) {
    const loaded = document.getElementById(id);
    if (loaded) return Promise.resolve(loaded);

    const inFlight = panelRequests.get(id);
    if (inFlight) return inFlight;

    const stub = panelStub(id);
    if (!stub) return Promise.resolve(null);

    const request = fetch(PANEL_URL + encodeURIComponent(id), { headers: { Accept: 'text/html' } })
        .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        })
        .then(html => {
            const holder = document.createElement('template');
            holder.innerHTML = html.trim();
            const panel = holder.content.firstElementChild;
            stub.replaceWith(holder.content);
            const queued = pendingPanelInit.get(id) || [];
            pendingPanelInit.delete(id);
            queued.forEach(fn => runPanelInit(id, fn));
            // After the init callbacks, not before: several of them populate
            // fields, and a baseline taken first would read as an edit the
            // moment they finished (#662).
            registerSaveScopes(panel);
            return panel;
        })
        .catch(err => {
            console.error('[dashboard] could not load panel "' + id + '":', err);
            // Forget the attempt so the next click retries instead of sticking.
            panelRequests.delete(id);
            const message = stub.querySelector('.panel-stub-message');
            if (message) message.textContent = 'Could not load this section. Click the tab again to retry.';
            toast('Could not load that section. Please try again.', 'error');
            return null;
        });

    panelRequests.set(id, request);
    return request;
}

const DAILY_NEWS_INITIAL_PROFILES = boot('dailyNewsProfiles');
const DAILY_NEWS_CHANNELS = boot('channels');
const ESCALATION_DEFAULTS = [
    { threshold: 3,  action: 'mute', durationMinutes: 10,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
    { threshold: 5,  action: 'mute', durationMinutes: 60,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
    { threshold: 7,  action: 'kick', durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
    { threshold: 10, action: 'ban',  durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' }
];
let ESCALATION_LADDER = boot('escalationLadder');

// Sidebar tab navigation
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

// The tab the reader last asked for. A panel that is still being fetched when
// the reader moves on must not steal the view when it finally arrives.
let requestedTab = document.querySelector('.panel.active')?.id || null;

async function activateTab(tab) {
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
    if (history.replaceState) {
        const innerToParent = { knowledgebase: 'ai', aisummaries: 'ai', aipersonas: 'ai', dailynews: 'rss' };
        const curInner = location.hash.slice(1);
        const newHash = (innerToParent[curInner] === tab) ? location.hash : '#' + tab;
        history.replaceState(null, '', newHash);
    }

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
    if (tab === 'analytics') loadAnalytics();
    if (tab === 'leveling') loadLevelLeaderboard(1);
    return panel;
}

navItems.forEach(item => {
    item.addEventListener('click', async () => {
        await activateTab(item.dataset.tab);
        // Land the reader in the section they just opened. Without this, a
        // keyboard user picking the last item in the sidebar has to tab back
        // through every item below it to reach the settings — 25 stops on
        // every visit. `preventScroll` keeps the mouse path unchanged, and the
        // target is tabindex="-1", so this adds no tab stop of its own.
        if (mainContent && document.activeElement === item) {
            mainContent.focus({ preventScroll: true });
        }
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

// AI inner tab navigation
function switchAiInnerTab(tabId) {
    document.querySelectorAll('#ai .ai-inner-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#ai .ai-inner-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`.ai-inner-tab[data-ai-tab="${tabId}"]`);
    const panel = document.getElementById(tabId);
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');
    if (tabId === 'ai-knowledgebase') loadKnowledgeBase();
    if (tabId === 'ai-summaries') loadSummaryJobs();
    if (tabId === 'ai-personas') renderPersonas();
    if (tabId === 'ai-mcp') loadMcpServers();
}

// RSS inner tab navigation
function switchRssInnerTab(tabId) {
    document.querySelectorAll('.rss-inner-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#rss .ai-inner-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`.rss-inner-tab[data-rss-tab="${tabId}"]`);
    const panel = document.getElementById(tabId);
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');
}

// Game inner tab navigation (Hunt / Fish / Mine)
function makeGameTabSwitcher(tabClass, panelSelector, dataAttr) {
    return function switchTab(tabId) {
        document.querySelectorAll('.' + tabClass).forEach(t => t.classList.remove('active'));
        document.querySelectorAll(panelSelector).forEach(p => p.classList.remove('active'));
        const btn = document.querySelector('.' + tabClass + '[data-' + dataAttr + '="' + tabId + '"]');
        const panel = document.getElementById(tabId);
        if (btn) btn.classList.add('active');
        if (panel) panel.classList.add('active');
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
        if (tab.dataset.ecoTab === 'eco-tab-health') loadEcoHealth();
    } else if (cls.contains('mod-inner-tab')) {
        switchModTab(tab.dataset.modTab);
        if (tab.dataset.modTab === 'mod-tab-sanctions') loadActiveSanctions();
        if (tab.dataset.modTab === 'mod-tab-cases') loadCaseHistory(1);
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

if (location.hash) {
    // An inner tab can only be selected once its parent panel has arrived.
    (async function routeFromHash() {
        const hash = location.hash.slice(1);
        const aiInnerMap = { knowledgebase: 'ai-knowledgebase', aisummaries: 'ai-summaries', aipersonas: 'ai-personas' };
        const rssInnerMap = { dailynews: 'rss-tab-dailynews' };
        if (aiInnerMap[hash]) {
            if (await activateTab('ai')) switchAiInnerTab(aiInnerMap[hash]);
        } else if (rssInnerMap[hash]) {
            if (await activateTab('rss')) switchRssInnerTab(rssInnerMap[hash]);
        } else {
            await activateTab(hash);
        }
    })();
}

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

// ── Welcome card preview ──────────────────────────────────────────────
async function sendWelcomeCardPreview() {
    const btn = document.getElementById('welcome-preview-btn');
    const guildId = BOOT.guildId;
    const channelId = document.getElementById('welcome-channel').value;
    if (!channelId) { toast('Select a welcome channel first', 'error'); return; }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
        const resp = await fetch(`/api/v1/guild/${guildId}/welcome/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId })
        });
        if (resp.ok) {
            toast('Preview sent to channel', 'success');
        } else {
            const d = await resp.json().catch(() => ({}));
            toast(d.error || 'Failed to send preview', 'error');
        }
    } catch { toast('Network error', 'error'); } finally {
        btn.disabled = false;
        btn.textContent = 'Send card preview to channel';
    }
}

// Timezone validation — checks against Intl.supportedValuesOf on blur
function validateTimezoneInput(input) {
    const val = input.value.trim();
    const errEl = document.getElementById(input.id + '-err');
    if (!val || val === 'UTC') { if (errEl) errEl.style.display = 'none'; return true; }
    try {
        const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : null;
        if (supported && !supported.includes(val)) {
            if (errEl) { errEl.textContent = `"${val}" is not a valid IANA timezone.`; errEl.style.display = ''; }
            return false;
        }
        // Fallback: try constructing a formatter
        Intl.DateTimeFormat(undefined, { timeZone: val });
        if (errEl) errEl.style.display = 'none';
        return true;
    } catch (_) {
        if (errEl) { errEl.textContent = `"${val}" is not a valid IANA timezone.`; errEl.style.display = ''; }
        return false;
    }
}

// Message preview helper — substitutes template variables with sample values
const PREVIEW_VARS = {
    user: '@SampleUser',
    username: 'SampleUser',
    tag: 'SampleUser#0000',
    server: BOOT.guildName,
    memberCount: '1,234',
    age: '25'
};
function updateMsgPreview(textareaId, previewId) {
    const ta = document.getElementById(textareaId);
    const box = document.getElementById(previewId);
    if (!ta || !box) return;
    const raw = ta.value;
    if (!raw.trim()) { box.textContent = ''; return; }
    const rendered = raw.replace(/\{(\w+)\}/g, (_, key) => PREVIEW_VARS[key] !== undefined ? PREVIEW_VARS[key] : `{${key}}`);
    box.textContent = rendered;
}
// Initialise each preview when its panel arrives
onPanel('welcome',   () => updateMsgPreview('welcome-message', 'welcome-preview'));
onPanel('farewell',  () => updateMsgPreview('farewell-message', 'farewell-preview'));
onPanel('birthdays', () => updateMsgPreview('birthday-message', 'birthday-preview'));

// ── Toast ─────────────────────────────────────────────────────────────
// The only feedback channel the dashboard has: every save, delete and failure
// reports through this one element. That makes three things load-bearing (#659):
//
//   * The element is a live region (role="status" in the markup), so a screen
//     reader announces the result instead of the reader being left guessing.
//   * Success and failure are told apart by an icon and a word, not by a
//     0.4-alpha border colour — WCAG 1.4.1 rules colour-only out, and the
//     border was invisible to most people anyway.
//   * There is a dismiss button, and an error stays up long enough to read.
//     The old fixed 2.8 s auto-dismiss could take a message away mid-sentence
//     with no way to bring it back.
const toastEl = document.getElementById('toast');
const toastIcon = document.getElementById('toast-icon');
const toastMessage = document.getElementById('toast-message');
const toastClose = document.getElementById('toast-close');
let toastTimer;

const TOAST_KINDS = {
    success: { icon: '✓', prefix: 'Success' },
    error:   { icon: '⚠', prefix: 'Error' },
    info:    { icon: 'ℹ', prefix: 'Note' },
};
const TOAST_DISMISS_MS = { success: 2800, error: 8000, info: 4500 };

function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove('show');
    // The toast is only faded out, not display:none, so without this the
    // dismiss button stays in the tab order — an unlabelled stop in the corner
    // of every page, dismissing nothing. It ships `hidden` for the same reason.
    if (toastClose) toastClose.hidden = true;
}

function toast(message, kind) {
    const style = TOAST_KINDS[kind];
    toastIcon.textContent = style ? style.icon : '';
    // The prefix is what a screen reader hears first, so it carries the
    // outcome even when the message itself reads the same either way
    // ("Network error" is only an error because we say so).
    toastMessage.textContent = style ? `${style.prefix}: ${message}` : message;
    toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastClose) toastClose.hidden = false;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TOAST_DISMISS_MS[kind] || 2800);
}

if (toastClose) toastClose.addEventListener('click', hideToast);

const AI_MODEL_DEFAULTS = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5',
    gemini: 'gemini-2.0-flash',
    openrouter: 'openai/gpt-4o-mini',
    ollama: 'llama3.2'
};

function updateAiProviderUI() {
    const provider = document.getElementById('ai-provider').value;
    document.querySelectorAll('.ai-key-field').forEach(el => {
        el.style.display = el.dataset.provider === provider ? '' : 'none';
    });
    const hint = document.getElementById('ai-model-hint');
    if (hint) hint.textContent = 'Default: ' + (AI_MODEL_DEFAULTS[provider] || '');
}
onPanel('ai', () => { if (document.getElementById('ai-provider')) updateAiProviderUI(); });
onPanel('rss', renderDailyNewsProfiles);
onPanel('moderation', renderEscalationLadder);

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function renderEscalationLadder() {
    const host = document.getElementById('mod-escalation-ladder');
    if (!host) return;
    if (!ESCALATION_LADDER.length) {
        host.innerHTML = '<p style="opacity:.7;font-size:.85rem;margin:.5rem 0;">No ladder steps configured. Click <strong>Add step</strong> to create one, or <strong>Reset to defaults</strong> for the recommended ladder.</p>';
        return;
    }
    const sorted = ESCALATION_LADDER.slice().sort((a, b) => (a.threshold || 0) - (b.threshold || 0));
    host.innerHTML = sorted.map((step, idx) => {
        const needsDuration = step.action === 'mute' || step.action === 'tempban';
        return `
        <div class="field esc-ladder-row">
            <div><label class="field-label" style="font-size:.75rem;" for="esc-${idx}-threshold">Warnings</label><input type="number" id="esc-${idx}-threshold" min="1" value="${step.threshold || 1}" data-esc-idx="${idx}" data-esc-key="threshold"></div>
            <div><label class="field-label" style="font-size:.75rem;" for="esc-${idx}-action">Action</label>
                <select id="esc-${idx}-action" data-esc-idx="${idx}" data-esc-key="action">
                    <option value="mute" ${step.action === 'mute' ? 'selected' : ''}>Mute</option>
                    <option value="tempban" ${step.action === 'tempban' ? 'selected' : ''}>Tempban</option>
                    <option value="kick" ${step.action === 'kick' ? 'selected' : ''}>Kick</option>
                    <option value="ban" ${step.action === 'ban' ? 'selected' : ''}>Ban</option>
                </select>
            </div>
            <div><label class="field-label" style="font-size:.75rem;" for="esc-${idx}-duration">Duration (min)</label><input type="number" id="esc-${idx}-duration" min="1" max="40320" value="${step.durationMinutes ?? ''}" ${needsDuration ? '' : 'disabled'} data-esc-idx="${idx}" data-esc-key="durationMinutes"></div>
            <div><label class="field-label" style="font-size:.75rem;" for="esc-${idx}-dm">DM</label><input type="checkbox" id="esc-${idx}-dm" ${step.dmUser !== false ? 'checked' : ''} data-esc-idx="${idx}" data-esc-key="dmUser"></div>
            <div><label class="field-label" style="font-size:.75rem;" for="esc-${idx}-reason">Reason (supports {count})</label><input type="text" id="esc-${idx}-reason" value="${escapeHtml(step.reason || '')}" data-esc-idx="${idx}" data-esc-key="reason"></div>
            <div><button type="button" class="btn btn-sm" onclick="removeEscalationStep(${idx})">✕</button></div>
        </div>`;
    }).join('');

    host.querySelectorAll('[data-esc-idx]').forEach(el => {
        el.addEventListener('change', updateEscalationFromDom);
        el.addEventListener('input', updateEscalationFromDom);
    });
    ESCALATION_LADDER = sorted;
}

function updateEscalationFromDom(e) {
    const idx = parseInt(e.target.getAttribute('data-esc-idx'), 10);
    const key = e.target.getAttribute('data-esc-key');
    if (Number.isNaN(idx) || !ESCALATION_LADDER[idx]) return;
    const step = ESCALATION_LADDER[idx];
    if (key === 'threshold') step.threshold = parseInt(e.target.value, 10) || 1;
    else if (key === 'durationMinutes') step.durationMinutes = e.target.value === '' ? null : (parseInt(e.target.value, 10) || null);
    else if (key === 'dmUser') step.dmUser = e.target.checked;
    else if (key === 'reason') step.reason = e.target.value;
    else if (key === 'action') {
        step.action = e.target.value;
        if (step.action !== 'mute' && step.action !== 'tempban') step.durationMinutes = null;
        renderEscalationLadder();
    }
}

function addEscalationStep() {
    const maxThreshold = ESCALATION_LADDER.reduce((m, s) => Math.max(m, s.threshold || 0), 0);
    ESCALATION_LADDER.push({
        threshold: maxThreshold + 1,
        action: 'mute',
        durationMinutes: 10,
        dmUser: true,
        reason: 'Automatic escalation: {count} warnings reached'
    });
    renderEscalationLadder();
}

function removeEscalationStep(idx) {
    ESCALATION_LADDER.splice(idx, 1);
    renderEscalationLadder();
}

async function resetEscalationLadder() {
    const ok = await showConfirm({ title: 'Reset escalation ladder', body: 'Replace the current ladder with the default 4-step ladder? Your custom steps will be lost.', okText: 'Reset' });
    if (!ok) return;
    ESCALATION_LADDER = JSON.parse(JSON.stringify(ESCALATION_DEFAULTS));
    renderEscalationLadder();
}

function serializeEscalationLadder() {
    const seen = new Set();
    const cleaned = [];
    for (const step of ESCALATION_LADDER) {
        const threshold = parseInt(step.threshold, 10);
        if (!threshold || threshold < 1 || seen.has(threshold)) continue;
        const action = step.action || 'mute';
        let durationMinutes = null;
        if (action === 'mute' || action === 'tempban') {
            const duration = parseInt(step.durationMinutes, 10);
            if (!duration || duration < 1) continue;
            durationMinutes = duration;
        }
        seen.add(threshold);
        cleaned.push({
            threshold,
            action,
            durationMinutes,
            dmUser: step.dmUser !== false,
            reason: step.reason || 'Automatic escalation: {count} warnings reached'
        });
    }
    return cleaned.sort((a, b) => a.threshold - b.threshold);
}

function dailyNewsChannelOptions(selected = '') {
    return ['<option value="">Select a channel</option>']
        .concat(DAILY_NEWS_CHANNELS.map(c => `<option value="${c.id}" ${selected === c.id ? 'selected' : ''}>#${c.name}</option>`))
        .join('');
}

function renderDailyNewsProfiles() {
    const container = document.getElementById('dailynews-profiles-list');
    if (!container) return;
    if (!container.dataset.initialized) {
        const seed = (DAILY_NEWS_INITIAL_PROFILES.length ? DAILY_NEWS_INITIAL_PROFILES : []).map((p, idx) => ({
            profileId: p.profileId || `profile-${Date.now()}-${idx + 1}`,
            name: p.name || '',
            enabled: p.enabled !== false,
            channelId: p.channelId || '',
            time: p.time || '09:00',
            timezone: p.timezone || '',
            title: p.title || '📰 Daily News Digest',
            feeds: Array.isArray(p.feeds) ? p.feeds : [],
            maxItemsPerFeed: p.maxItemsPerFeed || 3
        }));
        container.dataset.profiles = JSON.stringify(seed);
        container.dataset.initialized = '1';
    }

    const profiles = JSON.parse(container.dataset.profiles || '[]');
    container.innerHTML = profiles.length ? '' : '<div class="empty-state" style="padding:1rem;"><p>No additional profiles yet.</p></div>';
    profiles.forEach((profile, idx) => {
        const displayName = profile.name ? profile.name : `Profile ${idx + 1}`;
        const card = document.createElement('div');
        card.className = 'list-item';
        card.style.display = 'block';
        card.style.marginBottom = '.75rem';
        card.innerHTML = `
            <div style="display:grid;gap:.5rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <strong>${escHtml(displayName)}</strong>
                    <button class="btn btn-danger btn-sm" type="button" onclick="removeDailyNewsProfile(${idx})">Remove</button>
                </div>
                <label for="dn-${idx}-name">Profile name</label>
                <input id="dn-${idx}-name" type="text" value="${escHtml(profile.name || '')}" placeholder="e.g. Tech News" oninput="updateDailyNewsProfile(${idx}, 'name', this.value); this.closest('.list-item').querySelector('strong').textContent = this.value || 'Profile ${idx + 1}';">
                <label for="dn-${idx}-channel">Channel</label>
                <select id="dn-${idx}-channel" onchange="updateDailyNewsProfile(${idx}, 'channelId', this.value)">${dailyNewsChannelOptions(profile.channelId)}</select>
                <label for="dn-${idx}-time">Time (24h)</label>
                <input id="dn-${idx}-time" type="text" value="${escHtml(profile.time || '09:00')}" onchange="updateDailyNewsProfile(${idx}, 'time', this.value)">
                <label for="dn-${idx}-timezone">Timezone <small style="font-weight:normal;opacity:.7;">(IANA, e.g. UTC, America/New_York, Europe/London)</small></label>
                <input id="dn-${idx}-timezone" type="text" list="tz-datalist" value="${escHtml(profile.timezone || '')}" placeholder="UTC" autocomplete="off" onblur="validateTimezoneInput(this)" onchange="updateDailyNewsProfile(${idx}, 'timezone', this.value)">
                <label for="dn-${idx}-title">Digest title</label>
                <input id="dn-${idx}-title" type="text" value="${escHtml(profile.title || '📰 Daily News Digest')}" onchange="updateDailyNewsProfile(${idx}, 'title', this.value)">
                <label for="dn-${idx}-feeds">Feeds (one URL per line)</label>
                <textarea id="dn-${idx}-feeds" rows="3" onchange="updateDailyNewsProfile(${idx}, 'feeds', this.value)">${escHtml((profile.feeds || []).join('\n'))}</textarea>
                <div id="feed-status-${idx}" style="font-size:.8rem;"></div>
                <button class="btn btn-sm" type="button" onclick="validateProfileFeeds(${idx})">Validate feeds</button>
            </div>
        `;
        container.appendChild(card);
    });
}

function addDailyNewsProfile() {
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    profiles.push({ profileId: `profile-${Date.now()}`, name: '', enabled: true, channelId: '', time: '09:00', timezone: '', title: '📰 Daily News Digest', feeds: [], maxItemsPerFeed: parseInt(document.getElementById('dailynews-max-items').value, 10) || 3 });
    container.dataset.profiles = JSON.stringify(profiles);
    renderDailyNewsProfiles();
}

function removeDailyNewsProfile(index) {
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    profiles.splice(index, 1);
    container.dataset.profiles = JSON.stringify(profiles);
    renderDailyNewsProfiles();
}

function updateDailyNewsProfile(index, key, value) {
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    if (!profiles[index]) return;
    profiles[index][key] = key === 'feeds' ? value.split('\n').map(f => f.trim()).filter(Boolean) : value;
    container.dataset.profiles = JSON.stringify(profiles);
}

async function validateFeedUrl(url, guildId) {
    const resp = await fetch(`/api/v1/guild/${guildId}/validate-feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    return resp.json();
}

async function validateMainFeeds() {
    const guildId = BOOT.guildId;
    const statusEl = document.getElementById('main-feed-status');
    const urls = document.getElementById('dailynews-feeds').value.split('\n').map(f => f.trim()).filter(Boolean);
    if (!urls.length) { statusEl.textContent = 'No feed URLs to validate.'; return; }
    statusEl.textContent = `Checking ${urls.length} feed(s)…`;
    const results = await Promise.all(urls.map(url => validateFeedUrl(url, guildId).then(r => ({ url, ...r })).catch(() => ({ url, valid: false, error: 'Request failed' }))));
    statusEl.innerHTML = results.map(r => r.valid
        ? `<span style="color:var(--success,#3ba55d);">✓ ${escHtml(r.url)} — ${escHtml(r.title || 'untitled')} (${r.itemCount} items)</span>`
        : `<span style="color:var(--danger,#ed4245);">✗ ${escHtml(r.url)} — ${escHtml(r.error)}</span>`
    ).join('<br>');
}

async function validateProfileFeeds(index) {
    const guildId = BOOT.guildId;
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    const profile = profiles[index];
    if (!profile) return;
    const statusEl = document.getElementById(`feed-status-${index}`);
    const urls = profile.feeds || [];
    if (!urls.length) { statusEl.textContent = 'No feed URLs in this profile.'; return; }
    statusEl.textContent = `Checking ${urls.length} feed(s)…`;
    const results = await Promise.all(urls.map(url => validateFeedUrl(url, guildId).then(r => ({ url, ...r })).catch(() => ({ url, valid: false, error: 'Request failed' }))));
    statusEl.innerHTML = results.map(r => r.valid
        ? `<span style="color:var(--success,#3ba55d);">✓ ${escHtml(r.url)} — ${escHtml(r.title || 'untitled')} (${r.itemCount} items)</span>`
        : `<span style="color:var(--danger,#ed4245);">✗ ${escHtml(r.url)} — ${escHtml(r.error)}</span>`
    ).join('<br>');
}

// Returns true when the settings reached the server, false when they did not.
// The unsaved-changes tracking below reads it: a section is only clean once a
// save has actually succeeded, so a failed POST must leave the dirty mark up.
async function saveSettings(section) {
    const guildId = BOOT.guildId;
    let data = {};

    if (section === 'welcome') {
        data = {
            'welcome.enabled': document.getElementById('welcome-enabled').checked,
            'welcome.channelId': document.getElementById('welcome-channel').value,
            'welcome.message': document.getElementById('welcome-message').value,
            'welcome.cardEnabled': document.getElementById('welcome-card').checked,
            'welcome.dmEnabled': document.getElementById('welcome-dm-enabled').checked,
            'welcome.dmMessage': document.getElementById('welcome-dm-message').value
        };
    } else if (section === 'farewell') {
        data = {
            'farewell.enabled': document.getElementById('farewell-enabled').checked,
            'farewell.channelId': document.getElementById('farewell-channel').value,
            'farewell.message': document.getElementById('farewell-message').value
        };
    } else if (section === 'birthdays') {
        data = {
            'birthdays.enabled': document.getElementById('birthday-enabled').checked,
            'birthdays.channelId': document.getElementById('birthday-channel').value || null,
            'birthdays.wishingHourUtc': (() => { const v = parseInt(document.getElementById('birthday-hour').value, 10); return Number.isNaN(v) ? 9 : v; })(),
            'birthdays.roleId': document.getElementById('birthday-role').value || null,
            'birthdays.message': document.getElementById('birthday-message').value || "It's the birthday of {user} ({age}) ! 🎂"
        };
    } else if (section === 'moderation') {
        const immunityRoleIds = Array.from(document.getElementById('mod-immunity-roles').selectedOptions).map(o => o.value);
        data = {
            'moderation.enabled': document.getElementById('mod-enabled').checked,
            'moderation.logChannelId': document.getElementById('mod-log-channel').value || null,
            'moderation.muteRoleId': document.getElementById('mod-mute-role').value || null,
            'moderation.autoModEnabled': document.getElementById('mod-automod').checked,
            'moderation.immunityRoleIds': immunityRoleIds,
            'moderation.spamProtection': document.getElementById('mod-spam').checked,
            'moderation.spamThreshold': parseInt(document.getElementById('mod-spam-threshold').value, 10) || 5,
            'moderation.spamWindow': parseInt(document.getElementById('mod-spam-window').value, 10) || 5,
            'moderation.inviteFilter': document.getElementById('mod-invites').checked,
            'moderation.inviteAllowlist': document.getElementById('mod-invite-allowlist').value.split('\n').map(s => s.trim()).filter(Boolean),
            'moderation.linkFilter': document.getElementById('mod-links').checked,
            'moderation.linkAllowlist': document.getElementById('mod-link-allowlist').value.split('\n').map(s => s.trim()).filter(Boolean),
            'moderation.profanityFilter': document.getElementById('mod-profanity').checked,
            'moderation.customBadWords': document.getElementById('mod-bad-words').value.split('\n').map(w => w.trim()).filter(Boolean),
            'moderation.repeatedTextFilter': document.getElementById('mod-repeated').checked,
            'moderation.excessiveCapsFilter': document.getElementById('mod-caps').checked,
            'moderation.capsThresholdPercent': parseInt(document.getElementById('mod-caps-threshold').value, 10) || 70,
            'moderation.excessiveEmojisFilter': document.getElementById('mod-emojis').checked,
            'moderation.emojiThreshold': parseInt(document.getElementById('mod-emoji-threshold').value, 10) || 8,
            'moderation.zalgoFilter': document.getElementById('mod-zalgo').checked,
            'moderation.excessiveMentionsFilter': document.getElementById('mod-mentions').checked,
            'moderation.mentionThreshold': parseInt(document.getElementById('mod-mention-threshold').value, 10) || 5,
            'moderation.warnThreshold': parseInt(document.getElementById('mod-warn-threshold').value, 10) || 3,
            'moderation.kickThreshold': parseInt(document.getElementById('mod-kick-threshold').value, 10) || 0,
            'moderation.banThreshold': parseInt(document.getElementById('mod-ban-threshold').value, 10) || 0,
            'moderation.behaviorScoreMuteAt': parseInt(document.getElementById('mod-score-mute').value, 10) || 0,
            'moderation.behaviorScoreKickAt': parseInt(document.getElementById('mod-score-kick').value, 10) || 0,
            'moderation.behaviorScoreBanAt': parseInt(document.getElementById('mod-score-ban').value, 10) || 0,
            'moderation.behaviorScoreDecayDays': parseInt(document.getElementById('mod-score-decay').value, 10) || 7,
            'moderation.appealsEnabled': document.getElementById('mod-appeals-enabled').checked,
            'moderation.appealChannelId': document.getElementById('mod-appeal-channel').value || null,
            'moderation.escalation.enabled': document.getElementById('mod-escalation-enabled').checked,
            'moderation.escalation.ladder': serializeEscalationLadder()
        };
    } else if (section === 'leveling') {
        const noXpRoleIds = Array.from(document.querySelectorAll('#level-no-xp-roles-list [data-role-id]')).map(el => el.dataset.roleId);
        const noXpChannelIds = Array.from(document.querySelectorAll('#level-no-xp-channels-list [data-channel-id]')).map(el => el.dataset.channelId);
        const levelRoles = Array.from(document.querySelectorAll('#level-role-rewards-list .level-reward-row')).map(row => ({
            level: parseInt(row.querySelector('.level-reward-level').value, 10),
            roleId: row.querySelector('.level-reward-role').value
        })).filter(r => r.level > 0 && r.roleId);
        const maxLevelRaw = parseInt(document.getElementById('level-max-level').value, 10);
        data = {
            'leveling.enabled': document.getElementById('level-enabled').checked,
            'leveling.xpRate': parseFloat(document.getElementById('level-xp-rate').value) || 1.0,
            'leveling.maxLevel': Number.isFinite(maxLevelRaw) && maxLevelRaw > 0 ? maxLevelRaw : null,
            'leveling.levelUpMessage': document.getElementById('level-message').value,
            'leveling.rewardsEnabled': document.getElementById('level-rewards-enabled').checked,
            'leveling.noXpRoleIds': noXpRoleIds,
            'leveling.noXpChannelIds': noXpChannelIds,
            'leveling.rewardChannelId': document.getElementById('level-reward-channel').value || null,
            'leveling.voiceXpEnabled': document.getElementById('level-voice-xp').checked,
            'leveling.voiceXpRate': parseFloat(document.getElementById('level-voice-rate').value) || 1.0,
            levelRoles
        };
    } else if (section === 'economy') {
        const safeInt = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        data = {
            'economy.enabled': document.getElementById('economy-enabled').checked,
            'economy.currency': document.getElementById('economy-currency').value,
            'economy.dailyAmount': safeInt('economy-daily', 100),
            'economy.workMin': safeInt('economy-work-min', 50),
            'economy.workMax': safeInt('economy-work-max', 150),
            'economy.shopEnabled': document.getElementById('economy-shop-enabled').checked,
            'economy.gamesEnabled': document.getElementById('economy-games-enabled').checked,
            'economy.coinflipEnabled': document.getElementById('economy-coinflip-enabled').checked,
            'economy.rollEnabled': document.getElementById('economy-roll-enabled').checked,
            'economy.blackjackEnabled': document.getElementById('economy-blackjack-enabled').checked,
            'economy.casinoEnabled': document.getElementById('economy-casino-enabled').checked,
            'economy.duelEnabled': document.getElementById('economy-duel-enabled').checked,
            'economy.crimeEnabled': document.getElementById('economy-crime-enabled').checked,
            'economy.robEnabled': document.getElementById('economy-rob-enabled').checked,
            'economy.quizEnabled': document.getElementById('economy-quiz-enabled').checked,
            'economy.jobsEnabled': document.getElementById('economy-jobs-enabled').checked,
            'economy.announcementChannelId': document.getElementById('economy-announcement-channel').value || null,
            shop: storeItems,
            jobs: jobsList,
            jobTiers: jobTiersList
        };
    } else if (section === 'achievements') {
        data = {
            'achievements.enabled': document.getElementById('ach-enabled').checked,
            'achievements.announcementChannelId': document.getElementById('ach-announce-channel').value || null,
            'achievements.disabledAchievements': _disabledAchievements,
            'achievements.customAchievements': _customAchievements
        };
    } else if (section === 'raiddetection') {
        data = {
            'raidDetection.enabled': document.getElementById('raid-enabled').checked,
            'raidDetection.threshold': parseInt(document.getElementById('raid-threshold').value, 10) || 10,
            'raidDetection.windowSeconds': parseInt(document.getElementById('raid-window').value, 10) || 60,
            'raidDetection.minAccountAgeDays': parseInt(document.getElementById('raid-min-age').value, 10) || 0,
            'raidDetection.action': document.getElementById('raid-action').value,
            'raidDetection.quarantineRoleId': document.getElementById('raid-quarantine-role').value || null,
            'raidDetection.alertChannelId': document.getElementById('raid-alert-channel').value || null
        };
    } else if (section === 'starboard') {
        data = {
            'starboard.enabled': document.getElementById('starboard-enabled').checked,
            'starboard.channelId': document.getElementById('starboard-channel').value || null,
            'starboard.emoji': document.getElementById('starboard-emoji').value || '⭐',
            'starboard.threshold': parseInt(document.getElementById('starboard-threshold').value, 10) || 3
        };
    } else if (section === 'eventlog') {
        data = {
            'eventLog.enabled': document.getElementById('eventlog-enabled').checked,
            'eventLog.channelId': document.getElementById('eventlog-channel').value || null,
            'eventLog.logMessageEdit': document.getElementById('log-msg-edit').checked,
            'eventLog.logMessageDelete': document.getElementById('log-msg-delete').checked,
            'eventLog.logMessageBulkDelete': document.getElementById('log-msg-bulk-delete').checked,
            'eventLog.logMemberJoin': document.getElementById('log-member-join').checked,
            'eventLog.logMemberLeave': document.getElementById('log-member-leave').checked,
            'eventLog.logNicknameChange': document.getElementById('log-nickname-change').checked,
            'eventLog.logUsernameChange': document.getElementById('log-username-change').checked,
            'eventLog.logAvatarChange': document.getElementById('log-avatar-change').checked,
            'eventLog.logTimeout': document.getElementById('log-timeout').checked,
            'eventLog.logBoost': document.getElementById('log-boost').checked,
            'eventLog.logRoleChanges': document.getElementById('log-role-changes').checked,
            'eventLog.logChannelChanges': document.getElementById('log-channel-changes').checked,
            'eventLog.logVoiceJoin': document.getElementById('log-voice-join').checked,
            'eventLog.logVoiceLeave': document.getElementById('log-voice-leave').checked,
            'eventLog.logVoiceMove': document.getElementById('log-voice-move').checked,
            'eventLog.logVoiceMuteDeafen': document.getElementById('log-voice-mute').checked,
            'eventLog.logInviteCreate': document.getElementById('log-invite-create').checked,
            'eventLog.logInviteDelete': document.getElementById('log-invite-delete').checked,
            'eventLog.logServerUpdate': document.getElementById('log-server-update').checked,
            'eventLog.logEmojiUpdate': document.getElementById('log-emoji-update').checked,
            'eventLog.logWebhookUpdate': document.getElementById('log-webhook-update').checked,
            'eventLog.logBotAdd': document.getElementById('log-bot-add').checked,
            'eventLog.logThreadCreate': document.getElementById('log-thread-create').checked,
            'eventLog.logThreadDelete': document.getElementById('log-thread-delete').checked,
            'eventLog.logThreadArchive': document.getElementById('log-thread-archive').checked
        };
    } else if (section === 'quests') {
        const safeReward = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        const safeSlot = (id, fallback, min, max) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback; };
        data = {
            'quests.enabled': document.getElementById('quests-enabled').checked,
            'quests.notificationChannelId': document.getElementById('quests-notif-channel').value || null,
            'quests.questsPerDay': safeSlot('quests-per-day', 3, 1, 6),
            'quests.questsPerWeek': safeSlot('quests-per-week', 2, 1, 4),
            'quests.dailyXpReward': safeReward('quests-daily-xp', 50),
            'quests.dailyCoinReward': safeReward('quests-daily-coins', 25),
            'quests.weeklyXpReward': safeReward('quests-weekly-xp', 300),
            'quests.weeklyCoinReward': safeReward('quests-weekly-coins', 150)
        };
    } else if (section === 'suggestions') {
        data = {
            'suggestions.enabled': document.getElementById('suggestions-enabled').checked,
            'suggestions.channelId': document.getElementById('suggestions-channel').value || null,
            'suggestions.upvoteEmoji': document.getElementById('suggestions-upvote').value || '👍',
            'suggestions.downvoteEmoji': document.getElementById('suggestions-downvote').value || '👎',
            'suggestions.staffReviewChannelId': document.getElementById('suggestions-staff-channel').value || null,
            'suggestions.autoThread': document.getElementById('suggestions-auto-thread').checked,
            'suggestions.anonymous': document.getElementById('suggestions-anonymous').checked,
            'suggestions.minAccountAgeDays': parseInt(document.getElementById('suggestions-min-age').value, 10) || 0,
            'suggestions.statusEmojis.approve': document.getElementById('sug-status-approve').value || '✅',
            'suggestions.statusEmojis.deny': document.getElementById('sug-status-deny').value || '❌',
            'suggestions.statusEmojis.review': document.getElementById('sug-status-review').value || '🔎',
            'suggestions.statusEmojis.implement': document.getElementById('sug-status-implement').value || '🚀'
        };
    } else if (section === 'antinuke') {
        const splitIds = id => document.getElementById(id).value.split('\n').map(s => s.trim()).filter(Boolean);
        data = {
            'antiNuke.enabled': document.getElementById('an-enabled').checked,
            'antiNuke.alertChannelId': document.getElementById('an-alert-channel').value || null,
            'antiNuke.windowSeconds': parseInt(document.getElementById('an-window').value, 10) || 30,
            'antiNuke.punishment': document.getElementById('an-punishment').value,
            'antiNuke.autoLockdown': document.getElementById('an-auto-lockdown').checked,
            'antiNuke.thresholds': {
                channelDelete: parseInt(document.getElementById('an-t-channelDelete').value, 10) || 3,
                channelCreate: parseInt(document.getElementById('an-t-channelCreate').value, 10) || 5,
                roleDelete:    parseInt(document.getElementById('an-t-roleDelete').value, 10) || 3,
                roleCreate:    parseInt(document.getElementById('an-t-roleCreate').value, 10) || 5,
                ban:           parseInt(document.getElementById('an-t-ban').value, 10) || 3,
                kick:          parseInt(document.getElementById('an-t-kick').value, 10) || 5,
                webhookCreate: parseInt(document.getElementById('an-t-webhookCreate').value, 10) || 2
            },
            'antiNuke.whitelistUserIds': splitIds('an-whitelist-users'),
            'antiNuke.whitelistRoleIds': splitIds('an-whitelist-roles'),
            'antiNuke.joinGate': {
                enabled:           document.getElementById('an-jg-enabled').checked,
                minAccountAgeDays: parseInt(document.getElementById('an-jg-age').value, 10) || 3,
                action:            document.getElementById('an-jg-action').value
            }
        };
    } else if (section === 'casesettings') {
        data = {
            'caseSettings.slaHours':    parseInt(document.getElementById('cs-sla-hours').value, 10) || 48,
            'caseSettings.slaChannelId': document.getElementById('cs-sla-channel').value || null
        };
    } else if (section === 'season') {
        const tierRewards = Array.from(document.querySelectorAll('#season-tier-rewards-list .season-tier-row')).map(row => ({
            tier: parseInt(row.querySelector('.season-tier-num').value, 10),
            coins: parseInt(row.querySelector('.season-tier-coins').value, 10) || 0,
            roleId: row.querySelector('.season-tier-role').value || null,
            label: row.querySelector('.season-tier-label').value.trim()
        })).filter(r => !isNaN(r.tier) && r.tier > 0).sort((a, b) => a.tier - b.tier);
        data = {
            'season.enabled':    document.getElementById('season-enabled').checked,
            'season.name':       document.getElementById('season-name').value.trim() || 'Season 1',
            'season.seasonId':   document.getElementById('season-id').value.trim() || null,
            'season.startDate':  document.getElementById('season-start').value || null,
            'season.endDate':    document.getElementById('season-end').value || null,
            'season.xpPerTier':  parseInt(document.getElementById('season-xp-per-tier').value, 10) || 100,
            'season.maxTiers':   parseInt(document.getElementById('season-max-tiers').value, 10) || 50,
            'season.tierRewards': tierRewards
        };
    } else if (section === 'progressiontracks') {
        const helperChannels = Array.from(document.getElementById('pt-helper-channels').selectedOptions).map(o => o.value);
        data = {
            'progressionTracks.enabled':       document.getElementById('pt-enabled').checked,
            'progressionTracks.creatorBonus':  parseInt(document.getElementById('pt-creator-bonus').value, 10) || 20,
            'progressionTracks.helperBonus':   parseInt(document.getElementById('pt-helper-bonus').value, 10) || 20,
            'progressionTracks.raiderBonus':   parseInt(document.getElementById('pt-raider-bonus').value, 10) || 20,
            'progressionTracks.helperChannels': helperChannels
        };
    } else if (section === 'commandpolicies') {
        const excRoleIds = Array.from(document.querySelectorAll('#cp-exc-roles-list [data-role-id]')).map(el => el.dataset.roleId);
        const excUserIds = document.getElementById('cp-exc-users').value.split('\n').map(s => s.trim()).filter(Boolean);
        data = {
            'commandPolicies.enabled': document.getElementById('cp-enabled').checked,
            'commandPolicies.exceptions': {
                userIds: excUserIds,
                roleIds: excRoleIds
            },
            'commandPolicies.rules':            _cpRules,
            'commandPolicies.cooldownOverrides': _cpCooldowns
        };
    } else if (section === 'ai') {
        // EJS renders the saved systemPrompt verbatim, so pre-existing values
        // can exceed the textarea's maxlength (e.g. set via the API).
        // Validate here so we never POST an oversized prompt.
        const aiPromptVal = document.getElementById('ai-prompt').value;
        if (aiPromptVal.length > 4000) {
            updatePromptCount('ai-prompt');
            toast('System prompt is ' + aiPromptVal.length + ' chars — maximum is 4000.', 'error');
            return;
        }
        data = {
            'ai.enabled': document.getElementById('ai-enabled').checked,
            'ai.provider': document.getElementById('ai-provider').value,
            'ai.model': document.getElementById('ai-model').value.trim(),
            ...(document.getElementById('ai-openai-key').value ? {'ai.openaiKey': document.getElementById('ai-openai-key').value} : {}),
            ...(document.getElementById('ai-anthropic-key').value ? {'ai.anthropicKey': document.getElementById('ai-anthropic-key').value} : {}),
            ...(document.getElementById('ai-gemini-key').value ? {'ai.geminiKey': document.getElementById('ai-gemini-key').value} : {}),
            ...(document.getElementById('ai-openrouter-key').value ? {'ai.openrouterKey': document.getElementById('ai-openrouter-key').value} : {}),
            'ai.ollamaBaseUrl': document.getElementById('ai-ollama-url').value.trim(),
            'ai.channelId': document.getElementById('ai-channel').value,
            'ai.systemPrompt': aiPromptVal,
            'ai.temperature': parseFloat(document.getElementById('ai-temperature').value),
            'ai.maxTokens': parseInt(document.getElementById('ai-max-tokens').value, 10),
            'ai.maxHistory': parseInt(document.getElementById('ai-max-history').value, 10),
            'ai.streaming': document.getElementById('ai-streaming').checked,
            'ai.rateLimitPerUser': parseInt(document.getElementById('ai-rate-limit').value, 10),
            'ai.rateLimitPerChannel': parseInt(document.getElementById('ai-rate-channel').value, 10),
            'ai.rateLimitWindowMin': parseInt(document.getElementById('ai-rate-window').value, 10),
            'ai.monthlyTokenLimit': parseInt(document.getElementById('ai-monthly-tokens').value, 10) || 0,
            'ai.monthlyCostLimit': parseFloat(document.getElementById('ai-monthly-cost').value) || 0,
            'ai.actionsEnabled': document.getElementById('ai-actions-enabled').checked,
            'ai.taskModeEnabled': document.getElementById('ai-task-mode').checked,
            // These live on the Connections tab but belong to the same ai
            // document, so they save with everything else rather than needing
            // their own endpoint.
            //
            // Only once that tab has actually loaded, though. The controls are
            // in the markup from the start and default to the first option, so
            // sending them unhydrated would take a guild that had approvals on
            // `writes` and quietly put them back to `off` — because somebody
            // changed the temperature on the Chat tab and pressed Save.
            ...(_mcpHydrated ? {
                'ai.mcpConfirm': mcpEl('mcp-confirm').value,
                'ai.mcpRoute': mcpEl('mcp-route').value
            } : {})
        };
    } else if (section === 'tempvoice') {
        data = {
            'tempVoice.enabled': document.getElementById('tv-enabled').checked,
            'tempVoice.lobbyChannelId': document.getElementById('tv-lobby').value || null,
            'tempVoice.categoryId': document.getElementById('tv-category').value || null,
            'tempVoice.channelName': document.getElementById('tv-channel-name').value.trim() || "{username}'s VC",
            'tempVoice.userLimit': parseInt(document.getElementById('tv-user-limit').value, 10) || 0,
            'tempVoice.bitrate': parseInt(document.getElementById('tv-bitrate').value, 10) || 64
        };
    } else if (section === 'bibleverses') {
        data = {
            'bibleVerse.enabled': document.getElementById('bv-enabled').checked,
            'bibleVerse.channelId': document.getElementById('bv-channel').value || null,
            'bibleVerse.time': document.getElementById('bv-time').value.trim() || '08:00',
            'bibleVerse.timezone': document.getElementById('bv-timezone').value.trim() || 'UTC',
            'bibleVerse.translation': document.getElementById('bv-translation').value,
            'bibleVerse.autoRespond': document.getElementById('bv-autorespond').checked
        };
    } else if (section === 'dailynews') {
        const feedsText = document.getElementById('dailynews-feeds').value;
        const feeds = feedsText.split('\n').filter(f => f.trim() !== '');
        const profiles = JSON.parse(document.getElementById('dailynews-profiles-list').dataset.profiles || '[]')
            .map((p, index) => ({
                profileId: p.profileId || `profile-${index + 1}`,
                name: (p.name || '').trim(),
                enabled: p.enabled !== false,
                channelId: (p.channelId || '').trim(),
                time: (p.time || '09:00').trim(),
                timezone: (p.timezone || '').trim() || null,
                title: (p.title || '📰 Daily News Digest').trim(),
                feeds: (Array.isArray(p.feeds) ? p.feeds : []).map(f => f.trim()).filter(Boolean),
                maxItemsPerFeed: parseInt(document.getElementById('dailynews-max-items').value, 10) || 3
            }))
            .filter(p => p.channelId && p.feeds.length);
        data = {
            'dailyNews.enabled': document.getElementById('dailynews-enabled').checked,
            'dailyNews.channelId': document.getElementById('dailynews-channel').value,
            'dailyNews.time': document.getElementById('dailynews-time').value,
            'dailyNews.timezone': document.getElementById('dailynews-timezone').value.trim() || null,
            'dailyNews.title': document.getElementById('dailynews-title').value,
            'dailyNews.maxItemsPerFeed': parseInt(document.getElementById('dailynews-max-items').value),
            'dailyNews.feeds': feeds,
            dailyNewsProfiles: profiles
        };
    } else if (section === 'newspaper') {
        const safeInt = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        data = {
            'newspaper.enabled':         document.getElementById('newspaper-enabled').checked,
            'newspaper.channelId':        document.getElementById('newspaper-channel').value || null,
            'newspaper.deliveryDay':      safeInt('newspaper-day', 1),
            'newspaper.deliveryHourUtc':  safeInt('newspaper-hour', 9),
            'newspaper.sections': {
                topEarners:       document.getElementById('np-top-earners').checked,
                levelUps:         document.getElementById('np-level-ups').checked,
                casinoHighlights: document.getElementById('np-casino').checked,
                moderationDigest: document.getElementById('np-mod').checked,
                gameStandouts:    document.getElementById('np-games').checked,
                quoteOfTheWeek:   document.getElementById('np-quote').checked,
                newMembers:       document.getElementById('np-new-members').checked,
            }
        };
    } else if (section === 'heist') {
        const safeInt = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        data = {
            'heist.enabled':              document.getElementById('heist-enabled').checked,
            'heist.cooldownHours':         safeInt('heist-cooldown', 6),
            'heist.lobbyDurationSeconds':  safeInt('heist-lobby', 60),
            'heist.minPlayers':            safeInt('heist-min-players', 2),
            'heist.jailDurationMinutes':   safeInt('heist-jail', 30),
            'heist.maxPayout':             safeInt('heist-max-payout', 10000),
        };
    } else if (section === 'dynamicPricing') {
        const bandPct = parseFloat(document.getElementById('dynamic-pricing-band').value);
        const recalc  = parseInt(document.getElementById('dynamic-pricing-recalc').value, 10);
        data = {
            'dynamicPricing.enabled':       document.getElementById('dynamic-pricing-enabled').checked,
            'dynamicPricing.volatility':    document.getElementById('dynamic-pricing-volatility').value,
            'dynamicPricing.priceBand':     Number.isFinite(bandPct) ? Math.min(0.9, Math.max(0.05, bandPct / 100)) : 0.5,
            'dynamicPricing.recalcMinutes': Number.isFinite(recalc)  ? Math.min(1440, Math.max(15, recalc))          : 60
        };
    } else if (section === 'exploration') {
        const safeFloat = (id, fallback, min, max) => {
            const v = parseFloat(document.getElementById(id).value);
            return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
        };
        const disabledRegions = Array.from(document.querySelectorAll('.exploration-region'))
            .filter(cb => !cb.checked)
            .map(cb => cb.dataset.regionId);
        data = {
            'exploration.enabled':            document.getElementById('exploration-enabled').checked,
            'exploration.dropRateMultiplier': safeFloat('exploration-droprate', 1, 0.1, 5),
            'exploration.rareEventBonus':     safeFloat('exploration-rarebonus', 0, 0, 0.25),
            'exploration.announceSecrets':    document.getElementById('exploration-announce-secrets').checked,
            'exploration.disabledRegions':    disabledRegions,
        };
    }

    try {
        const response = await fetch(`/api/v1/guild/${guildId}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            toast(err.error || 'Failed to save settings', 'error');
            return false;
        }

        // After saving economy settings, upload/delete pending shop item images
        if (section === 'economy') {
            const uploads = Object.entries(_shopItemPendingImages).map(([itemId, info]) => {
                const fd = new FormData();
                fd.append('image', info.file);
                return fetch(`/api/v1/item-image/shop/${guildId}/${itemId}`, { method: 'POST', body: fd })
                    .then(r => r.ok ? null : r.json().then(e => e.error || 'Upload failed'))
                    .catch(() => 'Upload error');
            });
            const deletes = [..._shopItemClearedImages].map(itemId =>
                fetch(`/api/v1/item-image/shop/${guildId}/${itemId}`, { method: 'DELETE' })
                    .then(r => r.ok ? null : 'Delete failed')
                    .catch(() => 'Delete error')
            );
            const results = await Promise.all([...uploads, ...deletes]);
            const errors = results.filter(Boolean);
            if (errors.length) {
                toast('Settings saved, but image update failed: ' + errors[0], 'error');
                // The settings landed but the images did not, and the pending
                // image is still unsaved work — so this is not a clean save.
                return false;
            }
            Object.keys(_shopItemPendingImages).forEach(k => delete _shopItemPendingImages[k]);
            _shopItemClearedImages.clear();
            toast('Settings saved', 'success');
        } else {
            toast('Settings saved', 'success');
        }
        return true;
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
        return false;
    }
}

// Activity images belong to this guild, not to every guild the bot is in (#561),
// so the guild id is part of the path. `_guildId` is assigned further down this
// file; both callers run on a click, long after the script has finished.
function activityImageUrl(itemId) {
    return '/api/v1/item-image/activity/' + encodeURIComponent(_guildId) + '/' + encodeURIComponent(itemId);
}

async function uploadActivityImage(itemId, input) {
    const file = input.files[0];
    if (!file) return;
    const emojiEl = document.getElementById('gic-emoji-' + itemId);
    let imgEl = document.getElementById('gic-img-' + itemId);
    const fd = new FormData();
    fd.append('image', file);
    try {
        const r = await fetch(activityImageUrl(itemId), { method: 'POST', body: fd });
        if (r.ok) {
            const dataUrl = await new Promise(function(res) {
                const reader = new FileReader();
                reader.onload = function(e) { res(e.target.result); };
                reader.readAsDataURL(file);
            });
            // Card was rendered without an <img>; create one and insert before the emoji
            if (!imgEl && emojiEl) {
                imgEl = document.createElement('img');
                imgEl.className = 'game-item-img';
                imgEl.id = 'gic-img-' + itemId;
                imgEl.alt = '';
                emojiEl.parentNode.insertBefore(imgEl, emojiEl);
            }
            if (imgEl) {
                imgEl.src = dataUrl;
                imgEl.style.display = 'block';
            }
            if (emojiEl) emojiEl.style.display = 'none';
            toast('Image uploaded', 'success');
        } else {
            const err = await r.json().catch(function(){ return {}; });
            toast(err.error || 'Upload failed', 'error');
        }
    } catch {
        toast('Upload error', 'error');
    }
    input.value = '';
}

async function removeActivityImage(itemId) {
    const ok = await showConfirm({ title: 'Remove image', body: 'Remove the image for this activity item?', okText: 'Remove' });
    if (!ok) return;
    try {
        const r = await fetch(activityImageUrl(itemId), { method: 'DELETE' });
        if (r.ok) {
            const imgEl = document.getElementById('gic-img-' + itemId);
            const emojiEl = document.getElementById('gic-emoji-' + itemId);
            if (imgEl) {
                imgEl.src = '';
                imgEl.style.display = 'none';
            }
            if (emojiEl) emojiEl.style.display = 'flex';
            toast('Image removed', 'success');
        } else {
            const err = await r.json().catch(function(){ return {}; });
            toast(err.error || 'Remove failed', 'error');
        }
    } catch {
        toast('Error removing image', 'error');
    }
}

async function triggerDailyNewsNow() {
    const guildId = BOOT.guildId;
    const ok = await showConfirm({ title: 'Send digest now', body: 'Send the daily digest right now to the configured channel?', okText: 'Send' });
    if (!ok) return;
    try {
        const response = await fetch(`/api/v1/guild/${guildId}/dailynews/trigger`, { method: 'POST' });
        if (response.ok) toast('Digest sent', 'success');
        else {
            const err = await response.json().catch(() => ({}));
            toast(err.error || 'Failed to send digest', 'error');
        }
    } catch (error) {
        console.error(error);
        toast('An error occurred sending the digest', 'error');
    }
}

async function addAutoRole() {
    const guildId = BOOT.guildId;
    const select = document.getElementById('autorole-select');
    const roleId = select.value;
    if (!roleId) { toast('Please select a role', 'error'); return; }
    if (document.querySelector(`#autorole-list [data-role-id="${roleId}"]`)) {
        toast('Role already added', 'error'); return;
    }
    try {
        const response = await fetch(`/api/v1/guild/${guildId}/autorole`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roleId })
        });
        if (response.ok) {
            const roleName = select.options[select.selectedIndex].text.replace(/^@/, '');
            // Built with DOM nodes, not innerHTML: a role name is attacker-chosen
            // text from Discord, so `@${roleName}` in a template literal turns any
            // role called `<img onerror=...>` into markup that runs for the next
            // admin to open this panel. textContent renders it as the name it is.
            // The remove button goes through data-action for the same reason the
            // rest of this page does — see the delegated handler below.
            const chip = document.createElement('span');
            chip.className = 'role-tag';
            chip.dataset.roleId = roleId;
            chip.appendChild(document.createTextNode('@' + roleName + ' '));
            const removeBtn = document.createElement('button');
            removeBtn.title = 'Remove';
            removeBtn.dataset.action = 'autorole-remove';
            removeBtn.dataset.roleId = roleId;
            removeBtn.textContent = '\u00d7';
            chip.appendChild(removeBtn);
            document.getElementById('autorole-list').appendChild(chip);
            select.value = '';
            toast('Role added', 'success');
        } else toast('Failed to add role', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

async function removeAutoRole(roleId) {
    const guildId = BOOT.guildId;
    try {
        const response = await fetch(`/api/v1/guild/${guildId}/autorole/${roleId}`, { method: 'DELETE' });
        if (response.ok) {
            const chip = document.querySelector(`#autorole-list [data-role-id="${roleId}"]`);
            if (chip) chip.remove();
            toast('Role removed', 'success');
        } else toast('Failed to remove role', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

async function addRssFeed() {
    const guildId = BOOT.guildId;
    const url = document.getElementById('rss-url').value;
    const channelId = document.getElementById('rss-channel').value;
    if (!url || !channelId) { toast('Please fill in all fields', 'error'); return; }
    try {
        const response = await fetch(`/api/v1/guild/${guildId}/rss/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, channelId })
        });
        if (response.ok) { toast('RSS feed added', 'success'); setTimeout(() => location.reload(), 600); }
        else toast('Failed to add RSS feed', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

async function deleteRssFeed(index) {
    const ok = await showConfirm({ title: 'Remove RSS feed', body: 'Remove this RSS feed? The bot will stop posting new articles from it.', okText: 'Remove feed' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const response = await fetch(`/api/v1/guild/${guildId}/rss/${index}`, { method: 'DELETE' });
        if (response.ok) { toast('RSS feed removed', 'success'); setTimeout(() => location.reload(), 600); }
        else toast('Failed to delete RSS feed', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

// ── Economy Store & Jobs ───────────────────────────────────────────────
// Command Policies state
var _cpRules     = boot('commandPolicyRules');
var _cpCooldowns = boot('commandPolicyCooldowns');
var _cpRuleIdx = -1;
var _cpCdIdx   = -1;

// ── Shared modal machinery ───────────────────────────────────────────
// One dialog on this page was built properly and the other eight were not:
// they were shown with a bare `style.display = 'flex'`, which leaves the
// dialog unannounced, Escape dead, Tab free to walk out into the page behind
// it, and focus dumped on <body> when it closes (#658). The implementation
// that was already written and working now lives here, and every dialog goes
// through it.
//
// A stack rather than one current dialog: showConfirm() is called from inside
// open dialogs — clearing a store item's image, for one — and closing the
// confirm has to hand focus back to the dialog underneath rather than to
// whatever was focused before both of them opened.
var _modalStack = [];
var _modalBodyOverflow = '';

// Visibility test that answers the same way in a browser and in the jsdom the
// dashboard suites run under, which has no layout engine and reports
// offsetParent === null for everything. Dialogs and conditional fields on this
// page are all toggled through inline `style.display`, so walking inline
// styles is both accurate here and portable.
function _modalHidden(el) {
    for (var node = el; node && node !== document.body; node = node.parentElement) {
        if (node.hidden || (node.style && node.style.display === 'none')) return true;
    }
    return false;
}

function _modalFocusables(modal) {
    return Array.from(modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function(el) { return !_modalHidden(el); });
}

/**
 * Shows `modal` as a dialog: displays it, moves focus inside, traps Tab, and
 * dismisses on Escape or a click on the backdrop.
 *
 * opts.initialFocus — element or element id to focus first. Defaults to the
 *                     first focusable that is not the ✕ button, so a form
 *                     opens on its first field.
 * opts.onDismiss    — run instead of closeModal(modal) for Escape and backdrop
 *                     click. Pass the dialog's own close function when it has
 *                     state of its own to unwind.
 * opts.display      — overlay display value, default 'flex'.
 */
function openModal(modal, opts) {
    modal = typeof modal === 'string' ? document.getElementById(modal) : modal;
    if (!modal) return null;
    opts = opts || {};

    // Re-opening an already-open dialog must not push a second entry, or its
    // close would restore focus into the copy of itself it just hid.
    if (_modalStack.some(function(e) { return e.modal === modal; })) closeModal(modal);

    const entry = { modal: modal, prevFocus: document.activeElement };
    entry.dismiss = typeof opts.onDismiss === 'function'
        ? opts.onDismiss
        : function() { closeModal(modal); };

    entry.onKeydown = function(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); entry.dismiss(); return; }
        if (e.key !== 'Tab') return;
        const focusables = _modalFocusables(modal);
        if (!focusables.length) { e.preventDefault(); return; }
        const first = focusables[0], last = focusables[focusables.length - 1];
        const inside = modal.contains(document.activeElement);
        if (e.shiftKey) {
            if (!inside || document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (!inside || document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    };
    entry.onClick = function(e) { if (e.target === modal) entry.dismiss(); };

    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = opts.display || 'flex';
    modal.addEventListener('keydown', entry.onKeydown);
    modal.addEventListener('click', entry.onClick);
    _modalStack.push(entry);

    // The page behind must not scroll while a dialog is up. Restored by the
    // close of the last one, so nested dialogs do not each clobber the value.
    if (_modalStack.length === 1) {
        _modalBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
    }

    let target = typeof opts.initialFocus === 'string'
        ? document.getElementById(opts.initialFocus)
        : opts.initialFocus;
    if (!target || _modalHidden(target)) {
        const focusables = _modalFocusables(modal);
        target = focusables.filter(function(el) { return !el.classList.contains('modal-close'); })[0]
            || focusables[0];
    }
    if (target) target.focus();

    return modal;
}

/** Hides a dialog opened by openModal and returns focus where it came from. */
function closeModal(modal) {
    modal = typeof modal === 'string' ? document.getElementById(modal) : modal;
    if (!modal) return;

    const idx = _modalStack.findIndex(function(e) { return e.modal === modal; });
    if (idx === -1) {
        // Not open through openModal — hide it anyway rather than leave a
        // dialog on screen because a caller got out of step.
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        return;
    }

    const entry = _modalStack.splice(idx, 1)[0];
    modal.removeEventListener('keydown', entry.onKeydown);
    modal.removeEventListener('click', entry.onClick);
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    if (!_modalStack.length) document.body.style.overflow = _modalBodyOverflow;

    // Focus goes back to whatever opened the dialog. Letting it fall to <body>
    // strands a keyboard user at the top of the page.
    if (entry.prevFocus && typeof entry.prevFocus.focus === 'function' && document.contains(entry.prevFocus)) {
        entry.prevFocus.focus();
    }
}

// ── Styled confirmation modal ────────────────────────────────────────
var _confirmResolve = null;

function showConfirm(opts) {
    return new Promise(function(resolve) {
        const title  = opts.title  || 'Are you sure?';
        const body   = opts.body   || 'This action cannot be undone.';
        const okText = opts.okText || 'Confirm';
        const typeRequired = opts.typeRequired || null;
        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-body').textContent  = body;
        document.getElementById('confirm-modal-ok').textContent    = okText;
        const typeArea  = document.getElementById('confirm-modal-type-reset');
        const typeInput = document.getElementById('confirm-type-input');
        if (typeRequired) {
            document.getElementById('confirm-type-label').innerHTML = 'Type <strong>' + escHtml(typeRequired) + '</strong> to confirm';
            typeInput.value = '';
            typeInput.placeholder = typeRequired;
            typeArea.style.display = '';
        } else {
            typeArea.style.display = 'none';
        }
        const modal = document.getElementById('confirm-modal');

        // Defined before the dialog opens: Escape and a backdrop click both
        // route through it, and either can fire from the moment it is up.
        _confirmResolve = function(ok) {
            if (ok && typeRequired && typeInput.value.trim() !== typeRequired) {
                typeInput.focus();
                typeInput.style.borderColor = 'var(--danger, #e05)';
                return;
            }
            typeInput.style.borderColor = '';
            closeModal(modal);
            _confirmResolve = function(){};
            resolve(ok);
        };

        openModal(modal, {
            // Type-to-confirm resets open on the input; everything else opens
            // on the button the user is here to press.
            initialFocus: typeRequired ? typeInput : document.getElementById('confirm-modal-ok'),
            onDismiss: function() { _confirmResolve(false); }
        });
    });
}

function renderCpRules() {
    const list = document.getElementById('cp-rules-list');
    if (!_cpRules.length) { list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem;">No rules — click <strong>+ Add rule</strong> to add one.</p>'; return; }
    list.innerHTML = _cpRules.map(function(r, i) {
        const color = r.effect === 'allow' ? '#2ecc71' : '#e74c3c';
        return '<div class="store-item-card" style="padding:.6rem .9rem;display:flex;align-items:center;gap:.75rem;">' +
            '<span style="flex:1"><strong>' + escHtml(r.command) + '</strong> — <span style="color:' + color + '">' + escHtml(r.effect) + '</span></span>' +
            '<button class="btn btn-sm" onclick="openCpRuleModal(' + i + ')">Edit</button>' +
            '<button class="btn btn-sm" style="color:#e74c3c" onclick="_cpRules.splice(' + i + ',1);renderCpRules()">✕</button></div>';
    }).join('');
}
var _cpRoleMap = boot('roleNames');
function renderCpCooldowns() {
    const list = document.getElementById('cp-cooldowns-list');
    if (!_cpCooldowns.length) { list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem;">No cooldown overrides — click <strong>+ Add override</strong>.</p>'; return; }
    list.innerHTML = _cpCooldowns.map(function(c, i) {
        const roleName = _cpRoleMap[c.roleId] ? '@' + _cpRoleMap[c.roleId] : escHtml(c.roleId);
        return '<div class="store-item-card" style="padding:.6rem .9rem;display:flex;align-items:center;gap:.75rem;">' +
            '<span style="flex:1"><strong>' + escHtml(c.command) + '</strong> — ' + escHtml(roleName) + ' → ' + escHtml(c.cooldownSeconds) + 's</span>' +
            '<button class="btn btn-sm" onclick="openCpCooldownModal(' + i + ')">Edit</button>' +
            '<button class="btn btn-sm" style="color:#e74c3c" onclick="_cpCooldowns.splice(' + i + ',1);renderCpCooldowns()">✕</button></div>';
    }).join('');
}
function openCpRuleModal(idx) {
    _cpRuleIdx = idx;
    const r = idx === -1 ? {} : _cpRules[idx];
    document.getElementById('cp-rule-modal-title').textContent = idx === -1 ? 'Add Rule' : 'Edit Rule';
    document.getElementById('cp-r-command').value   = r.command || '';
    document.getElementById('cp-r-effect').value    = r.effect || 'allow';
    const rRoles = r.roleIds || [];
    Array.from(document.getElementById('cp-r-roles').options).forEach(function(o) { o.selected = rRoles.includes(o.value); });
    const rChans = r.channelIds || [];
    Array.from(document.getElementById('cp-r-channels').options).forEach(function(o) { o.selected = rChans.includes(o.value); });
    document.getElementById('cp-r-start-hour').value = r.startHourUtc != null ? r.startHourUtc : '';
    document.getElementById('cp-r-end-hour').value   = r.endHourUtc   != null ? r.endHourUtc   : '';
    openModal('cp-rule-modal', { initialFocus: 'cp-r-command' });
}
function closeCpRuleModal() { closeModal('cp-rule-modal'); }
function saveCpRuleModal() {
    const cmd = document.getElementById('cp-r-command').value.trim();
    if (!cmd) { toast('Command name is required', 'error'); return; }
    const sh = document.getElementById('cp-r-start-hour').value;
    const eh = document.getElementById('cp-r-end-hour').value;
    const rule = {
        command: cmd,
        effect: document.getElementById('cp-r-effect').value,
        roleIds: Array.from(document.getElementById('cp-r-roles').selectedOptions).map(function(o){return o.value;}),
        channelIds: Array.from(document.getElementById('cp-r-channels').selectedOptions).map(function(o){return o.value;}),
        startHourUtc: sh !== '' ? parseInt(sh, 10) : null,
        endHourUtc:   eh !== '' ? parseInt(eh, 10) : null,
        daysOfWeek: []
    };
    if (_cpRuleIdx === -1) _cpRules.push(rule); else _cpRules[_cpRuleIdx] = rule;
    closeCpRuleModal(); renderCpRules();
}
function openCpCooldownModal(idx) {
    _cpCdIdx = idx;
    const c = idx === -1 ? {} : _cpCooldowns[idx];
    document.getElementById('cp-cd-command').value = c.command || '';
    document.getElementById('cp-cd-role').value    = c.roleId  || '';
    document.getElementById('cp-cd-seconds').value = c.cooldownSeconds != null ? c.cooldownSeconds : '';
    openModal('cp-cooldown-modal', { initialFocus: 'cp-cd-command' });
}
function closeCpCooldownModal() { closeModal('cp-cooldown-modal'); }
function saveCpCooldownModal() {
    const cmd = document.getElementById('cp-cd-command').value.trim();
    const role = document.getElementById('cp-cd-role').value.trim();
    if (!cmd || !role) { toast('Command and role are required', 'error'); return; }
    const entry = { command: cmd, roleId: role, cooldownSeconds: parseInt(document.getElementById('cp-cd-seconds').value, 10) || 0 };
    if (_cpCdIdx === -1) _cpCooldowns.push(entry); else _cpCooldowns[_cpCdIdx] = entry;
    closeCpCooldownModal(); renderCpCooldowns();
}

function addCpExcRole() {
    const sel = document.getElementById('cp-exc-roles-select');
    const roleId = sel.value;
    const roleName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : roleId;
    if (!roleId) return;
    if (document.querySelector('#cp-exc-roles-list [data-role-id="' + CSS.escape(roleId) + '"]')) { toast('Role already added', 'error'); return; }
    const list = document.getElementById('cp-exc-roles-list');
    const tag = document.createElement('span');
    tag.className = 'role-tag';
    tag.dataset.roleId = roleId;
    tag.textContent = roleName + ' ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.onclick = function() { tag.remove(); };
    tag.appendChild(btn);
    list.appendChild(tag);
    sel.value = '';
}

// Initialize CP lists
onPanel('commandpolicies', () => { renderCpRules(); renderCpCooldowns(); });

var storeItems = boot('shop');
var _serverJobs = boot('jobs');
var jobsList = _serverJobs.length > 0 ? _serverJobs.slice() : boot('defaultJobs');

var _savedTiers = boot('jobTiers');
var jobTiersList = _savedTiers.length === 4
    ? _savedTiers.slice().sort(function(a,b){return a.tier-b.tier;})
    : boot('defaultTiers');

var _roleMap = boot('roleNames');
var editingItemIdx = -1;
var editingJobIdx = -1;

var _shopItemPendingImages = {}; // itemId -> { file, dataUrl }
var _shopItemClearedImages = new Set(); // itemIds whose images were explicitly removed
var _guildId = BOOT.guildId;

function renderStoreItems() {
    const grid = document.getElementById('store-items-grid');
    if (!storeItems.length) {
        grid.innerHTML = '<div class="empty-state"><h3>No store items yet</h3><p>Click <strong>+ Add item</strong> to create your first shop listing.</p></div>';
        return;
    }
    grid.innerHTML = storeItems.map(function(item, i) {
        const roleName = item.roleId ? (_roleMap[item.roleId] || item.roleId) : null;
        const stockText = (item.stock === -1 || item.stock == null) ? '∞ Unlimited' : item.stock + ' left';
        const imgSrc = (item.itemId && _shopItemPendingImages[item.itemId])
            ? _shopItemPendingImages[item.itemId].dataUrl
            : (item.itemId ? '/api/v1/item-image/shop/' + _guildId + '/' + escHtml(item.itemId) : '');
        const thumbHtml = imgSrc ? '<img class="store-card-thumb" src="' + imgSrc + '" alt="" onerror="this.style.display=\'none\'">' : '';
        return '<div class="store-card">' +
            (thumbHtml ? '<div class="store-card-thumb-wrap">' + thumbHtml + '</div>' : '') +
            '<div class="store-card-body">' +
                '<div class="store-card-name">' + escHtml(item.name) + '</div>' +
                '<div class="store-card-desc">' + (item.description ? escHtml(item.description) : '<em style="color:var(--text-mute)">No description</em>') + '</div>' +
                '<div class="store-card-meta">' +
                    '<span class="store-meta-tag price-tag">💰 ' + Number(item.price).toLocaleString() + '</span>' +
                    '<span class="store-meta-tag">' + stockText + '</span>' +
                    (roleName ? '<span class="store-meta-tag role-meta">@' + escHtml(roleName) + '</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="store-card-actions">' +
                '<button class="btn btn-sm" onclick="openItemModal(' + i + ')">Edit</button>' +
                '<button class="btn btn-sm btn-danger" onclick="deleteItem(' + i + ')">Remove</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function _genItemId() {
    return 'item_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function previewShopItemImage(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        document.getElementById('shop-img-preview').src = dataUrl;
        document.getElementById('shop-img-preview').style.display = 'block';
        document.getElementById('shop-img-placeholder').style.display = 'none';
        document.getElementById('shop-img-clear-btn').style.display = 'inline-flex';
        input._pendingFile = file;
        input._pendingDataUrl = dataUrl;
    };
    reader.readAsDataURL(file);
}

function clearShopItemImage() {
    document.getElementById('shop-img-preview').src = '';
    document.getElementById('shop-img-preview').style.display = 'none';
    document.getElementById('shop-img-placeholder').style.display = 'block';
    document.getElementById('shop-img-clear-btn').style.display = 'none';
    const fileInput = document.getElementById('modal-item-image-file');
    fileInput._pendingFile = null;
    fileInput._pendingDataUrl = null;
    fileInput.value = '';
    fileInput._clearExisting = true;
}

function openItemModal(idx) {
    editingItemIdx = idx;
    document.getElementById('item-modal-title').textContent = idx === -1 ? 'Add Store Item' : 'Edit Store Item';
    const item = idx === -1 ? {} : storeItems[idx];
    document.getElementById('modal-item-name').value = item.name || '';
    document.getElementById('modal-item-desc').value = item.description || '';
    document.getElementById('modal-item-price').value = item.price != null ? item.price : '';
    document.getElementById('modal-item-role').value = item.roleId || '';
    const isUnlimited = (item.stock == null || item.stock === -1);
    document.getElementById('modal-item-unlimited').checked = isUnlimited;
    document.getElementById('modal-item-stock').style.display = isUnlimited ? 'none' : '';
    document.getElementById('modal-item-stock').value = isUnlimited ? '' : item.stock;

    // Reset image preview
    const fileInput = document.getElementById('modal-item-image-file');
    fileInput.value = '';
    fileInput._pendingFile = null;
    fileInput._pendingDataUrl = null;
    fileInput._clearExisting = false;
    const preview = document.getElementById('shop-img-preview');
    const placeholder = document.getElementById('shop-img-placeholder');
    const clearBtn = document.getElementById('shop-img-clear-btn');
    const pending = item.itemId && _shopItemPendingImages[item.itemId];
    if (pending) {
        preview.src = pending.dataUrl;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
        clearBtn.style.display = 'inline-flex';
    } else if (item.itemId) {
        const imgSrc = '/api/v1/item-image/shop/' + _guildId + '/' + item.itemId;
        preview.src = imgSrc;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
        clearBtn.style.display = 'inline-flex';
        preview.onerror = function() {
            preview.style.display = 'none';
            placeholder.style.display = 'block';
            clearBtn.style.display = 'none';
        };
    } else {
        preview.style.display = 'none';
        placeholder.style.display = 'block';
        clearBtn.style.display = 'none';
    }
    openModal('item-modal', { initialFocus: 'modal-item-name' });
}

function closeItemModal() { closeModal('item-modal'); }
function toggleStockInput(cb) {
    document.getElementById('modal-item-stock').style.display = cb.checked ? 'none' : '';
}

function saveItemModal() {
    const name = document.getElementById('modal-item-name').value.trim();
    const price = parseInt(document.getElementById('modal-item-price').value, 10);
    if (!name) { toast('Item name is required', 'error'); return; }
    if (!Number.isFinite(price) || price < 0) { toast('Enter a valid price', 'error'); return; }
    const isUnlimited = document.getElementById('modal-item-unlimited').checked;
    const parsedStock = isUnlimited ? -1 : parseInt(document.getElementById('modal-item-stock').value, 10);
    if (!isUnlimited && (!Number.isFinite(parsedStock) || parsedStock < 1)) { toast('Enter a valid stock quantity', 'error'); return; }
    const fileInput = document.getElementById('modal-item-image-file');

    const existingItem = editingItemIdx === -1 ? null : storeItems[editingItemIdx];
    const itemId = (existingItem && existingItem.itemId) ? existingItem.itemId : _genItemId();

    const item = {
        name: name,
        itemId: itemId,
        description: document.getElementById('modal-item-desc').value.trim(),
        price: price,
        roleId: document.getElementById('modal-item-role').value || null,
        stock: Number.isNaN(parsedStock) ? -1 : parsedStock
    };

    if (fileInput._pendingFile) {
        _shopItemPendingImages[itemId] = { file: fileInput._pendingFile, dataUrl: fileInput._pendingDataUrl };
        _shopItemClearedImages.delete(itemId);
    } else if (fileInput._clearExisting) {
        delete _shopItemPendingImages[itemId];
        if (existingItem && existingItem.itemId) _shopItemClearedImages.add(itemId);
    }

    if (editingItemIdx === -1) storeItems.push(item);
    else storeItems[editingItemIdx] = item;
    closeItemModal();
    renderStoreItems();
}

async function deleteItem(idx) {
    const ok = await showConfirm({ title: 'Delete store item', body: 'Remove "' + storeItems[idx].name + '" from the store? This cannot be undone.', okText: 'Delete' });
    if (!ok) return;
    storeItems.splice(idx, 1);
    renderStoreItems();
}

var JOB_TIER_COLORS = ['#2ecc71','#3498db','#9b59b6','#f39c12'];
var JOB_TIER_BADGES = ['🟢','🔵','🟣','🟡'];

function renderJobTiers() {
    const grid = document.getElementById('job-tiers-grid');
    grid.innerHTML = jobTiersList.map(function(t, i) {
        const color = JOB_TIER_COLORS[i] || '#888';
        const badge = JOB_TIER_BADGES[i] || '⚪';
        const isFirst = t.minShifts === 0;
        return '<div class="job-tier-row" style="border-left:3px solid ' + color + '">' +
            '<span class="job-tier-row-badge">' + badge + ' Tier ' + t.tier + '</span>' +
            '<input class="job-tier-name-input" data-tier-idx="' + i + '" data-field="name" value="' + escHtml(t.name) + '" placeholder="Tier name" oninput="updateTierField(this)">' +
            '<div class="job-tier-row-shifts">' +
                '<input type="number" class="job-tier-shifts-input" data-tier-idx="' + i + '" data-field="minShifts" value="' + t.minShifts + '" min="0"' + (isFirst ? ' disabled title="Tier 1 always starts at 0 shifts"' : '') + ' oninput="updateTierField(this)">' +
                '<span class="job-tier-shifts-label">shifts to unlock</span>' +
            '</div>' +
        '</div>';
    }).join('');
}

function updateTierField(el) {
    const idx = parseInt(el.dataset.tierIdx, 10);
    const field = el.dataset.field;
    jobTiersList[idx][field] = field === 'minShifts' ? (parseInt(el.value, 10) || 0) : el.value;
}

var JOB_TIER_META = [
    { tier: 1, label: 'Tier 1 · Intern',            color: '#2ecc71', badge: '🟢' },
    { tier: 2, label: 'Tier 2 · Skilled Worker',    color: '#3498db', badge: '🔵' },
    { tier: 3, label: 'Tier 3 · Senior Specialist', color: '#9b59b6', badge: '🟣' },
    { tier: 4, label: 'Tier 4 · Executive',         color: '#f39c12', badge: '🟡' },
];

function renderJobs() {
    const list = document.getElementById('jobs-list');
    if (!jobsList.length) {
        list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem;padding:.5rem 0">No jobs — click <strong>+ Add job</strong> to add one.</p>';
        return;
    }

    // Sort by tier then name
    const sorted = jobsList.map(function(j, i) { return { job: j, idx: i }; });
    sorted.sort(function(a, b) {
        const ta = a.job.tier || 1, tb = b.job.tier || 1;
        return ta !== tb ? ta - tb : a.job.name.localeCompare(b.job.name);
    });

    // Build tier name lookup from live jobTiersList so names stay in sync
    const tierNameMap = {};
    jobTiersList.forEach(function(t) { tierNameMap[t.tier] = t.name; });

    // Group into tiers
    let html = '';
    let lastTier = null;
    sorted.forEach(function(entry) {
        const job = entry.job, i = entry.idx;
        const tier = job.tier || 1;
        const color = JOB_TIER_COLORS[tier - 1] || '#888';
        const badge = JOB_TIER_BADGES[tier - 1] || '⚪';
        const tierName = tierNameMap[tier] || ('Tier ' + tier);
        if (tier !== lastTier) {
            if (lastTier !== null) html += '</div>';
            html += '<div class="job-tier-group">' +
                '<div class="job-tier-header" style="border-left:3px solid ' + color + '">' +
                    badge + ' <strong>Tier ' + tier + ' · ' + escHtml(tierName) + '</strong>' +
                '</div>';
            lastTier = tier;
        }
        const minPay = job.minPay != null ? job.minPay : '?';
        const maxPay = job.maxPay != null ? job.maxPay : '?';
        html += '<div class="job-chip">' +
            (job.emoji ? '<span class="job-chip-emoji">' + escHtml(job.emoji) + '</span>' : '') +
            '<span class="job-name">' + escHtml(job.name) + '</span>' +
            '<span class="job-pay-badge">💰 ' + minPay + '–' + maxPay + '</span>' +
            '<button class="job-btn" onclick="openJobModal(' + i + ')" title="Edit">✏️</button>' +
            '<button class="job-btn" onclick="deleteJob(' + i + ')" title="Remove" style="font-size:1rem">×</button>' +
        '</div>';
    });
    if (lastTier !== null) html += '</div>';
    list.innerHTML = html;
}

function openJobModal(idx) {
    editingJobIdx = idx;
    document.getElementById('job-modal-title').textContent = idx === -1 ? 'Add Job' : 'Edit Job';
    const job = idx === -1 ? {} : jobsList[idx];
    document.getElementById('modal-job-name').value = job.name || '';
    document.getElementById('modal-job-emoji').value = job.emoji || '';
    document.getElementById('modal-job-tier').value = String(job.tier || 1);
    document.getElementById('modal-job-min-pay').value = job.minPay != null ? job.minPay : '';
    document.getElementById('modal-job-max-pay').value = job.maxPay != null ? job.maxPay : '';
    openModal('job-modal', { initialFocus: 'modal-job-name' });
}

function closeJobModal() { closeModal('job-modal'); }

function saveJobModal() {
    const name = document.getElementById('modal-job-name').value.trim();
    if (!name) { toast('Job name is required', 'error'); return; }
    const minPay = parseInt(document.getElementById('modal-job-min-pay').value, 10);
    const maxPay = parseInt(document.getElementById('modal-job-max-pay').value, 10);
    if (!Number.isFinite(minPay) || minPay < 0) { toast('Enter a valid min pay', 'error'); return; }
    if (!Number.isFinite(maxPay) || maxPay < minPay) { toast('Max pay must be ≥ min pay', 'error'); return; }
    const job = {
        name: name,
        emoji: document.getElementById('modal-job-emoji').value.trim(),
        tier: parseInt(document.getElementById('modal-job-tier').value, 10) || 1,
        minPay: minPay,
        maxPay: maxPay
    };
    if (editingJobIdx === -1) jobsList.push(job);
    else jobsList[editingJobIdx] = job;
    closeJobModal();
    renderJobs();
}

function deleteJob(idx) {
    jobsList.splice(idx, 1);
    renderJobs();
}

onPanel('economy', function() {
    renderStoreItems();
    renderJobTiers();
    renderJobs();
});
onPanel('achievements', function() {
    renderBuiltinAchievements();
    renderCustomAchievements();
});

// Close modals on overlay click
document.addEventListener('click', function(e) {
    if (e.target.id === 'item-modal') closeItemModal();
    if (e.target.id === 'job-modal') closeJobModal();
    if (e.target.id === 'ach-modal') closeAchModal();
});

// ── Delegated handlers for rendered lists ────────────────────────────
// Attacker-influenced values (member nicknames, achievement names, MCP
// server names) ride in data-* attributes and come back out through
// dataset. They must never be concatenated into an inline handler:
// an on*="" attribute is HTML-decoded before it is parsed as JS, so a
// `&#39;` from escHtml turns back into a quote and closes the string it
// was meant to sit inside.
document.addEventListener('click', function(e) {
    const el = e.target.closest && e.target.closest('[data-action]');
    if (!el) return;
    const d = el.dataset;
    if (d.action === 'ach-grant')      openAchGrantModal(d.achId, d.achName);
    else if (d.action === 'summary-delete') deleteSummaryJob(d.jobId);
    else if (d.action === 'persona-remove') removePersona(d.channelId);
    else if (d.action === 'mcp-test')       testMcpServer(d.serverName, el.closest('.list-item') && el.closest('.list-item').querySelector('.mcp-test-result'));
    // The approval mode lives on this tab but is part of the ai document, so
    // it saves through the same section as everything else on the Chat tab.
    else if (d.action === 'mcp-save-confirm') saveSettings('ai');
    else if (d.action === 'mcp-oauth-connect')    startMcpOAuth(d.serverName, el.closest('.list-item') && el.closest('.list-item').querySelector('.mcp-test-result'));
    else if (d.action === 'mcp-oauth-disconnect') disconnectMcpOAuth(d.serverName);
    else if (d.action === 'mcp-edit')       editMcpServer(d.serverName);
    else if (d.action === 'mcp-remove')     removeMcpServer(d.serverName);
    else if (d.action === 'autorole-remove') removeAutoRole(d.roleId);
});

// mousedown, not click: the dropdown is hidden by the input's blur, which
// fires first on a click.
document.addEventListener('mousedown', function(e) {
    const el = e.target.closest && e.target.closest('[data-action="member-select"]');
    if (el) selectGrantMember(el.dataset.memberId, el.dataset.memberName);
});

document.addEventListener('change', function(e) {
    const el = e.target.closest && e.target.closest('[data-builtin-ach-id]');
    if (el) toggleBuiltinAch(el.dataset.builtinAchId, el.checked);
});

// ── Achievements ───────────────────────────────────────────────────────────
var _BUILTIN_ACHS = boot('builtinAchievements');
var _disabledAchievements = boot('disabledAchievements');
var _customAchievements   = boot('customAchievements');
var _editingAchIdx = -1;

var ACH_CAT_LABELS = { economy:'Economy', leveling:'Leveling', hunt:'Hunt', fishing:'Fishing', community:'Community', moderation:'Moderation', custom:'Custom' };
var ACH_CAT_EMOJIS = { economy:'💰', leveling:'📈', hunt:'🏹', fishing:'🎣', community:'👥', moderation:'🛡️', custom:'⚙️' };

function renderBuiltinAchievements() {
    const list = document.getElementById('builtin-ach-list');
    if (!_BUILTIN_ACHS.length) { list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem">No built-in achievements loaded.</p>'; return; }
    list.innerHTML = _BUILTIN_ACHS.map(function(a) {
        const disabled = _disabledAchievements.indexOf(a.id) !== -1;
        const catLabel = (ACH_CAT_EMOJIS[a.category] || '🔹') + ' ' + (ACH_CAT_LABELS[a.category] || a.category);
        return '<div class="store-item-card" style="padding:.6rem .9rem;display:flex;align-items:center;gap:.75rem;">' +
            '<span style="font-size:1.4rem">' + escHtml(a.emoji) + '</span>' +
            '<span style="flex:1"><strong>' + escHtml(a.name) + '</strong> <span style="font-size:.8rem;color:var(--text-dim)">' + catLabel + '</span><br>' +
                '<span style="font-size:.85rem;color:var(--text-mute)">' + escHtml(a.description) + '</span></span>' +
            '<span style="font-size:.8rem;color:var(--text-dim);margin-right:.5rem">' +
                (a.xpReward ? '+' + a.xpReward + ' XP' : '') + (a.xpReward && a.coinReward ? ' · ' : '') + (a.coinReward ? '+' + a.coinReward.toLocaleString() + ' coins' : '') +
            '</span>' +
            '<label class="switch" style="margin:0"><input type="checkbox"' + (disabled ? '' : ' checked') + ' data-builtin-ach-id="' + escHtml(a.id) + '"><span class="slider"></span></label>' +
        '</div>';
    }).join('');
}

function toggleBuiltinAch(id, enabled) {
    if (enabled) {
        _disabledAchievements = _disabledAchievements.filter(function(x) { return x !== id; });
    } else {
        if (_disabledAchievements.indexOf(id) === -1) _disabledAchievements.push(id);
    }
}

function renderCustomAchievements() {
    const list = document.getElementById('custom-ach-list');
    if (!_customAchievements.length) {
        list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem;padding:.25rem 0">No custom achievements yet — click <strong>+ Add achievement</strong> to create one.</p>';
        return;
    }
    list.innerHTML = _customAchievements.map(function(a, i) {
        const catLabel = (ACH_CAT_EMOJIS[a.category] || '🔹') + ' ' + (ACH_CAT_LABELS[a.category] || a.category);
        return '<div class="store-card">' +
            '<div class="store-card-body">' +
                '<div class="store-card-name">' + escHtml(a.emoji || '🏆') + ' ' + escHtml(a.name) + '</div>' +
                '<div class="store-card-desc">' + (a.description ? escHtml(a.description) : '<em style="color:var(--text-mute)">No description</em>') + '</div>' +
                '<div class="store-card-meta">' +
                    '<span class="store-meta-tag">' + catLabel + '</span>' +
                    (a.xpReward ? '<span class="store-meta-tag">+' + a.xpReward + ' XP</span>' : '') +
                    (a.coinReward ? '<span class="store-meta-tag price-tag">+' + Number(a.coinReward).toLocaleString() + ' coins</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="store-card-actions">' +
                '<button class="btn btn-sm" data-action="ach-grant" data-ach-id="' + escHtml(a.id) + '" data-ach-name="' + escHtml(a.name) + '">Grant</button>' +
                '<button class="btn btn-sm" onclick="openAchModal(' + i + ')">Edit</button>' +
                '<button class="btn btn-sm btn-danger" onclick="deleteCustomAch(' + i + ')">Remove</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function openAchModal(idx) {
    _editingAchIdx = idx;
    document.getElementById('ach-modal-title').textContent = idx === -1 ? 'Add Achievement' : 'Edit Achievement';
    const a = idx === -1 ? {} : _customAchievements[idx];
    document.getElementById('modal-ach-name').value     = a.name        || '';
    document.getElementById('modal-ach-desc').value     = a.description || '';
    document.getElementById('modal-ach-emoji').value    = a.emoji       || '🏆';
    document.getElementById('modal-ach-category').value = a.category    || 'custom';
    document.getElementById('modal-ach-xp').value       = a.xpReward    != null ? a.xpReward   : 0;
    document.getElementById('modal-ach-coins').value    = a.coinReward  != null ? a.coinReward  : 0;
    openModal('ach-modal', { initialFocus: 'modal-ach-name' });
}

function closeAchModal() { closeModal('ach-modal'); }

function saveAchModal() {
    const name = document.getElementById('modal-ach-name').value.trim();
    const desc = document.getElementById('modal-ach-desc').value.trim();
    if (!name) { toast('Achievement name is required', 'error'); return; }
    if (!desc) { toast('Description is required', 'error'); return; }
    const entry = {
        id:          (_editingAchIdx === -1 ? 'custom_' + Date.now() : _customAchievements[_editingAchIdx].id),
        name:        name,
        description: desc,
        emoji:       document.getElementById('modal-ach-emoji').value.trim() || '🏆',
        category:    document.getElementById('modal-ach-category').value,
        xpReward:    parseInt(document.getElementById('modal-ach-xp').value,    10) || 0,
        coinReward:  parseInt(document.getElementById('modal-ach-coins').value,  10) || 0
    };
    if (_editingAchIdx === -1) _customAchievements.push(entry);
    else _customAchievements[_editingAchIdx] = entry;
    closeAchModal();
    renderCustomAchievements();
}

async function deleteCustomAch(idx) {
    const ok = await showConfirm({ title: 'Delete achievement', body: 'Remove "' + _customAchievements[idx].name + '"? This cannot be undone.', okText: 'Delete' });
    if (!ok) return;
    _customAchievements.splice(idx, 1);
    renderCustomAchievements();
}

// ── Achievement Grant ───────────────────────────────────────────────────────
var _grantAchId = '';
var _memberSearchTimer = null;
// The in-flight search, so a new keystroke can cancel the one it supersedes.
// Debouncing alone does not order the responses: a slow request for "ali" that
// the server is still working on resolves after the quick one for "alice" and
// repaints the dropdown with results for what the user has stopped typing.
var _memberSearchAbort = null;

function openAchGrantModal(achId, achName) {
    _grantAchId = achId;
    document.getElementById('grant-ach-id').value = achId;
    document.getElementById('grant-ach-name').textContent = achName;
    document.getElementById('grant-member-search').value = '';
    document.getElementById('grant-member-results').style.display = 'none';
    document.getElementById('grant-member-results').innerHTML = '';
    document.getElementById('grant-member-id').value = '';
    document.getElementById('grant-selected-member').style.display = 'none';
    document.getElementById('grant-selected-member').textContent = '';
    openModal('ach-grant-modal', { initialFocus: 'grant-member-search' });
}

function closeAchGrantModal() {
    // Nothing is left running behind a closed modal: the pending keystroke and
    // the request already out both belong to a dropdown that is going away.
    clearTimeout(_memberSearchTimer);
    abortMemberSearch();
    closeModal('ach-grant-modal');
}

function debouncedMemberSearch() {
    clearTimeout(_memberSearchTimer);
    _memberSearchTimer = setTimeout(runMemberSearch, 350);
}

/** Cancel whatever search is in flight; called before starting the next one. */
function abortMemberSearch() {
    if (_memberSearchAbort) _memberSearchAbort.abort();
    _memberSearchAbort = null;
}

async function runMemberSearch() {
    const q = document.getElementById('grant-member-search').value.trim();
    const resultsEl = document.getElementById('grant-member-results');
    abortMemberSearch();
    if (q.length < 2) { resultsEl.style.display = 'none'; return; }
    const guildId = BOOT.guildId;
    const controller = new AbortController();
    _memberSearchAbort = controller;
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/members/search?q=' + encodeURIComponent(q), { signal: controller.signal });
        if (!resp.ok) throw new Error('non-ok');
        const members = (await resp.json()).items || [];
        if (!members.length) {
            resultsEl.innerHTML = '<div style="padding:.5rem .75rem;font-size:.88rem;color:var(--text-dim)">No members found</div>';
        } else {
            resultsEl.innerHTML = members.map(function(m) {
                return '<div class="grant-member-option" style="padding:.45rem .75rem;cursor:pointer;font-size:.88rem;display:flex;align-items:center;gap:.5rem;" ' +
                    'data-action="member-select" data-member-id="' + escHtml(m.id) + '" data-member-name="' + escHtml(m.displayName || m.username) + '">' +
                    (m.avatarURL ? '<img src="' + escHtml(m.avatarURL) + '" alt="" style="width:22px;height:22px;border-radius:50%;">' : '') +
                    '<span>' + escHtml(m.displayName || m.username) + '</span>' +
                    '<span style="color:var(--text-dim);margin-left:auto;font-size:.8rem">' + escHtml(m.id) + '</span>' +
                '</div>';
            }).join('');
        }
        resultsEl.style.display = '';
    } catch (err) {
        // A cancelled request is this widget replacing its own search, not a
        // failure — the newer one is already on its way, and painting an error
        // over its results would be a lie about a search still running.
        if (err && err.name === 'AbortError') return;
        resultsEl.innerHTML = '<div style="padding:.5rem .75rem;font-size:.88rem;color:var(--bad)">Search failed</div>';
        resultsEl.style.display = '';
    } finally {
        if (_memberSearchAbort === controller) _memberSearchAbort = null;
    }
}

function selectGrantMember(userId, displayName) {
    document.getElementById('grant-member-id').value = userId;
    document.getElementById('grant-member-search').value = displayName;
    document.getElementById('grant-member-results').style.display = 'none';
    const sel = document.getElementById('grant-selected-member');
    sel.textContent = 'Selected: ' + displayName + ' (' + userId + ')';
    sel.style.display = '';
}

async function submitAchGrant() {
    const userId = document.getElementById('grant-member-id').value.trim();
    const achId  = document.getElementById('grant-ach-id').value.trim();
    if (!userId) { toast('Select a member first', 'error'); return; }
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/achievements/grant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userId, achievementId: achId })
        });
        const data = await resp.json();
        if (!resp.ok) { toast(data.error || 'Grant failed', 'error'); return; }
        toast(data.granted ? 'Achievement granted!' : 'Member already has this achievement', data.granted ? 'success' : 'info');
        closeAchGrantModal();
    } catch {
        toast('Grant failed', 'error');
    }
}

// ── Leveling Leaderboard ────────────────────────────────────────────────────
var _levelLeaderboardPage = 1;
var _levelLeaderboardLoaded = false;

function loadLevelLeaderboard(page, force) {
    page = page || 1;
    if (_levelLeaderboardLoaded && !force && page === _levelLeaderboardPage) return;
    const skel    = document.getElementById('level-leaderboard-skeleton');
    const err     = document.getElementById('level-leaderboard-error');
    const content = document.getElementById('level-leaderboard-content');
    const empty   = document.getElementById('level-leaderboard-empty');
    skel.style.display = ''; err.style.display = 'none';
    content.style.display = 'none'; empty.style.display = 'none';
    const guildId = BOOT.guildId;
    fetch('/api/v1/guild/' + guildId + '/leveling/leaderboard?page=' + page)
        .then(function(r) { if (!r.ok) throw new Error('non-ok'); return r.json(); })
        .then(function(data) {
            skel.style.display = 'none';
            const entries = data.items || [];
            if (!entries.length) { empty.style.display = ''; return; }
            const medals = ['🥇','🥈','🥉'];
            const tbody = document.getElementById('level-leaderboard-tbody');
            tbody.innerHTML = entries.map(function(u) {
                const rank = medals[u.rank - 1] || u.rank;
                return '<tr><td>' + rank + '</td>' +
                    '<td style="font-family:monospace;font-size:.82rem">' + escHtml(u.userId) + '</td>' +
                    '<td>' + escHtml(String(u.level)) + '</td>' +
                    '<td>' + Number(u.xp).toLocaleString() + '</td>' +
                    '<td>' + Number(u.messages || 0).toLocaleString() + '</td></tr>';
            }).join('');
            const pag = document.getElementById('level-leaderboard-pagination');
            pag.innerHTML = '';
            if (data.pages > 1) {
                if (page > 1) {
                    const prev = document.createElement('button');
                    prev.className = 'btn btn-sm'; prev.textContent = '← Prev';
                    prev.onclick = function() { loadLevelLeaderboard(page - 1, true); };
                    pag.appendChild(prev);
                }
                const info = document.createElement('span');
                info.style.cssText = 'font-size:.85rem;opacity:.7';
                info.textContent = 'Page ' + page + ' of ' + data.pages;
                pag.appendChild(info);
                if (page < data.pages) {
                    const next = document.createElement('button');
                    next.className = 'btn btn-sm'; next.textContent = 'Next →';
                    next.onclick = function() { loadLevelLeaderboard(page + 1, true); };
                    pag.appendChild(next);
                }
            }
            content.style.display = '';
            _levelLeaderboardLoaded = true;
            _levelLeaderboardPage = page;
        })
        .catch(function() {
            skel.style.display = 'none';
            err.style.display = '';
        });
}

// ── Leveling Admin Actions ──────────────────────────────────────────────────
async function levelAdminAction(action) {
    const guildId = BOOT.guildId;
    const userId  = document.getElementById('level-admin-user-id').value.trim();
    const amount  = parseInt(document.getElementById('level-admin-amount').value, 10);
    const msgEl   = document.getElementById('level-admin-msg');
    if (!userId) { msgEl.style.color = 'var(--bad)'; msgEl.textContent = 'Enter a Discord user ID.'; return; }
    if (['give','take','set_level'].includes(action) && (!Number.isFinite(amount) || amount < 0)) {
        msgEl.style.color = 'var(--bad)'; msgEl.textContent = 'Enter a valid amount / level.'; return;
    }
    msgEl.style.color = ''; msgEl.textContent = 'Working…';
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/leveling/adjust', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action, amount })
        });
        const data = await resp.json();
        if (!resp.ok) { msgEl.style.color = 'var(--bad)'; msgEl.textContent = data.error || 'Failed.'; return; }
        msgEl.style.color = 'var(--good)';
        msgEl.textContent = 'Done — level: ' + data.level + ' · XP: ' + Number(data.xp).toLocaleString();
        loadLevelLeaderboard(1, true);
    } catch {
        msgEl.style.color = 'var(--bad)'; msgEl.textContent = 'Request failed.';
    }
}

// ── Leveling Boost Events ──────────────────────────────────────────────────
async function startBoostEvent() {
    const guildId    = BOOT.guildId;
    const multiplier = parseFloat(document.getElementById('boost-multiplier').value);
    const hours      = parseInt(document.getElementById('boost-duration').value, 10);
    const msgEl      = document.getElementById('level-boost-msg');
    if (!Number.isFinite(multiplier) || multiplier < 1.1) { msgEl.style.color = 'var(--bad)'; msgEl.textContent = 'Multiplier must be at least 1.1×.'; return; }
    if (!Number.isFinite(hours) || hours < 1) { msgEl.style.color = 'var(--bad)'; msgEl.textContent = 'Duration must be at least 1 hour.'; return; }
    msgEl.style.color = ''; msgEl.textContent = 'Activating…';
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/leveling/xp-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ multiplier, durationHours: hours })
        });
        const data = await resp.json();
        if (!resp.ok) { msgEl.style.color = 'var(--bad)'; msgEl.textContent = data.error || 'Failed.'; return; }
        msgEl.style.color = 'var(--good)'; msgEl.textContent = '';
        const active = document.getElementById('level-boost-active');
        const end = new Date(data.endTime);
        active.style.display = '';
        active.innerHTML = '⚡ <strong>' + multiplier + '× XP boost active</strong> — expires ' + end.toLocaleString();
    } catch {
        msgEl.style.color = 'var(--bad)'; msgEl.textContent = 'Request failed.';
    }
}

// ── Reaction Roles ─────────────────────────────────────────────────────────
var rrRoles = boot('roles');

function addRrMapping() {
    const list = document.getElementById('rr-mappings-list');
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 2fr auto;gap:.5rem;align-items:center;';
    row.innerHTML =
        '<input type="text" placeholder="Emoji (e.g. 👍)" class="rr-emoji" style="font-size:1.1rem;" aria-label="Emoji">' +
        '<select class="rr-role" aria-label="Role to assign"><option value="">Select role</option>' +
        rrRoles.map(function(r) { return '<option value="' + r.id + '">@' + escHtml(r.name) + '</option>'; }).join('') +
        '</select>' +
        '<button class="btn btn-sm btn-danger" type="button" onclick="this.parentElement.remove()">×</button>';
    list.appendChild(row);
}

async function publishRrPanel() {
    const channelId = document.getElementById('rr-channel').value;
    if (!channelId) { toast('Select a target channel', 'error'); return; }

    const rows = document.querySelectorAll('#rr-mappings-list > div');
    const mappings = [];
    rows.forEach(function(row) {
        const emoji = row.querySelector('.rr-emoji').value.trim();
        const roleId = row.querySelector('.rr-role').value;
        if (emoji && roleId) mappings.push({ emoji: emoji, roleId: roleId });
    });

    if (!mappings.length) { toast('Add at least one emoji → role mapping', 'error'); return; }

    const guildId = BOOT.guildId;
    try {
        const response = await fetch('/api/v1/guild/' + guildId + '/reactionrole/panel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channelId: channelId,
                title: document.getElementById('rr-title').value.trim() || null,
                description: document.getElementById('rr-description').value.trim() || null,
                mappings: mappings
            })
        });
        const data = await response.json();
        if (response.ok) {
            toast('Panel published', 'success');
            setTimeout(function() { location.reload(); }, 800);
        } else {
            toast(data.error || 'Failed to publish panel', 'error');
        }
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

async function deleteRrPanel(messageId) {
    const ok = await showConfirm({ title: 'Delete reaction role panel', body: 'Delete this panel? The Discord message will also be permanently deleted and all reaction mappings will be removed.', okText: 'Delete panel' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const response = await fetch('/api/v1/guild/' + guildId + '/reactionrole/panel/' + messageId, { method: 'DELETE' });
        if (response.ok) {
            toast('Panel deleted', 'success');
            setTimeout(function() { location.reload(); }, 600);
        } else {
            toast('Failed to delete panel', 'error');
        }
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

// ── Knowledge Base ─────────────────────────────────────────────────────
var kbLoaded = false;
// The page currently on screen, so that adding, editing or deleting an entry
// reloads the page the admin was looking at rather than dropping them back to
// the first one. The list is paged now (#583) — before, everything past the
// hundredth entry simply did not come back.
var kbPage = 1;

async function loadKnowledgeBase(page) {
    if (kbLoaded && page === undefined) return;
    const wanted = page || kbPage;
    const guildId = BOOT.guildId;
    const skel = document.getElementById('kb-skeleton');
    const err  = document.getElementById('kb-error');
    if (skel) skel.style.display = '';
    if (err)  err.style.display  = 'none';
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/knowledge-base?page=' + wanted);
        if (!resp.ok) throw new Error('non-ok');
        const data = await resp.json();
        const pages = data.pages || 1;
        // Deleting the last entry on the last page shrinks the collection out
        // from under the page number the admin is on. One step back, not a
        // loop: `pages` is at least 1, so the retry always lands.
        if (wanted > pages) {
            kbLoaded = false;
            return loadKnowledgeBase(pages);
        }
        kbLoaded = true;
        kbPage = data.page || wanted;
        if (skel) skel.style.display = 'none';
        renderKbEntries(data.items || []);
        renderKbPagination(kbPage, pages, data.total || 0);
    } catch {
        if (skel) skel.style.display = 'none';
        if (err)  err.style.display  = '';
    }
}

function retryLoadKnowledgeBase() { kbLoaded = false; loadKnowledgeBase(); }

function renderKbEntries(entries) {
    const container = document.getElementById('kb-list');
    if (!Array.isArray(entries) || !entries.length) {
        container.innerHTML = '<div class="empty-state" style="padding:2rem 1.5rem;"><h3>No entries yet</h3><p>Add your first knowledge base entry below.</p></div>';
        return;
    }
    container.innerHTML = '';
    entries.forEach(function(entry) {
        container.appendChild(buildKbRow(entry));
    });
}

// Built with createElement and .onclick rather than innerHTML: the page's CSP
// allows no inline handlers, and `total` is a number from our own API but the
// rest of this file has settled on not interpolating anything into markup.
function renderKbPagination(page, pages, total) {
    const pag = document.getElementById('kb-pagination');
    if (!pag) return;
    pag.innerHTML = '';
    if (pages <= 1) return;
    if (page > 1) {
        const prev = document.createElement('button');
        prev.className = 'btn btn-sm';
        prev.textContent = '← Prev';
        prev.onclick = function() { loadKnowledgeBase(page - 1); };
        pag.appendChild(prev);
    }
    const info = document.createElement('span');
    info.className = 'pager-info';
    info.textContent = 'Page ' + page + ' of ' + pages + ' (' + total + ' entries)';
    pag.appendChild(info);
    if (page < pages) {
        const next = document.createElement('button');
        next.className = 'btn btn-sm';
        next.textContent = 'Next →';
        next.onclick = function() { loadKnowledgeBase(page + 1); };
        pag.appendChild(next);
    }
}

function buildKbRow(entry) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.id = 'kb-row-' + entry._id;
    const preview = entry.content.length > 120 ? entry.content.slice(0, 120) + '…' : entry.content;
    const tagsHtml = (entry.tags && entry.tags.length)
        ? '<div style="margin-top:.3rem;">' + entry.tags.map(function(t) { return '<span style="background:var(--surface-2);border-radius:4px;padding:1px 6px;font-size:.76rem;margin-right:4px;">' + escHtml(t) + '</span>'; }).join('') + '</div>'
        : '';
    div.innerHTML =
        '<div style="min-width:0;flex:1;">' +
            '<strong>' + escHtml(entry.title) + '</strong>' +
            '<div style="color:var(--text-mute);font-size:.82rem;margin-top:.2rem;">' + escHtml(preview) + '</div>' +
            tagsHtml +
        '</div>' +
        '<div style="display:flex;gap:.5rem;flex-shrink:0;">' +
            '<button class="btn btn-sm kb-edit-btn" data-id="' + entry._id + '" data-title="' + encodeURIComponent(entry.title) + '" data-content="' + encodeURIComponent(entry.content) + '" data-tags="' + encodeURIComponent((entry.tags||[]).join(',')) + '">Edit</button>' +
            '<button class="btn btn-danger btn-sm kb-delete-btn" data-id="' + entry._id + '">Remove</button>' +
        '</div>';
    return div;
}

function editKbEntry(id, encodedTitle, encodedContent, encodedTags) {
    const row = document.getElementById('kb-row-' + id);
    if (!row) return;
    const title = decodeURIComponent(encodedTitle);
    const content = decodeURIComponent(encodedContent);
    const tags = decodeURIComponent(encodedTags);
    row.innerHTML =
        '<div style="flex:1;display:flex;flex-direction:column;gap:.5rem;">' +
            '<input id="kb-edit-title-' + id + '" class="field-input" value="' + escHtml(title) + '" placeholder="Title" style="width:100%;">' +
            '<textarea id="kb-edit-content-' + id + '" rows="4" style="width:100%;resize:vertical;" placeholder="Content">' + escHtml(content) + '</textarea>' +
            '<input id="kb-edit-tags-' + id + '" class="field-input" value="' + escHtml(tags) + '" placeholder="Tags (comma-separated)" style="width:100%;">' +
            '<div style="display:flex;gap:.5rem;">' +
                '<button class="btn btn-primary btn-sm kb-save-btn" data-id="' + id + '">Save</button>' +
                '<button class="btn btn-sm kb-cancel-btn">Cancel</button>' +
            '</div>' +
        '</div>';
}

function cancelKbEdit() {
    kbLoaded = false;
    loadKnowledgeBase();
}

async function saveKbEntry(id) {
    const guildId = BOOT.guildId;
    const title = document.getElementById('kb-edit-title-' + id).value.trim();
    const content = document.getElementById('kb-edit-content-' + id).value.trim();
    const tagsRaw = document.getElementById('kb-edit-tags-' + id).value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [];
    if (!title || !content) { toast('Title and content are required', 'error'); return; }
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/knowledge-base/' + id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title, content: content, tags: tags })
        });
        const data = await resp.json();
        if (resp.ok) {
            toast('Entry updated', 'success');
            kbLoaded = false;
            loadKnowledgeBase();
        } else {
            toast(data.error || 'Failed to update entry', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

async function addKbEntry() {
    const guildId = BOOT.guildId;
    const title = document.getElementById('kb-title').value.trim();
    const content = document.getElementById('kb-content').value.trim();
    const tagsRaw = document.getElementById('kb-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [];
    if (!title || !content) { toast('Title and content are required', 'error'); return; }
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/knowledge-base', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title, content: content, tags: tags })
        });
        const data = await resp.json();
        if (resp.ok) {
            toast('Entry added', 'success');
            document.getElementById('kb-title').value = '';
            document.getElementById('kb-content').value = '';
            document.getElementById('kb-tags').value = '';
            kbLoaded = false;
            // Newest first, so the entry just added is on page 1 whatever page
            // the admin was reading.
            loadKnowledgeBase(1);
        } else {
            toast(data.error || 'Failed to add entry', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

async function deleteKbEntry(id) {
    const ok = await showConfirm({ title: 'Delete knowledge base entry', body: 'Remove this entry? The AI will no longer have access to this context.', okText: 'Delete' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/knowledge-base/' + id, { method: 'DELETE' });
        if (resp.ok) {
            toast('Entry removed', 'success');
            kbLoaded = false;
            loadKnowledgeBase();
        } else {
            toast('Failed to remove entry', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

// KB static button listeners (inline onclick blocked by CSP)
onPanel('ai', function() {
    const addBtn = document.getElementById('kb-add-btn');
    if (addBtn) addBtn.addEventListener('click', addKbEntry);
    const retryBtn = document.getElementById('kb-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', retryLoadKnowledgeBase);
    const kbList = document.getElementById('kb-list');
    if (kbList) {
        kbList.addEventListener('click', function(e) {
            const t = e.target;
            if (t.classList.contains('kb-edit-btn')) {
                editKbEntry(t.dataset.id, t.dataset.title, t.dataset.content, t.dataset.tags);
            } else if (t.classList.contains('kb-delete-btn')) {
                deleteKbEntry(t.dataset.id);
            } else if (t.classList.contains('kb-save-btn')) {
                saveKbEntry(t.dataset.id);
            } else if (t.classList.contains('kb-cancel-btn')) {
                cancelKbEdit();
            }
        });
    }
});

// ── AI Summaries ──────────────────────────────────────────────────────────
var summaryJobsLoaded = false;
var _channelNameMap = boot('channelNames');

async function loadSummaryJobs() {
    if (summaryJobsLoaded) return;
    const guildId = BOOT.guildId;
    const skel = document.getElementById('summary-jobs-skeleton');
    const err  = document.getElementById('summary-jobs-error');
    if (skel) skel.style.display = '';
    if (err)  err.style.display  = 'none';
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/summary-jobs');
        if (!resp.ok) throw new Error('non-ok');
        const data = await resp.json();
        summaryJobsLoaded = true;
        if (skel) skel.style.display = 'none';
        // One request is the whole list: the create route caps a guild at ten
        // jobs and the endpoint's default page size is that same cap, so there
        // is no pager here to go stale.
        renderSummaryJobs(data.items || []);
    } catch {
        if (skel) skel.style.display = 'none';
        if (err)  err.style.display  = '';
    }
}

function retryLoadSummaryJobs() { summaryJobsLoaded = false; loadSummaryJobs(); }

function renderSummaryJobs(jobs) {
    const container = document.getElementById('summary-jobs-list');
    if (!Array.isArray(jobs) || !jobs.length) {
        container.innerHTML = '<div class="empty-state" style="padding:2rem 1.5rem;"><h3>No summary jobs yet</h3><p>Add your first scheduled summary below.</p></div>';
        return;
    }
    container.innerHTML = '';
    jobs.forEach(function(job) {
        const div = document.createElement('div');
        div.className = 'list-item';
        const hh = String(job.hour).padStart(2, '0');
        const mm = String(job.minute).padStart(2, '0');
        const srcName = _channelNameMap[job.sourceChannelId] ? '#' + escHtml(_channelNameMap[job.sourceChannelId]) : escHtml(job.sourceChannelId);
        const tgtName = _channelNameMap[job.targetChannelId] ? '#' + escHtml(_channelNameMap[job.targetChannelId]) : escHtml(job.targetChannelId);
        const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString() : 'Never';
        div.innerHTML =
            '<div style="min-width:0;flex:1;">' +
                '<strong>' + escHtml(job.label) + '</strong>' +
                '<div style="color:var(--text-mute);font-size:.82rem;margin-top:.2rem;">' +
                    srcName + ' → ' + tgtName + ' · Daily at ' + hh + ':' + mm + ' UTC · Last run: ' + escHtml(lastRun) +
                '</div>' +
            '</div>' +
            '<button class="btn btn-danger btn-sm" data-action="summary-delete" data-job-id="' + escHtml(job._id) + '">Remove</button>';
        container.appendChild(div);
    });
}

async function saveDailyDigest() {
    const guildId = BOOT.guildId;
    const enabled = document.getElementById('digest-enabled').checked;
    const channelId = document.getElementById('digest-channel').value;
    const sourceOpts = Array.from(document.getElementById('digest-sources').selectedOptions).map(o => o.value);
    const hourRaw = document.getElementById('digest-hour').value.trim();
    const minuteRaw = document.getElementById('digest-minute').value.trim();
    const tzInput = document.getElementById('digest-timezone');
    const timezone = tzInput.value.trim() || 'UTC';

    if (enabled && !channelId) { toast('Please select a digest channel', 'error'); return; }
    const hour = parseInt(hourRaw, 10);
    const minute = parseInt(minuteRaw, 10);
    if (!/^\d+$/.test(hourRaw) || hour < 0 || hour > 23) { toast('Hour must be a number between 0 and 23', 'error'); return; }
    if (!/^\d+$/.test(minuteRaw) || minute < 0 || minute > 59) { toast('Minute must be a number between 0 and 59', 'error'); return; }
    if (!validateTimezoneInput(tzInput)) { toast('Please enter a valid IANA timezone (e.g. UTC, America/New_York)', 'error'); return; }

    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/daily-digest', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, channelId, sourceChannelIds: sourceOpts, hour, minute, timezone })
        });
        const data = await resp.json();
        if (resp.ok) {
            toast('Daily digest settings saved', 'success');
        } else {
            toast(data.error || 'Failed to save digest settings', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

async function addSummaryJob() {
    const guildId = BOOT.guildId;
    const sourceChannelId = document.getElementById('summary-source').value;
    const targetChannelId = document.getElementById('summary-target').value;
    const hour = parseInt(document.getElementById('summary-hour').value, 10);
    const minute = parseInt(document.getElementById('summary-minute').value, 10);
    const label = document.getElementById('summary-label').value.trim();
    if (!sourceChannelId || !targetChannelId) { toast('Please select both source and target channels', 'error'); return; }
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/summary-jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceChannelId: sourceChannelId, targetChannelId: targetChannelId, hour: hour, minute: minute, label: label })
        });
        const data = await resp.json();
        if (resp.ok) {
            toast('Summary job added', 'success');
            document.getElementById('summary-source').value = '';
            document.getElementById('summary-target').value = '';
            document.getElementById('summary-hour').value = '9';
            document.getElementById('summary-minute').value = '0';
            document.getElementById('summary-label').value = '';
            summaryJobsLoaded = false;
            loadSummaryJobs();
        } else {
            toast(data.error || 'Failed to add summary job', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

async function deleteSummaryJob(jobId) {
    const ok = await showConfirm({ title: 'Delete summary job', body: 'Remove this scheduled summary job? It will no longer run.', okText: 'Delete' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/summary-jobs/' + jobId, { method: 'DELETE' });
        if (resp.ok) {
            toast('Summary job removed', 'success');
            summaryJobsLoaded = false;
            loadSummaryJobs();
        } else {
            toast('Failed to remove summary job', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

// ── AI Personas ───────────────────────────────────────────────────────────
var _personas = boot('personas');

function updatePersonaChannelWarning() {
    const aiChannel = document.getElementById('ai-channel');
    const warning = document.getElementById('persona-channel-warning');
    if (!aiChannel || !warning) return;
    warning.style.display = aiChannel.value ? '' : 'none';
}

onPanel('ai', function() {
    const aiChannel = document.getElementById('ai-channel');
    if (aiChannel) aiChannel.addEventListener('change', updatePersonaChannelWarning);
});

function renderPersonas() {
    updatePersonaChannelWarning();
    const container = document.getElementById('personas-list');
    if (!container) return;
    if (!_personas.length) {
        container.innerHTML = '<div class="empty-state" style="padding:2rem 1.5rem;"><h3>No personas configured</h3><p>Add a persona below to give the AI a distinct identity in specific channels.</p></div>';
        return;
    }
    container.innerHTML = '';
    _personas.forEach(function(p) {
        const div = document.createElement('div');
        div.className = 'list-item';
        const chanName = _channelNameMap[p.channelId] ? '#' + escHtml(_channelNameMap[p.channelId]) : escHtml(p.channelId);
        const preview = p.systemPrompt.length > 120 ? p.systemPrompt.slice(0, 120) + '…' : p.systemPrompt;
        div.innerHTML =
            '<div style="min-width:0;flex:1;">' +
                '<strong>' + escHtml(p.personaName) + '</strong> <span style="color:var(--text-mute);font-size:.85rem;">(' + chanName + ')</span>' +
                '<div style="color:var(--text-mute);font-size:.82rem;margin-top:.2rem;">' + escHtml(preview) + '</div>' +
            '</div>' +
            '<button class="btn btn-danger btn-sm" data-action="persona-remove" data-channel-id="' + escHtml(p.channelId) + '">Remove</button>';
        container.appendChild(div);
    });
}

async function addPersona() {
    const guildId = BOOT.guildId;
    const channelId = document.getElementById('persona-channel').value;
    const personaName = document.getElementById('persona-name').value.trim();
    const systemPrompt = document.getElementById('persona-prompt').value.trim();
    if (!channelId || !personaName || !systemPrompt) { toast('All fields are required', 'error'); return; }
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/persona', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId: channelId, personaName: personaName, systemPrompt: systemPrompt })
        });
        const data = await resp.json();
        if (resp.ok) {
            toast('Persona saved', 'success');
            document.getElementById('persona-channel').value = '';
            document.getElementById('persona-name').value = '';
            document.getElementById('persona-prompt').value = '';
            _personas = data.personas || [];
            renderPersonas();
        } else {
            toast(data.error || 'Failed to save persona', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

async function removePersona(channelId) {
    const ok = await showConfirm({ title: 'Remove persona', body: 'Remove this channel persona? The AI will revert to the default system prompt for this channel.', okText: 'Remove' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/persona/' + encodeURIComponent(channelId), { method: 'DELETE' });
        if (resp.ok) {
            toast('Persona removed', 'success');
            _personas = _personas.filter(function(p) { return p.channelId !== channelId; });
            renderPersonas();
        } else {
            toast('Failed to remove persona', 'error');
        }
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

// Initialize personas when the AI panel arrives (data came with the bootstrap)
onPanel('ai', renderPersonas);

// ── MCP connections ─────────────────────────────────────────────────
// Servers are fetched rather than templated: the response is the one
// place that knows which are editable, and tokens never come back with
// it (the API returns hasToken, never the value).
var _mcpServers = null;
var _mcpGlobal = [];
var _mcpPresets = [];
var _mcpEditable = true;
var _mcpMaxServers = 10;
var _mcpEditing = null;
// { openai: { label: 'OpenAI', mcp: 'client' }, ... } — how each provider
// reaches MCP servers, so the note below the heading can answer for whatever is
// selected in the Chat tab right now, not only for what was saved.
var _mcpProviderSupport = {};
// Which route a Claude request would take right now. 'auto' is a question, not
// an answer, so the panel is told both.
var _mcpEffectiveRoute = null;
// Whether loadMcpServers() has put the guild's stored values into the approval
// and route controls. Until it has, they hold their markup defaults and must
// not be saved over what is stored.
var _mcpHydrated = false;

function mcpEl(id) { return document.getElementById(id); }

async function loadMcpServers(force) {
    if (_mcpServers && !force) { renderMcpServers(); return; }
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/mcp-servers');
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed to load');
        _mcpServers = data.servers || [];
        _mcpGlobal = data.globalServers || [];
        _mcpPresets = data.presets || [];
        _mcpEditable = data.editable !== false;
        _mcpMaxServers = data.maxServers || 10;
        _mcpProviderSupport = data.providerSupport || {};
        if (mcpEl('mcp-confirm') && data.confirmMode) mcpEl('mcp-confirm').value = data.confirmMode;
        if (mcpEl('mcp-route') && data.mcpRoute) mcpEl('mcp-route').value = data.mcpRoute;
        _mcpEffectiveRoute = data.effectiveRoute || null;
        // Set only on the success path: a load that failed leaves the controls
        // showing defaults that are not the guild's.
        _mcpHydrated = Boolean(mcpEl('mcp-confirm') && mcpEl('mcp-route'));
        renderMcpPresets();
        renderMcpServers(data.provider);
        loadMcpUsage();
    } catch (e) {
        console.error(e);
        const list = mcpEl('mcp-list');
        if (list) list.innerHTML = '<div class="empty-state" style="padding:1.5rem;"><p>Could not load MCP connections.</p></div>';
    }
}

function renderMcpPresets() {
    const select = mcpEl('mcp-preset');
    if (!select) return;
    select.innerHTML = '<option value="">Custom server…</option>';
    _mcpPresets.forEach(function(preset) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.label;
        select.appendChild(opt);
    });
}

var MCP_DEFAULT_PRESET_HINT = 'Pick a known service to prefill its endpoint, or enter any remote MCP server URL yourself.';
var MCP_DEFAULT_URL_PLACEHOLDER = 'https://api.example.com/mcp/';
var MCP_DEFAULT_TOKEN_HINT = 'Stored on the bot and sent to the MCP server when a tool is called — by Anthropic when Claude is your provider, by the bot itself otherwise. It is never shown again once saved.';

function resetMcpHints() {
    mcpEl('mcp-preset-hint').textContent = MCP_DEFAULT_PRESET_HINT;
    mcpEl('mcp-token-hint').textContent = MCP_DEFAULT_TOKEN_HINT;
    mcpEl('mcp-url').placeholder = MCP_DEFAULT_URL_PLACEHOLDER;
}

function applyMcpPreset() {
    const select = mcpEl('mcp-preset');
    const preset = _mcpPresets.find(function(p) { return p.id === select.value; });
    if (!preset) {
        resetMcpHints();
        return;
    }
    mcpEl('mcp-name').value = preset.name;
    // Some services have no single hosted endpoint — the server is one you run,
    // so the URL is the one field the preset cannot fill in. Its placeholder
    // shows the shape of the address, and the hint says whose it is.
    mcpEl('mcp-url').value = preset.url || '';
    mcpEl('mcp-url').placeholder = preset.urlPlaceholder || MCP_DEFAULT_URL_PLACEHOLDER;
    if (preset.suggestedBlockedTools && preset.suggestedBlockedTools.length) {
        mcpEl('mcp-blocked').value = preset.suggestedBlockedTools.join(', ');
    }

    mcpEl('mcp-preset-hint').textContent = preset.hint || MCP_DEFAULT_PRESET_HINT;
    mcpEl('mcp-token-hint').textContent = preset.tokenHint
        || (preset.requiresToken === false
            ? 'This service needs no token — leave it empty.'
            : MCP_DEFAULT_TOKEN_HINT);
    if (!preset.url) mcpEl('mcp-url').focus();
}

// What the selected provider does with these connections. Every provider the
// bot ships can use them — Anthropic through its own connector, the rest through
// the bot's MCP client — so this is a note about *how*, and only turns into a
// warning if a provider ever cannot.
function renderMcpProviderNote(provider) {
    const note = mcpEl('mcp-provider-note');
    if (!note) return;

    const selected = provider || (mcpEl('ai-provider') ? mcpEl('ai-provider').value : null);
    const support = selected ? _mcpProviderSupport[selected] : null;
    if (!selected || !support) { note.style.display = 'none'; return; }

    const label = support.label || selected;
    note.style.display = '';
    if (!support.mcp) {
        note.className = 'mcp-note mcp-note-warn';
        note.textContent = '⚠️ ' + label + ', your provider in the Chat tab, cannot use MCP connections, so these are inactive.';
    } else if (support.mcp === 'native') {
        note.className = 'mcp-note';
        note.textContent = '🔌 ' + label + ' is your provider in the Chat tab. Anthropic connects to these servers and calls their tools directly.';
    } else {
        note.className = 'mcp-note';
        note.textContent = '🔌 ' + label + ' is your provider in the Chat tab. Clawdia connects to these servers and offers their tools to the model — '
            + 'a model that does not support tool calling will simply never use one.';
    }
}

// The route only means anything on Claude: every other provider has always had
// exactly one way to reach a server.
function renderMcpRoute(provider) {
    const selected = provider || (mcpEl('ai-provider') ? mcpEl('ai-provider').value : null);
    const applies = selected === 'anthropic';

    ['mcp-route-head', 'mcp-route-field'].forEach(function(id) {
        const el = mcpEl(id);
        if (el) el.classList.toggle('mcp-hidden', !applies);
    });

    const hint = mcpEl('mcp-route-hint');
    const select = mcpEl('mcp-route');
    if (!applies || !hint || !select) return;

    const base = hint.dataset.base || hint.textContent;
    hint.dataset.base = base;
    hint.textContent = select.value === 'auto' && _mcpEffectiveRoute
        ? base + ' Right now automatic resolves to ' +
            (_mcpEffectiveRoute === 'client' ? "Clawdia's own client." : "Anthropic's connector.")
        : base;
}

function renderMcpServers(provider) {
    renderMcpProviderNote(provider);
    renderMcpRoute(provider);
    const disabledWarn = mcpEl('mcp-disabled-warning');
    if (disabledWarn) disabledWarn.style.display = _mcpEditable ? 'none' : '';
    updateMcpFormState();

    const container = mcpEl('mcp-list');
    if (!container) return;
    if (!_mcpServers || !_mcpServers.length) {
        container.innerHTML = '<div class="empty-state" style="padding:2rem 1.5rem;"><h3>No connections yet</h3><p>Add one below to let Claude use another service\'s tools during a conversation.</p></div>';
    } else {
        container.innerHTML = '';
        _mcpServers.forEach(function(srv) {
            const bits = [];
            // An OAuth grant (#796) replaces the token rather than sitting
            // beside it, so it is the same slot in the summary line.
            if (srv.oauth) {
                let credential = '🔓 signed in to ' + shortHost(srv.oauth.issuer);
                if (!srv.oauth.renewable) credential += ' (cannot renew — will need reconnecting)';
                bits.push(credential);
            } else {
                bits.push(srv.hasToken ? '🔑 token stored' : 'no token');
            }
            if (srv.allowedTools.length) bits.push('only ' + srv.allowedTools.length + ' tool(s)');
            if (srv.blockedTools.length) bits.push(srv.blockedTools.length + ' blocked');
            if ((srv.confirmTools || []).length) bits.push(srv.confirmTools.length + ' need approval');
            if (srv.resources) bits.push('📚 documents in context');
            const div = document.createElement('div');
            div.className = 'list-item';
            div.innerHTML =
                '<div style="min-width:0;flex:1;">' +
                    '<strong>' + escHtml(srv.name) + '</strong>' +
                    (srv.enabled ? '' : ' <span style="color:var(--text-mute);font-size:.8rem;">(disabled)</span>') +
                    '<div style="color:var(--text-mute);font-size:.82rem;margin-top:.2rem;word-break:break-all;">' + escHtml(srv.url) + '</div>' +
                    '<div style="color:var(--text-mute);font-size:.78rem;margin-top:.15rem;">' + escHtml(bits.join(' · ')) + '</div>' +
                    '<div class="mcp-test-result"></div>' +
                '</div>' +
                '<div style="display:flex;gap:.4rem;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" data-action="mcp-test" data-server-name="' + escHtml(srv.name) + '">Test</button>' +
                    (srv.oauth
                        ? '<button class="btn btn-sm" data-action="mcp-oauth-disconnect" data-server-name="' + escHtml(srv.name) + '">Sign out</button>'
                        : '<button class="btn btn-sm" data-action="mcp-oauth-connect" data-server-name="' + escHtml(srv.name) + '">Connect</button>') +
                    '<button class="btn btn-sm" data-action="mcp-edit" data-server-name="' + escHtml(srv.name) + '">Edit</button>' +
                    '<button class="btn btn-danger btn-sm" data-action="mcp-remove" data-server-name="' + escHtml(srv.name) + '">Remove</button>' +
                '</div>';
            container.appendChild(div);
        });
    }

    const globalBox = mcpEl('mcp-global-list');
    if (globalBox) {
        if (!_mcpGlobal.length) {
            globalBox.innerHTML = '';
        } else {
            globalBox.innerHTML =
                '<div class="mcp-note">🌐 The bot operator has also configured these for every server: ' +
                _mcpGlobal.map(function(g) { return '<code>' + escHtml(g.name) + '</code>'; }).join(', ') +
                '. Add one here with the same name to override it.</div>';
        }
    }
}

// Adding is blocked when the operator turned dashboard servers off, or
// when the guild is already at its cap. Editing an existing connection
// stays available in the cap case — it does not add another one.
function updateMcpFormState() {
    const atCap = !_mcpEditing && (_mcpServers || []).length >= _mcpMaxServers;
    const locked = !_mcpEditable || atCap;

    ['mcp-preset', 'mcp-url', 'mcp-token', 'mcp-allowed', 'mcp-blocked', 'mcp-enabled', 'mcp-save-btn'].forEach(function(id) {
        if (mcpEl(id)) mcpEl(id).disabled = locked;
    });
    // The name is fixed while editing — the API keys the record on it.
    if (mcpEl('mcp-name')) mcpEl('mcp-name').disabled = locked || Boolean(_mcpEditing);

    const capWarn = mcpEl('mcp-cap-warning');
    if (capWarn) {
        capWarn.style.display = _mcpEditable && atCap ? '' : 'none';
        capWarn.textContent = '⚠️ This server is at the limit of ' + _mcpMaxServers +
            ' connections. Remove one before adding another.';
    }
}

function splitToolNames(value) {
    return value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function resetMcpForm() {
    _mcpEditing = null;
    ['mcp-name', 'mcp-url', 'mcp-token', 'mcp-allowed', 'mcp-blocked', 'mcp-confirm-tools'].forEach(function(id) {
        if (mcpEl(id)) mcpEl(id).value = '';
    });
    mcpEl('mcp-preset').value = '';
    mcpEl('mcp-enabled').checked = true;
    if (mcpEl('mcp-resources')) mcpEl('mcp-resources').checked = false;
    mcpEl('mcp-form-title').textContent = 'Add a connection';
    mcpEl('mcp-save-btn').textContent = 'Add connection';
    mcpEl('mcp-cancel-btn').style.display = 'none';
    mcpEl('mcp-token').placeholder = 'Bearer token, if the server needs one';
    resetMcpHints();
    updateMcpFormState();
}

function editMcpServer(name) {
    const srv = (_mcpServers || []).find(function(s) { return s.name === name; });
    if (!srv) return;
    _mcpEditing = name;
    mcpEl('mcp-preset').value = '';
    resetMcpHints();
    mcpEl('mcp-name').value = srv.name;
    mcpEl('mcp-url').value = srv.url;
    mcpEl('mcp-token').value = '';
    mcpEl('mcp-token').placeholder = srv.hasToken ? '•••••••••• (leave empty to keep)' : 'Bearer token, if the server needs one';
    mcpEl('mcp-allowed').value = srv.allowedTools.join(', ');
    mcpEl('mcp-blocked').value = srv.blockedTools.join(', ');
    mcpEl('mcp-confirm-tools').value = (srv.confirmTools || []).join(', ');
    mcpEl('mcp-enabled').checked = srv.enabled;
    if (mcpEl('mcp-resources')) mcpEl('mcp-resources').checked = Boolean(srv.resources);
    mcpEl('mcp-form-title').textContent = 'Edit ' + srv.name;
    mcpEl('mcp-save-btn').textContent = 'Save changes';
    mcpEl('mcp-cancel-btn').style.display = '';
    updateMcpFormState();
    mcpEl('mcp-form-title').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveMcpServer() {
    const guildId = BOOT.guildId;
    const name = (_mcpEditing || mcpEl('mcp-name').value).trim();
    const url = mcpEl('mcp-url').value.trim();
    if (!name || !url) { toast('Name and URL are required', 'error'); return; }

    const body = {
        url: url,
        enabled: mcpEl('mcp-enabled').checked,
        allowedTools: splitToolNames(mcpEl('mcp-allowed').value),
        blockedTools: splitToolNames(mcpEl('mcp-blocked').value),
        confirmTools: splitToolNames(mcpEl('mcp-confirm-tools').value),
        resources: Boolean(mcpEl('mcp-resources') && mcpEl('mcp-resources').checked)
    };
    // Only send the token when one was typed — an absent field means
    // "keep whatever is stored", which is how editing without
    // re-entering the secret works.
    const token = mcpEl('mcp-token').value;
    if (token) body.authorizationToken = token;

    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        if (!resp.ok) { toast(data.error || 'Failed to save connection', 'error'); return; }
        toast('Connection saved', 'success');
        _mcpServers = data.servers || [];
        resetMcpForm();
        renderMcpServers();
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

async function removeMcpServer(name) {
    const ok = await showConfirm({
        title: 'Remove connection',
        body: 'Remove "' + name + '"? The model will lose access to its tools, and the stored token is deleted.',
        okText: 'Remove'
    });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name), { method: 'DELETE' });
        const data = await resp.json();
        if (!resp.ok) { toast(data.error || 'Failed to remove', 'error'); return; }
        toast('Connection removed', 'success');
        _mcpServers = data.servers || [];
        if (_mcpEditing === name) resetMcpForm();
        renderMcpServers();
    } catch (e) {
        console.error(e);
        toast('An error occurred', 'error');
    }
}

// `out` is located relative to the clicked button rather than by an id
// built from the server name — a name is operator-supplied text and does
// not survive round-tripping through an id selector.
async function testMcpServer(name, out) {
    const guildId = BOOT.guildId;
    if (out) { out.className = 'mcp-test-result'; out.textContent = 'Testing…'; }
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name) + '/test', { method: 'POST' });
        const data = await resp.json();
        if (!out) return;
        const okay = resp.ok && data.success;
        out.className = 'mcp-test-result ' + (okay ? 'ok' : 'bad');
        out.textContent = (okay ? '✓ ' : '✗ ') + (data.message || data.error || (okay ? 'Connected' : 'Failed'));
        // Tool names come from the server, so they are set as text on their own
        // element rather than concatenated into any markup.
        // Resources and prompts are the two halves of the protocol that are not
        // tools: documents this connection can answer questions from, and
        // templates `/ai mcp prompt` can run. Worth saying, because the
        // documents switch below means nothing on a server that publishes none.
        if (okay && (data.resourceCount || data.promptCount)) {
            const extra = document.createElement('small');
            extra.className = 'mcp-test-tools';
            const parts = [];
            if (data.resourceCount) parts.push(data.resourceCount + ' resource(s)');
            if (data.promptCount) parts.push(data.promptCount + ' prompt(s)');
            extra.textContent = 'Also publishes: ' + parts.join(' and ');
            out.appendChild(extra);
        }
        // A 401 asking for a login rather than a bad token. The Connect button
        // is already on the row; this says which button to press.
        if (!okay && data.needsOAuth) {
            const hint = document.createElement('small');
            hint.className = 'mcp-test-tools';
            hint.textContent = 'This server wants a login rather than a token — press Connect.';
            out.appendChild(hint);
        }
        if (okay && Array.isArray(data.tools) && data.tools.length) {
            const names = document.createElement('small');
            names.className = 'mcp-test-tools';
            const shown = data.tools.slice(0, 12);
            names.textContent = 'Tools: ' + shown.join(', ')
                + (data.tools.length > shown.length ? ', and ' + (data.tools.length - shown.length) + ' more' : '');
            out.appendChild(names);
        }
    } catch (e) {
        console.error(e);
        if (out) { out.className = 'mcp-test-result bad'; out.textContent = '✗ Request failed'; }
    }
}

/** An issuer URL as the host an admin would recognise, for the summary line. */
function shortHost(issuer) {
    try { return new URL(issuer).host; } catch (_err) { return issuer || 'the server'; }
}

/**
 * Start the OAuth flow for one connection (#796).
 *
 * The authorization URL is opened in a new tab rather than followed here: the
 * admin needs the dashboard still sitting where it was when they come back, and
 * the callback closes its own tab with a message. A popup blocker is the one
 * failure worth handling — the URL is offered as a link instead, since the
 * flow's state is already stored and waiting.
 */
async function startMcpOAuth(name, out) {
    const guildId = BOOT.guildId;
    if (out) { out.className = 'mcp-test-result'; out.textContent = 'Finding this server\u2019s login…'; }
    try {
        const resp = await fetch(
            '/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name) + '/oauth/start',
            { method: 'POST' }
        );
        const data = await resp.json();

        if (!resp.ok || !data.authorizationUrl) {
            if (out) {
                out.className = 'mcp-test-result bad';
                out.textContent = '\u2717 ' + (data.error || 'Could not start the login');
                if (data.redirectUri) {
                    const hint = document.createElement('small');
                    hint.className = 'mcp-test-tools';
                    hint.textContent = 'Redirect URI to register: ' + data.redirectUri;
                    out.appendChild(hint);
                }
            }
            return;
        }

        // `noopener` in the feature string makes window.open return null even
        // when it succeeded, which would make every successful sign-in read as
        // a blocked popup. The handle is what tells the two apart, so the
        // opener is severed on the returned window instead — same protection,
        // and the detection below keeps working.
        const opened = window.open(data.authorizationUrl, '_blank');
        if (opened) opened.opener = null;
        if (out) {
            out.className = 'mcp-test-result';
            out.textContent = opened
                ? 'Sign in to ' + shortHost(data.issuer) + ' in the new tab, then reload this page.'
                : 'Your browser blocked the popup. Open this link to sign in:';
            if (!opened) {
                const link = document.createElement('a');
                link.href = data.authorizationUrl;
                link.target = '_blank';
                link.rel = 'noopener';
                link.className = 'mcp-test-tools';
                link.textContent = 'Sign in to ' + shortHost(data.issuer);
                out.appendChild(link);
            }
        }
    } catch (e) {
        console.error(e);
        if (out) { out.className = 'mcp-test-result bad'; out.textContent = '\u2717 Request failed'; }
    }
}

/** Forget a grant. The connection stays, unauthenticated, ready to reconnect. */
async function disconnectMcpOAuth(name) {
    const ok = await showConfirm({
        title: 'Sign out of connection',
        body: 'Sign out of "' + name + '"? The connection stays, but the bot will not be able to use it until you connect again.',
        okText: 'Sign out'
    });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch(
            '/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name) + '/oauth',
            { method: 'DELETE' }
        );
        const data = await resp.json();
        if (!resp.ok) return toast(data.error || 'Could not sign out', 'error');
        toast('Signed out of ' + name, 'success');
        loadMcpServers(true);
    } catch (e) {
        console.error(e);
        toast('Request failed', 'error');
    }
}

// ── MCP activity ────────────────────────────────────────────────────
//
// What the connections have actually been doing, which is the half the Test
// button cannot answer: a server that worked when it was tested and has been
// timing out every turn since looks identical from the form.

function mcpSeconds(ms) {
    if (!ms) return '';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
}

// Tool and server names come from the far side, so every one of them is set as
// text on its own node. Nothing here is concatenated into markup.
function mcpUsageLine(parent, text, muted) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'font-size:.8rem;' + (muted ? 'color:var(--text-mute);' : '');
    parent.appendChild(el);
    return el;
}

function mcpCountsFor(row) {
    const bits = [row.calls + (row.calls === 1 ? ' call' : ' calls')];
    if (row.failures) bits.push(row.failures + ' failed');
    if (row.declined) bits.push(row.declined + ' not approved');
    if (row.avgMs) bits.push('avg ' + mcpSeconds(row.avgMs));
    return bits.join(' · ');
}

async function loadMcpUsage() {
    const box = mcpEl('mcp-usage');
    if (!box) return;

    try {
        const resp = await fetch('/api/v1/guild/' + BOOT.guildId + '/mcp-servers/usage');
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'failed');
        renderMcpUsage(data.servers || []);
    } catch (e) {
        console.error(e);
        box.textContent = 'Could not load activity.';
        box.style.cssText = 'font-size:.82rem;color:var(--text-mute);';
    }
}

function renderMcpUsage(servers) {
    const box = mcpEl('mcp-usage');
    if (!box) return;
    box.textContent = '';
    box.style.cssText = '';

    if (!servers.length) {
        box.innerHTML = '<div class="empty-state" style="padding:1.25rem 1.5rem;"><p>No tool calls in the last 7 days.</p></div>';
        return;
    }

    servers.forEach(function(srv) {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.style.cssText = 'display:block;';

        const head = document.createElement('strong');
        head.textContent = srv.server;
        item.appendChild(head);

        mcpUsageLine(item, mcpCountsFor(srv), true);

        // A connection that could not be reached made no calls, so it needs
        // saying separately or a dead server reads as an unused one.
        if (srv.unreachable) {
            mcpUsageLine(item, '⚠️ unreachable on ' + srv.unreachable + ' ' + (srv.unreachable === 1 ? 'turn' : 'turns'));
        }

        srv.tools.slice(0, 8).forEach(function(tool) {
            mcpUsageLine(item, '· ' + tool.tool + ' — ' + mcpCountsFor(tool), true);
        });
        if (srv.tools.length > 8) {
            mcpUsageLine(item, '· and ' + (srv.tools.length - 8) + ' more', true);
        }

        if (srv.lastError) {
            mcpUsageLine(item, '⚠️ last error: ' + srv.lastError, true);
        }

        box.appendChild(item);
    });
}

// ── Prompt editor: char counter + full-screen modal ─────────────────
function updatePromptCount(textareaId) {
    const ta = document.getElementById(textareaId);
    const counter = document.getElementById(textareaId + '-count');
    if (!ta || !counter) return;
    const max = parseInt(ta.getAttribute('maxlength'), 10) || 4000;
    const len = ta.value.length;
    counter.textContent = len + ' / ' + max;
    counter.classList.toggle('over', len >= max);
}

var _promptEditorTarget = null;
// Only the commit shortcut: Escape is the shared dialog machinery's job now.
function _promptEditorKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        closePromptEditor(true);
    }
}
function openPromptEditor(textareaId, title) {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    _promptEditorTarget = textareaId;
    document.getElementById('prompt-editor-title').textContent = title || 'Edit prompt';
    const editor = document.getElementById('prompt-editor-textarea');
    editor.value = ta.value;
    editor.setAttribute('maxlength', ta.getAttribute('maxlength') || 4000);
    updatePromptEditorCount();
    document.addEventListener('keydown', _promptEditorKeydown);
    openModal('prompt-editor-modal', {
        initialFocus: editor,
        // Escape and backdrop click discard the edit, matching Cancel.
        onDismiss: function() { closePromptEditor(false); }
    });
}
function updatePromptEditorCount() {
    const editor = document.getElementById('prompt-editor-textarea');
    const counter = document.getElementById('prompt-editor-count');
    const max = parseInt(editor.getAttribute('maxlength'), 10) || 4000;
    const len = editor.value.length;
    counter.textContent = len + ' / ' + max;
    counter.classList.toggle('over', len >= max);
}
function closePromptEditor(commit) {
    const modal = document.getElementById('prompt-editor-modal');
    if (commit && _promptEditorTarget) {
        const ta = document.getElementById(_promptEditorTarget);
        if (ta) {
            ta.value = document.getElementById('prompt-editor-textarea').value;
            updatePromptCount(_promptEditorTarget);
        }
    }
    closeModal(modal);
    document.removeEventListener('keydown', _promptEditorKeydown);
    _promptEditorTarget = null;
}
// Initialize counters when the AI panel arrives
onPanel('ai', function() {
    updatePromptCount('ai-prompt');
    updatePromptCount('persona-prompt');
});

// ── AI Token Usage ──────────────────────────────────────────────────
function formatTokens(n) {
    if (n == null) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
}
function formatCost(n, costKnown) {
    if (n == null) return '';
    if (!costKnown && n === 0) return 'cost unavailable';
    const prefix = costKnown ? '' : '≥ ';
    if (n < 0.01 && n > 0) return prefix + '< $0.01';
    return prefix + '$' + n.toFixed(2);
}
function renderSparkline(daily) {
    const svg = document.getElementById('ai-usage-sparkline');
    if (!svg) return;
    const W = 280, H = 60, pad = 4;
    const values = daily.map(function(d) { return d.inputTokens + d.outputTokens; });
    let max = Math.max.apply(null, values.concat([1]));
    if (max <= 0) max = 1;
    const n = values.length;
    // Build bars instead of a line — easier to read for small token counts
    const barW = Math.max(2, (W - pad * 2) / n - 2);
    let bars = '';
    for (let i = 0; i < n; i++) {
        const v = values[i];
        const h = max > 0 ? (v / max) * (H - pad * 2) : 0;
        const x = pad + i * ((W - pad * 2) / n);
        const y = H - pad - h;
        bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
                '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) +
                '" fill="currentColor" opacity="' + (v > 0 ? 0.7 : 0.2) + '">' +
                '<title>' + daily[i].day + ': ' + formatTokens(v) + ' tokens</title></rect>';
    }
    svg.innerHTML = bars;
    svg.style.color = 'var(--accent, #7aa7ff)';
}
function renderUsageBreakdown(byModel) {
    const el = document.getElementById('ai-usage-breakdown');
    if (!el) return;
    if (!byModel.length) { el.innerHTML = ''; return; }
    const rows = byModel
        .sort(function(a, b) { return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens); })
        .map(function(m) {
            const total = m.inputTokens + m.outputTokens;
            const costStr = m.costKnown ? '$' + (m.cost || 0).toFixed(4) : '—';
            return '<tr>' +
                '<td>' + escHtml(m.provider) + '</td>' +
                '<td>' + escHtml(m.model) + '</td>' +
                '<td class="num">' + m.requestCount + '</td>' +
                '<td class="num">' + formatTokens(total) + '</td>' +
                '<td class="num">' + costStr + '</td>' +
            '</tr>';
        }).join('');
    el.innerHTML =
        '<div style="margin-bottom:.4rem;color:var(--text);font-weight:600;">This month, by model</div>' +
        '<table><thead><tr>' +
            '<th>Provider</th><th>Model</th>' +
            '<th style="text-align:right;">Reqs</th>' +
            '<th style="text-align:right;">Tokens</th>' +
            '<th style="text-align:right;">Est. cost</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
}
// What is left of the monthly ceiling, when one is set.
//
// The same numbers enforcement reads — a panel that showed a different figure
// from the one refusing people's messages would be worse than showing none.
function renderUsageBudget(budget) {
    const el = document.getElementById('ai-usage-budget');
    if (!el) return;
    if (!budget || (!budget.tokens && !budget.cost)) { el.innerHTML = ''; return; }

    const bars = [];
    if (budget.tokens) {
        bars.push(budgetBar('Monthly tokens',
            formatTokens(budget.tokens.used) + ' of ' + formatTokens(budget.tokens.limit),
            formatTokens(budget.tokens.remaining) + ' left',
            budget.tokens.used / budget.tokens.limit));
    }
    if (budget.cost) {
        bars.push(budgetBar('Monthly cost',
            '$' + budget.cost.used.toFixed(2) + ' of $' + budget.cost.limit.toFixed(2)
                + (budget.cost.complete ? '' : ' (partial — some models have no pricing)'),
            '$' + budget.cost.remaining.toFixed(2) + ' left',
            budget.cost.used / budget.cost.limit));
    }
    el.innerHTML = bars.join('');
}

function budgetBar(label, usedStr, leftStr, ratio) {
    const pct = Math.min(100, Math.max(0, ratio * 100));
    const spent = pct >= 100;
    const fill = 'ai-usage-budget-fill' + (spent ? ' spent' : pct >= 80 ? ' near' : '');
    return '<div class="ai-usage-budget-row">' +
        '<div class="ai-usage-budget-head">' +
            '<span>' + escHtml(label) + ': ' + escHtml(usedStr) + '</span>' +
            '<span class="ai-usage-budget-left">' + escHtml(spent ? 'budget reached' : leftStr) + '</span>' +
        '</div>' +
        '<div class="ai-usage-budget-track">' +
            '<div class="' + fill + '" style="width:' + pct.toFixed(1) + '%"></div>' +
        '</div></div>';
}

async function loadAiUsage() {
    const guildId = BOOT.guildId;
    const statusEl = document.getElementById('ai-usage-status');
    try {
        const resp = await fetch('/api/v1/guild/' + guildId + '/ai/usage?days=14');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        document.getElementById('ai-usage-today-tokens').textContent = formatTokens(data.today.tokens);
        document.getElementById('ai-usage-week-tokens').textContent  = formatTokens(data.week.tokens);
        document.getElementById('ai-usage-month-tokens').textContent = formatTokens(data.month.tokens);
        document.getElementById('ai-usage-today-cost').textContent = formatCost(data.today.cost, data.costKnown);
        document.getElementById('ai-usage-week-cost').textContent  = formatCost(data.week.cost, data.costKnown);
        document.getElementById('ai-usage-month-cost').textContent = formatCost(data.month.cost, data.costKnown);
        renderSparkline(data.daily || []);
        renderUsageBreakdown(data.byModel || []);
        renderUsageBudget(data.budget);

        const rl = data.rateLimit || {};
        const rlParts = [];
        if (rl.perUser)    rlParts.push(rl.perUser + '/user');
        if (rl.perChannel) rlParts.push(rl.perChannel + '/channel');
        const rlStr = rlParts.length
            ? 'Limit: ' + rlParts.join(', ') + ' per ' + (rl.windowMin || 10) + 'm'
            : 'No rate limit set';
        statusEl.textContent = rlStr;
    } catch (e) {
        console.error('Failed to load AI usage:', e);
        statusEl.textContent = 'Failed to load usage';
        throw e;
    }
}
// Lazy-load AI usage stats the first time the AI panel becomes visible.
// Watches the AI panel's `.active` class so it works for nav clicks, hash
// routing, and initial page load without coupling to the nav implementation.
onPanel('ai', function(aiPanel) {
    if (!aiPanel) return;
    let loaded = false;
    let inFlight = false;
    function check() {
        if (loaded || inFlight) return;
        if (!aiPanel.classList.contains('active')) return;
        inFlight = true;
        loadAiUsage()
            .then(function() { loaded = true; })
            .catch(function() { /* leave `loaded` false so a later view retries */ })
            .finally(function() { inFlight = false; });
    }
    check();
    const obs = new MutationObserver(check);
    obs.observe(aiPanel, { attributes: true, attributeFilter: ['class'] });
});

// ── Leveling: No-XP role tag-input ──────────────────────────────────
function addLevelNoXpRole() {
    const sel = document.getElementById('level-no-xp-roles-select');
    const roleId = sel.value;
    const roleName = sel.options[sel.selectedIndex]?.text || roleId;
    if (!roleId) { toast('Please select a role', 'error'); return; }
    if (document.querySelector(`#level-no-xp-roles-list [data-role-id="${CSS.escape(roleId)}"]`)) {
        toast('Role already added', 'error'); return;
    }
    const list = document.getElementById('level-no-xp-roles-list');
    const tag = document.createElement('span');
    tag.className = 'role-tag';
    tag.dataset.roleId = roleId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.onclick = () => tag.remove();
    tag.textContent = roleName + ' ';
    tag.appendChild(btn);
    list.appendChild(tag);
    sel.value = '';
}
function removeLevelNoXpRole(roleId) {
    const el = document.querySelector(`#level-no-xp-roles-list [data-role-id="${CSS.escape(roleId)}"]`);
    if (el) el.remove();
}

// ── Leveling: No-XP channel tag-input ───────────────────────────────
function addLevelNoXpChannel() {
    const sel = document.getElementById('level-no-xp-channels-select');
    const channelId = sel.value;
    const channelName = sel.options[sel.selectedIndex]?.text || channelId;
    if (!channelId) { toast('Please select a channel', 'error'); return; }
    if (document.querySelector(`#level-no-xp-channels-list [data-channel-id="${CSS.escape(channelId)}"]`)) {
        toast('Channel already added', 'error'); return;
    }
    const list = document.getElementById('level-no-xp-channels-list');
    const tag = document.createElement('span');
    tag.className = 'role-tag';
    tag.dataset.channelId = channelId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.onclick = () => tag.remove();
    tag.textContent = channelName + ' ';
    tag.appendChild(btn);
    list.appendChild(tag);
    sel.value = '';
}
function removeLevelNoXpChannel(channelId) {
    const el = document.querySelector(`#level-no-xp-channels-list [data-channel-id="${CSS.escape(channelId)}"]`);
    if (el) el.remove();
}

// ── Leveling: role reward table ──────────────────────────────────────
function addLevelRoleReward() {
    const list = document.getElementById('level-role-rewards-list');
    const row = document.createElement('div');
    row.className = 'level-reward-row';
    row.style.cssText = 'display:flex;gap:.5rem;align-items:center';
    const sourceSelect = document.getElementById('level-no-xp-roles-select');
    const newSelect = sourceSelect.cloneNode(true);
    newSelect.removeAttribute('id');
    newSelect.removeAttribute('aria-label');
    newSelect.className = 'level-reward-role';
    newSelect.setAttribute('aria-label', 'Reward role');
    newSelect.value = '';
    const levelInput = document.createElement('input');
    levelInput.type = 'number';
    levelInput.className = 'level-reward-level';
    levelInput.min = 1;
    levelInput.max = 999;
    levelInput.style.width = '80px';
    levelInput.placeholder = 'Level';
    levelInput.setAttribute('aria-label', 'Required level');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.type = 'button';
    delBtn.title = 'Remove';
    delBtn.textContent = '×';
    delBtn.onclick = () => row.remove();
    row.appendChild(levelInput);
    row.appendChild(newSelect);
    row.appendChild(delBtn);
    list.appendChild(row);
}
function removeLevelRoleReward(btn) {
    btn.closest('.level-reward-row').remove();
}

// ── Season Pass: tier reward row builder ─────────────────────────────
function addSeasonTierRow() {
    const list = document.getElementById('season-tier-rewards-list');
    const row = document.createElement('div');
    row.className = 'season-tier-row';
    row.style.cssText = 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap';
    const roleRef = document.querySelector('#season-tier-rewards-list .season-tier-role')
                 || document.getElementById('level-no-xp-roles-select');
    const roleOptionsHtml = roleRef
        ? '<option value="">No role</option>' + Array.from(roleRef.options)
            .filter(function(o) { return o.value; })
            .map(function(o) { return '<option value="' + escHtml(o.value) + '">' + escHtml(o.text) + '</option>'; })
            .join('')
        : '<option value="">No role</option>';
    row.innerHTML =
        '<input type="number" class="season-tier-num" min="1" style="width:70px" placeholder="Tier" aria-label="Tier number">' +
        '<input type="number" class="season-tier-coins" min="0" style="width:90px" placeholder="Coins" aria-label="Coin reward">' +
        '<select class="season-tier-role" aria-label="Reward role">' + roleOptionsHtml + '</select>' +
        '<input type="text" class="season-tier-label" style="flex:1;min-width:100px" placeholder="Label (e.g. Bronze Tier)" aria-label="Tier label">' +
        '<button class="btn btn-danger" type="button" onclick="this.closest(\'.season-tier-row\').remove()" title="Remove">&times;</button>';
    list.appendChild(row);
}

// ── Getting Started checklist ────────────────────────────────────────
function initGettingStarted() {
    const guildId = BOOT.guildId;
    const key = `gs_dismissed_${guildId}`;
    if (localStorage.getItem(key) === '1') {
        const wrap = document.getElementById('getting-started-wrap');
        if (wrap) wrap.style.display = 'none';
        return;
    }
    const steps = document.querySelectorAll('.gs-step');
    const total = steps.length;
    const done = Array.from(steps).filter(s => s.classList.contains('on')).length;
    const sub = document.getElementById('gs-subtitle');
    if (sub) sub.textContent = `${done} of ${total} steps complete`;
    if (done >= total) {
        const wrap = document.getElementById('getting-started-wrap');
        if (wrap) wrap.style.display = 'none';
    }
}
onPanel('overview', initGettingStarted);
function toggleGettingStarted() {
    const body = document.getElementById('getting-started-body');
    const icon = document.getElementById('gs-toggle-icon');
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? '' : 'none';
    if (icon) icon.textContent = isHidden ? '▾' : '▸';
}
function dismissGettingStarted() {
    const guildId = BOOT.guildId;
    localStorage.setItem(`gs_dismissed_${guildId}`, '1');
    const wrap = document.getElementById('getting-started-wrap');
    if (wrap) wrap.style.display = 'none';
}

// ── Overview live stats ──────────────────────────────────────────────
async function loadOverviewStats() {
    const guildId = BOOT.guildId;
    try {
        const [statsResp, insightsResp] = await Promise.all([
            fetch(`/api/v1/guild/${guildId}/stats`),
            fetch(`/api/v1/guild/${guildId}/insights`)
        ]);
        if (!statsResp.ok || !insightsResp.ok) throw new Error('stats fetch failed');
        const stats = await statsResp.json();
        const insights = await insightsResp.json();
        const a = stats.analytics || {};
        const ret = insights.retention || {};

        // Members KPI
        const joins7 = ret.joins7 ?? 0;
        const leaves7 = ret.leaves7 ?? 0;
        const net7 = joins7 - leaves7;
        const memberVal = document.getElementById('kpi-members-value');
        const memberFoot = document.getElementById('kpi-members-foot');
        if (memberVal) memberVal.textContent = net7 >= 0 ? `+${net7}` : `${net7}`;
        if (memberFoot) memberFoot.textContent = `${joins7} joined · ${leaves7} left (7d)`;
        if (memberVal) memberVal.style.color = net7 >= 0 ? 'var(--good)' : 'var(--danger, #e05)';

        // Bot Status KPI
        const botVal = document.getElementById('kpi-bot-value');
        const botFoot = document.getElementById('kpi-bot-foot');
        if (botVal) { botVal.textContent = 'Online'; botVal.style.fontSize = '34px'; }
        if (botFoot) { botFoot.textContent = '● Active'; botFoot.style.color = 'var(--good)'; }

        // Moderation KPI
        const modCmds = ['warn','mute','kick','ban','timeout','unmute','unban'];
        const modTotal = modCmds.reduce((sum, cmd) => sum + (a.commandUsage?.[cmd]?.total || 0), 0);
        const modVal = document.getElementById('kpi-mod-value');
        const modFoot = document.getElementById('kpi-mod-foot');
        if (modVal) modVal.textContent = modTotal;
        if (modFoot) modFoot.textContent = modTotal === 1 ? 'action this week' : 'actions this week';

        // Economy KPI
        const ecoActive = a.economyStats?.activeUsers ?? 0;
        const ecoVal = document.getElementById('kpi-eco-value');
        if (ecoVal) ecoVal.textContent = ecoActive.toLocaleString();

        // Leveling KPI
        const topLevel = stats.topLevels?.[0]?.level ?? 0;
        const levelVal = document.getElementById('kpi-level-value');
        const levelFoot = document.getElementById('kpi-level-foot');
        if (levelVal) levelVal.textContent = topLevel;
        if (levelFoot) levelFoot.textContent = topLevel ? 'highest member level' : 'no levels yet';

        // AI KPI
        const aiCmds = ['ask', 'ai', 'chat', 'aiask', 'clawdia'];
        const aiTotal = aiCmds.reduce((sum, cmd) => sum + (a.commandUsage?.[cmd]?.total || 0), 0);
        const aiVal = document.getElementById('kpi-ai-value');
        const aiFoot = document.getElementById('kpi-ai-foot');
        if (aiVal) aiVal.textContent = aiTotal.toLocaleString();
        if (aiFoot) aiFoot.textContent = aiTotal === 1 ? 'AI request' : 'AI requests';

        // Ask Clawdia recommendations
        const recs = a.recommendations || [];
        const msgEl = document.getElementById('clawdia-msg');
        const actionsEl = document.getElementById('clawdia-actions');
        if (msgEl) {
            if (recs.length > 0) {
                msgEl.innerHTML = recs.slice(0, 3).map(r =>
                    `<div style="display:flex;gap:.5rem;align-items:flex-start;margin-bottom:.4rem"><span style="color:var(--accent,#f90);flex-shrink:0">💡</span><span>${r}</span></div>`
                ).join('');
            } else {
                msgEl.innerHTML = `<b>Everything looks good on ${escHtml(BOOT.guildName)}.</b><br><span style="opacity:.7">No active recommendations right now.</span>`;
            }
        }
        if (actionsEl) {
            actionsEl.innerHTML = `
                <button class="dash-bot-btn" onclick="document.querySelector('.nav-item[data-tab=analytics]').click()">Open Analytics →</button>
                <button class="dash-bot-btn" onclick="document.querySelector('.nav-item[data-tab=moderation]').click()" style="background:transparent;">Configure Moderation</button>
            `;
        }

        // Recent Activity feed
        const feed = document.getElementById('overview-activity-feed');
        const lastUpdated = document.getElementById('overview-last-updated');
        if (lastUpdated) lastUpdated.textContent = 'updated just now';
        if (feed) {
            const items = [];
            if (joins7 > 0 || leaves7 > 0) {
                items.push({ icon: '👥', text: `${joins7} joined, ${leaves7} left in the last 7 days`, color: net7 >= 0 ? 'var(--good)' : 'inherit' });
            }
            if (modTotal > 0) {
                items.push({ icon: '🛡️', text: `${modTotal} moderation action${modTotal === 1 ? '' : 's'} recorded recently` });
            }
            const churnAlerts = a.churnAlerts || [];
            for (const alert of churnAlerts.slice(0, 2)) {
                items.push({ icon: '⚠️', text: alert, color: 'var(--warn, #f90)' });
            }
            if (recs.length > 0) {
                items.push({ icon: '💡', text: `${recs.length} recommendation${recs.length === 1 ? '' : 's'} available — see Ask Clawdia above` });
            }
            if (items.length === 0) {
                items.push({ icon: '✓', text: 'No notable activity signals right now. Check Analytics for deeper insights.' });
            }
            feed.innerHTML = items.map(it =>
                `<div style="display:flex;gap:.6rem;align-items:flex-start;padding:.4rem 0;border-bottom:1px solid rgba(255,255,255,.05)">
                    <span style="flex-shrink:0;font-size:1rem">${it.icon}</span>
                    <span style="font-size:.875rem;color:${it.color || 'inherit'}">${it.text}</span>
                </div>`
            ).join('');
        }
    } catch {
        const msgEl = document.getElementById('clawdia-msg');
        if (msgEl) msgEl.innerHTML = `Open <a href="#" onclick="document.querySelector('.nav-item[data-tab=analytics]').click();return false">Analytics</a> to review server health.`;
        const actionsEl = document.getElementById('clawdia-actions');
        if (actionsEl) actionsEl.innerHTML = `<button class="dash-bot-btn" onclick="document.querySelector('.nav-item[data-tab=analytics]').click()">Open Analytics →</button>`;
        const memberVal = document.getElementById('kpi-members-value');
        const modVal = document.getElementById('kpi-mod-value');
        const botVal2 = document.getElementById('kpi-bot-value');
        const botFoot2 = document.getElementById('kpi-bot-foot');
        if (memberVal) memberVal.textContent = '—';
        if (modVal) modVal.textContent = '—';
        if (botVal2) { botVal2.textContent = 'Online'; botVal2.style.fontSize = '34px'; }
        if (botFoot2) { botFoot2.textContent = '● Active'; botFoot2.style.color = 'var(--good)'; }
        const feed = document.getElementById('overview-activity-feed');
        if (feed) feed.innerHTML = '<span style="opacity:.4;font-size:.85em">Could not load activity data.</span>';
    }
}
onPanel('overview', loadOverviewStats);

let _analyticsData = null;
let _analyticsInsights = null;
let _chartMemberGrowth = null;
let _chartCommandActivity = null;
let _chartRetention = null;
let _chartEconomy = null;
let _chartLeveling = null;
let _chartAiRequests = null;
let _analyticsRange = 7;

function setAnalyticsRange(days, btn) {
    _analyticsRange = days;
    document.querySelectorAll('.analytics-range').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (_analyticsData) renderAnalyticsCharts(_analyticsData, _analyticsInsights).catch(chartsUnavailable);
}

/** The rest of the analytics panel is readable without its charts, so a library
 *  that would not load is reported and left there rather than failing the tab. */
function chartsUnavailable(err) {
    console.error('[dashboard]', err);
    toast('Charts could not be loaded', 'error');
}

const _chartDefaults = {
    responsive: true,
    plugins: { legend: { labels: { color: '#ece4d2', font: { size: 11 } } } },
    scales: { x: { ticks: { color: '#b8a898', maxTicksLimit: 8 } }, y: { ticks: { color: '#b8a898' } } }
};

// ── Chart.js, fetched when a chart is actually going to be drawn (#685) ────
//
// This used to be a <script> in the page head pointing at cdn.jsdelivr.net at a
// floating `chart.js@4` with no integrity attribute: 200 KB downloaded and
// parsed on every guild-settings page, and one third-party origin allowed to
// execute whatever it resolved to that day on a page whose CSP is otherwise a
// per-request nonce. It is vendored under /vendor/ now, so script-src is back
// to 'self' alone.
//
// Injected on the first chart rather than in the head because only the
// Analytics panel and the Economy panel's Health tab draw one, and most
// sessions open neither.
let _chartJsLoad = null;

function loadChartJs() {
    if (window.Chart) return Promise.resolve();
    // One promise shared by every caller: the analytics panel starts six charts
    // in a row and each of them asks.
    if (_chartJsLoad) return _chartJsLoad;
    _chartJsLoad = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = BOOT.chartJsUrl;
        script.onload = () => resolve();
        script.onerror = () => {
            // Forgotten, so reopening the tab retries rather than settling
            // against a load that never happened.
            _chartJsLoad = null;
            reject(new Error('Could not load Chart.js'));
        };
        document.head.appendChild(script);
    });
    return _chartJsLoad;
}

/**
 * Give a chart the accessible equivalent a <canvas> cannot have (#669).
 *
 * A canvas is an opaque bitmap. With no ARIA it is announced as nothing at
 * all, so six charts made the whole Insights panel — and the economy command
 * breakdown — unreadable to a screen reader, WCAG 1.1.1. Each chart gets two
 * things instead: a role="img" carrying a one-line summary of what it shows,
 * and the series itself as a real <table> alongside, visually hidden but
 * navigable with table commands.
 *
 * Built from the same arrays the chart is drawn from, and called whether or
 * not Chart.js loaded — so when the library is unavailable the numbers are
 * still there rather than the panel being simply blank.
 *
 * @param {string} canvasId id of the <canvas>; the table goes in `<id>-data`
 * @param {object} spec     { title, summary, columns, rows }
 */
function describeChart(canvasId, { title, summary, columns = [], rows = [] }) {
    const canvas = document.getElementById(canvasId);
    if (canvas) {
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', summary || `${title} — no data yet`);
    }

    const host = document.getElementById(`${canvasId}-data`);
    if (!host) return;
    host.textContent = '';

    if (!rows.length) {
        const p = document.createElement('p');
        p.textContent = summary || `${title} — no data yet`;
        host.appendChild(p);
        return;
    }

    const table = document.createElement('table');
    const caption = document.createElement('caption');
    caption.textContent = title;
    table.appendChild(caption);

    const head = document.createElement('tr');
    for (const col of columns) {
        const th = document.createElement('th');
        th.setAttribute('scope', 'col');
        th.textContent = col;
        head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        // First cell is the row's label — a date, a command, a cohort — so it
        // is a header, and the ones after it are values it names.
        row.forEach((cell, i) => {
            const el = document.createElement(i === 0 ? 'th' : 'td');
            if (i === 0) el.setAttribute('scope', 'row');
            el.textContent = String(cell);
            tr.appendChild(el);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(table);
}

/** Sum one numeric key across a daily series, for the chart summaries. */
function sumBy(rows, key) {
    return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

async function renderAnalyticsCharts(data, insights) {
    // The summaries and data tables below are built from the same arrays the
    // charts are drawn from, and they have to survive a library that would not
    // load: a reader who cannot see the canvas anyway should not also lose the
    // numbers because a script fetch failed. So a load failure is reported and
    // the drawing skipped, rather than the whole render abandoned at the top.
    let charts = true;
    try {
        await loadChartJs();
    } catch (err) {
        charts = false;
        chartsUnavailable(err);
    }
    const a = data.analytics || {};
    const days = _analyticsRange;

    // Member growth chart
    const growthAll = a.memberGrowth || [];
    const growthSlice = growthAll.slice(-days);
    if (_chartMemberGrowth) _chartMemberGrowth.destroy();
    const ctxG = document.getElementById('chart-member-growth')?.getContext('2d');
    if (charts && ctxG) {
        _chartMemberGrowth = new Chart(ctxG, {
            type: 'bar',
            data: {
                labels: growthSlice.map(d => d.date.slice(5)),
                datasets: [
                    { label: 'Joins', data: growthSlice.map(d => d.joins), backgroundColor: 'rgba(93,138,90,0.7)', borderRadius: 3 },
                    { label: 'Leaves', data: growthSlice.map(d => d.leaves), backgroundColor: 'rgba(185,76,60,0.6)', borderRadius: 3 }
                ]
            },
            options: _chartDefaults
        });
    }

    describeChart('chart-member-growth', {
        title: `Member growth, last ${days} days`,
        summary: growthSlice.length
            ? `Member growth over the last ${days} days: ${sumBy(growthSlice, 'joins')} joins, ${sumBy(growthSlice, 'leaves')} leaves.`
            : 'Member growth — no data yet',
        columns: ['Date', 'Joins', 'Leaves'],
        rows: growthSlice.map(d => [d.date, d.joins || 0, d.leaves || 0]),
    });

    // Command activity chart — real per-command daily counts
    if (_chartCommandActivity) _chartCommandActivity.destroy();
    const ctxCA = document.getElementById('chart-command-activity')?.getContext('2d');
    const cmdSlice = (a.commandDaily || []).slice(-days);
    // Fallback when no daily breakdown has been recorded yet: the running
    // per-command totals, as a horizontal bar.
    const cmdRows = Object.entries(a.commandUsage || {}).sort((x, y) => y[1].total - x[1].total).slice(0, 8);
    if (charts && ctxCA) {
        if (cmdSlice.length) {
            _chartCommandActivity = new Chart(ctxCA, {
                type: 'bar',
                data: {
                    labels: cmdSlice.map(d => d.date.slice(5)),
                    datasets: [{ label: 'Commands', data: cmdSlice.map(d => d.count), backgroundColor: 'rgba(217,119,66,0.7)', borderRadius: 3 }]
                },
                options: _chartDefaults
            });
        } else {
            _chartCommandActivity = new Chart(ctxCA, {
                type: 'bar',
                data: {
                    labels: cmdRows.map(([cmd]) => '/' + cmd),
                    datasets: [{ label: 'Total runs', data: cmdRows.map(([,m]) => m.total), backgroundColor: 'rgba(217,119,66,0.7)', borderRadius: 3 }]
                },
                options: { ...JSON.parse(JSON.stringify(_chartDefaults)), indexAxis: 'y', plugins: { legend: { display: false } } }
            });
        }
    }

    describeChart('chart-command-activity', cmdSlice.length
        ? {
            title:   `Command activity, last ${days} days`,
            summary: `Command activity over the last ${days} days: ${sumBy(cmdSlice, 'count')} commands run.`,
            columns: ['Date', 'Commands'],
            rows:    cmdSlice.map(d => [d.date, d.count || 0]),
        }
        : {
            title:   'Most-used commands',
            summary: cmdRows.length
                ? `Most-used commands: ${cmdRows.map(([cmd, m]) => `/${cmd}, ${m.total}`).join('; ')}.`
                : 'Command activity — no data yet',
            columns: ['Command', 'Total runs'],
            rows:    cmdRows.map(([cmd, m]) => [`/${cmd}`, m.total || 0]),
        });

    // Retention cohort chart (D7/D30 by join month)
    if (_chartRetention) _chartRetention.destroy();
    const ctxR = document.getElementById('chart-retention')?.getContext('2d');
    const cohorts = insights?.retentionCohorts || [];
    const ret7 = insights?.retention?.retained7Pct || 0;
    const ret30 = insights?.retention?.retained30Pct || 0;
    if (charts && ctxR) {
        if (cohorts.length) {
            _chartRetention = new Chart(ctxR, {
                type: 'bar',
                data: {
                    labels: cohorts.map(c => c.month),
                    datasets: [
                        { label: 'D7 %', data: cohorts.map(c => c.d7Pct || 0), backgroundColor: 'rgba(93,138,90,0.8)', borderRadius: 3 },
                        { label: 'D30 %', data: cohorts.map(c => c.d30Pct || 0), backgroundColor: 'rgba(93,138,90,0.45)', borderRadius: 3 }
                    ]
                },
                options: { ...JSON.parse(JSON.stringify(_chartDefaults)), scales: { ...JSON.parse(JSON.stringify(_chartDefaults.scales)), y: { ticks: { color: '#b8a898' }, max: 100 } } }
            });
        } else {
            _chartRetention = new Chart(ctxR, {
                type: 'bar',
                data: {
                    labels: ['D7 retention', 'D30 retention'],
                    datasets: [{ label: '%', data: [ret7, ret30], backgroundColor: ['rgba(93,138,90,0.8)', 'rgba(93,138,90,0.5)'], borderRadius: 4 }]
                },
                options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#b8a898' }, max: 100 }, y: { ticks: { color: '#b8a898', font: { size: 11 } } } } }
            });
        }
    }

    describeChart('chart-retention', cohorts.length
        ? {
            title:   'Retention by join month',
            summary: `Retention by join month, ${cohorts.length} cohorts: ` +
                     `${cohorts.map(c => `${c.month}, D7 ${c.d7Pct || 0}%, D30 ${c.d30Pct || 0}%`).join('; ')}.`,
            columns: ['Cohort', 'D7 %', 'D30 %'],
            rows:    cohorts.map(c => [c.month, c.d7Pct || 0, c.d30Pct || 0]),
        }
        : {
            title:   'Retention',
            summary: `Retention: ${ret7}% of members still active after 7 days, ${ret30}% after 30 days.`,
            columns: ['Window', 'Retained %'],
            rows:    [['D7 retention', ret7], ['D30 retention', ret30]],
        });

    // Helper: remove any stale "no data" placeholder from a chart card container
    function clearChartPlaceholder(container) {
        const p = container.querySelector('p.chart-no-data');
        if (p) p.remove();
    }

    // Economy activity chart
    if (_chartEconomy) _chartEconomy.destroy();
    const ctxE = document.getElementById('chart-economy')?.getContext('2d');
    const ecoSlice = (a.economyDaily || []).slice(-days);
    if (charts && ctxE) {
        clearChartPlaceholder(ctxE.canvas.parentElement);
        if (ecoSlice.length) {
            _chartEconomy = new Chart(ctxE, {
                type: 'bar',
                data: {
                    labels: ecoSlice.map(d => d.date.slice(5)),
                    datasets: [
                        { label: 'Coins earned', data: ecoSlice.map(d => d.earned || 0), backgroundColor: 'rgba(230,190,80,0.75)', borderRadius: 3 },
                        { label: 'Coins spent', data: ecoSlice.map(d => d.spent || 0), backgroundColor: 'rgba(185,76,60,0.6)', borderRadius: 3 }
                    ]
                },
                options: _chartDefaults
            });
        } else {
            ctxE.canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="chart-no-data" style="text-align:center;opacity:.4;font-size:.82rem;margin-top:.5rem">No economy data yet</p>');
        }
    }
    describeChart('chart-economy', {
        title:   `Economy activity, last ${days} days`,
        summary: ecoSlice.length
            ? `Economy activity over the last ${days} days: ${sumBy(ecoSlice, 'earned')} coins earned, ` +
              `${sumBy(ecoSlice, 'spent')} spent.`
            : 'Economy activity — no data yet',
        columns: ['Date', 'Coins earned', 'Coins spent'],
        rows:    ecoSlice.map(d => [d.date, d.earned || 0, d.spent || 0]),
    });

    // Leveling / XP chart
    if (_chartLeveling) _chartLeveling.destroy();
    const ctxL = document.getElementById('chart-leveling')?.getContext('2d');
    const xpSlice = (a.xpDaily || []).slice(-days);
    if (charts && ctxL) {
        clearChartPlaceholder(ctxL.canvas.parentElement);
        if (xpSlice.length) {
            _chartLeveling = new Chart(ctxL, {
                type: 'bar',
                data: {
                    labels: xpSlice.map(d => d.date.slice(5)),
                    datasets: [
                        { label: 'XP awarded', data: xpSlice.map(d => d.xp || 0), backgroundColor: 'rgba(122,167,255,0.7)', borderRadius: 3 },
                        { label: 'Level-ups', data: xpSlice.map(d => d.levelUps || 0), backgroundColor: 'rgba(168,120,230,0.7)', borderRadius: 3, yAxisID: 'y2' }
                    ]
                },
                options: { ...JSON.parse(JSON.stringify(_chartDefaults)), scales: { x: { ticks: { color: '#b8a898', maxTicksLimit: 8 } }, y: { ticks: { color: '#b8a898' }, position: 'left' }, y2: { ticks: { color: '#b8a898' }, position: 'right', grid: { drawOnChartArea: false } } } }
            });
        } else {
            ctxL.canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="chart-no-data" style="text-align:center;opacity:.4;font-size:.82rem;margin-top:.5rem">No leveling data yet</p>');
        }
    }
    describeChart('chart-leveling', {
        title:   `XP and level-ups, last ${days} days`,
        summary: xpSlice.length
            ? `XP and level-ups over the last ${days} days: ${sumBy(xpSlice, 'xp')} XP awarded, ` +
              `${sumBy(xpSlice, 'levelUps')} level-ups.`
            : 'XP and level-ups — no data yet',
        columns: ['Date', 'XP awarded', 'Level-ups'],
        rows:    xpSlice.map(d => [d.date, d.xp || 0, d.levelUps || 0]),
    });

    // AI requests chart
    if (_chartAiRequests) _chartAiRequests.destroy();
    const ctxAI = document.getElementById('chart-ai-requests')?.getContext('2d');
    const aiSlice = (a.aiRequestsDaily || []).slice(-days);
    if (charts && ctxAI) {
        clearChartPlaceholder(ctxAI.canvas.parentElement);
        if (aiSlice.length) {
            _chartAiRequests = new Chart(ctxAI, {
                type: 'line',
                data: {
                    labels: aiSlice.map(d => d.date.slice(5)),
                    datasets: [{ label: 'AI requests', data: aiSlice.map(d => d.count || 0), borderColor: 'rgba(122,167,255,0.9)', backgroundColor: 'rgba(122,167,255,0.15)', fill: true, tension: 0.3, pointRadius: 2 }]
                },
                options: _chartDefaults
            });
        } else {
            ctxAI.canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="chart-no-data" style="text-align:center;opacity:.4;font-size:.82rem;margin-top:.5rem">No AI usage data yet</p>');
        }
    }
    describeChart('chart-ai-requests', {
        title:   `AI requests, last ${days} days`,
        summary: aiSlice.length
            ? `AI requests over the last ${days} days: ${sumBy(aiSlice, 'count')} in total.`
            : 'AI requests — no data yet',
        columns: ['Date', 'Requests'],
        rows:    aiSlice.map(d => [d.date, d.count || 0]),
    });
}

async function loadAnalytics() {
    const guildId = BOOT.guildId;
    document.getElementById('analytics-skeleton').style.display = '';
    document.getElementById('analytics-error').style.display = 'none';
    document.getElementById('analytics-content').style.display = 'none';

    try {
        const [statsResp, insightsResp] = await Promise.all([
            fetch(`/api/v1/guild/${guildId}/stats`),
            fetch(`/api/v1/guild/${guildId}/insights`)
        ]);
        if (!statsResp.ok || !insightsResp.ok) throw new Error('Non-OK response');
        const data = await statsResp.json();
        const insights = await insightsResp.json();
        _analyticsData = data;
        _analyticsInsights = insights;

        document.getElementById('analytics-skeleton').style.display = 'none';
        document.getElementById('analytics-content').style.display = '';

        const a = data.analytics || {};

        // KPI tiles
        const kpiRow = document.getElementById('analytics-kpi-row');
        kpiRow.innerHTML = '';
        const kpis = [
            { label: 'Total members', value: data.totalUsers ?? '—' },
            { label: '30d joins', value: a.growthFunnel?.joins30 ?? '—' },
            { label: 'Retention 7d', value: `${a.growthFunnel?.retained7 ?? '—'}%` },
            { label: 'Retention 30d', value: `${a.growthFunnel?.retained30 ?? '—'}%` },
            { label: 'Mod SLA (median)', value: insights.modSla?.medianResolutionHours != null ? `${insights.modSla.medianResolutionHours}h` : '—' }
        ];
        for (const kpi of kpis) {
            kpiRow.insertAdjacentHTML('beforeend', `<div class="eco-kpi-tile"><div class="eco-kpi-label">${kpi.label}</div><div class="eco-kpi-value">${kpi.value}</div></div>`);
        }

        // Render charts. Not awaited: Chart.js is fetched on demand now (#685)
        // and the KPI tiles, insights and command tables below are worth having
        // whether or not it arrives.
        renderAnalyticsCharts(data, insights).catch(chartsUnavailable);

        // Insights text
        const insightsCont = document.getElementById('analytics-insights-content');
        insightsCont.innerHTML = '';
        const rows = [
            ['Newcomer conversion', `${insights.newcomerConversion?.days7?.pct || 0}% @ 7d · ${insights.newcomerConversion?.days30?.pct || 0}% @ 30d`],
            ['Top active hours (UTC)', (insights.activeHours?.topHours || []).map(t => `${String(t.hourUtc).padStart(2,'0')}:00 (${t.count})`).join(' · ') || 'Not enough data'],
            ['Toxic channel hotspots', (insights.toxicChannels || []).slice(0,5).map(c=>`<#${c.channelId}> score ${c.score}`).join(' · ') || 'None detected'],
            ['Churn alerts', (a.churnAlerts || ['No active alerts']).join(' · ')],
            ['Likely causes', (a.likelyCauses || ['None detected']).join(' · ')],
        ];
        for (const [label, val] of rows) {
            insightsCont.insertAdjacentHTML('beforeend', `<div class="list-item"><strong>${label}</strong><span>${val}</span></div>`);
        }

        // Command usage
        const commandRows = Object.entries(a.commandUsage || {}).sort((x,y)=>y[1].total-x[1].total).slice(0,8);
        if (commandRows.length) {
            insightsCont.insertAdjacentHTML('beforeend', `<div class="panel-head" style="margin-top:1rem"><h3>Command usage / failures</h3></div>`);
            for (const [cmd, m] of commandRows) {
                insightsCont.insertAdjacentHTML('beforeend', `<div class="list-item"><strong>/${cmd}</strong><span>${m.total} runs · ${m.failed} failed (${m.total ? Math.round(m.failed/m.total*100) : 0}%)</span></div>`);
            }
        }

        // Recommendations as actionable cards
        const recCont = document.getElementById('analytics-recommendations');
        recCont.innerHTML = '';
        const navMap = {
            'welcome': 'welcome', 'moderation': 'moderation', 'auto-moderation': 'moderation',
            'rss': 'rss', 'economy': 'economy', 'leveling': 'leveling', 'command': 'commandpolicies'
        };
        const defaultRecs = [
            { text: 'Set up a welcome message to greet new members automatically', tab: 'welcome' },
            { text: 'Configure a moderation log channel to track mod actions', tab: 'moderation' },
            { text: 'Enable economy to boost member engagement with coins and a shop', tab: 'economy' },
            { text: 'Set up leveling to reward active members with roles and XP', tab: 'leveling' },
            { text: 'Configure command policies to restrict commands by role or channel', tab: 'commandpolicies' }
        ];
        const activeRecs = a.recommendations || [];
        if (!activeRecs.length) {
            for (const r of defaultRecs) {
                recCont.insertAdjacentHTML('beforeend', `<div class="analytics-rec-card"><span>💡 ${r.text}</span><a href="#" class="analytics-rec-link" onclick="document.querySelector('.nav-item[data-tab=${r.tab}]')?.click();return false">Configure →</a></div>`);
            }
        } else {
            for (const rec of activeRecs) {
                const navTarget = Object.keys(navMap).find(k => rec.toLowerCase().includes(k));
                const linkHtml = navTarget ? `<a href="#" class="analytics-rec-link" onclick="document.querySelector('.nav-item[data-tab=${navMap[navTarget]}]')?.click();return false">Configure →</a>` : '';
                recCont.insertAdjacentHTML('beforeend', `<div class="analytics-rec-card"><span>💡 ${rec}</span>${linkHtml}</div>`);
            }
        }
    } catch {
        document.getElementById('analytics-skeleton').style.display = 'none';
        document.getElementById('analytics-error').style.display = '';
    }
}

// ── Moderation: Active Sanctions ──────────────────────────────────────
let _sanctionsData = null;
let _sanctionsFilter = 'all';

function setSanctionsFilter(filter, btn) {
    _sanctionsFilter = filter;
    document.querySelectorAll('.sanctions-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (_sanctionsData) renderSanctions(_sanctionsData);
}

/** Show or hide a wide table (#668).
 *
 *  These tables live inside a `.table-scroll` wrapper, and it is the wrapper —
 *  not the table — that carries the visibility, because the wrapper is a
 *  labelled region with a tabindex. Toggling the table alone would leave an
 *  empty region behind as a tab stop announcing a table that is not there. */
function setTableVisible(id, visible) {
    const table = document.getElementById(id);
    if (!table) return;
    (table.closest('.table-scroll') || table).style.display = visible ? '' : 'none';
}

function renderSanctions(data) {
    const items = [
        ...(data.bans || []).map(b => ({ ...b, type: 'ban' })),
        ...(data.timeouts || []).map(t => ({ ...t, type: 'timeout' }))
    ].filter(i => _sanctionsFilter === 'all' || i.type === _sanctionsFilter);

    document.getElementById('sanctions-empty').style.display = items.length ? 'none' : '';
    setTableVisible('sanctions-table', items.length > 0);
    const tbody = document.getElementById('sanctions-tbody');
    tbody.innerHTML = '';
    for (const item of items) {
        const expires = item.expires ? new Date(item.expires).toLocaleString() : '—';
        const tr = document.createElement('tr');

        // User cell — avatar (src validated as CDN URL on server) + escaped tag
        const tdUser = document.createElement('td');
        const img = document.createElement('img');
        img.src = item.avatarUrl;
        img.style.cssText = 'width:20px;height:20px;border-radius:50%;margin-right:.35rem;vertical-align:middle';
        img.onerror = function() { this.style.display = 'none'; };
        tdUser.appendChild(img);
        tdUser.appendChild(document.createTextNode(item.userTag));

        // Type badge
        const tdType = document.createElement('td');
        tdType.innerHTML = `<span class="case-type-badge type-${item.type}">${item.type}</span>`;

        // Expires
        const tdExpires = document.createElement('td');
        tdExpires.textContent = expires;

        // Reason — user-controlled, must be text
        const tdReason = document.createElement('td');
        tdReason.style.cssText = 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        tdReason.textContent = item.reason || '—';

        // Action button — userId is a validated snowflake (digits only)
        const tdAction = document.createElement('td');
        const btn = document.createElement('button');
        if (item.type === 'ban') {
            btn.className = 'btn btn-sm btn-danger';
            btn.textContent = 'Unban';
            btn.onclick = () => doUnban(item.userId);
        } else {
            btn.className = 'btn btn-sm';
            btn.textContent = 'Remove timeout';
            btn.onclick = () => doRemoveTimeout(item.userId);
        }
        tdAction.appendChild(btn);

        tr.append(tdUser, tdType, tdExpires, tdReason, tdAction);
        tbody.appendChild(tr);
    }
}

async function loadActiveSanctions() {
    const guildId = BOOT.guildId;
    document.getElementById('sanctions-loading').style.display = '';
    document.getElementById('sanctions-error').style.display = 'none';
    document.getElementById('sanctions-empty').style.display = 'none';
    setTableVisible('sanctions-table', false);
    try {
        const resp = await fetch(`/api/v1/guild/${guildId}/sanctions/active`);
        if (!resp.ok) throw new Error('Non-OK');
        _sanctionsData = await resp.json();
        document.getElementById('sanctions-loading').style.display = 'none';
        renderSanctions(_sanctionsData);
    } catch {
        document.getElementById('sanctions-loading').style.display = 'none';
        document.getElementById('sanctions-error').style.display = '';
    }
}

async function doUnban(userId) {
    const ok = await showConfirm({ title: 'Unban user', body: `Unban user ${userId}? They will be able to rejoin the server.`, okText: 'Unban' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch(`/api/v1/guild/${guildId}/sanctions/unban/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await resp.json();
        if (!resp.ok) return alert(data.error || 'Failed to unban');
        await loadActiveSanctions();
    } catch { alert('Request failed'); }
}

async function doRemoveTimeout(userId) {
    const ok = await showConfirm({ title: 'Remove timeout', body: `Remove the active timeout for user ${userId}?`, okText: 'Remove timeout' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const resp = await fetch(`/api/v1/guild/${guildId}/sanctions/untimeout/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await resp.json();
        if (!resp.ok) return alert(data.error || 'Failed to remove timeout');
        await loadActiveSanctions();
    } catch { alert('Request failed'); }
}

// ── Moderation: Case History ──────────────────────────────────────────
let _casesCurrentPage = 1;

async function loadCaseHistory(page = 1) {
    _casesCurrentPage = page;
    const guildId = BOOT.guildId;
    const type = document.getElementById('cases-filter-type')?.value || '';
    const status = document.getElementById('cases-filter-status')?.value || '';
    document.getElementById('cases-loading').style.display = '';
    document.getElementById('cases-error').style.display = 'none';
    document.getElementById('cases-empty').style.display = 'none';
    setTableVisible('cases-table', false);
    const paginEl = document.getElementById('cases-pagination');
    paginEl.style.display = 'none';
    try {
        const params = new URLSearchParams({ page, limit: 20 });
        if (type) params.set('type', type);
        if (status) params.set('status', status);
        const resp = await fetch(`/api/v1/guild/${guildId}/cases?${params}`);
        if (!resp.ok) throw new Error('Non-OK');
        const { items, total, pages } = await resp.json();
        document.getElementById('cases-loading').style.display = 'none';
        if (!items.length) { document.getElementById('cases-empty').style.display = ''; return; }
        const tbody = document.getElementById('cases-tbody');
        tbody.innerHTML = '';
        for (const c of items) {
            const date = new Date(c.createdAt).toLocaleDateString();
            const targetCell = c.targetUserTag
                ? `<span title="${escHtml(c.targetUserId)}">${c.targetAvatarUrl ? `<img src="${escHtml(c.targetAvatarUrl)}" alt="" style="width:16px;height:16px;border-radius:50%;margin-right:4px;vertical-align:middle" onerror="this.style.display='none'">` : ''}${escHtml(c.targetUserTag)}</span>`
                : `<span style="font-size:.8em">${escHtml(c.targetUserId)}</span>`;
            const modCell = c.moderatorTag
                ? `<span title="${escHtml(c.moderatorId)}">${escHtml(c.moderatorTag)}</span>`
                : `<span style="font-size:.8em">${escHtml(c.moderatorId)}</span>`;
            tbody.insertAdjacentHTML('beforeend', `<tr>
                <td>#${c.caseId}</td>
                <td>${targetCell}</td>
                <td><span class="case-type-badge type-${c.type}">${c.type}</span></td>
                <td>${modCell}</td>
                <td>${date}</td>
                <td><span class="case-status-badge status-${c.status}">${c.status}</span></td>
                <td style="display:flex;gap:.35rem;flex-wrap:wrap">
                    <button class="btn btn-sm" onclick="openCaseNoteModal(${c.caseId})">Add note</button>
                    ${c.status === 'open' ? `<button class="btn btn-sm btn-danger" onclick="closeCase(${c.caseId})">Close</button>` : ''}
                </td>
            </tr>`);
        }
        setTableVisible('cases-table', true);
        if (pages > 1) {
            paginEl.style.display = 'flex';
            paginEl.innerHTML = '';
            if (page > 1) paginEl.insertAdjacentHTML('beforeend', `<button class="btn btn-sm" onclick="loadCaseHistory(${page-1})">‹ Prev</button>`);
            paginEl.insertAdjacentHTML('beforeend', `<span style="font-size:.85em;opacity:.7">Page ${page} of ${pages} (${total} total)</span>`);
            if (page < pages) paginEl.insertAdjacentHTML('beforeend', `<button class="btn btn-sm" onclick="loadCaseHistory(${page+1})">Next ›</button>`);
        }
    } catch {
        document.getElementById('cases-loading').style.display = 'none';
        document.getElementById('cases-error').style.display = '';
    }
}

function openCaseNoteModal(caseId, mode) {
    mode = mode || 'add_note';
    document.getElementById('case-note-case-id').value = caseId;
    document.getElementById('case-note-mode').value = mode;
    document.getElementById('case-note-content').value = '';
    if (mode === 'close') {
        document.getElementById('case-note-modal-title').textContent = `Close Case #${caseId}`;
        document.getElementById('case-note-label').textContent = 'Resolution note (optional)';
        document.getElementById('case-note-content').placeholder = 'Describe how the case was resolved...';
        document.getElementById('case-note-submit-btn').textContent = 'Close case';
    } else {
        document.getElementById('case-note-modal-title').textContent = 'Add Note to Case';
        document.getElementById('case-note-label').textContent = 'Note';
        document.getElementById('case-note-content').placeholder = 'Add a moderator note...';
        document.getElementById('case-note-submit-btn').textContent = 'Save note';
    }
    openModal('case-note-modal', { initialFocus: 'case-note-content' });
}
function closeCaseNoteModal() { closeModal('case-note-modal'); }

async function submitCaseAction() {
    const guildId = BOOT.guildId;
    const caseId = document.getElementById('case-note-case-id').value;
    const mode = document.getElementById('case-note-mode').value;
    const note = document.getElementById('case-note-content').value.trim();
    const body = mode === 'close'
        ? { action: 'close', ...(note && { resolution: note }) }
        : { action: 'add_note', note };
    if (mode === 'add_note' && !note) return alert('Note cannot be empty');
    try {
        const resp = await fetch(`/api/v1/guild/${guildId}/cases/${caseId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        if (!resp.ok) return alert(data.error || 'Failed');
        closeCaseNoteModal();
        loadCaseHistory(_casesCurrentPage);
    } catch { alert('Request failed'); }
}

function closeCase(caseId) {
    openCaseNoteModal(caseId, 'close');
}

// ── Economy Health ────────────────────────────────────────────────────
let _ecoCmdChart = null;

async function loadEcoHealth() {
    const guildId = BOOT.guildId;
    document.getElementById('eco-top-earners-loading').style.display = '';
    document.getElementById('eco-top-earners-error').style.display = 'none';
    document.getElementById('eco-top-earners-empty').style.display = 'none';
    setTableVisible('eco-top-earners-table', false);
    try {
        const resp = await fetch(`/api/v1/guild/${guildId}/economy/stats`);
        if (!resp.ok) throw new Error('Non-OK');
        const stats = await resp.json();
        document.getElementById('eco-stat-total-coins').textContent = (stats.totalCoins || 0).toLocaleString();
        document.getElementById('eco-stat-active-users').textContent = (stats.activeUsers || 0).toLocaleString();
        document.getElementById('eco-top-earners-loading').style.display = 'none';
        const topEarners = stats.topEarners || [];
        if (!topEarners.length) {
            document.getElementById('eco-top-earners-empty').style.display = '';
        } else {
            setTableVisible('eco-top-earners-table', true);
        }
        const tbody = document.getElementById('eco-top-earners-tbody');
        tbody.innerHTML = '';
        for (let i = 0; i < topEarners.length; i++) {
            const u = topEarners[i];
            const userCell = u.userTag
                ? `<span title="${escHtml(u.userId)}">${u.avatarUrl ? `<img src="${escHtml(u.avatarUrl)}" alt="" style="width:16px;height:16px;border-radius:50%;margin-right:4px;vertical-align:middle" onerror="this.style.display='none'">` : ''}${escHtml(u.userTag)}</span>`
                : `<span style="font-size:.8em">${escHtml(u.userId)}</span>`;
            tbody.insertAdjacentHTML('beforeend', `<tr><td>#${i+1}</td><td>${userCell}</td><td>${(u.balance||0).toLocaleString()}</td><td>${(u.bank||0).toLocaleString()}</td><td>${(u.total||0).toLocaleString()}</td></tr>`);
        }
        // Command frequency chart
        const cmds = stats.commandFrequency || [];
        if (_ecoCmdChart) _ecoCmdChart.destroy();
        const ctx = document.getElementById('eco-cmd-chart')?.getContext('2d');
        describeChart('eco-cmd-chart', {
            title:   'Most-used economy commands',
            summary: cmds.length
                ? `Most-used economy commands: ${cmds.map(c => `/${c.cmd}, ${c.count} uses`).join('; ')}.`
                : 'Most-used economy commands — no data yet',
            columns: ['Command', 'Uses'],
            rows:    cmds.map(c => [`/${c.cmd}`, c.count || 0]),
        });
        if (ctx && cmds.length) {
            // Its own try, inside the tab's: Chart.js is fetched on demand now
            // (#685), and a library that would not load must not take down the
            // totals and the top-earners table that already rendered above.
            try {
                await loadChartJs();
                _ecoCmdChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: cmds.map(c => `/${c.cmd}`),
                        datasets: [{ label: 'Uses', data: cmds.map(c => c.count), backgroundColor: 'rgba(217,119,66,0.75)', borderRadius: 4 }]
                    },
                    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#b8a898' } }, y: { ticks: { color: '#b8a898' } } } }
                });
            } catch (err) {
                chartsUnavailable(err);
            }
        }
    } catch {
        document.getElementById('eco-top-earners-loading').style.display = 'none';
        document.getElementById('eco-top-earners-error').style.display = '';
    }
}

let _ecoActionInFlight = false;
async function ecoAdminAction(action) {
    if (_ecoActionInFlight) return;
    const guildId = BOOT.guildId;
    const userId = document.getElementById('eco-admin-user-id').value.trim();
    const amount = parseInt(document.getElementById('eco-admin-amount').value, 10);
    const msgEl = document.getElementById('eco-admin-msg');
    if (!userId) { msgEl.textContent = 'Enter a user ID.'; msgEl.style.color = 'var(--red)'; return; }
    if (['give', 'take'].includes(action) && (!amount || amount <= 0)) { msgEl.textContent = 'Enter a valid amount > 0.'; msgEl.style.color = 'var(--red)'; return; }
    if (action === 'reset') {
        const ok = await showConfirm({ title: 'Reset balance', body: `This will permanently wipe the wallet and bank balance for user ${userId}. This cannot be undone.`, okText: 'Reset balance', typeRequired: 'RESET' });
        if (!ok) return;
    }

    _ecoActionInFlight = true;
    const controls = ['eco-admin-user-id', 'eco-admin-amount'];
    controls.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
    document.querySelectorAll('#eco-tab-health .btn').forEach(b => b.disabled = true);
    msgEl.textContent = '';

    try {
        const body = { userId, action };
        if (['give', 'take'].includes(action)) body.amount = amount;
        const resp = await fetch(`/api/v1/guild/${guildId}/economy/adjust`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        if (!resp.ok) { msgEl.textContent = data.error || 'Failed'; msgEl.style.color = 'var(--red)'; }
        else {
            msgEl.style.color = 'var(--green)';
            if (action === 'freeze') msgEl.textContent = 'Account frozen.';
            else if (action === 'unfreeze') msgEl.textContent = 'Account unfrozen.';
            else if (action === 'reset') msgEl.textContent = 'Balance reset. Wallet: 0, Bank: 0.';
            else msgEl.textContent = `Done. New wallet balance: ${(data.balance||0).toLocaleString()}`;
            loadEcoHealth();
        }
    } catch {
        msgEl.textContent = 'Request failed';
        msgEl.style.color = 'var(--red)';
    } finally {
        _ecoActionInFlight = false;
        controls.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
        document.querySelectorAll('#eco-tab-health .btn').forEach(b => b.disabled = false);
    }
}

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
            fetch(`/api/v1/guild/${_gId}/members/resolve?ids=${existingIds.join(',')}`)
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
                    const results = await fetch(`/api/v1/guild/${_gId}/members/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
                        .then(r => r.json())
                        .then(d => d.items);
                    if (!Array.isArray(results) || !results.length) { dropdown.style.display = 'none'; return; }
                    dropdown.innerHTML = results.map(u => {
                        const name = escHtml(u.displayName || u.username);
                        const id   = escHtml(u.id);
                        const av   = u.avatarURL ? escHtml(u.avatarURL) : '';
                        return `<div class="user-search-item" data-id="${id}" data-name="${name}" data-avatar="${av}">
                            ${av ? `<img src="${av}" alt="" style="width:20px;height:20px;border-radius:50%" onerror="this.style.display='none'">` : ''}
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
        tag.innerHTML  = `${safeAv ? `<img src="${safeAv}" alt="" style="width:16px;height:16px;border-radius:50%" onerror="this.style.display='none'">` : ''}<span title="${safeId}">${safeName}</span><button type="button" title="Remove">&times;</button>`;
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

// Matched by reading the attribute rather than with [onclick*="saveSettings("]:
// a bare "(" inside an attribute selector's quoted value is legal CSS that not
// every selector engine parses, and one that quietly matches nothing would
// leave every panel looking permanently saved.
const SAVE_CALL = /saveSettings\(\s*'([^']+)'/;
function saveButtonsIn(root) {
    return Array.from(root.querySelectorAll('[onclick]'))
        .filter(el => SAVE_CALL.test(el.getAttribute('onclick') || ''));
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
    const match = SAVE_CALL.exec(btn.getAttribute('onclick') || '');
    return match ? match[1] : null;
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
    // A shop item's image is the one setting on this page that lives nowhere in
    // the DOM. The file input is skipped above — its value is a fake path — and
    // the chosen file waits in _shopItemPendingImages until saveSettings
    // uploads it. Without this, changing only an item's image leaves every
    // reachable value identical to the baseline: the scope reads clean, the
    // banner stays down, beforeunload allows the navigation, and the upload is
    // dropped. The id sets are enough, because both are emptied only by a save
    // that succeeded, so any pending entry at all means unsaved work.
    if (scope.querySelector('#store-items-grid')) {
        for (const id of Object.keys(_shopItemPendingImages).sort()) parts.push('img+' + id);
        for (const id of [..._shopItemClearedImages].sort()) parts.push('img-' + id);
    }
    return parts.join(FIELD_SEP);
}

function registerSaveScopes(root) {
    for (const btn of saveButtonsIn(root)) {
        const section = sectionOfSaveButton(btn);
        const scope = saveScopeOf(btn);
        if (!section || !scope || saveScopes.has(scope)) continue;
        saveScopes.set(scope, { section, baseline: scopeSignature(scope) });
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
    return saveButtonsIn(document).filter(btn => {
        const match = SAVE_CALL.exec(btn.getAttribute('onclick') || '');
        return !!match && match[1] === section;
    });
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
// they ran inline as this file executed — so it can be baselined here. Every
// other panel is baselined by loadPanel() when its markup lands.
registerSaveScopes(document);
