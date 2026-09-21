
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
    if (!body) return;
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    // aria-expanded reports the state to anyone not looking at it (#882) and
    // also drives the chevron's rotation in CSS, so the two cannot disagree.
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
}
function dismissGettingStarted() {
    const guildId = BOOT.guildId;
    localStorage.setItem(`gs_dismissed_${guildId}`, '1');
    const wrap = document.getElementById('getting-started-wrap');
    if (wrap) wrap.style.display = 'none';
}

// ── Overview KPI helpers (v5) ────────────────────────────────────────
// A number that ticks up to its value — the one motion flourish on the strip.
// Off entirely under reduced motion, or where requestAnimationFrame is missing
// (jsdom in tests), where it just writes the final number so the value is never
// left mid-count. Formats with the locale's grouping and an optional sign.
function overviewCount(el, to, prefix = '') {
    if (!el) return;
    const fmt = n => prefix + Math.round(n).toLocaleString();
    const reduce = typeof window.matchMedia !== 'function'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches
        || typeof requestAnimationFrame !== 'function';
    if (reduce) { el.textContent = fmt(to); return; }
    const dur = 650, t0 = performance.now();
    (function step(t) {
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
    })(t0);
}

// The hero's week-over-week delta, coloured by direction and always carrying a
// ▲/▼/→ glyph so colour is never the only signal. `value` is an integer we
// computed, never guild-supplied text, so it goes into innerHTML directly.
function overviewDelta(el, value) {
    if (!el) return;
    const dir = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '→';
    const sign = value > 0 ? '+' : '';
    el.className = 'dash-kpi-delta ' + dir;
    el.innerHTML = `<span class="dash-kpi-delta-arrow" aria-hidden="true">${arrow}</span>${sign}${value} vs last wk`;
    el.hidden = false;
}

// A minimal area sparkline for the hero. Decorative — the container is
// aria-hidden and the same trend is in the delta and foot — so it is built from
// presentation attributes with no inline style, keeping the #692 ratchet clean.
// One hero on the page, so the gradient id is fixed.
function overviewSparkline(host, series) {
    if (!host || series.length < 2) return;
    const w = 100, h = 40, pad = 3;
    const min = Math.min(...series), max = Math.max(...series), span = (max - min) || 1;
    const pts = series.map((v, i) => [pad + (i * (w - pad * 2)) / (series.length - 1), h - pad - ((v - min) / span) * (h - pad * 2)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = `M${pts[0][0].toFixed(1)} ${h} ` + pts.map(p => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ` L${pts[pts.length - 1][0].toFixed(1)} ${h} Z`;
    host.innerHTML =
        `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
        '<defs><linearGradient id="ov-spark-grad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#9aa876" stop-opacity="0.24"/><stop offset="1" stop-color="#9aa876" stop-opacity="0"/></linearGradient></defs>' +
        `<path d="${area}" fill="url(#ov-spark-grad)"/>` +
        `<path d="${line}" fill="none" stroke="#9aa876" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
        '</svg>';
}

// Small line icons for the activity feed and recommendation list, in the same
// language as the sidebar and the KPI tiles. Decorative — the row's text carries
// the meaning — so aria-hidden, and coloured by currentColor off the chip class.
const OV_ICON_PATHS = {
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><circle cx="17" cy="9" r="2.5"/><path d="M22 19c0-2.5-2-4.5-5-4.5"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z"/>',
    alert: '<path d="M12 4l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/>',
    bulb: '<path d="M9.5 18h5"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.1 1 1.9h5c.1-.8.4-1.4 1-1.9A6 6 0 0 0 12 3z"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
};
function ovIcon(name) {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${OV_ICON_PATHS[name] || ''}</svg>`;
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

        // Members KPI — the hero. The value and 7-day figures come from
        // retention; the week-over-week delta and the sparkline from the 30-day
        // memberGrowth series (last 7 days vs the 7 before). The headline number
        // stays cream — the colour lives in the delta chip, not the number.
        const joins7 = ret.joins7 ?? 0;
        const leaves7 = ret.leaves7 ?? 0;
        const net7 = joins7 - leaves7;
        const memberVal = document.getElementById('kpi-members-value');
        const memberFoot = document.getElementById('kpi-members-foot');
        overviewCount(memberVal, net7, net7 >= 0 ? '+' : '');
        if (memberFoot) memberFoot.textContent = `${joins7} joined · ${leaves7} left (7d)`;

        const growth = a.memberGrowth || [];
        if (growth.length >= 2) {
            const dayNet = day => (day.joins || 0) - (day.leaves || 0);
            const last7 = growth.slice(-7);
            let running = 0;
            overviewSparkline(document.getElementById('kpi-members-spark'), last7.map(day => (running += dayNet(day))));
            const thisWeek = last7.reduce((sum, day) => sum + dayNet(day), 0);
            const prevWeek = growth.slice(-14, -7).reduce((sum, day) => sum + dayNet(day), 0);
            overviewDelta(document.getElementById('kpi-members-delta'), thisWeek - prevWeek);
        }

        // Bot Status KPI — a live dot (in the markup) plus the word; the size is
        // the .status class now, not an inline font-size.
        const botVal = document.getElementById('kpi-bot-value');
        const botFoot = document.getElementById('kpi-bot-foot');
        if (botVal) botVal.textContent = 'Online';
        if (botFoot) { botFoot.textContent = 'Active'; botFoot.style.color = 'var(--good)'; }

        // Moderation KPI
        const modCmds = ['warn','mute','kick','ban','timeout','unmute','unban'];
        const modTotal = modCmds.reduce((sum, cmd) => sum + (a.commandUsage?.[cmd]?.total || 0), 0);
        const modVal = document.getElementById('kpi-mod-value');
        const modFoot = document.getElementById('kpi-mod-foot');
        overviewCount(modVal, modTotal);
        if (modFoot) modFoot.textContent = modTotal === 1 ? 'action this week' : 'actions this week';

        // Economy KPI
        const ecoActive = a.economyStats?.activeUsers ?? 0;
        overviewCount(document.getElementById('kpi-eco-value'), ecoActive);

        // Leveling KPI
        const topLevel = stats.topLevels?.[0]?.level ?? 0;
        const levelVal = document.getElementById('kpi-level-value');
        const levelFoot = document.getElementById('kpi-level-foot');
        overviewCount(levelVal, topLevel);
        if (levelFoot) levelFoot.textContent = topLevel ? 'highest member level' : 'no levels yet';

        // AI KPI
        const aiCmds = ['ask', 'ai', 'chat', 'aiask', 'clawdia'];
        const aiTotal = aiCmds.reduce((sum, cmd) => sum + (a.commandUsage?.[cmd]?.total || 0), 0);
        const aiVal = document.getElementById('kpi-ai-value');
        const aiFoot = document.getElementById('kpi-ai-foot');
        overviewCount(aiVal, aiTotal);
        if (aiFoot) aiFoot.textContent = aiTotal === 1 ? 'Clawdia chat' : 'Clawdia chats';

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
                    `<div class="dash-rec">${ovIcon('bulb')}<span>${escHtml(r)}</span></div>`
                ).join('');
            } else {
                msgEl.innerHTML = `<b>Everything looks good on ${escHtml(BOOT.guildName)}.</b><br><span class="dash-bot-dim">No active recommendations right now.</span>`;
            }
        }
        if (actionsEl) {
            actionsEl.innerHTML = `
                <button class="dash-bot-btn" data-action="goto-tab" data-tab="analytics">Open Analytics →</button>
                <button class="dash-bot-btn ghost" data-action="goto-tab" data-tab="moderation">Configure Moderation</button>
            `;
        }

        // Recent Activity feed
        const feed = document.getElementById('overview-activity-feed');
        const lastUpdated = document.getElementById('overview-last-updated');
        if (lastUpdated) lastUpdated.textContent = 'updated just now';
        if (feed) {
            // Built on the shared .dash-feed component (a tinted icon chip + body),
            // not ad-hoc emoji rows. The chip's `kind` sets its colour; the row's
            // words carry the meaning, so colour is never the only signal.
            const items = [];
            if (joins7 > 0 || leaves7 > 0) {
                items.push({ kind: net7 >= 0 ? 'good' : 'warn', icon: 'users', text: `${joins7} joined, ${leaves7} left in the last 7 days` });
            }
            if (modTotal > 0) {
                items.push({ kind: 'info', icon: 'shield', text: `${modTotal} moderation action${modTotal === 1 ? '' : 's'} recorded recently` });
            }
            const churnAlerts = a.churnAlerts || [];
            for (const alert of churnAlerts.slice(0, 2)) {
                items.push({ kind: 'warn', icon: 'alert', text: alert });
            }
            if (recs.length > 0) {
                items.push({ kind: 'info', icon: 'bulb', text: `${recs.length} recommendation${recs.length === 1 ? '' : 's'} available — see Ask Clawdia above` });
            }
            if (items.length === 0) {
                items.push({ kind: 'good', icon: 'check', text: 'No notable activity signals right now. Check Analytics for deeper insights.' });
            }
            feed.innerHTML = items.map(it =>
                `<div class="dash-feed-item"><span class="dash-feed-icon ${it.kind}">${ovIcon(it.icon)}</span><div class="dash-feed-body">${escHtml(it.text)}</div></div>`
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
        // Clear the initial "loading…" foots too, or a failed KPI reads as one
        // still loading forever rather than one that could not load.
        const memberFoot = document.getElementById('kpi-members-foot');
        const modFoot = document.getElementById('kpi-mod-foot');
        if (memberFoot) memberFoot.textContent = 'unavailable';
        if (modFoot) modFoot.textContent = 'unavailable';
        if (botVal2) botVal2.textContent = 'Online';
        if (botFoot2) { botFoot2.textContent = 'Active'; botFoot2.style.color = 'var(--good)'; }
        const feed = document.getElementById('overview-activity-feed');
        if (feed) feed.innerHTML = '<span class="dash-feed-empty">Could not load activity data.</span> <button class="btn btn-sm" type="button" data-action="reload-overview">Retry</button>';
    }
}
onPanel('overview', loadOverviewStats);

registerPanelActions({
    click: {
        'toggle-getting-started':  () => toggleGettingStarted(),
        'dismiss-getting-started': () => dismissGettingStarted(),
        'reload-overview':         () => loadOverviewStats(),
    },
});
