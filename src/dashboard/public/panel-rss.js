
// The RSS panel and its Daily News tab (#935).
//
// Two lists of feeds that answer to the same rules: a feed URL is
// admin-supplied and lands in a list every other admin sees, and both lists are
// redrawn from what the API returns after every mutation rather than patched in
// place (#689) — a feed is addressed by its position, so removing a row without
// redrawing would leave every row after it carrying an index one too high and
// the next Remove would unsubscribe the wrong feed.

const DAILY_NEWS_INITIAL_PROFILES = boot('dailyNewsProfiles');
const DAILY_NEWS_CHANNELS = boot('channels');
onPanel('rss', renderDailyNewsProfiles);
function dailyNewsChannelOptions(selected = '') {
    return ['<option value="">Select a channel</option>']
        .concat(DAILY_NEWS_CHANNELS.map(c => `<option value="${c.id}" ${selected === c.id ? 'selected' : ''}>#${c.name}</option>`))
        .join('');
}

function renderDailyNewsProfiles() {
    const container = document.getElementById('dailynews-profiles-list');
    if (!container) return;
    if (!container.dataset.initialized) {
        const seed = (DAILY_NEWS_INITIAL_PROFILES.length ? DAILY_NEWS_INITIAL_PROFILES : []).map((p, idx) => ({
            profileId: p.profileId || `profile-${Date.now()}-${idx + 1}`,
            name: p.name || '',
            enabled: p.enabled !== false,
            channelId: p.channelId || '',
            time: p.time || '09:00',
            timezone: p.timezone || '',
            title: p.title || '📰 Daily News Digest',
            feeds: Array.isArray(p.feeds) ? p.feeds : [],
            maxItemsPerFeed: p.maxItemsPerFeed || 3
        }));
        container.dataset.profiles = JSON.stringify(seed);
        container.dataset.initialized = '1';
    }

    const profiles = JSON.parse(container.dataset.profiles || '[]');
    container.innerHTML = profiles.length ? '' : '<div class="empty-state" style="padding:1rem;"><p>No additional profiles yet.</p></div>';
    profiles.forEach((profile, idx) => {
        const displayName = profile.name ? profile.name : `Profile ${idx + 1}`;
        const card = document.createElement('div');
        card.className = 'list-item';
        card.style.display = 'block';
        card.style.marginBottom = '.75rem';
        card.innerHTML = `
            <div style="display:grid;gap:.5rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <strong>${escHtml(displayName)}</strong>
                    <button class="btn btn-danger btn-sm" type="button" data-action="dn-remove" data-idx="${idx}">Remove</button>
                </div>
                <label for="dn-${idx}-name">Profile name</label>
                <input id="dn-${idx}-name" type="text" value="${escHtml(profile.name || '')}" placeholder="e.g. Tech News" data-dn-idx="${idx}" data-dn-field="name" data-dn-label="Profile ${idx + 1}">
                <label for="dn-${idx}-channel">Channel</label>
                <select id="dn-${idx}-channel" data-dn-idx="${idx}" data-dn-field="channelId">${dailyNewsChannelOptions(profile.channelId)}</select>
                <label for="dn-${idx}-time">Time (24h)</label>
                <input id="dn-${idx}-time" type="text" value="${escHtml(profile.time || '09:00')}" data-dn-idx="${idx}" data-dn-field="time">
                <label for="dn-${idx}-timezone">Timezone <small style="font-weight:normal;opacity:.7;">(IANA, e.g. UTC, America/New_York, Europe/London)</small></label>
                <input id="dn-${idx}-timezone" type="text" list="tz-datalist" value="${escHtml(profile.timezone || '')}" placeholder="UTC" autocomplete="off" data-validate-timezone data-dn-idx="${idx}" data-dn-field="timezone">
                <label for="dn-${idx}-title">Digest title</label>
                <input id="dn-${idx}-title" type="text" value="${escHtml(profile.title || '📰 Daily News Digest')}" data-dn-idx="${idx}" data-dn-field="title">
                <label for="dn-${idx}-feeds">Feeds (one URL per line)</label>
                <textarea id="dn-${idx}-feeds" rows="3" data-dn-idx="${idx}" data-dn-field="feeds">${escHtml((profile.feeds || []).join('\n'))}</textarea>
                <div id="feed-status-${idx}" style="font-size:.8rem;"></div>
                <button class="btn btn-sm" type="button" data-action="dn-validate" data-idx="${idx}">Validate feeds</button>
            </div>
        `;
        container.appendChild(card);
    });
}

function addDailyNewsProfile() {
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    profiles.push({ profileId: `profile-${Date.now()}`, name: '', enabled: true, channelId: '', time: '09:00', timezone: '', title: '📰 Daily News Digest', feeds: [], maxItemsPerFeed: parseInt(document.getElementById('dailynews-max-items').value, 10) || 3 });
    container.dataset.profiles = JSON.stringify(profiles);
    renderDailyNewsProfiles();
}

function removeDailyNewsProfile(index) {
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    profiles.splice(index, 1);
    container.dataset.profiles = JSON.stringify(profiles);
    renderDailyNewsProfiles();
}

function updateDailyNewsProfile(index, key, value) {
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    if (!profiles[index]) return;
    profiles[index][key] = key === 'feeds' ? value.split('\n').map(f => f.trim()).filter(Boolean) : value;
    container.dataset.profiles = JSON.stringify(profiles);
}

async function validateFeedUrl(url, guildId) {
    const resp = await apiFetch(`/api/v1/guild/${guildId}/validate-feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    return resp.json();
}

async function validateMainFeeds() {
    const guildId = BOOT.guildId;
    const statusEl = document.getElementById('main-feed-status');
    const urls = document.getElementById('dailynews-feeds').value.split('\n').map(f => f.trim()).filter(Boolean);
    if (!urls.length) { statusEl.textContent = 'No feed URLs to validate.'; return; }
    statusEl.textContent = `Checking ${urls.length} feed(s)…`;
    const results = await Promise.all(urls.map(url => validateFeedUrl(url, guildId).then(r => ({ url, ...r })).catch(() => ({ url, valid: false, error: 'Request failed' }))));
    statusEl.innerHTML = results.map(r => r.valid
        ? `<span style="color:var(--success,#3ba55d);">✓ ${escHtml(r.url)} — ${escHtml(r.title || 'untitled')} (${r.itemCount} items)</span>`
        : `<span style="color:var(--danger,#ed4245);">✗ ${escHtml(r.url)} — ${escHtml(r.error)}</span>`
    ).join('<br>');
}

async function validateProfileFeeds(index) {
    const guildId = BOOT.guildId;
    const container = document.getElementById('dailynews-profiles-list');
    const profiles = JSON.parse(container.dataset.profiles || '[]');
    const profile = profiles[index];
    if (!profile) return;
    const statusEl = document.getElementById(`feed-status-${index}`);
    const urls = profile.feeds || [];
    if (!urls.length) { statusEl.textContent = 'No feed URLs in this profile.'; return; }
    statusEl.textContent = `Checking ${urls.length} feed(s)…`;
    const results = await Promise.all(urls.map(url => validateFeedUrl(url, guildId).then(r => ({ url, ...r })).catch(() => ({ url, valid: false, error: 'Request failed' }))));
    statusEl.innerHTML = results.map(r => r.valid
        ? `<span style="color:var(--success,#3ba55d);">✓ ${escHtml(r.url)} — ${escHtml(r.title || 'untitled')} (${r.itemCount} items)</span>`
        : `<span style="color:var(--danger,#ed4245);">✗ ${escHtml(r.url)} — ${escHtml(r.error)}</span>`
    ).join('<br>');
}
async function triggerDailyNewsNow() {
    const guildId = BOOT.guildId;
    const ok = await showConfirm({ title: 'Send digest now', body: 'Send the daily digest right now to the configured channel?', okText: 'Send' });
    if (!ok) return;
    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/dailynews/trigger`, { method: 'POST' });
        if (response.ok) toast('Digest sent', 'success');
        else {
            const err = await response.json().catch(() => ({}));
            toast(err.error || 'Failed to send digest', 'error');
        }
    } catch (error) {
        console.error(error);
        toast('An error occurred sending the digest', 'error');
    }
}
// ── RSS feeds ──────────────────────────────────────────────────────────
// Adding or removing one feed used to answer with location.reload(), which
// re-downloads and re-parses the whole ~450 KB settings page to show one row
// appearing or disappearing (#689). Both mutations now return the guild's feed
// list and this redraws #rss-feeds from it.
//
// The whole list rather than the one row that changed, because a feed is
// addressed by its *position*: removing a row in place would leave every row
// after it carrying an index one too high, and the next Remove would
// unsubscribe the wrong feed. Rebuilding from the array the server just saved
// makes that impossible to get wrong.
//
// Built with createElement and textContent rather than an innerHTML string.
// A feed URL is admin-supplied and lands in a list every other admin sees, so
// it is exactly the kind of value the escaping rules at the top of
// esc-html.js exist for — and a node whose text is assigned needs no escaping
// rule to be remembered.

/** One `.list-item` row, matching the markup in partials/panels/rss.ejs. */
function rssFeedRow(feed, index) {
    const row = document.createElement('div');
    row.className = 'list-item';

    const main = document.createElement('div');
    main.className = 'rss-feed-main';

    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = feed.url;

    const target = document.createElement('small');
    target.className = 'rss-feed-target';
    target.textContent = '→ #' + (BOOT.channelNames[feed.channelId] || 'unknown');

    main.appendChild(url);
    main.appendChild(target);

    const remove = document.createElement('button');
    remove.className = 'btn btn-danger btn-sm';
    remove.dataset.action = 'rss-remove';
    remove.dataset.index = String(index);
    remove.textContent = 'Remove';

    row.appendChild(main);
    row.appendChild(remove);
    return row;
}

function renderRssFeeds(feeds) {
    const list = document.getElementById('rss-feeds');
    if (!list) return;

    list.textContent = '';

    if (!feeds.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '2rem 1.5rem';
        const heading = document.createElement('h3');
        heading.textContent = 'No feeds yet';
        const hint = document.createElement('p');
        hint.textContent = 'Add your first RSS feed below.';
        empty.appendChild(heading);
        empty.appendChild(hint);
        list.appendChild(empty);
        return;
    }

    feeds.forEach(function(feed, index) { list.appendChild(rssFeedRow(feed, index)); });
}

// Add and Publish are the two buttons on this page that create something on a
// second click rather than overwriting what the first one made. The page used
// to reload after both, which was never a guard — the reload was on a timer,
// and a click inside it posted again — but the page it left had no button on it
// to click twice. Now that it stays, the window is the whole request, so both
// hold a flag for the length of their POST. Cleared in `finally`: a failed add
// has to be retryable, and a flag left set by a network error is a button that
// never works again until the admin reloads.
let _rssAddInFlight = false;

async function addRssFeed() {
    if (_rssAddInFlight) return;
    const guildId = BOOT.guildId;
    const urlField = document.getElementById('rss-url');
    const channelField = document.getElementById('rss-channel');
    const url = urlField.value;
    const channelId = channelField.value;
    if (!url || !channelId) { toast('Please fill in all fields', 'error'); return; }
    _rssAddInFlight = true;
    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/rss/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, channelId })
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
            renderRssFeeds(data.feeds || []);
            // The reload used to clear these; without it the URL of the feed
            // that was just added sits in the box inviting a second add.
            urlField.value = '';
            channelField.value = '';
            toast('RSS feed added', 'success');
        } else toast(data.error || 'Failed to add RSS feed', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    } finally {
        _rssAddInFlight = false;
    }
}

async function deleteRssFeed(index) {
    const ok = await showConfirm({ title: 'Remove RSS feed', body: 'Remove this RSS feed? The bot will stop posting new articles from it.', okText: 'Remove feed' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/rss/${index}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
            renderRssFeeds(data.feeds || []);
            toast('RSS feed removed', 'success');
        } else toast(data.error || 'Failed to delete RSS feed', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}
// The Daily News profile editor, which was seven inline handlers across one
// rendered card (#887). Every field carries the profile index and the key it
// writes, so one pair of listeners replaces all of them.
function dailyNewsFieldEdit(e) {
    const el = e.target.closest && e.target.closest('[data-dn-idx]');
    if (!el) return;
    updateDailyNewsProfile(Number(el.dataset.dnIdx), el.dataset.dnField, el.value);
    // The card's heading echoes the name as it is typed.
    if (el.dataset.dnLabel !== undefined) {
        const heading = el.closest('.list-item') && el.closest('.list-item').querySelector('strong');
        if (heading) heading.textContent = el.value || el.dataset.dnLabel;
    }
}
document.addEventListener('input', dailyNewsFieldEdit);
document.addEventListener('change', dailyNewsFieldEdit);

registerPanelActions({
    click: {
        'add-daily-news-profile': () => addDailyNewsProfile(),
        'trigger-daily-news-now': () => triggerDailyNewsNow(),
        'validate-main-feeds':    () => validateMainFeeds(),
        'add-rss-feed':           () => addRssFeed(),
        'dn-remove':     (el, d) => removeDailyNewsProfile(Number(d.idx)),
        'dn-validate':   (el, d) => validateProfileFeeds(Number(d.idx)),
        // The rows are redrawn from the API after every mutation (#689), so a
        // row rendered a moment ago by renderRssFeeds has no listener of its own.
        'rss-remove':    (el, d) => deleteRssFeed(Number(d.index)),
    },
});
