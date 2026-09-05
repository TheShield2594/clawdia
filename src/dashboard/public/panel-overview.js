
// The Overview panel (#935): the Getting Started checklist and the live stats
// the page opens on.
//
// The panel that ships with the page rather than being fetched on a click, so
// everything here runs on load for most visits.

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
    const body   = document.getElementById('getting-started-body');
    const toggle = document.getElementById('gs-toggle');
    const icon   = document.getElementById('gs-toggle-icon');
    if (!body) return;
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    // The glyph is decorative (aria-hidden in the view), so aria-expanded is the
    // only thing reporting the state to anyone not looking at it (#882). The two
    // move together or the button lies.
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (icon) icon.textContent = open ? '▾' : '▸';
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
            apiFetch(`/api/v1/guild/${guildId}/stats`),
            apiFetch(`/api/v1/guild/${guildId}/insights`)
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

        // Ask Clawdia recommendations.
        //
        // The strings arrive off the API, so they go through escHtml on the
        // way into innerHTML (#918). Every one of them is a fixed sentence
        // today, but the first that quotes a guild name, a channel topic or a
        // nickname would make this sink stored XSS, and the escape costs
        // nothing to have in place before that.
        const recs = a.recommendations || [];
        const msgEl = document.getElementById('clawdia-msg');
        const actionsEl = document.getElementById('clawdia-actions');
        if (msgEl) {
            if (recs.length > 0) {
                msgEl.innerHTML = recs.slice(0, 3).map(r =>
                    `<div style="display:flex;gap:.5rem;align-items:flex-start;margin-bottom:.4rem"><span style="color:var(--accent,#f90);flex-shrink:0">💡</span><span>${escHtml(r)}</span></div>`
                ).join('');
            } else {
                msgEl.innerHTML = `<b>Everything looks good on ${escHtml(BOOT.guildName)}.</b><br><span style="opacity:.7">No active recommendations right now.</span>`;
            }
        }
        if (actionsEl) {
            actionsEl.innerHTML = `
                <button class="dash-bot-btn" data-action="goto-tab" data-tab="analytics">Open Analytics →</button>
                <button class="dash-bot-btn" data-action="goto-tab" data-tab="moderation" style="background:transparent;">Configure Moderation</button>
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
                    <span style="font-size:.875rem;color:${it.color || 'inherit'}">${escHtml(it.text)}</span>
                </div>`
            ).join('');
        }
    } catch {
        const msgEl = document.getElementById('clawdia-msg');
        if (msgEl) msgEl.innerHTML = `Open <a href="#" data-action="goto-tab" data-tab="analytics">Analytics</a> to review server health.`;
        const actionsEl = document.getElementById('clawdia-actions');
        if (actionsEl) actionsEl.innerHTML = `<button class="dash-bot-btn" data-action="goto-tab" data-tab="analytics">Open Analytics →</button>`;
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

registerPanelActions({
    click: {
        'toggle-getting-started':  () => toggleGettingStarted(),
        'dismiss-getting-started': () => dismissGettingStarted(),
    },
});
