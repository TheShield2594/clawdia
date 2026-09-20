'use strict';

/**
 * Social-media notification providers.
 *
 * The RSS feature already owns the hard part of turning a URL into Discord
 * posts: an SSRF-safe fetcher, a per-subscription cursor, a dead-feed circuit
 * breaker and a sharded sweep. What it does not own is the shape of what a
 * server admin actually wants to follow — a YouTube channel, a subreddit, an X
 * account — none of which an admin knows the feed URL for, and two of which
 * (X, Instagram, TikTok) publish no feed at all.
 *
 * This module is the translation layer. Each provider knows how to turn what an
 * admin pastes (a channel URL, an @handle, a bare name) into a single pollable
 * feed URL, and how a post from it should look in Discord. The resolved feed
 * URL is stored once at add-time, so socialService's poll path is the same feed
 * fetch the RSS sweep already does — nothing platform-specific runs every five
 * minutes.
 *
 * Two tiers of platform:
 *
 *   Native feeds — YouTube and Reddit both publish a public feed that no bot
 *   needs a key or a login to read (YouTube's is the Atom feed behind every
 *   channel; Reddit's is `.rss` on any listing). These resolve to a URL on the
 *   platform's own host and work out of the box.
 *
 *   Bridged feeds — X/Twitter, Instagram and TikTok publish nothing an
 *   unauthenticated reader can poll, and their private APIs cost money and
 *   change without notice. The honest, maintainable way to follow them is an
 *   RSSHub-compatible bridge the operator runs (or points at): set
 *   SOCIAL_BRIDGE_BASE_URL and these resolve to `<bridge>/<route>`. With no
 *   bridge configured they refuse at add-time with a message that says why,
 *   rather than being offered and silently never posting.
 *
 * Every resolved URL is still fetched through `safeFetchFeed` by the poller, so
 * a bridge on a private host, or a platform host that resolves to one, is
 * blocked there regardless of what is stored here.
 */

const { safeFetchFeed } = require('../utils/safeFeedFetch');
const { assertPublicHttpUrl } = require('../utils/outboundGuard');

/** The env var an operator points at an RSSHub-compatible bridge instance. */
const BRIDGE_ENV_VAR = 'SOCIAL_BRIDGE_BASE_URL';

// Read lazily rather than captured at module load, so a process that sets it
// after require (and every test that sets it per-case) sees the live value.
function getBridgeBaseUrl() {
    // Read as a literal `process.env.SOCIAL_BRIDGE_BASE_URL` rather than through
    // BRIDGE_ENV_VAR, so tests/envExampleDrift.test.js can see the bot consumes
    // it — a computed `process.env[name]` read is invisible to that grep.
    const raw = process.env.SOCIAL_BRIDGE_BASE_URL;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// A validated `<bridge>/<route>` URL, or a clear refusal. The route is built
// from an already-sanitised username, so the only untrusted half is the
// operator's own bridge base — validated here for protocol/shape and by
// `safeFetchFeed` for where its host actually points.
function bridgeFeedUrl(route, platformLabel) {
    const base = getBridgeBaseUrl();
    if (!base) {
        throw new Error(
            `${platformLabel} needs a social bridge. Set ${BRIDGE_ENV_VAR} to an ` +
            'RSSHub-compatible instance (self-hosted or public) to follow ' +
            `${platformLabel} accounts. YouTube and Reddit work without one.`
        );
    }
    let parsed;
    try {
        parsed = assertPublicHttpUrl(base, BRIDGE_ENV_VAR);
    } catch (err) {
        throw new Error(`${BRIDGE_ENV_VAR} is not usable: ${err.message}`, { cause: err });
    }
    // Trailing slash on the base doubles up with the leading slash on the route;
    // an empty pathname ('/') is the common case and must not become '//route'.
    const origin = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    return origin + route;
}

// ── Input parsing helpers ───────────────────────────────────────────────────

// Pulls the last non-empty path segment out of a URL an admin pasted, so
// `https://www.tiktok.com/@someone?lang=en` and `@someone` both reduce to the
// same handle. Query and fragment are dropped. Returns '' when there is nothing
// usable, which every caller turns into a per-platform "what to paste" error.
function lastPathSegment(input) {
    try {
        const url = new URL(input);
        const segs = url.pathname.split('/').filter(Boolean);
        return segs.length ? segs[segs.length - 1] : '';
    } catch {
        return '';
    }
}

// A leading '@' is how every one of these platforms writes a handle, and how an
// admin will paste one; it is never part of the stored name.
function stripAt(value) {
    return value.replace(/^@+/, '');
}

function looksLikeUrl(input) {
    return /^https?:\/\//i.test(input.trim());
}

// ── YouTube ─────────────────────────────────────────────────────────────────

const YT_CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;
const YT_PLAYLIST_ID = /^(?:PL|UU|FL|LL|OL)[0-9A-Za-z_-]{10,}$/;
// Legacy usernames (the /user/ era) and /c/ vanity names are looser than a
// modern @handle but never contain a slash or a space.
const YT_NAME = /^[0-9A-Za-z._-]{1,80}$/;

function youtubeChannelFeed(channelId) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

// A channel page carries its own id in several stable places; any one of them
// is enough. Tried in order of how specific the match is.
function extractChannelId(html) {
    const patterns = [
        /"channelId":"(UC[0-9A-Za-z_-]{22})"/,
        /"externalId":"(UC[0-9A-Za-z_-]{22})"/,
        /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})"/,
        /\/channel\/(UC[0-9A-Za-z_-]{22})/,
    ];
    for (const re of patterns) {
        const m = re.exec(html);
        if (m) return m[1];
    }
    return null;
}

// Resolves an @handle or /c/ vanity name to a channel id by reading the page,
// because YouTube's feed endpoint keys on the id and nothing else. The fetch is
// the SSRF-safe one, injectable so tests do not reach the network. On failure
// the admin is told to paste the channel URL or id, which never needs a fetch.
async function resolveYoutubeHandle(handle, fetchText) {
    const clean = stripAt(handle);
    if (!YT_NAME.test(clean)) {
        throw new Error('That does not look like a YouTube handle. Paste the channel URL, @handle, or channel ID (UC…).');
    }
    let html;
    try {
        html = await fetchText(`https://www.youtube.com/@${encodeURIComponent(clean)}`);
    } catch (err) {
        throw new Error(`Could not reach YouTube to resolve @${clean} (${err.message}). Try pasting the channel URL or its ID (UC…).`, { cause: err });
    }
    const channelId = extractChannelId(html);
    if (!channelId) {
        throw new Error(`Could not find a channel for @${clean}. Paste the channel URL or its ID (UC…) instead.`);
    }
    return channelId;
}

async function resolveYoutube(input, fetchText) {
    const raw = input.trim();

    // An already-built feed URL — pass it through untouched so an admin who found
    // the Atom feed themselves is not second-guessed. Parsed, not substring-matched:
    // `https://example.com/youtube.com/feeds/videos.xml` is not a YouTube feed, and
    // a bare string with no scheme is not a URL at all.
    try {
        const u = new URL(raw);
        if (/^https?:$/.test(u.protocol) && /(^|\.)youtube\.com$/i.test(u.hostname) && u.pathname === '/feeds/videos.xml') {
            return { feedUrl: raw, ref: raw };
        }
    } catch { /* not a URL — fall through to the identifier and handle branches */ }

    // Bare identifiers, no URL needed.
    if (YT_CHANNEL_ID.test(raw)) return { feedUrl: youtubeChannelFeed(raw), ref: raw };
    if (YT_PLAYLIST_ID.test(raw)) {
        return { feedUrl: `https://www.youtube.com/feeds/videos.xml?playlist_id=${raw}`, ref: raw };
    }

    if (looksLikeUrl(raw)) {
        let url;
        try { url = new URL(raw); } catch { url = null; }
        if (url && /(^|\.)youtube\.com$/i.test(url.hostname)) {
            const segs = url.pathname.split('/').filter(Boolean);
            const playlist = url.searchParams.get('list');
            const legacyUser = url.searchParams.get('user');
            if (segs[0] === 'channel' && YT_CHANNEL_ID.test(segs[1] || '')) {
                return { feedUrl: youtubeChannelFeed(segs[1]), ref: `@${segs[1]}` };
            }
            if (playlist && YT_PLAYLIST_ID.test(playlist)) {
                return { feedUrl: `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlist}`, ref: playlist };
            }
            if (segs[0] === 'user' && YT_NAME.test(segs[1] || '')) {
                return { feedUrl: `https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(segs[1])}`, ref: segs[1] };
            }
            if (legacyUser && YT_NAME.test(legacyUser)) {
                return { feedUrl: `https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(legacyUser)}`, ref: legacyUser };
            }
            // /@handle and /c/name both need a page read to find the id.
            const handle = (segs[0] || '').startsWith('@') ? segs[0]
                : segs[0] === 'c' ? segs[1]
                : segs[0];
            if (handle) {
                const channelId = await resolveYoutubeHandle(handle, fetchText);
                return { feedUrl: youtubeChannelFeed(channelId), ref: `@${stripAt(handle)}` };
            }
        }
        throw new Error('That is not a YouTube link. Paste a channel URL, @handle, or channel ID (UC…).');
    }

    // A bare @handle or handle.
    const channelId = await resolveYoutubeHandle(raw, fetchText);
    return { feedUrl: youtubeChannelFeed(channelId), ref: `@${stripAt(raw)}` };
}

// ── Reddit ──────────────────────────────────────────────────────────────────

const REDDIT_SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;
const REDDIT_USERNAME = /^[A-Za-z0-9_-]{3,20}$/;

async function resolveReddit(input) {
    const raw = input.trim();

    let path = raw;
    if (looksLikeUrl(raw)) {
        let url;
        try { url = new URL(raw); } catch { url = null; }
        if (!url || !/(^|\.)reddit\.com$/i.test(url.hostname)) {
            throw new Error('That is not a reddit link. Paste a subreddit (r/name) or a user (u/name).');
        }
        path = url.pathname;
    }

    const segs = path.split('/').filter(Boolean);
    // r/name  or  /r/name/...
    const rIdx = segs.findIndex(s => s.toLowerCase() === 'r');
    if (rIdx !== -1 && segs[rIdx + 1]) {
        const name = segs[rIdx + 1];
        if (!REDDIT_SUBREDDIT.test(name)) throw new Error(`"${name}" is not a valid subreddit name.`);
        return { feedUrl: `https://www.reddit.com/r/${name}/.rss`, ref: `r/${name}` };
    }
    // u/name or user/name
    const uIdx = segs.findIndex(s => s.toLowerCase() === 'u' || s.toLowerCase() === 'user');
    if (uIdx !== -1 && segs[uIdx + 1]) {
        const name = segs[uIdx + 1];
        if (!REDDIT_USERNAME.test(name)) throw new Error(`"${name}" is not a valid reddit username.`);
        return { feedUrl: `https://www.reddit.com/user/${name}/.rss`, ref: `u/${name}` };
    }

    // A bare word is taken as a subreddit — the far more common thing to follow.
    if (REDDIT_SUBREDDIT.test(raw)) {
        return { feedUrl: `https://www.reddit.com/r/${raw}/.rss`, ref: `r/${raw}` };
    }
    throw new Error('Enter a subreddit (r/name) or a user (u/name).');
}

// ── Bridged platforms (X / Instagram / TikTok) ──────────────────────────────

// The username an RSSHub route needs, extracted from a URL, an @handle, or a
// bare name and validated against the platform's own character rules.
function bridgeUsername(input, pattern, platformLabel) {
    let candidate = input.trim();
    if (looksLikeUrl(candidate)) candidate = lastPathSegment(candidate);
    candidate = stripAt(candidate);
    if (!candidate || !pattern.test(candidate)) {
        throw new Error(`That is not a valid ${platformLabel} username. Paste the profile URL or @handle.`);
    }
    return candidate;
}

const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const IG_USERNAME = /^[A-Za-z0-9_.]{1,30}$/;
const TIKTOK_USERNAME = /^[A-Za-z0-9_.]{1,24}$/;

function resolveTwitter(input) {
    const user = bridgeUsername(input, X_USERNAME, 'X/Twitter');
    return { feedUrl: bridgeFeedUrl(`/twitter/user/${user}`, 'X/Twitter'), ref: `@${user}` };
}

function resolveInstagram(input) {
    const user = bridgeUsername(input, IG_USERNAME, 'Instagram');
    return { feedUrl: bridgeFeedUrl(`/instagram/user/${user}`, 'Instagram'), ref: `@${user}` };
}

function resolveTiktok(input) {
    const user = bridgeUsername(input, TIKTOK_USERNAME, 'TikTok');
    // RSSHub's TikTok route keeps the @ in the path segment.
    return { feedUrl: bridgeFeedUrl(`/tiktok/user/@${user}`, 'TikTok'), ref: `@${user}` };
}

// ── Provider registry ───────────────────────────────────────────────────────

// `kind` tells socialService how to lay the post out. An `article` (a video or a
// link post) has a real headline, so its title leads and the text sits beneath;
// a `post` (a microblog or photo post) has no headline — the text *is* the post —
// so its body leads and its media is shown large. See buildSocialEmbed.
const PROVIDERS = {
    youtube: {
        id: 'youtube',
        label: 'YouTube',
        emoji: '▶️',
        color: 0xFF0000,
        verb: 'posted a new video',
        kind: 'article',
        requiresBridge: false,
        placeholder: 'youtube.com/@handle, channel URL, or channel ID (UC…)',
        resolve: (input, ctx) => resolveYoutube(input, ctx.fetchText),
    },
    reddit: {
        id: 'reddit',
        label: 'Reddit',
        emoji: '👽',
        color: 0xFF4500,
        verb: 'has a new post',
        kind: 'article',
        requiresBridge: false,
        placeholder: 'r/subreddit or u/username',
        resolve: input => resolveReddit(input),
    },
    twitter: {
        id: 'twitter',
        label: 'X (Twitter)',
        emoji: '𝕏',
        color: 0x1DA1F2,
        verb: 'posted',
        kind: 'post',
        requiresBridge: true,
        placeholder: '@handle or profile URL (needs a social bridge)',
        resolve: input => resolveTwitter(input),
    },
    instagram: {
        id: 'instagram',
        label: 'Instagram',
        emoji: '📸',
        color: 0xE1306C,
        verb: 'shared a new post',
        kind: 'post',
        requiresBridge: true,
        placeholder: '@handle or profile URL (needs a social bridge)',
        resolve: input => resolveInstagram(input),
    },
    tiktok: {
        id: 'tiktok',
        label: 'TikTok',
        emoji: '🎵',
        color: 0x69C9D0,
        verb: 'posted a new video',
        kind: 'post',
        requiresBridge: true,
        placeholder: '@handle or profile URL (needs a social bridge)',
        resolve: input => resolveTiktok(input),
    },
};

const PLATFORMS = Object.keys(PROVIDERS);

function getProvider(platform) {
    return PROVIDERS[platform] || null;
}

/**
 * Turn what an admin typed into a stored subscription.
 *
 * @param {string} platform  one of PLATFORMS
 * @param {string} input     the channel URL, @handle, or name the admin pasted
 * @param {object} [opts]
 * @param {(url:string)=>Promise<string>} [opts.fetchText] SSRF-safe text fetch,
 *   overridable in tests; defaults to safeFetchFeed.
 * @returns {Promise<{ platform:string, ref:string, feedUrl:string }>}
 * @throws {Error} with an admin-readable message on bad input or a missing bridge
 */
async function resolveSocialTarget(platform, input, opts = {}) {
    const provider = getProvider(platform);
    if (!provider) throw new Error(`Unknown platform "${platform}".`);
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('Enter an account, channel, or URL to follow.');
    }
    const fetchText = opts.fetchText || safeFetchFeed;
    const { feedUrl, ref } = await provider.resolve(input, { fetchText });
    return { platform, ref, feedUrl };
}

/** Public, serialisable provider metadata for the dashboard's platform picker. */
function listProviders() {
    return PLATFORMS.map(id => {
        const p = PROVIDERS[id];
        return {
            id: p.id,
            label: p.label,
            emoji: p.emoji,
            requiresBridge: p.requiresBridge,
            placeholder: p.placeholder,
        };
    });
}

function isBridgeConfigured() {
    return getBridgeBaseUrl() !== null;
}

// The origin (protocol//host:port) of the configured bridge, or null. Passed to
// safeFetchFeed as its one permitted private origin, so the bundled bridge on a
// Docker-network address can be fetched while every other feed URL keeps full
// SSRF protection.
function getBridgeOrigin() {
    const base = getBridgeBaseUrl();
    if (!base) return null;
    try {
        return new URL(base).origin;
    } catch {
        return null;
    }
}

module.exports = {
    PLATFORMS,
    BRIDGE_ENV_VAR,
    getProvider,
    resolveSocialTarget,
    listProviders,
    isBridgeConfigured,
    getBridgeOrigin,
    __test__: {
        resolveYoutube, resolveReddit, resolveTwitter, resolveInstagram, resolveTiktok,
        extractChannelId, bridgeFeedUrl, getBridgeBaseUrl, bridgeUsername,
        X_USERNAME, IG_USERNAME, TIKTOK_USERNAME,
    },
};
