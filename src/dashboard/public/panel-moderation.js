
// The moderation panels (#935): the warning escalation ladder, command
// policies, the active-sanctions table and the case history.
//
// Four panels rather than one, and they are together because they are the same
// subsystem seen from four angles — what happens automatically, what members
// may run, who is currently under a sanction, and what was done before.

const ESCALATION_DEFAULTS = [
    { threshold: 3,  action: 'mute', durationMinutes: 10,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
    { threshold: 5,  action: 'mute', durationMinutes: 60,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
    { threshold: 7,  action: 'kick', durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
    { threshold: 10, action: 'ban',  durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' }
];
let ESCALATION_LADDER = boot('escalationLadder');
onPanel('moderation', renderEscalationLadder);
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
            <div><button type="button" class="btn btn-sm" data-action="escalation-remove" data-idx="${idx}" aria-label="Remove escalation step ${idx + 1}">✕</button></div>
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

registerPayloadSources({ serializeEscalationLadder: () => serializeEscalationLadder });
// Command Policies state
var _cpRules     = boot('commandPolicyRules');
var _cpCooldowns = boot('commandPolicyCooldowns');
var _cpRuleIdx = -1;
var _cpCdIdx   = -1;

registerPayloadSources({ cpRules: () => _cpRules, cpCooldowns: () => _cpCooldowns });
function renderCpRules() {
    const list = document.getElementById('cp-rules-list');
    if (!_cpRules.length) { list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem;">No rules — click <strong>+ Add rule</strong> to add one.</p>'; return; }
    list.innerHTML = _cpRules.map(function(r, i) {
        const color = r.effect === 'allow' ? '#2ecc71' : '#e74c3c';
        return '<div class="store-item-card" style="padding:.6rem .9rem;display:flex;align-items:center;gap:.75rem;">' +
            '<span style="flex:1"><strong>' + escHtml(r.command) + '</strong> — <span style="color:' + color + '">' + escHtml(r.effect) + '</span></span>' +
            '<button class="btn btn-sm" data-action="cp-rule-edit" data-idx="' + i + '">Edit</button>' +
            '<button class="btn btn-sm" style="color:#e74c3c" data-action="cp-rule-remove" data-idx="' + i + '" aria-label="Remove the ' + escHtml(r.command) + ' rule">✕</button></div>';
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
            '<button class="btn btn-sm" data-action="cp-cooldown-edit" data-idx="' + i + '">Edit</button>' +
            '<button class="btn btn-sm" style="color:#e74c3c" data-action="cp-cooldown-remove" data-idx="' + i + '" aria-label="Remove the ' + escHtml(c.command) + ' cooldown override">✕</button></div>';
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
    btn.setAttribute('aria-label', 'Remove ' + roleName);
    btn.textContent = '×';
    btn.onclick = function() { tag.remove(); };
    tag.appendChild(btn);
    list.appendChild(tag);
    sel.value = '';
}

// Initialize CP lists
onPanel('commandpolicies', () => { renderCpRules(); renderCpCooldowns(); });
// ── Moderation: Active Sanctions ──────────────────────────────────────
let _sanctionsData = null;
let _sanctionsFilter = 'all';

function setSanctionsFilter(filter, btn) {
    _sanctionsFilter = filter;
    document.querySelectorAll('.sanctions-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (_sanctionsData) renderSanctions(_sanctionsData);
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
        const resp = await apiFetch(`/api/v1/guild/${guildId}/sanctions/active`);
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
        const resp = await apiFetch(`/api/v1/guild/${guildId}/sanctions/unban/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
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
        const resp = await apiFetch(`/api/v1/guild/${guildId}/sanctions/untimeout/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
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
        const resp = await apiFetch(`/api/v1/guild/${guildId}/cases?${params}`);
        if (!resp.ok) throw new Error('Non-OK');
        const { items, total, pages } = await resp.json();
        document.getElementById('cases-loading').style.display = 'none';
        if (!items.length) { document.getElementById('cases-empty').style.display = ''; return; }
        const tbody = document.getElementById('cases-tbody');
        tbody.innerHTML = '';
        for (const c of items) {
            const date = new Date(c.createdAt).toLocaleDateString();
            const targetCell = c.targetUserTag
                ? `<span title="${escHtml(c.targetUserId)}">${c.targetAvatarUrl ? `<img src="${escHtml(c.targetAvatarUrl)}" alt="" style="width:16px;height:16px;border-radius:50%;margin-right:4px;vertical-align:middle" data-hide-on-error>` : ''}${escHtml(c.targetUserTag)}</span>`
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
                    <button class="btn btn-sm" data-action="case-note" data-case-id="${c.caseId}">Add note</button>
                    ${c.status === 'open' ? `<button class="btn btn-sm btn-danger" data-action="case-close" data-case-id="${c.caseId}">Close</button>` : ''}
                </td>
            </tr>`);
        }
        setTableVisible('cases-table', true);
        if (pages > 1) {
            paginEl.style.display = 'flex';
            paginEl.innerHTML = '';
            if (page > 1) paginEl.insertAdjacentHTML('beforeend', `<button class="btn btn-sm" data-action="case-page" data-page="${page - 1}">‹ Prev</button>`);
            paginEl.insertAdjacentHTML('beforeend', `<span style="font-size:.85em;opacity:.7">Page ${page} of ${pages} (${total} total)</span>`);
            if (page < pages) paginEl.insertAdjacentHTML('beforeend', `<button class="btn btn-sm" data-action="case-page" data-page="${page + 1}">Next ›</button>`);
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
        const resp = await apiFetch(`/api/v1/guild/${guildId}/cases/${caseId}`, {
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

registerPanelActions({
    click: {
        'add-escalation-step':     () => addEscalationStep(),
        'reset-escalation-ladder': () => resetEscalationLadder(),
        'escalation-remove': (el, d) => removeEscalationStep(Number(d.idx)),

        'add-cp-exc-role':         () => addCpExcRole(),
        'close-cp-rule-modal':     () => closeCpRuleModal(),
        'save-cp-rule-modal':      () => saveCpRuleModal(),
        'close-cp-cooldown-modal': () => closeCpCooldownModal(),
        'save-cp-cooldown-modal':  () => saveCpCooldownModal(),
        'cp-rule-edit':       (el, d) => openCpRuleModal(Number(d.idx)),
        'cp-rule-remove':     (el, d) => { _cpRules.splice(Number(d.idx), 1); renderCpRules(); },
        'cp-cooldown-edit':   (el, d) => openCpCooldownModal(Number(d.idx)),
        'cp-cooldown-remove': (el, d) => { _cpCooldowns.splice(Number(d.idx), 1); renderCpCooldowns(); },

        'load-active-sanctions':   () => loadActiveSanctions(),
        'sanctions-filter':   (el, d) => setSanctionsFilter(d.filter, el),

        'close-case-note-modal':   () => closeCaseNoteModal(),
        'submit-case-action':      () => submitCaseAction(),
        'case-note':          (el, d) => openCaseNoteModal(Number(d.caseId)),
        'case-close':         (el, d) => closeCase(Number(d.caseId)),
        'case-page':          (el, d) => loadCaseHistory(Number(d.page)),
    },
    change: {
        // The pager is a <select> on a narrow viewport and buttons on a wide
        // one, so the same page number arrives as either event.
        'case-page': (el, d) => loadCaseHistory(Number(d.page)),
    },
});

onShown('mod-tab-sanctions', () => loadActiveSanctions());
onShown('mod-tab-cases', () => loadCaseHistory(1));
