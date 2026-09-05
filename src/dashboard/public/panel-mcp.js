
// The AI panel's MCP tab (#935): the guild's connections, the OAuth round trip
// for the ones that need it, and what they have been costing.
//
// Its own file rather than part of panel-ai.js: it is the largest of the AI
// tabs on its own, it is the only one that fetches its state rather than
// reading it out of the bootstrap payload (the response is the one place that
// knows which servers are editable, and a token never comes back with it), and
// it is the only one with a connection to a third party to keep alive.

// The `.mcp-test-result` slot inside the row a connection button sits in, which
// is where a test or an OAuth round trip writes what happened.
function mcpResultSlot(el) {
    const row = el.closest('.list-item');
    return row && row.querySelector('.mcp-test-result');
}
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

// A function rather than the values: settings-payload.js calls this itself, so
// that a Chat-tab save made before loadMcpServers() has answered posts nothing
// for MCP rather than posting the markup defaults over what is stored.
function mcpSaveState() {
    return _mcpHydrated
        ? { confirm: mcpEl('mcp-confirm').value, route: mcpEl('mcp-route').value }
        : null;
}
registerPayloadSources({ mcpSettings: () => mcpSaveState });

async function loadMcpServers(force) {
    if (_mcpServers && !force) { renderMcpServers(); return; }
    const guildId = BOOT.guildId;
    try {
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/mcp-servers');
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
    mcpEl('mcp-form-title').scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name), {
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name), { method: 'DELETE' });
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/mcp-servers/' + encodeURIComponent(name) + '/test', { method: 'POST' });
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
        const resp = await apiFetch(
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
        const resp = await apiFetch(
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
        const resp = await apiFetch('/api/v1/guild/' + BOOT.guildId + '/mcp-servers/usage');
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

registerPanelActions({
    click: {
        'reset-mcp-form':  () => resetMcpForm(),
        'save-mcp-server': () => saveMcpServer(),
        // The approval mode lives on this tab but is part of the ai document, so
        // it saves through the same section as everything else on the Chat tab.
        'mcp-save-confirm': () => saveSettings('ai'),
        'mcp-test':          (el, d) => testMcpServer(d.serverName, mcpResultSlot(el)),
        'mcp-oauth-connect': (el, d) => startMcpOAuth(d.serverName, mcpResultSlot(el)),
        'mcp-oauth-disconnect': (el, d) => disconnectMcpOAuth(d.serverName),
        'mcp-edit':          (el, d) => editMcpServer(d.serverName),
        'mcp-remove':        (el, d) => removeMcpServer(d.serverName),
    },
    change: {
        'mcp-preset': () => applyMcpPreset(),
    },
});

onShown('ai-mcp', () => loadMcpServers());
