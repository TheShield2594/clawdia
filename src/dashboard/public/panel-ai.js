
// The AI panel (#935): the provider fields on the Chat tab, the knowledge base,
// the scheduled summaries, the per-channel personas, the full-screen prompt
// editor and the token-usage widget.
//
// One file for five inner tabs because they are one panel and one save: every
// tab here posts through the `ai` section, which is also why the MCP tab's own
// Save button (panel-mcp.js) calls saveSettings('ai').

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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/knowledge-base?page=' + wanted);
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/knowledge-base/' + id, {
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/knowledge-base', {
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/knowledge-base/' + id, { method: 'DELETE' });
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/summary-jobs');
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/daily-digest', {
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/summary-jobs', {
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/summary-jobs/' + jobId, { method: 'DELETE' });
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/persona', {
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/persona/' + encodeURIComponent(channelId), { method: 'DELETE' });
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

// EJS renders the saved systemPrompt verbatim, so pre-existing values can
// exceed the textarea's maxlength (e.g. one set through the API). Checked
// before the POST so an oversized prompt never reaches the server.
registerSaveGuard('ai', () => {
    const length = document.getElementById('ai-prompt').value.length;
    if (length <= 4000) return null;
    updatePromptCount('ai-prompt');
    return 'System prompt is ' + length + ' chars — maximum is 4000.';
});

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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/ai/usage?days=14');
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

registerPanelActions({
    click: {
        'add-persona':            () => addPersona(),
        'add-summary-job':        () => addSummaryJob(),
        'save-daily-digest':      () => saveDailyDigest(),
        'retry-load-summary-jobs': () => retryLoadSummaryJobs(),
        'close-prompt-editor':    () => closePromptEditor(false),
        'save-prompt-editor':     () => closePromptEditor(true),
        'persona-remove':    (el, d) => removePersona(d.channelId),
        'summary-delete':    (el, d) => deleteSummaryJob(d.jobId),
        'prompt-edit':       (el, d) => openPromptEditor(d.promptTarget, d.promptTitle),
    },
    input: {
        'prompt-editor-count':  () => updatePromptEditorCount(),
        'prompt-count':  (el, d) => updatePromptCount(d.promptTarget),
    },
    change: {
        'ai-provider': () => updateAiProviderUI(),
    },
});

// Three of the AI tabs fetch on first sight rather than out of the bootstrap
// payload. The MCP tab does too, from panel-mcp.js.
onShown('ai-knowledgebase', () => loadKnowledgeBase());
onShown('ai-summaries', () => loadSummaryJobs());
onShown('ai-personas', () => renderPersonas());
