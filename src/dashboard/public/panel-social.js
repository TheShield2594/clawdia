
// The Social Notifications panel.
//
// A sibling of the RSS feeds panel and built on the same rules: an account
// reference is admin-supplied and lands in a list every other admin sees, and
// the list is redrawn from what the API returns after every mutation rather than
// patched in place (#689) — a subscription is addressed by its position, so
// removing a row without redrawing would leave every row after it carrying an
// index one too high and the next Remove would unfollow the wrong account.
//
// Rows are built with createElement and textContent, never an innerHTML string,
// because the platform ref (an @handle, a subreddit) is untrusted input.

const SOCIAL_PLATFORM_LABELS = {
    youtube: '▶️ YouTube',
    reddit: '👽 Reddit',
    twitter: '𝕏 X',
    instagram: '📸 Instagram',
    tiktok: '🎵 TikTok',
};

/** One `.list-item` row, matching the markup in partials/panels/social.ejs. */
function socialFeedRow(feed, index) {
    const row = document.createElement('div');
    row.className = 'list-item';

    const main = document.createElement('div');
    main.className = 'rss-feed-main';

    const label = document.createElement('div');
    label.className = 'url';
    label.textContent = `${SOCIAL_PLATFORM_LABELS[feed.platform] || feed.platform} · ${feed.ref}`;

    const target = document.createElement('small');
    target.className = 'rss-feed-target';
    target.textContent = '→ #' + (BOOT.channelNames[feed.channelId] || 'unknown');

    main.appendChild(label);
    main.appendChild(target);

    const remove = document.createElement('button');
    remove.className = 'btn btn-danger btn-sm';
    remove.dataset.action = 'social-remove';
    remove.dataset.index = String(index);
    remove.textContent = 'Remove';

    row.appendChild(main);
    row.appendChild(remove);
    return row;
}

function renderSocialFeeds(feeds) {
    const list = document.getElementById('social-feeds');
    if (!list) return;

    list.textContent = '';

    if (!feeds.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '2rem 1.5rem';
        const heading = document.createElement('h3');
        heading.textContent = 'No subscriptions yet';
        const hint = document.createElement('p');
        hint.textContent = 'Follow your first account below.';
        empty.appendChild(heading);
        empty.appendChild(hint);
        list.appendChild(empty);
        return;
    }

    feeds.forEach(function (feed, index) { list.appendChild(socialFeedRow(feed, index)); });
}

// Updates the input placeholder to match the platform, so an admin sees what to
// paste for the one they picked.
const SOCIAL_PLACEHOLDERS = {
    youtube: 'youtube.com/@handle, channel URL, or channel ID (UC…)',
    reddit: 'r/subreddit or u/username',
    twitter: '@handle or profile URL (needs a social bridge)',
    instagram: '@handle or profile URL (needs a social bridge)',
    tiktok: '@handle or profile URL (needs a social bridge)',
};

function syncSocialPlaceholder() {
    const platform = document.getElementById('social-platform');
    const input = document.getElementById('social-input');
    if (platform && input) input.placeholder = SOCIAL_PLACEHOLDERS[platform.value] || '';
}
onPanel('social', syncSocialPlaceholder);

async function validateSocial() {
    const guildId = BOOT.guildId;
    const platform = document.getElementById('social-platform').value;
    const input = document.getElementById('social-input').value;
    const statusEl = document.getElementById('social-status');
    if (!input.trim()) { statusEl.textContent = 'Enter an account or URL to test.'; return; }
    statusEl.textContent = 'Checking…';
    try {
        const resp = await apiFetch(`/api/v1/guild/${guildId}/social/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, input }),
        });
        const r = await resp.json().catch(() => ({}));
        statusEl.innerHTML = r.valid
            ? `<span style="color:var(--success,#3ba55d);">✓ ${escHtml(r.ref || '')} — ${escHtml(r.title || 'untitled')} (${r.itemCount} items)</span>`
            : `<span style="color:var(--danger,#ed4245);">✗ ${escHtml(r.error || 'Could not resolve that account.')}</span>`;
    } catch (error) {
        console.error(error);
        statusEl.innerHTML = '<span style="color:var(--danger,#ed4245);">✗ Request failed</span>';
    }
}

// Add and Test both reach out to a caller-supplied URL; Add also creates a row,
// so it holds a flag for the length of its POST to stop a double-click creating
// two subscriptions. Cleared in `finally` so a failed add stays retryable.
let _socialAddInFlight = false;

async function addSocial() {
    if (_socialAddInFlight) return;
    const guildId = BOOT.guildId;
    const platform = document.getElementById('social-platform').value;
    const inputField = document.getElementById('social-input');
    const channelField = document.getElementById('social-channel');
    const input = inputField.value;
    const channelId = channelField.value;
    if (!input || !channelId) { toast('Please fill in all fields', 'error'); return; }
    _socialAddInFlight = true;
    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/social/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, input, channelId }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
            renderSocialFeeds(data.feeds || []);
            inputField.value = '';
            channelField.value = '';
            document.getElementById('social-status').textContent = '';
            toast('Now following', 'success');
        } else toast(data.error || 'Failed to follow account', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    } finally {
        _socialAddInFlight = false;
    }
}

async function deleteSocial(index) {
    const ok = await showConfirm({ title: 'Unfollow account', body: 'Stop posting new updates from this account?', okText: 'Unfollow' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/social/${index}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
            renderSocialFeeds(data.feeds || []);
            toast('Unfollowed', 'success');
        } else toast(data.error || 'Failed to unfollow', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'social-platform') syncSocialPlaceholder();
});

registerPanelActions({
    click: {
        'validate-social': () => validateSocial(),
        'add-social':      () => addSocial(),
        // Rows are redrawn from the API after every mutation (#689), so a row
        // rendered a moment ago by renderSocialFeeds has no listener of its own.
        'social-remove':   (el, d) => deleteSocial(Number(d.index)),
    },
});
