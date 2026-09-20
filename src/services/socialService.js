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
const { EmbedBuilder } = require('discord.js');

const { safeFetchFeed } = require('../utils/safeFeedFetch');
const { handlesGuild } = require('../utils/sharding');
const { getProvider, getBridgeOrigin } = require('./socialProviders');

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
        return end === -1 ? null : tag.slice(i + 1, end);
    }
    return null;
}

// The first inline <img> URL in an HTML fragment, located by scanning rather than
// a tag-matching regex (see readTagAttr). Used only for bridges that embed a
// post's photo in the body instead of exposing it as an enclosure or media:*.
function firstInlineImageUrl(html) {
    const lower = html.toLowerCase();
    for (let start = lower.indexOf('<img'); start !== -1; start = lower.indexOf('<img', start + 4)) {
        const close = html.indexOf('>', start);
        const tag = close === -1 ? html.slice(start) : html.slice(start, close + 1);
        const src = readTagAttr(tag, 'src');
        if (isHttpUrl(src)) return src;
        if (close === -1) break;
    }
    return null;
}

// The post's own media, to show large. A bridge exposes it as an enclosure, a
// media:* element, or — the shape the X and Instagram bridges use — an inline
// <img> in the content HTML, which the enclosure/media checks alone miss.
function postMedia(item) {
    if (isHttpUrl(item.enclosure?.url)) return item.enclosure.url;
    const mediaUrl = item['media:thumbnail']?.$?.url || item['media:content']?.$?.url;
    if (isHttpUrl(mediaUrl)) return mediaUrl;
    for (const field of CONTENT_FIELDS) {
        const raw = item[field];
        if (typeof raw !== 'string' || !raw.includes('<img')) continue;
        const url = firstInlineImageUrl(raw);
        if (url) return url;
    }
    return null;
}

// The feed's own image — a channel avatar, subreddit icon or profile picture —
// used as the small author/thumbnail badge rather than as the post's media.
function feedAvatar(parsedFeed) {
    return isHttpUrl(parsedFeed?.image?.url) ? parsedFeed.image.url : null;
}

function buildSocialEmbed(provider, feed, item, date, parsedFeed) {
    const account = feed.ref || parsedFeed.title || provider.label;
    const avatar = feedAvatar(parsedFeed);
    const media = postMedia(item);
    const body = postText(item);

    const embed = new EmbedBuilder()
        .setColor(provider.color)
        .setAuthor({
            name: `${provider.emoji} ${provider.label} • ${account} ${provider.verb}`.slice(0, AUTHOR_LIMIT),
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

        for (const { item, date } of toPost) {
            await channel.send({ embeds: [buildSocialEmbed(provider, feed, item, date, parsedFeed)] });
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

        // Fetch each resolved URL once and fan it out — a popular channel may be
        // followed by many guilds.
        const subscriptionsByUrl = new Map(); // feedUrl -> [{ guild, feed }]
        for (const guild of guilds) {
            // Per-guild job: each shard posts only for the guilds it can reach.
            if (!handlesGuild(guild.guildId, client)) continue;
            for (const feed of guild.socialFeeds) {
                if (!feed?.feedUrl) continue;
                let subs = subscriptionsByUrl.get(feed.feedUrl);
                if (!subs) subscriptionsByUrl.set(feed.feedUrl, subs = []);
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

                let parsedFeed;
                try {
                    parsedFeed = await parseFeedUrl(url, bridgeOrigin);
                    recordFeedSuccess(url);
                } catch (error) {
                    recordFeedFailure(url, error);
                    failed++;
                    continue;
                }

                const entries = datedItems(parsedFeed);
                if (!entries.length) continue;

                for (const { guild, feed } of subscriptionsByUrl.get(url)) {
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
    __test__: {
        feedFailCounts, feedLastFailTime, shouldSkipDeadFeed,
        pruneFeedFailureState, DEAD_FEED_STATE_TTL_MS,
        DEAD_FEED_THRESHOLD, DEAD_FEED_COOLDOWN_MS, SOCIAL_FETCH_CONCURRENCY,
        datedItems, MAX_ITEMS_PER_SWEEP, buildSocialEmbed,
        postText, postMedia, feedAvatar,
    },
};
