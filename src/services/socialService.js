'use strict';

/**
 * Social-media notifications: the poll half of the feature.
 *
 * This is `rssService.checkRssFeeds` applied to a different subscription array.
 * Every social subscription stores a resolved feed URL (socialProviders turned a
 * YouTube handle or a subreddit into one at add-time), so the work here is the
 * same fetch-dedup-post-advance loop the RSS sweep runs — the differences are
 * cosmetic (the embed is styled per platform) and structural (the cursor lives
 * on `socialFeeds`, not `rssFeeds`).
 *
 * The RSS sweep's machinery is deliberately re-implemented here rather than
 * shared: `rssService` keeps its circuit-breaker Maps private behind a `__test__`
 * bag that a dozen tests reach into by reference, and threading a second caller
 * through them would couple the two features' failure state (a YouTube feed
 * failing would count against an unrelated blog). Two small self-contained
 * copies keep each feature's dead-source bookkeeping its own, at the cost of the
 * ~40 lines below.
 */

const Guild = require('../models/Guild');
const { EmbedBuilder, escapeMarkdown } = require('discord.js');

const { safeFetchFeed } = require('../utils/safeFeedFetch');
const { handlesGuild } = require('../utils/sharding');
const { getProvider, getBridgeOrigin, twitterBridgeFeedUrl, X_USERNAME } = require('./socialProviders');
const { fetchTweetDetails, fetchProfileTimeline, isXApiEnabled, formatDuration } = require('./xEnrichment');

const Parser = require('rss-parser');
const parser = new Parser();

// `allowPrivateOrigin` is the configured bridge origin: safeFetchFeed permits a
// private/reserved address only for a hop on exactly that origin, so the bundled
// RSSHub bridge (a Docker-network host) is reachable while YouTube, Reddit and
// any redirect to another origin keep full SSRF protection.
async function parseFeedUrl(url, allowPrivateOrigin) {
    return parser.parseString(await safeFetchFeed(url, { allowPrivateOrigin }));
}

// ── Dead-source circuit breaker (mirrors rssService) ────────────────────────
//
// Consecutive-failure bookkeeping per resolved feed URL: a source that keeps
// failing is parked for a cooldown rather than re-fetched every sweep, and the
// two Maps are pruned by age so an unsubscribed source's state cannot accumulate
// for the life of the process. See rssService for the full rationale.
const feedFailCounts = new Map();
const feedLastFailTime = new Map();
const DEAD_FEED_THRESHOLD = 3;
const DEAD_FEED_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DEAD_FEED_STATE_TTL_MS = 2 * DEAD_FEED_COOLDOWN_MS;

// How many URLs are fetched at once, and the most items one sweep will post for
// a single source that published a burst — same values and same reasoning as
// the RSS sweep.
const SOCIAL_FETCH_CONCURRENCY = 5;
const MAX_ITEMS_PER_SWEEP = 5;

function shouldSkipDeadFeed(feedUrl) {
    const failCount = feedFailCounts.get(feedUrl) || 0;
    if (failCount < DEAD_FEED_THRESHOLD) return false;

    const lastFail = feedLastFailTime.get(feedUrl) || 0;
    if (Date.now() - lastFail < DEAD_FEED_COOLDOWN_MS) {
        console.warn(`[Social] Skipping dead source (${failCount} consecutive failures): ${feedUrl}`);
        return true;
    }
    console.log(`[Social] Retrying previously dead source after cooldown: ${feedUrl}`);
    return false;
}

function recordFeedSuccess(feedUrl) {
    feedFailCounts.delete(feedUrl);
    feedLastFailTime.delete(feedUrl);
}

function recordFeedFailure(feedUrl, error) {
    const newCount = (feedFailCounts.get(feedUrl) || 0) + 1;
    feedFailCounts.set(feedUrl, newCount);
    feedLastFailTime.set(feedUrl, Date.now());
    if (newCount >= DEAD_FEED_THRESHOLD) {
        console.error(`[Social] Source marked dead after ${newCount} consecutive failures: ${feedUrl}`);
    } else {
        console.error(`[Social] Error parsing source (failure ${newCount}/${DEAD_FEED_THRESHOLD}) ${feedUrl}:`, error.message);
    }
}

function pruneFeedFailureState(now = Date.now()) {
    const cutoff = now - DEAD_FEED_STATE_TTL_MS;
    for (const url of feedFailCounts.keys()) {
        const lastFail = feedLastFailTime.get(url);
        if (lastFail === undefined || lastFail <= cutoff) {
            feedFailCounts.delete(url);
            feedLastFailTime.delete(url);
        }
    }
    for (const url of feedLastFailTime.keys()) {
        if (!feedFailCounts.has(url)) feedLastFailTime.delete(url);
    }
}

// ── Item ordering (mirrors rssService.datedItems) ───────────────────────────
//
// Order is taken from the item dates, not the document, and an item whose date
// does not parse is dropped: its date is both the "is this new" test and the
// embed timestamp, and setTimestamp on an unparseable date throws.
function datedItems(parsedFeed) {
    return (parsedFeed.items || [])
        .map(item => ({ item, date: new Date(item.pubDate || item.isoDate) }))
        .filter(entry => !Number.isNaN(entry.date.getTime()))
        .sort((a, b) => a.date - b.date);
}

async function fetchSendableChannel(client, channelId) {
    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch {
        channel = client.channels.cache.get(channelId) || null;
    }
    if (!channel || typeof channel.send !== 'function') return null;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return null;
    return channel;
}

// Discord caps a description at 4096, but a social post is short — a fuller slice
// than a headline needs, without turning a thread or a long caption into a wall.
const DESCRIPTION_LIMIT = 700;
const TITLE_LIMIT = 256;
const AUTHOR_LIMIT = 256;

function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// The raw content fields a bridge might carry a post's body in, richest first.
// rss-parser maps <content:encoded> and <description> to both `content` and (once
// stripped) `contentSnippet`, and Atom's <summary> to `summary`; the X/Instagram
// bridges also inline a post's photo as an <img> in these fields.
const CONTENT_FIELDS = ['content:encoded', 'content', 'summary', 'description'];

// The readable text of a post. rss-parser already strips the markup out of a
// feed's content into `contentSnippet` (the same field rssService renders from),
// so the body needs no HTML handling of our own; the plain-text content fields
// are a fallback for the rare feed that leaves contentSnippet empty. Empty string
// when a post genuinely carries no text (a bare photo tweet).
function postText(item) {
    const snippet = typeof item.contentSnippet === 'string' ? item.contentSnippet.trim() : '';
    if (snippet) return snippet;
    for (const field of CONTENT_FIELDS) {
        const raw = item[field];
        // Only accept a field that is already plain text — deriving readable text
        // from HTML is rss-parser's job (via contentSnippet), not a regex here.
        if (typeof raw === 'string' && raw.trim() && !raw.includes('<')) return raw.trim();
    }
    return '';
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

// The post's own media, to show large, in the order the post shows it. A bridge
// exposes it as an enclosure, a media:* element, or — the shape the X and
// Instagram bridges use — inline <img>/<video poster> markup in the content
// HTML, which the enclosure/media checks alone miss.
function postMediaList(item) {
    const urls = [];
    const add = url => {
        if (!isHttpUrl(url)) return;
        const safe = discordSafeImageUrl(url);
        if (!urls.includes(safe)) urls.push(safe);
    };
    add(item.enclosure?.url);
    add(item['media:thumbnail']?.$?.url || item['media:content']?.$?.url);
    for (const field of CONTENT_FIELDS) {
        const raw = item[field];
        if (typeof raw !== 'string') continue;
        const lower = raw.toLowerCase();
        if (!lower.includes('<img') && !lower.includes('<video')) continue;
        inlineImageUrls(raw).forEach(add);
        // The fields are copies of one another; the first that has markup is
        // the post, and scanning the rest would only find the same pictures.
        if (urls.length) break;
    }
    return urls;
}

function postMedia(item) {
    return postMediaList(item)[0] || null;
}

// The feed's own image — a channel avatar, subreddit icon or profile picture —
// used as the small author/thumbnail badge rather than as the post's media.
function feedAvatar(parsedFeed) {
    return isHttpUrl(parsedFeed?.image?.url) ? parsedFeed.image.url : null;
}

// The poster's display name, if the feed names it. An email-shaped <author>
// (what plain RSS puts there) is not a name, so it is skipped; RSSHub-style
// feeds carry the real name in <dc:creator>/<author>.
function posterName(item) {
    for (const raw of [item.creator, item.author]) {
        if (typeof raw !== 'string') continue;
        const name = raw.trim();
        if (!name || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) continue;
        return name;
    }
    return '';
}

// The author line for a microblog/photo embed, shaped like Discord's own X and
// Instagram link unfurls: the poster's name leads with their handle beside it
// ("IGN (@IGN)"), and the platform lives in the footer rather than the author.
// Falls back to just the handle when the feed does not name the poster, and to
// the account label when there is no handle either.
function postAuthorName(feed, item, account) {
    const handle = (feed.ref || '').trim();
    const name = posterName(item);
    if (name) {
        if (!handle) return name;
        // Collapse only when the "name" is literally the handle again ("@IGN"),
        // not when a real display name happens to match the username — native
        // still renders that as "IGN (@IGN)".
        if (name.toLowerCase() === handle.toLowerCase()) return handle;
        return `${name} (${handle})`;
    }
    return handle || account;
}

function buildSocialEmbed(provider, feed, item, date, parsedFeed) {
    const account = feed.ref || parsedFeed.title || provider.label;
    const avatar = feedAvatar(parsedFeed);
    const media = postMedia(item);
    const body = postText(item);

    // Post kind mirrors a native link unfurl (name + handle, platform in the
    // footer); article kind keeps the notification framing (platform • account
    // posted), where knowing the source and that it is new matters more.
    const authorName = provider.kind === 'post'
        ? postAuthorName(feed, item, account)
        : `${provider.emoji} ${provider.label} • ${account} ${provider.verb}`;

    const embed = new EmbedBuilder()
        .setColor(provider.color)
        .setAuthor({
            name: authorName.slice(0, AUTHOR_LIMIT),
            ...(item.link ? { url: item.link } : {}),
            ...(avatar ? { iconURL: avatar } : {}),
        })
        .setFooter({ text: provider.label })
        .setTimestamp(date);

    if (item.link) embed.setURL(item.link);

    if (provider.kind === 'post') {
        // A microblog or photo post has no headline — the text is the post — so
        // the body leads and the media carries the visual. This is what turns a
        // bare "New post" line into something that reads like the tweet it is.
        // Some bridges (RSSHub's TikTok route, which maps a clip's caption to the
        // item <title> and fills <description> with the player embed) carry the
        // caption in the title, so fall back to it when there is no body text.
        const caption = body || (typeof item.title === 'string' ? item.title.trim() : '');
        if (caption) embed.setDescription(caption.slice(0, DESCRIPTION_LIMIT));
        else if (!media) embed.setTitle(`${provider.label} post`);
        if (media) embed.setImage(media);
        else if (avatar) embed.setThumbnail(avatar);
    } else {
        // A video or link post has a real headline: keep the title prominent,
        // the text beneath it, and the artwork in the corner.
        embed.setTitle((item.title || body || 'New post').slice(0, TITLE_LIMIT));
        if (body && body !== item.title) embed.setDescription(body.slice(0, DESCRIPTION_LIMIT));
        const thumb = media || avatar;
        if (thumb) embed.setThumbnail(thumb);
    }

    return embed;
}

// Discord shows up to four images in one message as a gallery when every embed
// carries the same `url`: the first embed holds the post, and each extra embed
// is just that shared URL and one more picture.
const GALLERY_MAX = 4;

function galleryEmbeds(color, url, images) {
    if (!url) return [];
    return images.slice(1, GALLERY_MAX).map(image =>
        new EmbedBuilder().setColor(color).setURL(url).setImage(image));
}

// Tweet text reads best with its @mentions and #hashtags clickable, as they are
// on X. Only a mention or tag that starts a word is linked, so the `@` in an
// email or a medium.com/@user URL and the `#` in a URL fragment are left alone.
function linkifyTweetText(text) {
    return text
        .replace(/(^|[^\w/@])@([A-Za-z0-9_]{1,15})(?![\w@])/g,
            (_, pre, handle) => `${pre}[@${handle}](https://x.com/${handle})`)
        .replace(/(^|[^\w/&#])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu,
            (_, pre, tag) => `${pre}[#${tag}](https://x.com/hashtag/${encodeURIComponent(tag)})`);
}

// Text for an embed description or field, clipped on a character boundary with
// an ellipsis, then linkified — unless the links would push it over the limit,
// in which case the plain text is the safer thing to send.
function tweetBody(text, limit) {
    const clipped = text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
    const linked = linkifyTweetText(clipped);
    return linked.length <= limit * 1.5 ? linked : clipped;
}

// Description budget for a tweet: Discord allows 4096, and X's long posts can
// run to thousands of characters. Leave room for the repost/reply lines, the
// video/card line and link markup.
const TWEET_TEXT_LIMIT = 2500;
const QUOTE_TEXT_LIMIT = 600;

/**
 * The embeds for one tweet, built from FxTwitter's normalised data rather than
 * the bridge's HTML — see xEnrichment. Shaped like Discord's own X unfurl:
 * name and handle as the author, the text as the body, the pictures as a
 * gallery, a quoted tweet beneath, the platform in the footer.
 *
 * @param {object} opts.allowSensitive  whether the channel is age-restricted, so
 *   a tweet X marked sensitive may show its media inline.
 */
function buildTweetEmbeds(provider, feed, tweet, item, date, parsedFeed, { allowSensitive = false } = {}) {
    const lines = [];

    // RSSHub lists an account's reposts as its own items but links them to the
    // original tweet; FxTwitter then describes the original. Say who reposted it,
    // as X does above the post.
    const feedHandle = (feed.ref || '').replace(/^@/, '');
    const reposter = tweet.repostedBy
        || (feedHandle && tweet.author.handle.toLowerCase() !== feedHandle.toLowerCase()
            ? { name: posterName(item) || feedHandle, handle: feedHandle }
            : null);
    if (reposter) lines.push(`-# 🔁 ${escapeMarkdown(reposter.name)} reposted`);
    if (tweet.replyingTo) {
        lines.push(`-# ↩️ Replying to [@${tweet.replyingTo}](https://x.com/${tweet.replyingTo})`);
    }
    if (tweet.text) lines.push(tweetBody(tweet.text, TWEET_TEXT_LIMIT));

    const hideMedia = tweet.sensitive && !allowSensitive;
    const media = hideMedia ? [] : tweet.media;
    const quoteMedia = hideMedia || !tweet.quote ? [] : tweet.quote.media;
    // The tweet's own pictures lead; a quote tweet with none of its own borrows
    // the quoted tweet's, which is what X shows as the post's visual.
    const shown = media.length ? media : quoteMedia;
    const images = shown.map(m => discordSafeImageUrl(m.image));

    const video = shown.find(m => m.type === 'video' || m.type === 'gif');
    if (video) {
        const duration = formatDuration(video.duration);
        const label = video.type === 'gif' ? 'GIF' : `Watch video${duration ? ` (${duration})` : ''}`;
        lines.push(`▶️ [${label}](${tweet.url})`);
    }

    // A link-card tweet (an article, a show page) has no media of its own; the
    // card is the post's visual, as it is on X.
    const card = !images.length && !tweet.quote ? tweet.card : null;
    if (card) {
        // Brackets would end the masked link early, so they go from the title.
        const title = escapeMarkdown(card.title.slice(0, 200)).replace(/[[\]]/g, '');
        const heading = title ? `🔗 **[${title}](${card.url})**` : `🔗 ${card.url}`;
        lines.push(card.domain ? `${heading}\n-# ${escapeMarkdown(card.domain)}` : heading);
        if (!hideMedia && card.image) images.push(discordSafeImageUrl(card.image));
    }

    if (hideMedia && (tweet.media.length || quoteMedia.length || tweet.card?.image)) {
        lines.push(`⚠️ Sensitive media hidden — [view on X](${tweet.url})`);
    }

    const embed = new EmbedBuilder()
        .setColor(provider.color)
        .setAuthor({
            name: `${tweet.author.name} (@${tweet.author.handle})`.slice(0, AUTHOR_LIMIT),
            url: tweet.author.url,
            ...(tweet.author.avatar || feedAvatar(parsedFeed)
                ? { iconURL: tweet.author.avatar || feedAvatar(parsedFeed) }
                : {}),
        })
        .setURL(tweet.url)
        .setFooter({ text: provider.label })
        .setTimestamp(tweet.createdAt && !Number.isNaN(tweet.createdAt.getTime()) ? tweet.createdAt : date);

    const description = lines.join('\n\n');
    if (description) embed.setDescription(description.slice(0, 4096));
    else if (!images.length) embed.setTitle(`${provider.label} post`);

    if (tweet.quote) {
        const q = tweet.quote;
        const quoted = q.text ? tweetBody(q.text, QUOTE_TEXT_LIMIT) : '';
        embed.addFields({
            name: `💬 Quoting ${q.author.name} (@${q.author.handle})`.slice(0, 256),
            value: `${quoted ? `${quoted}\n` : ''}[View quoted post](${q.url})`.slice(0, 1024),
        });
    }

    if (images.length) embed.setImage(images[0]);

    return [embed, ...galleryEmbeds(provider.color, tweet.url, images)];
}

/**
 * Everything one post sends: the embed built from the bridge's item, or — for
 * an X post FxTwitter could describe — the richer tweet embeds, plus a gallery
 * for a post with several pictures.
 */
function buildSocialMessage(provider, feed, item, date, parsedFeed, { tweet = null, allowSensitive = false } = {}) {
    if (tweet) {
        return { embeds: buildTweetEmbeds(provider, feed, tweet, item, date, parsedFeed, { allowSensitive }) };
    }
    const embed = buildSocialEmbed(provider, feed, item, date, parsedFeed);
    const extra = provider.kind === 'post' && item.link
        ? galleryEmbeds(provider.color, item.link, postMediaList(item))
        : [];
    return { embeds: [embed, ...extra] };
}

/**
 * Delivers a freshly-parsed source to one guild's subscription: posts what is
 * new and advances its cursor only as far as delivery actually got. Per-guild
 * failures are contained so one deleted channel does not stop the fan-out.
 *
 * Returns the number of items posted, for the sweep summary.
 */
async function deliverSocialUpdate(client, guild, feed, parsedFeed, entries) {
    const provider = getProvider(feed.platform);
    if (!provider) return 0; // a platform we no longer support — leave it be.

    // First sight posts the newest item only; without it, subscribing would
    // empty the whole visible history into the channel.
    const fresh = feed.lastPublished
        ? entries.filter(entry => entry.date > feed.lastPublished)
        : entries.slice(-1);
    if (!fresh.length) return 0;

    const toPost = fresh.slice(-MAX_ITEMS_PER_SWEEP);

    let delivered = 0;
    let cursor = null;

    try {
        const channel = await fetchSendableChannel(client, feed.channelId);
        // No channel is not a delivery: advancing here would drop the burst for
        // good on a channel that was only briefly unreachable.
        if (!channel) return 0;

        const allowSensitive = channel.nsfw === true;
        for (const { item, date, tweet: known } of toPost) {
            // An X post read from FxTwitter's timeline arrives described; one from
            // the bridge is looked up by id. Every other platform, and any lookup
            // that fails, renders from the feed item alone.
            const tweet = known || (provider.id === 'twitter' ? await fetchTweetDetails(item.link) : null);
            await channel.send(buildSocialMessage(provider, feed, item, date, parsedFeed, { tweet, allowSensitive }));
            delivered++;
            cursor = date;
        }
        // The whole batch landed, so the cursor may also skip whatever the
        // per-sweep cap left behind — those are not coming.
        cursor = fresh[fresh.length - 1].date;
    } catch (error) {
        console.error(`[Social] Error delivering ${feed.platform} ${feed.ref} to guild ${guild.guildId}:`, error);
    }

    if (cursor) {
        try {
            await Guild.updateOne(
                { guildId: guild.guildId, 'socialFeeds._id': feed._id },
                { $set: { 'socialFeeds.$.lastPublished': cursor } }
            );
        } catch (error) {
            console.error(`[Social] Error advancing the cursor for ${feed.feedUrl} in guild ${guild.guildId}:`, error);
        }
    }

    return delivered;
}

// ── Sources ─────────────────────────────────────────────────────────────────
//
// Most subscriptions are one feed URL, fetched as is. An X subscription is an
// account: it is read from FxTwitter's timeline by handle, and from the bridge
// only when that fails. Its sweep key is the handle, so a subscription stored
// before this (whose feedUrl is a bridge URL) and one stored after (whose
// feedUrl is the profile URL) share one fetch and one dead-source record.

// The X handle a subscription follows, or null if its ref is not one.
function xHandle(feed) {
    const handle = (feed?.ref || '').trim().replace(/^@/, '');
    return X_USERNAME.test(handle) ? handle : null;
}

function sourceKey(feed) {
    if (feed.platform === 'twitter') {
        const handle = xHandle(feed);
        if (handle) return `x:${handle.toLowerCase()}`;
    }
    return feed.feedUrl;
}

// Timeline tweets as the sweep's dated entries, oldest first. The item carries
// what buildSocialEmbed and the repost line read (link, text, the account's
// display name), and `tweet` spares delivery a second lookup.
function tweetEntries(tweets, handle) {
    const own = tweets.find(t => t.author.handle.toLowerCase() === handle.toLowerCase());
    const accountName = own ? own.author.name : '';
    return tweets
        .filter(t => t.createdAt && !Number.isNaN(t.createdAt.getTime()))
        .map(t => ({
            item: { link: t.url, title: t.text, creator: accountName },
            date: t.createdAt,
            tweet: t,
        }))
        .sort((a, b) => a.date - b.date);
}

// The bridge feed an X subscription can fall back to: the configured bridge's
// route for the handle, or — for a subscription stored when the bridge was the
// only X source — the bridge URL it was stored with.
function xBridgeUrl(handle, storedFeedUrl) {
    const current = twitterBridgeFeedUrl(handle);
    if (current) return current;
    if (typeof storedFeedUrl !== 'string' || !isHttpUrl(storedFeedUrl)) return null;
    try {
        // The stored profile URL is an identity, not a feed.
        if (/(^|\.)x\.com$/i.test(new URL(storedFeedUrl).hostname)) return null;
    } catch {
        return null;
    }
    return storedFeedUrl;
}

/**
 * An X account's latest posts: FxTwitter first, the bridge if that fails.
 * Throws only when every available source failed.
 *
 * @returns {Promise<{ parsedFeed: object, entries: object[], via: string }>}
 */
async function loadXSource(handle, bridgeOrigin, storedFeedUrl) {
    let apiError = null;
    if (isXApiEnabled()) {
        try {
            const tweets = await fetchProfileTimeline(handle);
            const own = tweets.find(t => t.author.handle.toLowerCase() === handle.toLowerCase());
            return {
                parsedFeed: {
                    title: own ? `${own.author.name} (@${own.author.handle})` : `@${handle}`,
                    ...(own?.author.avatar ? { image: { url: own.author.avatar } } : {}),
                    items: [],
                },
                entries: tweetEntries(tweets, handle),
                via: 'fxtwitter',
            };
        } catch (error) {
            apiError = error;
        }
    }

    const bridgeUrl = xBridgeUrl(handle, storedFeedUrl);
    if (!bridgeUrl) throw apiError || new Error(`No source for @${handle}: FxTwitter is off and no bridge is set.`);
    try {
        const parsedFeed = await parseFeedUrl(bridgeUrl, bridgeOrigin);
        if (apiError) console.warn(`[Social] FxTwitter failed for @${handle} (${apiError.message}); read the bridge instead.`);
        return { parsedFeed, entries: datedItems(parsedFeed), via: 'bridge' };
    } catch (bridgeError) {
        if (!apiError) throw bridgeError;
        throw new Error(`FxTwitter: ${apiError.message} Bridge: ${bridgeError.message}`, { cause: bridgeError });
    }
}

async function loadSource(key, feed, bridgeOrigin) {
    if (key.startsWith('x:')) return loadXSource(xHandle(feed), bridgeOrigin, feed.feedUrl);
    const parsedFeed = await parseFeedUrl(feed.feedUrl, bridgeOrigin);
    return { parsedFeed, entries: datedItems(parsedFeed), via: 'feed' };
}

/**
 * One sweep of every social subscription across every guild: fetch each unique
 * feed URL once, fan the parsed result out to every subscribing channel, and
 * advance each subscription's cursor only as far as delivery got.
 *
 * Overlap protection lives in the scheduler (runJob). Does not throw: a per-feed
 * failure is logged and counted, and the sweep carries on to the rest.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function checkSocialFeeds(client) {
    try {
        // The one origin whose private-address resolution safeFetchFeed permits
        // this sweep — only URLs actually on the configured bridge match it.
        const bridgeOrigin = getBridgeOrigin();
        const guilds = await Guild.find({ 'socialFeeds.0': { $exists: true } }, 'guildId socialFeeds').lean();

        // Fetch each source once and fan it out — a popular channel may be
        // followed by many guilds. Keyed by sourceKey: the feed URL, or the
        // handle for an X account.
        const subscriptionsByUrl = new Map(); // sourceKey -> [{ guild, feed }]
        for (const guild of guilds) {
            // Per-guild job: each shard posts only for the guilds it can reach.
            if (!handlesGuild(guild.guildId, client)) continue;
            for (const feed of guild.socialFeeds) {
                if (!feed?.feedUrl) continue;
                const key = sourceKey(feed);
                let subs = subscriptionsByUrl.get(key);
                if (!subs) subscriptionsByUrl.set(key, subs = []);
                subs.push({ guild, feed });
            }
        }

        const urls = [...subscriptionsByUrl.keys()];
        let next = 0;
        let posted = 0;
        let failed = 0;
        let skipped = 0;
        const worker = async () => {
            while (next < urls.length) {
                const url = urls[next++];
                if (shouldSkipDeadFeed(url)) { skipped++; continue; }

                const subs = subscriptionsByUrl.get(url);
                let parsedFeed;
                let entries;
                try {
                    ({ parsedFeed, entries } = await loadSource(url, subs[0].feed, bridgeOrigin));
                    recordFeedSuccess(url);
                } catch (error) {
                    recordFeedFailure(url, error);
                    failed++;
                    continue;
                }

                if (!entries.length) continue;

                for (const { guild, feed } of subs) {
                    posted += await deliverSocialUpdate(client, guild, feed, parsedFeed, entries);
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(SOCIAL_FETCH_CONCURRENCY, urls.length) }, worker)
        );

        console.log(`[Social] Sweep: ${urls.length} source(s), ${posted} posted, ${failed} failed, ${skipped} parked.`);
    } catch (error) {
        console.error('[Social] Error checking social feeds:', error);
    } finally {
        // In `finally` so a sweep that threw halfway still reclaims: the prune is
        // keyed on age alone and needs nothing the sweep produced.
        pruneFeedFailureState();
    }
}

module.exports = {
    checkSocialFeeds,
    loadXSource,
    __test__: {
        feedFailCounts, feedLastFailTime, shouldSkipDeadFeed,
        pruneFeedFailureState, DEAD_FEED_STATE_TTL_MS,
        DEAD_FEED_THRESHOLD, DEAD_FEED_COOLDOWN_MS, SOCIAL_FETCH_CONCURRENCY,
        datedItems, MAX_ITEMS_PER_SWEEP, buildSocialEmbed,
        postText, postMedia, postMediaList, feedAvatar, postAuthorName,
        buildSocialMessage, buildTweetEmbeds, linkifyTweetText, discordSafeImageUrl,
        sourceKey, xBridgeUrl, tweetEntries,
    },
};
