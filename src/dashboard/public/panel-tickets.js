// The tickets panel's open-tickets table (#1012).
//
// The settings half of the panel saves through the generic settings endpoint
// like every other panel; this script only fills the read-only table of open
// tickets, fetched the first time the panel is shown and on the refresh button.
// Globals (BOOT, apiFetch, onShown, registerPanelActions, escHtml) come from
// dashboard-core.js / esc-html.js, loaded first.
//
// Visibility is toggled with the `tickets-hidden` class rather than an inline
// style: a dashboard script must render no `style=` attribute of its own
// (tests/dashboardInlineAttributes.js), and the layout classes live in
// styles.css.

function setTicketsState(id, shown) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('tickets-hidden', !shown);
}

async function loadOpenTickets() {
    const guildId = BOOT.guildId;
    setTicketsState('tickets-loading', true);
    setTicketsState('tickets-error', false);
    setTicketsState('tickets-empty', false);
    setTicketsState('tickets-table-wrap', false);

    try {
        const resp = await apiFetch(`/api/v1/guild/${guildId}/tickets`);
        if (!resp.ok) throw new Error('Non-OK');
        const { items } = await resp.json();
        setTicketsState('tickets-loading', false);
        if (!items.length) { setTicketsState('tickets-empty', true); return; }

        const tbody = document.getElementById('tickets-tbody');
        tbody.innerHTML = '';
        for (const t of items) {
            const opener = t.openerTag
                ? `<span title="${escHtml(t.openerId)}">${escHtml(t.openerTag)}</span>`
                : `<span class="tickets-rawid">${escHtml(t.openerId)}</span>`;
            const claimed = t.claimedBy
                ? (t.claimedByTag ? `<span title="${escHtml(t.claimedBy)}">${escHtml(t.claimedByTag)}</span>` : `<span class="tickets-rawid">${escHtml(t.claimedBy)}</span>`)
                : '<span class="tickets-muted">Unclaimed</span>';
            const opened = t.openedAt ? new Date(t.openedAt).toLocaleDateString() : '';
            const num = String(t.ticketId).padStart(4, '0');
            tbody.insertAdjacentHTML('beforeend', `<tr>
                <td>#${num}</td>
                <td>${opener}</td>
                <td>${t.subject ? escHtml(t.subject) : '<span class="tickets-muted">—</span>'}</td>
                <td>${claimed}</td>
                <td>${opened}</td>
            </tr>`);
        }
        setTicketsState('tickets-table-wrap', true);
    } catch {
        setTicketsState('tickets-loading', false);
        setTicketsState('tickets-error', true);
    }
}

registerPanelActions({
    click: {
        'tickets-refresh': () => loadOpenTickets(),
    },
});

onShown('tickets', () => loadOpenTickets());
