
// The Achievements panel (#935): which built-in achievements are on, the
// guild's own custom ones, and granting one to a member by hand.
//
// The member picker is here rather than in the shared machinery because this
// is the only place that grants: it is a search box, a debounce, an abortable
// request and a dropdown, and all four exist to fill in one field of the grant
// dialog.

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

registerPayloadSources({
    disabledAchievements: () => _disabledAchievements,
    customAchievements:   () => _customAchievements,
});

// Below the state it reads rather than at the top of the file: onPanel() runs
// its callback straight away when the panel is already in the document, and
// `var` hoists the declaration without the value.
onPanel('achievements', function() {
    renderBuiltinAchievements();
    renderCustomAchievements();
});

function renderBuiltinAchievements() {
    const list = document.getElementById('builtin-ach-list');
    if (!_BUILTIN_ACHS.length) { list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem">No built-in achievements loaded.</p>'; return; }
    list.innerHTML = _BUILTIN_ACHS.map(function(a) {
        const disabled = _disabledAchievements.indexOf(a.id) !== -1;
        // The label falls back to the stored category when the map has no
        // entry for it, so it carries whatever was saved — escaped like
        // every other value on this card.
        const catLabel = escHtml((ACH_CAT_EMOJIS[a.category] || '🔹') + ' ' + (ACH_CAT_LABELS[a.category] || a.category));
        return '<div class="store-item-card" style="padding:.6rem .9rem;display:flex;align-items:center;gap:.75rem;">' +
            '<span style="font-size:1.4rem">' + escHtml(a.emoji) + '</span>' +
            '<span style="flex:1"><strong>' + escHtml(a.name) + '</strong> <span style="font-size:.8rem;color:var(--text-dim)">' + catLabel + '</span><br>' +
                '<span style="font-size:.85rem;color:var(--text-mute)">' + escHtml(a.description) + '</span></span>' +
            '<span style="font-size:.8rem;color:var(--text-dim);margin-right:.5rem">' +
                (a.xpReward ? '+' + Number(a.xpReward) + ' XP' : '') + (a.xpReward && a.coinReward ? ' · ' : '') + (a.coinReward ? '+' + a.coinReward.toLocaleString() + ' coins' : '') +
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
        // Same fallback, same rule as the built-in list above.
        const catLabel = escHtml((ACH_CAT_EMOJIS[a.category] || '🔹') + ' ' + (ACH_CAT_LABELS[a.category] || a.category));
        return '<div class="store-card">' +
            '<div class="store-card-body">' +
                '<div class="store-card-name">' + escHtml(a.emoji || '🏆') + ' ' + escHtml(a.name) + '</div>' +
                '<div class="store-card-desc">' + (a.description ? escHtml(a.description) : '<em style="color:var(--text-mute)">No description</em>') + '</div>' +
                '<div class="store-card-meta">' +
                    '<span class="store-meta-tag">' + catLabel + '</span>' +
                    (a.xpReward ? '<span class="store-meta-tag">+' + Number(a.xpReward) + ' XP</span>' : '') +
                    (a.coinReward ? '<span class="store-meta-tag price-tag">+' + Number(a.coinReward).toLocaleString() + ' coins</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="store-card-actions">' +
                '<button class="btn btn-sm" data-action="ach-grant" data-ach-id="' + escHtml(a.id) + '" data-ach-name="' + escHtml(a.name) + '">Grant</button>' +
                '<button class="btn btn-sm" data-action="ach-edit" data-idx="' + i + '">Edit</button>' +
                '<button class="btn btn-sm btn-danger" data-action="ach-delete" data-idx="' + i + '">Remove</button>' +
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/members/search?q=' + encodeURIComponent(q), { signal: controller.signal });
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/achievements/grant', {
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

// Clicking the backdrop closes this panel's dialog.
document.addEventListener('click', function(e) {
    if (e.target.id === 'ach-modal') closeAchModal();
});

registerPanelActions({
    click: {
        'close-ach-modal':       () => closeAchModal(),
        'save-ach-modal':        () => saveAchModal(),
        'close-ach-grant-modal': () => closeAchGrantModal(),
        'submit-ach-grant':      () => submitAchGrant(),
        'ach-edit':         (el, d) => openAchModal(Number(d.idx)),
        'ach-delete':       (el, d) => deleteCustomAch(Number(d.idx)),
        'ach-grant':        (el, d) => openAchGrantModal(d.achId, d.achName),
    },
    input: {
        'member-search': () => debouncedMemberSearch(),
    },
});
