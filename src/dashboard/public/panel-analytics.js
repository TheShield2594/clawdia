
// The Analytics panel (#935): six charts, their text equivalents, and the
// Chart.js loader they share.
//
// The library is fetched the first time a chart is about to be drawn (#685)
// rather than on every page load — only this panel and the Economy panel's
// Health tab draw one, and most sessions open neither. The panel is readable
// without its charts, so a library that will not load is reported and left
// there rather than failing the tab.

let _analyticsData = null;
let _analyticsInsights = null;
let _chartMemberGrowth = null;
let _chartCommandActivity = null;
let _chartRetention = null;
let _chartEconomy = null;
let _chartLeveling = null;
let _chartAiRequests = null;
let _analyticsRange = 7;

function setAnalyticsRange(days, btn) {
    _analyticsRange = days;
    document.querySelectorAll('.analytics-range').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (_analyticsData) renderAnalyticsCharts(_analyticsData, _analyticsInsights).catch(chartsUnavailable);
}

const _chartDefaults = {
    responsive: true,
    plugins: { legend: { labels: { color: '#ece4d2', font: { size: 11 } } } },
    scales: { x: { ticks: { color: '#b8a898', maxTicksLimit: 8 } }, y: { ticks: { color: '#b8a898' } } }
};

// Warm chart palette (v5): the charts read in the same cream/ink/claw system as
// the rest of the dashboard — no stray blues, golds or purples. `claw` is the
// primary, `moss` the positive/membership hue, `terra` the negative, `plum` the
// secondary categorical, and a warm amber stands in for coins. Each is a
// function of alpha so a single hue can also serve as a sequential ramp.
const CHART = {
    claw:  a => `rgba(217,119,66,${a})`,
    moss:  a => `rgba(138,152,99,${a})`,
    terra: a => `rgba(185,76,60,${a})`,
    plum:  a => `rgba(126,85,112,${a})`,
    gold:  a => `rgba(217,164,65,${a})`,
};

/** Sum one numeric key across a daily series, for the chart summaries. */
function sumBy(rows, key) {
    return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

const _HOUR_LABELS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/**
 * Weekday × hour activity heatmap (#1015), drawn as a CSS grid rather than a
 * Chart.js canvas: there is no matrix chart type loaded here, and a grid of
 * coloured cells is legible and accessible on its own. Colour is the same green
 * ramp the other charts use, scaled to the busiest cell. A row for entries
 * whose weekday predates the tracking is shown only when there are any, labelled
 * so it is not mistaken for a real day. The paired data table is emitted for the
 * reader who cannot see the grid, exactly as every chart here does.
 */
function renderActivityHeatmap(heatmap) {
    const host = document.getElementById('chart-heatmap-grid');
    const tz = heatmap?.timezone || 'UTC';
    const weekdays = heatmap?.weekdays || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const grid = heatmap?.grid || [];
    const unknown = heatmap?.unknownWeekday || [];
    const hasUnknown = !!heatmap?.hasUnknown;

    let max = 0;
    for (const row of grid) for (const v of row) if (v > max) max = v;
    if (hasUnknown) for (const v of unknown) if (v > max) max = v;

    // Intensity as one of four classes rather than an inline background — the
    // dashboard's CSP does not let the inline-style budget grow, so the colour
    // ramp lives in styles.css (.heat-1…4) and this only picks the bucket.
    const heatClass = v => (v > 0 ? ` heat-${Math.min(4, Math.ceil((v / max) * 4))}` : '');

    if (host) {
        host.innerHTML = '';
        if (!max) {
            host.insertAdjacentHTML('beforeend', '<p class="chart-no-data">No command activity yet</p>');
        } else {
            const parts = ['<div class="heatmap-grid">'];
            // Hour header row: a blank corner, then a label every six hours so
            // 24 columns stay readable.
            parts.push('<div></div>');
            for (let h = 0; h < 24; h++) {
                parts.push(`<div class="heatmap-hour">${h % 6 === 0 ? String(h).padStart(2, '0') : ''}</div>`);
            }
            const pushRow = (label, counts) => {
                parts.push(`<div class="heatmap-label">${escHtml(label)}</div>`);
                for (let h = 0; h < 24; h++) {
                    const v = Number(counts[h]) || 0;
                    parts.push(`<div class="heatmap-cell${heatClass(v)}" title="${escHtml(label)} ${_HOUR_LABELS[h]} — ${v} command${v === 1 ? '' : 's'}"></div>`);
                }
            };
            weekdays.forEach((label, day) => pushRow(label, grid[day] || []));
            if (hasUnknown) pushRow('Unknown', unknown);
            parts.push('</div>');
            parts.push(`<div class="heatmap-note">Times shown in ${escHtml(tz)}.${hasUnknown ? ' “Unknown” holds activity recorded before the weekday was tracked.' : ''}</div>`);
            host.insertAdjacentHTML('beforeend', parts.join(''));
        }
    }

    // Accessibility / no-Chart.js table: one row per weekday, columns are hours.
    const tableRows = weekdays.map((label, day) => [label, ...(grid[day] || Array(24).fill(0)).map(v => Number(v) || 0)]);
    if (hasUnknown) tableRows.push(['Unknown', ...unknown.map(v => Number(v) || 0)]);
    describeChart('chart-heatmap', {
        title:   `Activity by weekday and hour (${tz})`,
        summary: max
            ? `Command activity by weekday and hour, shown in ${tz}. Busiest cell: ${max} commands.`
            : 'Activity by weekday and hour — no data yet',
        columns: ['Day', ..._HOUR_LABELS],
        rows:    tableRows,
    });
}

/**
 * Draw every analytics chart and its accessible fallback from one payload:
 * command-usage trend, the retention cohorts, the weekday×hour activity
 * heatmap, and the moderation-SLA figures (#1015).
 *
 * @param {object} data     the stats payload the API returned
 * @param {object} insights the derived insights (cohorts, heatmap, SLA) for it
 */
async function renderAnalyticsCharts(data, insights) {
    // The summaries and data tables below are built from the same arrays the
    // charts are drawn from, and they have to survive a library that would not
    // load: a reader who cannot see the canvas anyway should not also lose the
    // numbers because a script fetch failed. So a load failure is reported and
    // the drawing skipped, rather than the whole render abandoned at the top.
    let charts = true;
    try {
        await loadChartJs();
    } catch (err) {
        charts = false;
        chartsUnavailable(err);
    }
    const a = data.analytics || {};
    const days = _analyticsRange;

    // Member growth chart
    const growthAll = a.memberGrowth || [];
    const growthSlice = growthAll.slice(-days);
    if (_chartMemberGrowth) _chartMemberGrowth.destroy();
    const ctxG = document.getElementById('chart-member-growth')?.getContext('2d');
    if (charts && ctxG) {
        _chartMemberGrowth = new Chart(ctxG, {
            type: 'bar',
            data: {
                labels: growthSlice.map(d => d.date.slice(5)),
                datasets: [
                    { label: 'Joins', data: growthSlice.map(d => d.joins), backgroundColor: CHART.moss(0.75), borderRadius: 3 },
                    { label: 'Leaves', data: growthSlice.map(d => d.leaves), backgroundColor: CHART.terra(0.6), borderRadius: 3 }
                ]
            },
            options: _chartDefaults
        });
    }

    describeChart('chart-member-growth', {
        title: `Member growth, last ${days} days`,
        summary: growthSlice.length
            ? `Member growth over the last ${days} days: ${sumBy(growthSlice, 'joins')} joins, ${sumBy(growthSlice, 'leaves')} leaves.`
            : 'Member growth — no data yet',
        columns: ['Date', 'Joins', 'Leaves'],
        rows: growthSlice.map(d => [d.date, d.joins || 0, d.leaves || 0]),
    });

    // Command activity chart — real per-command daily counts
    if (_chartCommandActivity) _chartCommandActivity.destroy();
    const ctxCA = document.getElementById('chart-command-activity')?.getContext('2d');
    const cmdSlice = (a.commandDaily || []).slice(-days);
    // Fallback when no daily breakdown has been recorded yet: the running
    // per-command totals, as a horizontal bar.
    const cmdRows = Object.entries(a.commandUsage || {}).sort((x, y) => y[1].total - x[1].total).slice(0, 8);
    if (charts && ctxCA) {
        if (cmdSlice.length) {
            _chartCommandActivity = new Chart(ctxCA, {
                type: 'bar',
                data: {
                    labels: cmdSlice.map(d => d.date.slice(5)),
                    datasets: [{ label: 'Commands', data: cmdSlice.map(d => d.count), backgroundColor: CHART.claw(0.7), borderRadius: 3 }]
                },
                options: _chartDefaults
            });
        } else {
            _chartCommandActivity = new Chart(ctxCA, {
                type: 'bar',
                data: {
                    labels: cmdRows.map(([cmd]) => '/' + cmd),
                    datasets: [{ label: 'Total runs', data: cmdRows.map(([,m]) => m.total), backgroundColor: CHART.claw(0.7), borderRadius: 3 }]
                },
                options: { ...JSON.parse(JSON.stringify(_chartDefaults)), indexAxis: 'y', plugins: { legend: { display: false } } }
            });
        }
    }

    describeChart('chart-command-activity', cmdSlice.length
        ? {
            title:   `Command activity, last ${days} days`,
            summary: `Command activity over the last ${days} days: ${sumBy(cmdSlice, 'count')} commands run.`,
            columns: ['Date', 'Commands'],
            rows:    cmdSlice.map(d => [d.date, d.count || 0]),
        }
        : {
            title:   'Most-used commands',
            summary: cmdRows.length
                ? `Most-used commands: ${cmdRows.map(([cmd, m]) => `/${cmd}, ${m.total}`).join('; ')}.`
                : 'Command activity — no data yet',
            columns: ['Command', 'Total runs'],
            rows:    cmdRows.map(([cmd, m]) => [`/${cmd}`, m.total || 0]),
        });

    // Retention cohort chart — D1/D7/D30 survival by the week each member
    // joined (#1015). A window with no bar for a recent cohort is not zero: it
    // is a cohort too young to have a figure for that window yet (the server
    // sends null until it is ripe), so it reads as a gap and the table as "—".
    if (_chartRetention) _chartRetention.destroy();
    const ctxR = document.getElementById('chart-retention')?.getContext('2d');
    const cohorts = insights?.retentionCohorts || [];
    const ret7 = insights?.retention?.retained7Pct || 0;
    const ret30 = insights?.retention?.retained30Pct || 0;
    // `null` is drawn as a gap; only the fallback pair coerces to 0.
    const pctOrGap = v => (v == null ? null : v);
    const pctText = v => (v == null ? '—' : `${v}%`);
    if (charts && ctxR) {
        if (cohorts.length) {
            _chartRetention = new Chart(ctxR, {
                type: 'bar',
                data: {
                    labels: cohorts.map(c => c.cohort),
                    datasets: [
                        { label: 'D1 %', data: cohorts.map(c => pctOrGap(c.d1Pct)), backgroundColor: CHART.moss(0.9), borderRadius: 3 },
                        { label: 'D7 %', data: cohorts.map(c => pctOrGap(c.d7Pct)), backgroundColor: CHART.moss(0.6), borderRadius: 3 },
                        { label: 'D30 %', data: cohorts.map(c => pctOrGap(c.d30Pct)), backgroundColor: CHART.moss(0.35), borderRadius: 3 }
                    ]
                },
                options: { ...JSON.parse(JSON.stringify(_chartDefaults)), scales: { ...JSON.parse(JSON.stringify(_chartDefaults.scales)), y: { ticks: { color: '#b8a898' }, max: 100 } } }
            });
        } else {
            _chartRetention = new Chart(ctxR, {
                type: 'bar',
                data: {
                    labels: ['D7 retention', 'D30 retention'],
                    datasets: [{ label: '%', data: [ret7, ret30], backgroundColor: [CHART.moss(0.8), CHART.moss(0.5)], borderRadius: 4 }]
                },
                options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#b8a898' }, max: 100 }, y: { ticks: { color: '#b8a898', font: { size: 11 } } } } }
            });
        }
    }

    describeChart('chart-retention', cohorts.length
        ? {
            title:   'Retention by join week',
            summary: `Retention by join week, ${cohorts.length} cohorts (join dates tracked from ${cohorts[0].cohort}): ` +
                     `${cohorts.map(c => `week of ${c.cohort}, D1 ${pctText(c.d1Pct)}, D7 ${pctText(c.d7Pct)}, D30 ${pctText(c.d30Pct)}`).join('; ')}.`,
            columns: ['Join week', 'Members', 'D1 %', 'D7 %', 'D30 %'],
            rows:    cohorts.map(c => [c.cohort, c.size || 0, pctText(c.d1Pct), pctText(c.d7Pct), pctText(c.d30Pct)]),
        }
        : {
            title:   'Retention',
            summary: `Retention: ${ret7}% of members still active after 7 days, ${ret30}% after 30 days. Per-week cohorts appear once members join with the new tracking in place.`,
            columns: ['Window', 'Retained %'],
            rows:    [['D7 retention', ret7], ['D30 retention', ret30]],
        });

    // Weekday × hour activity heatmap, in the guild's configured timezone
    // (#1015). Built as a CSS grid rather than a Chart.js canvas — Chart.js has
    // no matrix type loaded here, and the grid is legible and accessible on its
    // own. A paired data table is still emitted for the same reason every other
    // chart has one.
    renderActivityHeatmap(insights?.activeHours?.heatmap);

    // Helper: remove any stale "no data" placeholder from a chart card container
    function clearChartPlaceholder(container) {
        const p = container.querySelector('p.chart-no-data');
        if (p) p.remove();
    }

    // Economy activity chart
    if (_chartEconomy) _chartEconomy.destroy();
    const ctxE = document.getElementById('chart-economy')?.getContext('2d');
    const ecoSlice = (a.economyDaily || []).slice(-days);
    if (charts && ctxE) {
        clearChartPlaceholder(ctxE.canvas.parentElement);
        if (ecoSlice.length) {
            _chartEconomy = new Chart(ctxE, {
                type: 'bar',
                data: {
                    labels: ecoSlice.map(d => d.date.slice(5)),
                    datasets: [
                        { label: 'Coins earned', data: ecoSlice.map(d => d.earned || 0), backgroundColor: CHART.gold(0.8), borderRadius: 3 },
                        { label: 'Coins spent', data: ecoSlice.map(d => d.spent || 0), backgroundColor: CHART.terra(0.6), borderRadius: 3 }
                    ]
                },
                options: _chartDefaults
            });
        } else {
            ctxE.canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="chart-no-data" style="text-align:center;opacity:.4;font-size:.82rem;margin-top:.5rem">No economy data yet</p>');
        }
    }
    describeChart('chart-economy', {
        title:   `Economy activity, last ${days} days`,
        summary: ecoSlice.length
            ? `Economy activity over the last ${days} days: ${sumBy(ecoSlice, 'earned')} coins earned, ` +
              `${sumBy(ecoSlice, 'spent')} spent.`
            : 'Economy activity — no data yet',
        columns: ['Date', 'Coins earned', 'Coins spent'],
        rows:    ecoSlice.map(d => [d.date, d.earned || 0, d.spent || 0]),
    });

    // Leveling / XP chart
    if (_chartLeveling) _chartLeveling.destroy();
    const ctxL = document.getElementById('chart-leveling')?.getContext('2d');
    const xpSlice = (a.xpDaily || []).slice(-days);
    if (charts && ctxL) {
        clearChartPlaceholder(ctxL.canvas.parentElement);
        if (xpSlice.length) {
            _chartLeveling = new Chart(ctxL, {
                type: 'bar',
                data: {
                    labels: xpSlice.map(d => d.date.slice(5)),
                    datasets: [
                        { label: 'XP awarded', data: xpSlice.map(d => d.xp || 0), backgroundColor: CHART.claw(0.7), borderRadius: 3 },
                        { label: 'Level-ups', data: xpSlice.map(d => d.levelUps || 0), backgroundColor: CHART.plum(0.8), borderRadius: 3, yAxisID: 'y2' }
                    ]
                },
                options: { ...JSON.parse(JSON.stringify(_chartDefaults)), scales: { x: { ticks: { color: '#b8a898', maxTicksLimit: 8 } }, y: { ticks: { color: '#b8a898' }, position: 'left' }, y2: { ticks: { color: '#b8a898' }, position: 'right', grid: { drawOnChartArea: false } } } }
            });
        } else {
            ctxL.canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="chart-no-data" style="text-align:center;opacity:.4;font-size:.82rem;margin-top:.5rem">No leveling data yet</p>');
        }
    }
    describeChart('chart-leveling', {
        title:   `XP and level-ups, last ${days} days`,
        summary: xpSlice.length
            ? `XP and level-ups over the last ${days} days: ${sumBy(xpSlice, 'xp')} XP awarded, ` +
              `${sumBy(xpSlice, 'levelUps')} level-ups.`
            : 'XP and level-ups — no data yet',
        columns: ['Date', 'XP awarded', 'Level-ups'],
        rows:    xpSlice.map(d => [d.date, d.xp || 0, d.levelUps || 0]),
    });

    // AI requests chart
    if (_chartAiRequests) _chartAiRequests.destroy();
    const ctxAI = document.getElementById('chart-ai-requests')?.getContext('2d');
    const aiSlice = (a.aiRequestsDaily || []).slice(-days);
    if (charts && ctxAI) {
        clearChartPlaceholder(ctxAI.canvas.parentElement);
        if (aiSlice.length) {
            _chartAiRequests = new Chart(ctxAI, {
                type: 'line',
                data: {
                    labels: aiSlice.map(d => d.date.slice(5)),
                    datasets: [{ label: 'AI requests', data: aiSlice.map(d => d.count || 0), borderColor: CHART.claw(0.9), backgroundColor: CHART.claw(0.15), fill: true, tension: 0.3, pointRadius: 2 }]
                },
                options: _chartDefaults
            });
        } else {
            ctxAI.canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="chart-no-data" style="text-align:center;opacity:.4;font-size:.82rem;margin-top:.5rem">No AI usage data yet</p>');
        }
    }
    describeChart('chart-ai-requests', {
        title:   `AI requests, last ${days} days`,
        summary: aiSlice.length
            ? `AI requests over the last ${days} days: ${sumBy(aiSlice, 'count')} in total.`
            : 'AI requests — no data yet',
        columns: ['Date', 'Requests'],
        rows:    aiSlice.map(d => [d.date, d.count || 0]),
    });
}

/**
 * Fetch the guild's analytics payload and hand it to `renderAnalyticsCharts`,
 * toggling the skeleton, error, and content states around the request.
 */
async function loadAnalytics() {
    const guildId = BOOT.guildId;
    document.getElementById('analytics-skeleton').style.display = '';
    document.getElementById('analytics-error').style.display = 'none';
    document.getElementById('analytics-content').style.display = 'none';

    try {
        const [statsResp, insightsResp] = await Promise.all([
            apiFetch(`/api/v1/guild/${guildId}/stats`),
            apiFetch(`/api/v1/guild/${guildId}/insights`)
        ]);
        if (!statsResp.ok || !insightsResp.ok) throw new Error('Non-OK response');
        const data = await statsResp.json();
        const insights = await insightsResp.json();
        _analyticsData = data;
        _analyticsInsights = insights;

        document.getElementById('analytics-skeleton').style.display = 'none';
        document.getElementById('analytics-content').style.display = '';

        const a = data.analytics || {};

        // KPI tiles
        const kpiRow = document.getElementById('analytics-kpi-row');
        kpiRow.innerHTML = '';
        const kpis = [
            { label: 'Total members', value: data.totalUsers ?? '—' },
            { label: '30d joins', value: a.growthFunnel?.joins30 ?? '—' },
            { label: 'Retention 7d', value: `${a.growthFunnel?.retained7 ?? '—'}%` },
            { label: 'Mod 1st response', value: insights.modSla?.medianFirstResponseHours != null ? `${insights.modSla.medianFirstResponseHours}h` : '—' },
            { label: 'Mod resolution', value: insights.modSla?.medianResolutionHours != null ? `${insights.modSla.medianResolutionHours}h` : '—' }
        ];
        for (const kpi of kpis) {
            kpiRow.insertAdjacentHTML('beforeend', `<div class="eco-kpi-tile"><div class="eco-kpi-label">${kpi.label}</div><div class="eco-kpi-value">${kpi.value}</div></div>`);
        }

        // Render charts. Not awaited: Chart.js is fetched on demand now (#685)
        // and the KPI tiles, insights and command tables below are worth having
        // whether or not it arrives.
        renderAnalyticsCharts(data, insights).catch(chartsUnavailable);

        // Insights text
        const insightsCont = document.getElementById('analytics-insights-content');
        insightsCont.innerHTML = '';
        const modSla = insights.modSla || {};
        const slaText = [
            modSla.medianFirstResponseHours != null ? `${modSla.medianFirstResponseHours}h to first response` : null,
            modSla.medianResolutionHours != null ? `${modSla.medianResolutionHours}h to close` : null,
        ].filter(Boolean).join(' · ') || 'Not enough data';
        const rows = [
            ['Newcomer conversion', `${insights.newcomerConversion?.days7?.pct || 0}% @ 7d · ${insights.newcomerConversion?.days30?.pct || 0}% @ 30d`],
            ['Mod SLA (median)', slaText],
            ['Top active hours (UTC)', (insights.activeHours?.topHours || []).map(t => `${String(t.hourUtc).padStart(2,'0')}:00 (${t.count})`).join(' · ') || 'Not enough data'],
            ['Toxic channel hotspots', (insights.toxicChannels || []).slice(0,5).map(c=>`<#${c.channelId}> score ${c.score}`).join(' · ') || 'None detected'],
            ['Churn alerts', (a.churnAlerts || ['No active alerts']).join(' · ')],
            ['Likely causes', (a.likelyCauses || ['None detected']).join(' · ')],
        ];
        for (const [label, val] of rows) {
            insightsCont.insertAdjacentHTML('beforeend', `<div class="list-item"><strong>${label}</strong><span>${escHtml(val)}</span></div>`);
        }

        // Command usage
        const commandRows = Object.entries(a.commandUsage || {}).sort((x,y)=>y[1].total-x[1].total).slice(0,8);
        if (commandRows.length) {
            insightsCont.insertAdjacentHTML('beforeend', `<div class="panel-head" style="margin-top:1rem"><h3>Command usage / failures</h3></div>`);
            for (const [cmd, m] of commandRows) {
                insightsCont.insertAdjacentHTML('beforeend', `<div class="list-item"><strong>/${escHtml(cmd)}</strong><span>${escHtml(m.total)} runs · ${escHtml(m.failed)} failed (${m.total ? Math.round(m.failed/m.total*100) : 0}%)</span></div>`);
            }
        }

        // Recommendations as actionable cards. Same API strings as the
        // overview's Ask Clawdia box, same escape on the way in (#918).
        const recCont = document.getElementById('analytics-recommendations');
        recCont.innerHTML = '';
        const navMap = {
            'welcome': 'welcome', 'moderation': 'moderation', 'auto-moderation': 'moderation',
            'rss': 'rss', 'economy': 'economy', 'leveling': 'leveling', 'command': 'commandpolicies'
        };
        const defaultRecs = [
            { text: 'Set up a welcome message to greet new members automatically', tab: 'welcome' },
            { text: 'Configure a moderation log channel to track mod actions', tab: 'moderation' },
            { text: 'Enable economy to boost member engagement with coins and a shop', tab: 'economy' },
            { text: 'Set up leveling to reward active members with roles and XP', tab: 'leveling' },
            { text: 'Configure command policies to restrict commands by role or channel', tab: 'commandpolicies' }
        ];
        const activeRecs = a.recommendations || [];
        if (!activeRecs.length) {
            for (const r of defaultRecs) {
                recCont.insertAdjacentHTML('beforeend', `<div class="analytics-rec-card"><span>💡 ${escHtml(r.text)}</span><a href="#" class="analytics-rec-link" data-action="goto-tab" data-tab="${escHtml(r.tab)}">Configure →</a></div>`);
            }
        } else {
            for (const rec of activeRecs) {
                const navTarget = Object.keys(navMap).find(k => rec.toLowerCase().includes(k));
                const linkHtml = navTarget ? `<a href="#" class="analytics-rec-link" data-action="goto-tab" data-tab="${escHtml(navMap[navTarget])}">Configure →</a>` : '';
                recCont.insertAdjacentHTML('beforeend', `<div class="analytics-rec-card"><span>💡 ${escHtml(rec)}</span>${linkHtml}</div>`);
            }
        }
    } catch {
        document.getElementById('analytics-skeleton').style.display = 'none';
        document.getElementById('analytics-error').style.display = '';
    }
}

registerPanelActions({
    click: {
        'load-analytics':      () => loadAnalytics(),
        'analytics-range': (el, d) => setAnalyticsRange(Number(d.days), el),
    },
});

// Fetched the first time the reader opens the tab rather than when its markup
// lands: six charts' worth of aggregation is not worth asking for until then.
onShown('analytics', () => loadAnalytics());
