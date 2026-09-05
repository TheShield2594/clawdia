
// The Leveling panel (#935), and the Season Pass's tier rows.
//
// The tier-row builder is here because it is the same repeater as the level
// role rewards above it — the same row shape, the same remove button, the same
// screen-reader numbering — and the two would drift apart kept in different
// files.

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
    apiFetch('/api/v1/guild/' + guildId + '/leveling/leaderboard?page=' + page)
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/leveling/adjust', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action, amount })
        });
        const data = await resp.json();
        if (!resp.ok) { msgEl.style.color = 'var(--bad)'; msgEl.textContent = data.error || 'Failed.'; return; }
        msgEl.style.color = 'var(--good)';
        // `settled: false` means the XP landed but another writer kept beating
        // the level fold to the document. Saying "done" with a level the server
        // has just told us it did not write would be the misreport this whole
        // path exists to avoid.
        msgEl.textContent = data.settled === false
            ? 'XP applied — level is still catching up; reload in a moment.'
            : 'Done — level: ' + data.level + ' · XP: ' + Number(data.xp).toLocaleString();
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
        const resp = await apiFetch('/api/v1/guild/' + guildId + '/leveling/xp-event', {
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
    btn.setAttribute('aria-label', 'Remove ' + roleName);
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
    btn.setAttribute('aria-label', 'Remove ' + channelName);
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
    delBtn.dataset.rowRemove = 'level-reward';
    delBtn.textContent = '×';
    delBtn.onclick = () => row.remove();
    row.appendChild(levelInput);
    row.appendChild(newSelect);
    row.appendChild(delBtn);
    list.appendChild(row);
    labelRepeatedRows(list);
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
        '<button class="btn btn-danger" type="button" data-action="row-remove" data-row-selector=".season-tier-row" title="Remove" data-row-remove="season-tier">&times;</button>';
    list.appendChild(row);
    labelRepeatedRows(list);
}

registerPanelActions({
    click: {
        'level-leaderboard':      () => loadLevelLeaderboard(1, true),
        'start-boost-event':      () => startBoostEvent(),
        'add-level-no-xp-role':   () => addLevelNoXpRole(),
        'add-level-no-xp-channel': () => addLevelNoXpChannel(),
        'add-level-role-reward':  () => addLevelRoleReward(),
        'add-season-tier-row':    () => addSeasonTierRow(),
        'level-admin':       (el, d) => levelAdminAction(d.levelAction),
        'level-no-xp-role-remove':    (el, d) => removeLevelNoXpRole(d.noXpRoleId),
        'level-no-xp-channel-remove': (el, d) => removeLevelNoXpChannel(d.channelId),
    },
});

onShown('leveling', () => loadLevelLeaderboard(1));
