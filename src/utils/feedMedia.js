'use strict';

/**
 * Pictures and bylines out of RSS/Atom items, shared by the RSS poller and the
 * social-media poller.
 *
 * The HTML helpers here lived in socialService until the RSS poller needed
 * them too — a plain blog feed carries its article image the same ways a
 * bridge carries a post's photo — and two copies of a hand-rolled attribute
 * scanner are two places for the next fix to miss.
 */

function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// The value of a quoted attribute inside one tag string, read by plain string
// scanning. Deliberately not a regex: a tag-matching regex is unreliable HTML
// filtering (CodeQL js/bad-tag-filter), and this codebase leaves real parsing to
// rss-parser. Returns null when the attribute is absent or unquoted.
function readTagAttr(tag, name) {
    const lower = tag.toLowerCase();
    for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + name.length)) {
        // The name must start at an attribute boundary, or `data-src`/`x-src`
        // would satisfy a search for `src` and hand back the wrong URL.
        const before = at > 0 ? tag[at - 1] : '<';
        if (before !== '<' && before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r') continue;
        let i = at + name.length;
        while (i < tag.length && (tag[i] === ' ' || tag[i] === '\t' || tag[i] === '\n' || tag[i] === '\r')) i++;
        if (tag[i] !== '=') continue; // e.g. matched "srcset" — keep looking for "src"
        i++;
        while (i < tag.length && (tag[i] === ' ' || tag[i] === '\t' || tag[i] === '\n' || tag[i] === '\r')) i++;
        const quote = tag[i];
        if (quote !== '"' && quote !== "'") return null;
        const end = tag.indexOf(quote, i + 1);
        return end === -1 ? null : decodeAttrEntities(tag.slice(i + 1, end));
    }
    return null;
}

// An attribute value as the browser would read it. RSSHub escapes the `&` in a
// photo URL's query (`?format=jpg&amp;name=orig`) when the description is not
// CDATA-wrapped, and that literal `&amp;` in an embed image URL is a request
// Discord's proxy cannot resolve — an embed with a picture that never appears.
function decodeAttrEntities(value) {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

// X photos arrive at `name=orig` — the uploaded original, which can be a 4096px
// PNG of many megabytes. Discord's image proxy gives up on those and the embed
// renders with no picture at all, so ask X's CDN for its 2048px `large` variant,
// which is what x.com itself shows.
function discordSafeImageUrl(url) {
    if (!isHttpUrl(url)) return url;
    let parsed;
    try { parsed = new URL(url); } catch { return url; }
    if (!/(^|\.)twimg\.com$/i.test(parsed.hostname)) return url;
    if (parsed.searchParams.get('name') === 'orig') {
        parsed.searchParams.set('name', 'large');
        return parsed.toString();
    }
    const suffixed = /^(.*\.(?:jpe?g|png|webp|gif)):orig$/i.exec(parsed.pathname);
    if (suffixed) {
        parsed.pathname = `${suffixed[1]}:large`;
        return parsed.toString();
    }
    return url;
}

// Every inline picture in an HTML fragment, in document order: an <img>'s src,
// and a <video>'s poster — which is all RSSHub's X route gives a video or GIF
// tweet, and which the <img>-only scan this replaced missed entirely, leaving
// those tweets as an embed with no body and no picture. Located by scanning
// rather than a tag-matching regex (see readTagAttr).
function inlineImageUrls(html) {
    const urls = [];
    const lower = html.toLowerCase();
    let start = 0;
    for (;;) {
        const img = lower.indexOf('<img', start);
        const video = lower.indexOf('<video', start);
        if (img === -1 && video === -1) break;
        const isVideo = img === -1 || (video !== -1 && video < img);
        const at = isVideo ? video : img;
        const close = html.indexOf('>', at);
        const tag = close === -1 ? html.slice(at) : html.slice(at, close + 1);
        const src = readTagAttr(tag, isVideo ? 'poster' : 'src');
        if (isHttpUrl(src) && !urls.includes(src)) urls.push(src);
        if (close === -1) break;
        start = close + 1;
    }
    return urls;
}


// ── Articles (the RSS poller) ───────────────────────────────────────────────

// rss-parser drops every element it has no mapping for, and Media RSS is one:
// without these, `<media:content>` and `<media:thumbnail>` — how most news
// sites and YouTube attach an article's picture — never reach the item. Pass
// to the Parser constructor.
const MEDIA_CUSTOM_FIELDS = {
    item: [
        ['media:content', 'mediaContent', { keepArray: true }],
        ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
        ['media:group', 'mediaGroup'],
    ],
};

const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp|avif)(?:$|[?#])/i;

// Whether a media element points at a picture. An enclosure is as often a
// podcast episode or a video file as an image, and Discord renders neither in
// an embed's image slot, so a type or medium has to say "image" — or, failing
// both, the URL has to end like one.
function isImageMedia(attrs) {
    if (!attrs || typeof attrs.url !== 'string' || !attrs.url.trim()) return false;
    const type = typeof attrs.type === 'string' ? attrs.type.toLowerCase() : '';
    const medium = typeof attrs.medium === 'string' ? attrs.medium.toLowerCase() : '';
    if (type) return type.startsWith('image/');
    if (medium) return medium === 'image';
    return IMAGE_EXTENSION.test(attrs.url);
}

// An absolute http(s) URL for `raw`, resolved against `base` when it is
// relative — feeds write "/img/a.jpg" as readily as a full URL — or null.
function absoluteImageUrl(raw, base) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const url = new URL(raw.trim(), base);
        return url.protocol === 'http:' || url.protocol === 'https:' ? discordSafeImageUrl(url.toString()) : null;
    } catch {
        return null;
    }
}

const attrsOf = node => (node && typeof node === 'object' ? (node.$ || node) : null);
const asList = value => (Array.isArray(value) ? value : value ? [value] : []);

// The fields an article's HTML body can arrive in, richest first.
const ARTICLE_HTML_FIELDS = ['content:encoded', 'content', 'summary'];

/**
 * The picture that goes with an article, or null.
 *
 * In order: Media RSS (`media:content` that is an image, then
 * `media:thumbnail`, each also looked for inside a `media:group`), an image
 * enclosure, the episode art a podcast feed gives in `itunes:image`, and last
 * the first `<img>` in the article's own HTML — which is where WordPress and
 * most blog engines put it. Thumbnails are always images, so they need no
 * type check.
 *
 * @param {object} item an rss-parser item from a parser built with MEDIA_CUSTOM_FIELDS
 * @param {string} [base] what a relative media URL is resolved against
 * @returns {?string} an absolute http(s) URL
 */
function articleImage(item, base) {
    const group = item.mediaGroup || {};
    const firstUsable = candidates => {
        for (const url of candidates) {
            const absolute = absoluteImageUrl(url, base);
            if (absolute) return absolute;
        }
        return null;
    };

    const contents = asList(item.mediaContent).concat(asList(group['media:content'])).map(attrsOf);
    const thumbnails = asList(item.mediaThumbnail).concat(asList(group['media:thumbnail'])).map(attrsOf);
    const found = firstUsable(contents.filter(isImageMedia).map(c => c.url))
        || firstUsable(thumbnails.filter(Boolean).map(t => t.url))
        || (isImageMedia(item.enclosure) ? absoluteImageUrl(item.enclosure.url, base) : null)
        || absoluteImageUrl(item.itunes?.image, base);
    if (found) return found;

    for (const field of ARTICLE_HTML_FIELDS) {
        const html = item[field];
        if (typeof html !== 'string' || !html.toLowerCase().includes('<img')) continue;
        const [first] = inlineImageUrls(html);
        if (first) return discordSafeImageUrl(first);
    }
    return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who wrote an article, or ''. `<dc:creator>` or Atom's `<author><name>` hold a
 * name; RSS 2.0's `<author>` is specified as an email address, usually written
 * "jane@example.com (Jane Doe)" — the name in brackets is kept and a bare
 * address, which is not a byline anyone wants posted, is dropped.
 *
 * @param {object} item an rss-parser item
 * @returns {string}
 */
function articleByline(item) {
    for (const raw of [item.creator, item.author]) {
        if (typeof raw !== 'string') continue;
        const text = raw.trim();
        const bracketed = /^\S+@\S+\s+\((.+)\)$/.exec(text);
        if (bracketed) return bracketed[1].trim();
        if (text && !EMAIL.test(text)) return text;
    }
    return '';
}

module.exports = {
    isHttpUrl,
    discordSafeImageUrl,
    inlineImageUrls,
    readTagAttr,
    decodeAttrEntities,
    MEDIA_CUSTOM_FIELDS,
    articleImage,
    articleByline,
};
