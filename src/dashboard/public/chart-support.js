// The chart machinery the dashboard's two charting panels share (#935):
// fetching Chart.js the first time one is going to be drawn, the text
// equivalent that goes under each canvas, and what to say when the library will
// not load.
//
// Analytics draws six and the Economy panel's Health tab draws one, so this
// sits beside them rather than inside either — a copy in each is how the two
// stop agreeing about what a chart on this page looks like.

/** The rest of the analytics panel is readable without its charts, so a library
 *  that would not load is reported and left there rather than failing the tab. */
function chartsUnavailable(err) {
    console.error('[dashboard]', err);
    toast('Charts could not be loaded', 'error');
}

// ── Chart.js, fetched when a chart is actually going to be drawn (#685) ────
//
// This used to be a <script> in the page head pointing at cdn.jsdelivr.net at a
// floating `chart.js@4` with no integrity attribute: 200 KB downloaded and
// parsed on every guild-settings page, and one third-party origin allowed to
// execute whatever it resolved to that day on a page whose CSP is otherwise a
// per-request nonce. It is vendored under /vendor/ now, so script-src is back
// to 'self' alone.
//
// Injected on the first chart rather than in the head because only the
// Analytics panel and the Economy panel's Health tab draw one, and most
// sessions open neither.
let _chartJsLoad = null;

function loadChartJs() {
    if (window.Chart) return Promise.resolve();
    // One promise shared by every caller: the analytics panel starts six charts
    // in a row and each of them asks.
    if (_chartJsLoad) return _chartJsLoad;
    _chartJsLoad = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = BOOT.chartJsUrl;
        script.onload = () => resolve();
        script.onerror = () => {
            // Forgotten, so reopening the tab retries rather than settling
            // against a load that never happened.
            _chartJsLoad = null;
            reject(new Error('Could not load Chart.js'));
        };
        document.head.appendChild(script);
    });
    return _chartJsLoad;
}

/**
 * Give a chart the accessible equivalent a <canvas> cannot have (#669).
 *
 * A canvas is an opaque bitmap. With no ARIA it is announced as nothing at
 * all, so six charts made the whole Insights panel — and the economy command
 * breakdown — unreadable to a screen reader, WCAG 1.1.1. Each chart gets two
 * things instead: a role="img" carrying a one-line summary of what it shows,
 * and the series itself as a real <table> alongside, visually hidden but
 * navigable with table commands.
 *
 * Built from the same arrays the chart is drawn from, and called whether or
 * not Chart.js loaded — so when the library is unavailable the numbers are
 * still there rather than the panel being simply blank.
 *
 * @param {string} canvasId id of the <canvas>; the table goes in `<id>-data`
 * @param {object} spec     { title, summary, columns, rows }
 */
function describeChart(canvasId, { title, summary, columns = [], rows = [] }) {
    const canvas = document.getElementById(canvasId);
    if (canvas) {
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', summary || `${title} — no data yet`);
    }

    const host = document.getElementById(`${canvasId}-data`);
    if (!host) return;
    host.textContent = '';

    if (!rows.length) {
        const p = document.createElement('p');
        p.textContent = summary || `${title} — no data yet`;
        host.appendChild(p);
        return;
    }

    const table = document.createElement('table');
    const caption = document.createElement('caption');
    caption.textContent = title;
    table.appendChild(caption);

    const head = document.createElement('tr');
    for (const col of columns) {
        const th = document.createElement('th');
        th.setAttribute('scope', 'col');
        th.textContent = col;
        head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        // First cell is the row's label — a date, a command, a cohort — so it
        // is a header, and the ones after it are values it names.
        row.forEach((cell, i) => {
            const el = document.createElement(i === 0 ? 'th' : 'td');
            if (i === 0) el.setAttribute('scope', 'row');
            el.textContent = String(cell);
            tr.appendChild(el);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(table);
}
