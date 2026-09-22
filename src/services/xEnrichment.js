'use strict';

/**
 * Rich X/Twitter post data for the social sweep.
 *
 * RSSHub's X route is good at one thing — telling us *which* tweets are new —
 * and poor at describing them: the body is an HTML blob whose photo, video and
 * quote markup varies by tweet type, video tweets carry nothing an embed can
 * show (only a <video poster>), link-card tweets carry no card at all, and a
 * photo's `name=orig` URL can be too large for Discord's image proxy, which on
 * mobile renders as an embed with no body and no picture.
 *
 * FxTwitter (the service behind fxtwitter.com / fixupx.com unfurls) exposes a
 * free, keyless JSON API that returns a tweet already normalised: full text with
 * links expanded, every photo, video thumbnails and durations, the quoted tweet,
 * the link card, the reply target and the author's avatar. So the bridge stays
 * the source of *what* is new, and each new tweet is looked up here by id to
 * learn *what it is*. Any failure — the API down, a deleted tweet, a disabled
 * lookup — returns null, and the caller falls back to rendering the RSSHub item
 * as before. Nothing here can stop a post from being delivered.
 *
 * The lookup goes through `safeFetchFeed`, so the same SSRF guard, DNS pinning,
 * size cap and deadlines apply as to every other outbound fetch in the sweep.
 */

const { safeFetchFeed } = require('../utils/safeFeedFetch');

const DEFAULT_API_BASE = 'https://api.fxtwitter.com';

// Read lazily (like SOCIAL_BRIDGE_BASE_URL) so tests and late env changes see
// the live value. Unset means the public FxTwitter API; `off` disables lookups
// and leaves X posts rendered from the bridge's feed alone.
function getApiBase() {
    const raw = process.env.SOCIAL_X_API_BASE_URL;
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return DEFAULT_API_BASE;
    if (/^(off|none|false|0|disabled?)$/i.test(value)) return null;
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol)) return null;
        return url.origin + url.pathname.replace(/\/+$/, '');
    } catch {
        return null;
    }
}

const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|fixupx|vxtwitter|fixvx)\.com$/i;

/**
 * The account and status id in an X permalink, or null for anything else.
 * RSSHub links are `https://x.com/<user>/status/<id>`; older instances use
 * twitter.com, and `/i/web/status/<id>` is X's own handle-less form.
 */
function parseStatusLink(link) {
    if (typeof link !== 'string') return null;
    let url;
    try { url = new URL(link); } catch { return null; }
    if (!X_HOSTS.test(url.hostname)) return null;
    const m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/.exec(url.pathname)
        || /^\/i\/web\/status\/(\d{1,25})(?:\/|$)/.exec(url.pathname);
    if (!m) return null;
    return m.length === 3 ? { user: m[1], id: m[2] } : { user: 'i', id: m[1] };
}

function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function str(value) {
    return typeof value === 'string' ? value : '';
}

// X serves avatars at 48px (`_normal`) by default; the embed icon is small but
// Discord scales it for high-DPI screens, so ask for the 400px original.
function largeAvatar(url) {
    if (!isHttpUrl(url)) return null;
    return url.replace(/_normal(\.\w+)$/, '_400x400$1');
}

// A duration in seconds as m:ss or h:mm:ss, or '' when there is none.
function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function normaliseAuthor(author) {
    if (!author || typeof author !== 'object') return null;
    const handle = str(author.screen_name);
    if (!handle) return null;
    return {
        name: str(author.name) || handle,
        handle,
        avatar: largeAvatar(author.avatar_url),
        url: `https://x.com/${handle}`,
    };
}

// Photos, video/GIF thumbnails and an external (e.g. YouTube) player, in the
// order the tweet shows them. `media.all` keeps the author's order across
// photos and videos; the per-type arrays are the fallback for older payloads.
function normaliseMedia(media) {
    const items = [];
    if (!media || typeof media !== 'object') return items;
    const all = Array.isArray(media.all) && media.all.length
        ? media.all
        : [...(Array.isArray(media.photos) ? media.photos : []), ...(Array.isArray(media.videos) ? media.videos : [])];
    for (const m of all) {
        if (!m || typeof m !== 'object') continue;
        if (m.type === 'photo' && isHttpUrl(m.url)) {
            items.push({ type: 'photo', image: m.url, alt: str(m.altText) });
        } else if ((m.type === 'video' || m.type === 'gif') && isHttpUrl(m.thumbnail_url)) {
            items.push({ type: m.type, image: m.thumbnail_url, duration: m.duration, url: isHttpUrl(m.url) ? m.url : null });
        }
    }
    if (!items.length && media.external && isHttpUrl(media.external.thumbnail_url)) {
        items.push({ type: 'video', image: media.external.thumbnail_url, url: isHttpUrl(media.external.url) ? media.external.url : null });
    }
    return items;
}

function normaliseCard(card) {
    if (!card || typeof card !== 'object' || !isHttpUrl(card.url)) return null;
    const title = str(card.title).trim();
    const image = isHttpUrl(card.image?.url) ? card.image.url : null;
    if (!title && !image) return null;
    return {
        url: card.url,
        title,
        description: str(card.description).trim(),
        domain: str(card.domain).trim(),
        image,
    };
}

// v1 of the API names reply targets as a bare handle string, v2 as an object.
function normaliseReplyingTo(value) {
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && typeof value.screen_name === 'string') return value.screen_name;
    return null;
}

/**
 * The fields the Discord embed needs, from either API version's status object
 * (`tweet` in v1, `status` in v2). Null when the payload is not a usable tweet.
 */
function normaliseTweet(raw, depth = 0) {
    if (!raw || typeof raw !== 'object' || raw.type === 'tombstone') return null;
    const author = normaliseAuthor(raw.author);
    if (!author) return null;
    const id = str(raw.id);
    const url = isHttpUrl(raw.url) ? raw.url : (id ? `https://x.com/${author.handle}/status/${id}` : author.url);
    const quote = depth === 0 ? normaliseTweet(raw.quote, depth + 1) : null;
    const repostedBy = raw.reposted_by && typeof raw.reposted_by === 'object' && raw.reposted_by.screen_name
        ? { name: str(raw.reposted_by.name) || raw.reposted_by.screen_name, handle: raw.reposted_by.screen_name }
        : null;
    return {
        id,
        url,
        text: str(raw.text).trim(),
        author,
        media: normaliseMedia(raw.media),
        card: normaliseCard(raw.card),
        quote,
        replyingTo: normaliseReplyingTo(raw.replying_to),
        repostedBy,
        sensitive: raw.possibly_sensitive === true,
        createdAt: typeof raw.created_timestamp === 'number' ? new Date(raw.created_timestamp * 1000) : null,
    };
}

// Tweets are immutable enough that one lookup per id serves every guild that
// follows the account and every sweep that sees it again before the cursor
// moves. Bounded both by age and size so it cannot grow for the process's life.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map(); // id -> { at, promise }

function pruneCache(now) {
    for (const [key, entry] of cache) {
        if (now - entry.at > CACHE_TTL_MS || cache.size > CACHE_MAX) cache.delete(key);
        else break; // Map iterates oldest-first, so the rest are newer.
    }
}

async function lookup(base, status, fetchText) {
    const url = `${base}/${encodeURIComponent(status.user)}/status/${encodeURIComponent(status.id)}`;
    const body = await fetchText(url);
    const json = JSON.parse(body);
    const code = json && typeof json.code === 'number' ? json.code : 200;
    // A deleted or protected tweet will not come back, so that answer is kept;
    // anything else non-OK (FxTwitter's own 5xx, a rate limit) is thrown so it
    // is not cached and the next sweep may try again.
    if (code === 401 || code === 404) return null;
    if (code !== 200) throw new Error(`FxTwitter answered ${code}`);
    return normaliseTweet(json?.tweet || json?.status);
}

/**
 * Rich data for the tweet an RSSHub item links to, or null when the link is not
 * a tweet, lookups are disabled, or the lookup fails for any reason.
 *
 * @param {string} link  the feed item's permalink
 * @param {object} [opts]
 * @param {(url:string)=>Promise<string>} [opts.fetchText] overridable in tests
 */
async function fetchTweetDetails(link, opts = {}) {
    const status = parseStatusLink(link);
    if (!status) return null;
    const base = getApiBase();
    if (!base) return null;

    const now = Date.now();
    pruneCache(now);
    const cached = cache.get(status.id);
    if (cached && now - cached.at <= CACHE_TTL_MS) return cached.promise;

    const fetchText = opts.fetchText || (url => safeFetchFeed(url));
    const promise = lookup(base, status, fetchText).catch(err => {
        console.warn(`[Social] X lookup failed for status ${status.id}; using the bridge's copy (${err.message})`);
        // Forget a failure so the next sweep may retry, rather than caching it.
        cache.delete(status.id);
        return null;
    });
    cache.set(status.id, { at: now, promise });
    return promise;
}

module.exports = {
    fetchTweetDetails,
    parseStatusLink,
    formatDuration,
    __test__: { normaliseTweet, getApiBase, largeAvatar, cache, CACHE_MAX },
};
