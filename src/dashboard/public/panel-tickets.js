// The tickets panel's open-tickets table (#1012).
//
// The settings half of the panel saves through the generic settings endpoint
// like every other panel; this script only fills the read-only table of open
// tickets, fetched the first time the panel is shown and on the refresh button.
// Globals (BOOT, apiFetch, onShown, registerPanelActions, escHtml,
// setTableVisible) come from dashboard-core.js / esc-html.js, loaded first.

async function loadOpenTickets() {
    const guildId = BOOT.guildId;
    const loading = document.getElementById('tickets-loading');
    const errorEl = document.getElementById('tickets-error');
    const emptyEl = document.getElementById('tickets-empty');
    if (loading) loading.style.display = '';
    if (errorEl) errorEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'none';
    setTableVisible('tickets-table', false);

    try {
        const resp = await apiFetch(`/api/v1/guild/${guildId}/tickets`);
        if (!resp.ok) throw new Error('Non-OK');
        const { items } = await resp.json();
        if (loading) loading.style.display = 'none';
        if (!items.length) { if (emptyEl) emptyEl.style.display = ''; return; }

        const tbody = document.getElementById('tickets-tbody');
        tbody.innerHTML = '';
        for (const t of items) {
            const opener = t.openerTag
                ? `<span title="${escHtml(t.openerId)}">${escHtml(t.openerTag)}</span>`
                : `<span style="font-size:.8em">${escHtml(t.openerId)}</span>`;
            const claimed = t.claimedBy
                ? (t.claimedByTag ? `<span title="${escHtml(t.claimedBy)}">${escHtml(t.claimedByTag)}</span>` : `<span style="font-size:.8em">${escHtml(t.claimedBy)}</span>`)
                : '<span style="opacity:.6">Unclaimed</span>';
            const opened = t.openedAt ? new Date(t.openedAt).toLocaleDateString() : '';
            const num = String(t.ticketId).padStart(4, '0');
            tbody.insertAdjacentHTML('beforeend', `<tr>
                <td>#${num}</td>
                <td>${opener}</td>
                <td>${t.subject ? escHtml(t.subject) : '<span style="opacity:.6">—</span>'}</td>
                <td>${claimed}</td>
                <td>${opened}</td>
            </tr>`);
        }
        setTableVisible('tickets-table', true);
    } catch {
        if (loading) loading.style.display = 'none';
        if (errorEl) errorEl.style.display = '';
    }
}

registerPanelActions({
    click: {
        'tickets-refresh': () => loadOpenTickets(),
    },
});

onShown('tickets', () => loadOpenTickets());
