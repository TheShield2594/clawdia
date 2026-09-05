// The guild settings page's shared machinery: the bootstrap payload, the
// fetch wrapper, panel loading, toasts, dialogs, escaping, and the registries
// the panel scripts wire themselves into.
//
// ── How this page is put together (#935) ─────────────────────────────
//
// It used to be one 5,206-line file covering every panel's load, save,
// validation and dialog behaviour, with no boundary between any two of them.
// It is a set of scripts now, loaded in this order (see views/guild-settings.ejs):
//
//   esc-html.js         the shared escaper
//   settings-payload.js which fields each section POSTs
//   dashboard-core.js   this file — what every panel needs
//   chart-support.js    loading Chart.js, and describing a chart in text
//   panel-*.js          one per settings panel, in any order
//   guild-settings.js   the page shell: nav, tabs, saving, unsaved-changes
//
// The order is the contract. This file may not name anything a panel declares;
// a panel may not name anything the shell declares except through a handler
// that runs on an event, long after everything has loaded. What a panel
// contributes it registers — `registerPanelActions` for its delegated
// handlers, `registerPayloadSources` / `registerSaveGuard` /
// `registerSaveFollowUp` / `registerScopeSignature` for its part of a save, and
// `onPanel` / `onShown` for when its markup lands and when the reader opens it.
// So nothing above has to hold a list of what is below.
//
// These are classic scripts, not modules: they share one global scope, and a
// name crossing a file boundary has to be a top-level `var` or a function
// declaration. A `const` or a `let` is a binding in the shared global lexical
// scope, which a browser resolves across scripts and the suites' per-file
// `eval()` boot does not — so panel-local state is `const`/`let` and anything
// another file reads is not. tests/dashboardScriptBoundaries holds that.
//
// Every file here is static and content-addressed by the `asset()` helper, so
// a browser fetches each once and reuses it across every guild and every
// reload. Everything that varies per request arrives in the small inline
// bootstrap block that guild-settings.ejs renders before them.

// `var` rather than `const`, per the rule above: every panel reads it.
var BOOT = window.CLAWDIA_BOOTSTRAP;

// Each server value used to be inlined as its own object literal, so two
// variables initialised from the same value were independent and safe to mutate
// separately. Reading straight off the shared bootstrap would alias them, so
// hand out a copy instead — the payload is plain JSON, and a stringify
// round-trip reproduces the old semantics exactly.
function boot(key) {
    return JSON.parse(JSON.stringify(BOOT[key]));
}

// ── Media queries ────────────────────────────────────────────────────
// jsdom has no matchMedia, and a page that called it there would throw before
// it rendered anything. A query nobody can answer reads as "no preference
// expressed" — the desktop layout, and motion left as authored — which is what
// the page did before any of this existed.
//
// jsdom is the whole of the reason, and the comment here used to credit old
// browsers as well. It cannot have been helping any: this file is parsed as a
// whole before a line of it runs and it is ES2020 throughout, so a browser with
// no matchMedia — one from a decade before `?.` — fails on the syntax and never
// reaches the check written for it (#948). The floor is ES2020 and the DOM of
// the browsers that also run Discord; docs/EXTENDING.md, "What the browser
// scripts may assume", is where that is written down.
function media(query) {
    return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// styles.css answers this for everything it can reach, but `scroll-behavior`
// in CSS does not govern a `behavior: 'smooth'` passed to scrollIntoView (#675)
// — that argument wins over the stylesheet — so the one call that scrolls the
// page has to ask as well.
function scrollBehavior() {
    return media(REDUCED_MOTION)?.matches ? 'auto' : 'smooth';
}

// ── Session expiry ───────────────────────────────────────────────────
// Sessions idle out after four hours. For this page that is a routine event
// rather than an edge case — leave a tab open over lunch and every control on
// it is talking to a server that no longer knows who you are — and nothing here
// recognised it. The two request shapes failed in two different misleading
// ways: an API route answers 401 with `{ error: 'Unauthorized' }`, which
// surfaced as a bare "Unauthorized" toast on a section the user plainly does
// administer, and a panel fragment comes from a *page* route, which answers 302
// to /auth/login and on to Discord, where the cross-origin hop dies in CORS and
// surfaced as "Could not load this section". Neither says what happened, and
// neither offers a way back — with unsaved edits sitting in the form (#878).
//
// Every request the page makes goes through apiFetch(), which recognises both
// shapes and reports them once, in a banner that stays up until it is acted on.
// Nothing is discarded and nothing is reloaded: the session cookie is set for
// the whole site, so signing in again in a second tab is enough to make this
// tab's next request work. That is what the banner asks for, and it is why a
// response that succeeds takes the banner back down again.
const sessionExpiredBanner = document.getElementById('session-expired');
let sessionExpired = false;

// Following the page routes' 302 lands on Discord's OAuth endpoint, which sends
// no CORS headers, so a followed redirect fails as a network error
// indistinguishable from the server being down. `redirect: 'manual'` stops
// before that hop: the redirect comes back as an opaque response, which is a
// fact to test rather than an exception to guess at.
function isSessionExpired(res) {
    if (res.status === 401) return true;
    if (res.type === 'opaqueredirect') return true;
    // A caller that opted back into following redirects still gets the check:
    // a response that ended up off this origin, or on the login route, is the
    // same expired session arriving by the other path.
    if (res.redirected && res.url) {
        try {
            const to = new URL(res.url, window.location.href);
            return to.origin !== window.location.origin || to.pathname.startsWith('/auth/login');
        } catch {
            return false;
        }
    }
    return false;
}

function showSessionExpired() {
    if (sessionExpired) return;
    sessionExpired = true;
    if (sessionExpiredBanner) sessionExpiredBanner.hidden = false;
}

function clearSessionExpired() {
    if (!sessionExpired) return;
    sessionExpired = false;
    if (sessionExpiredBanner) sessionExpiredBanner.hidden = true;
}

/**
 * fetch() for everything this page asks of its own server.
 *
 * Returns the response untouched, so every call site keeps reading `ok`,
 * `status` and `json()` exactly as it did; the only difference is that an
 * expired session is recognised on the way past. A rejection — an aborted
 * search, a genuinely offline network — still rejects, and still means what it
 * meant before.
 */
function apiFetch(url, options) {
    // Whether the banner was already up when this request left. A success only
    // clears the banner if it is evidence about the session the banner is
    // describing, and a request dispatched before the banner went up is not:
    // the page fires requests in parallel — the overview panel asks for stats
    // and insights at once — so a slow 200 from before the expiry could land
    // after its neighbour's 401 and take the banner down while the session is
    // still dead.
    const expiredWhenSent = sessionExpired;

    return window.fetch(url, { redirect: 'manual', ...(options || {}) }).then(res => {
        if (isSessionExpired(res)) showSessionExpired();
        else if (res.ok && (expiredWhenSent || !sessionExpired)) clearSessionExpired();
        return res;
    });
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

    const request = apiFetch(PANEL_URL + encodeURIComponent(id), { headers: { Accept: 'text/html' } })
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
            // The banner overhead says what happened and what to do about it;
            // the stub only has to stop claiming the section is broken and say
            // what makes it load. The toast below is suppressed while the
            // banner is up, so it needs no guard of its own.
            if (message) message.textContent = sessionExpired
                ? 'Sign in again in the other tab, then click this tab to load this section.'
                : 'Could not load this section. Click the tab again to retry.';
            toast('Could not load that section. Please try again.', 'error');
            return null;
        });

    panelRequests.set(id, request);
    return request;
}

// ── Delegated handlers for rendered lists ────────────────────────────
// Attacker-influenced values (member nicknames, achievement names, MCP
// server names) ride in data-* attributes and come back out through
// dataset. They must never be concatenated into an inline handler:
// an on*="" attribute is HTML-decoded before it is parsed as JS, so a
// `&#39;` from escHtml turns back into a quote and closes the string it
// was meant to sit inside.
//
// One table per event — click, input, change — keyed on the element's own
// data-action / data-input / data-change and holding a handler called with
// `(element, dataset, event)`. A table rather than another forty `else if`
// lines because the point of #887 is that there are forty of them. And a
// table, not a lookup into `window`: an injected `data-action` can only name
// something that was registered, which is the difference between a data
// attribute and the `onclick=""` it replaced.
//
// Registered rather than written out as one literal (#935). The panels are
// separate scripts now, and each contributes the actions for its own markup as
// it loads — so this file names no function that belongs to a panel, and a
// panel that goes away takes its actions with it instead of leaving a dangling
// entry behind.
var CLICK_ACTIONS = {};
var INPUT_ACTIONS = {};
var CHANGE_ACTIONS = {};

/**
 * Contribute delegated handlers: `{ click, input, change }`, each an object of
 * data-attribute value → `(element, dataset, event) => void`. Handlers are
 * written as thunks rather than bare references so a table can sit beside the
 * markup it serves regardless of where each function is declared.
 */
function registerPanelActions(tables) {
    Object.assign(CLICK_ACTIONS,  tables.click  || {});
    Object.assign(INPUT_ACTIONS,  tables.input  || {});
    Object.assign(CHANGE_ACTIONS, tables.change || {});
}

function runTableAction(table, attribute, e) {
    const el = e.target.closest && e.target.closest('[' + attribute + ']');
    if (!el) return;
    const fn = table[el.getAttribute(attribute)];
    if (fn) fn(el, el.dataset, e);
}

document.addEventListener('click',  e => runTableAction(CLICK_ACTIONS,  'data-action', e));
document.addEventListener('input',  e => runTableAction(INPUT_ACTIONS,  'data-input',  e));
document.addEventListener('change', e => runTableAction(CHANGE_ACTIONS, 'data-change', e));

// ── What a save is made of, and what happens around it ────────────────
//
// Three registries, filled by the panel scripts that load after this one
// (#935). A panel's state — its shop array, its escalation ladder, whether the
// MCP controls have been hydrated yet — lives in that panel's own file, and
// this file has no business naming any of it. So each panel says what it
// contributes instead:
//
//   registerPayloadSources({ storeItems: () => storeItems })
//       one entry of the `sources` object settings-payload.js reads. A getter,
//       not a value: `jobsList` and friends are reassigned as the panel is
//       edited, and a value captured at load time would post the state the
//       page arrived with.
//
//   registerSaveGuard('ai', () => 'System prompt is too long')
//       a last check before the POST. Returning a string stops the save and
//       shows it; returning nothing lets it through.
//
//   registerSaveFollowUp('economy', async () => 'image upload failed')
//       work that only counts as done once the settings have landed — the
//       pending shop-item images. A returned string means the section is not
//       cleanly saved after all.
var PAYLOAD_SOURCES = {};
var SAVE_GUARDS = {};
var SAVE_FOLLOW_UPS = {};

function registerPayloadSources(sources) { Object.assign(PAYLOAD_SOURCES, sources); }
function registerSaveGuard(section, fn) { SAVE_GUARDS[section] = fn; }
function registerSaveFollowUp(section, fn) { SAVE_FOLLOW_UPS[section] = fn; }

/** The `sources` object for this save, each entry read at save time. */
function payloadSources() {
    const sources = {};
    for (const key of Object.keys(PAYLOAD_SOURCES)) sources[key] = PAYLOAD_SOURCES[key]();
    return sources;
}

// Extra state a save scope is dirty on, for the settings that live nowhere in
// the DOM. The shell reads form controls and chips to decide whether a section
// has unsaved edits; a shop item's chosen image is neither, so the panel that
// holds it says how to see it. Keyed by a selector that says which scopes it
// belongs to.
var SIGNATURE_EXTRAS = [];
function registerScopeSignature(selector, read) { SIGNATURE_EXTRAS.push({ selector, read }); }

// ── A panel or inner tab coming into view ─────────────────────────────
//
// Most panels are ready as soon as their markup lands, and `onPanel` is enough
// for those. A few fetch their own data — the analytics charts, the knowledge
// base, the MCP connections, the moderation tables — and want to do it the
// first time the reader actually looks, not when the markup arrives.
//
// The shell's tab router announces what it just showed and each panel listens
// for its own ids, so the router names no panel and a panel that goes away
// takes its listener with it (#935). The id is the panel's or the inner tab
// panel's element id, which is what the router already has in hand.
var shownHandlers = new Map();

function onShown(id, fn) {
    const queued = shownHandlers.get(id);
    if (queued) queued.push(fn);
    else shownHandlers.set(id, [fn]);
}

/** Tell whoever is listening that `id` is now the visible panel or inner tab. */
function announceShown(id) {
    for (const fn of shownHandlers.get(id) || []) {
        try {
            fn();
        } catch (err) {
            // One panel's fetch blowing up must not take the tab switch with it.
            console.error('[dashboard] shown handler for "' + id + '" failed:', err);
        }
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
    // Once the expired-session banner is up, every failure the page can report
    // is that same failure, and the banner already says it — along with the one
    // thing a toast cannot, which is what to do about it. Swallowed here rather
    // than guarded at fifty call sites. Anything that is not an error still
    // shows: a success toast while the banner is up would be news.
    if (sessionExpired && kind === 'error') return;

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
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
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
// Forms that exist for their layout and their Enter-to-submit behaviour, never
// to navigate. This was `onsubmit="return false"`.
document.addEventListener('submit', function(e) {
    if (e.target.closest && e.target.closest('form[data-no-submit]')) e.preventDefault();
});

// The activity-item cards: when the uploaded image 404s, it hides itself and
// the emoji underneath takes its place. Capture phase, because `error` does not
// bubble — the same reason the data-hide-on-error listener below captures.
document.addEventListener('error', function(e) {
    const el = e.target;
    if (!el || !el.matches || !el.matches('img[data-emoji-fallback]')) return;
    el.style.display = 'none';
    const emoji = document.getElementById(el.dataset.emojiFallback);
    if (emoji) emoji.style.display = 'flex';
}, true);

// `blur` does not bubble, so it is listened for in the capture phase — the same
// reason the `error` handler below captures.
document.addEventListener('blur', function(e) {
    const el = e.target;
    if (el && el.matches && el.matches('[data-validate-timezone]')) validateTimezoneInput(el);
}, true);

// An avatar or shop thumbnail whose URL 404s hides itself rather than showing a
// broken-image glyph. `error` does not bubble either, hence the capture phase.
document.addEventListener('error', function(e) {
    const el = e.target;
    if (el && el.matches && el.matches('img[data-hide-on-error]')) el.style.display = 'none';
}, true);
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


// The confirm dialog's two buttons. Everything else on this page belongs to a
// panel and is registered from that panel's own script; these belong to the
// dialog machinery above, which is why they are here.
registerPanelActions({
    click: {
        'confirm-cancel': () => _confirmResolve(false),
        'confirm-ok':     () => _confirmResolve(true),
    },
    input: {
        // A range input echoing its own value into a label beside it. Not a
        // panel's: any slider on the page can carry it.
        'mirror-value':  (el, d) => {
            const target = document.getElementById(d.mirrorTarget);
            if (target) target.textContent = el.value;
        },
    },
});
