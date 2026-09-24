const Parser = require('rss-parser');
const Guild = require('../models/Guild');
const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const cron = require('node-cron');
const crypto = require('crypto');

const { safeFetchFeed, fetchFeedConditional } = require('../utils/safeFeedFetch');
const { runJob } = require('../utils/jobRunner');
const { handlesGuild } = require('../utils/sharding');
const COLORS = require('../utils/embedColors');
const { MEDIA_CUSTOM_FIELDS, articleImage, articleByline } = require('../utils/feedMedia');

// With Media RSS mapped: without it rss-parser drops <media:content> and
// <media:thumbnail>, which is how most news sites attach an article's picture.
const parser = new Parser({ customFields: MEDIA_CUSTOM_FIELDS });

// A daily-news send claims its slot for this long. 23h rather than 24 so a
// send that fired late (catch-up after downtime) does not push the next
// day's past its configured time for good.
const DAILY_NEWS_REFIRE_GUARD_MS = 23 * 60 * 60 * 1000;

// Feed URLs are operator-supplied, so every poll is an outbound request to a
// destination a guild admin chose. Route them through the SSRF-safe fetcher
// (private/reserved IPs blocked, DNS pinned against rebinding, redirects and
// body size bounded) rather than rss-parser's own parseURL, which would happily
// fetch the cloud metadata endpoint or the internal MongoDB host and relay the
// response into a Discord channel.
async function parseFeedUrl(url) {
    return parser.parseString(await safeFetchFeed(url));
}

// ETag / Last-Modified per feed URL, from the last sweep that fetched it. With
// them the next sweep asks "changed since?" and an unchanged feed answers 304:
// nothing downloaded, nothing parsed. Most feeds are unchanged most of the
// five-minute ticks, so this is most of the sweep's traffic.
//
// Only held while every subscription to the URL is fully caught up. A 304
// skips delivery entirely, so a feed with an item still owed to some channel
// (a send that failed, a channel briefly unreachable) must be fetched in full
// again, or that item would wait until the feed next changed.
const feedValidators = new Map();

// The sweep's fetch. Resolves null for a feed unchanged since the last sweep.
async function fetchSweepFeed(url) {
    const result = await fetchFeedConditional(url, feedValidators.get(url));
    if (result.notModified) return null;
    return { parsedFeed: await parser.parseString(result.body), validators: result.validators };
}

const runtimeTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Consecutive failure counts per feed URL. Feeds are skipped after DEAD_FEED_THRESHOLD failures,
// but a retry is allowed once DEAD_FEED_COOLDOWN_MS has elapsed since the last failure.
// Shared between the 5-minute sweep and the daily digests: a feed that is down
// is down for both.
const feedFailCounts = new Map();
const feedLastFailTime = new Map();
const DEAD_FEED_THRESHOLD = 3;
const DEAD_FEED_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// How many feed URLs checkRssFeeds fetches at once. Each fetch can take up to
// ~40s worst case (8s/hop × 5 redirects through safeFetchFeed), so strictly
// serial fetching could not finish a few dozen slow feeds inside the 5-minute
// schedule; unbounded parallelism would burst-open one socket per configured
// feed. Five keeps the sweep short without being a thundering herd.
const RSS_FETCH_CONCURRENCY = 5;

function shouldSkipDeadFeed(feedUrl) {
    const failCount = feedFailCounts.get(feedUrl) || 0;
    if (failCount < DEAD_FEED_THRESHOLD) return false;

    const lastFail = feedLastFailTime.get(feedUrl) || 0;
    if (Date.now() - lastFail < DEAD_FEED_COOLDOWN_MS) {
        console.warn(`Skipping dead feed (${failCount} consecutive failures): ${feedUrl}`);
        return true;
    }
    console.log(`Retrying previously dead feed after cooldown: ${feedUrl}`);
    return false;
}

function recordFeedSuccess(feedUrl) {
    feedFailCounts.delete(feedUrl);
    feedLastFailTime.delete(feedUrl);
}

// Nothing removes a URL from the two maps above when the last guild subscribed
// to it unsubscribes, so they accumulate every feed ever configured for the
// life of the process.
//
// Pruning against the sweep's live subscription list would look like the
// obvious fix and would be wrong: daily-news profiles carry their own feed URLs
// (dailyNewsProfiles[].feeds), which checkRssFeeds never queries, so the sweep
// would delete the circuit-breaker state of every digest-only feed every five
// minutes and a dead one would be re-fetched on each digest for good.
//
// Age is the property that covers both callers. An entry only changes behaviour
// while it is inside DEAD_FEED_COOLDOWN_MS of its last failure — past that,
// shouldSkipDeadFeed retries the feed regardless — and any feed still being
// polled refreshes its entry on each failed retry. So an entry that has aged
// well past the cooldown belongs to a URL nothing polls any more. The margin
// keeps the prune clear of the boundary, so a retry that is about to happen
// still finds its count for the log line.
const DEAD_FEED_STATE_TTL_MS = 2 * DEAD_FEED_COOLDOWN_MS;

function pruneFeedFailureState(now = Date.now()) {
    const cutoff = now - DEAD_FEED_STATE_TTL_MS;
    for (const url of feedFailCounts.keys()) {
        const lastFail = feedLastFailTime.get(url);
        if (lastFail === undefined || lastFail <= cutoff) {
            feedFailCounts.delete(url);
            feedLastFailTime.delete(url);
        }
    }
    // Any timestamp with no surviving count is state no reader can act on.
    for (const url of feedLastFailTime.keys()) {
        if (!feedFailCounts.has(url)) feedLastFailTime.delete(url);
    }
}

function recordFeedFailure(feedUrl, error) {
    const newCount = (feedFailCounts.get(feedUrl) || 0) + 1;
    feedFailCounts.set(feedUrl, newCount);
    feedLastFailTime.set(feedUrl, Date.now());
    if (newCount >= DEAD_FEED_THRESHOLD) {
        console.error(`Feed marked as dead after ${newCount} consecutive failures: ${feedUrl}`);
    } else {
        console.error(`Error parsing feed (failure ${newCount}/${DEAD_FEED_THRESHOLD}) ${feedUrl}:`, error.message);
    }
}

const SENT_LINKS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function compareByDateDesc(a, b) {
    const aTime = a.date.getTime();
    const bTime = b.date.getTime();
    const aValid = !Number.isNaN(aTime);
    const bValid = !Number.isNaN(bTime);
    if (aValid && bValid) return bTime - aTime;
    if (aValid) return -1;
    if (bValid) return 1;
    return 0;
}

function createLegacyProfile(guild) {
    const legacy = guild.dailyNews || {};
    return {
        profileId: 'default',
        enabled: Boolean(legacy.enabled),
        channelId: legacy.channelId || null,
        time: legacy.time || '09:00',
        timezone: runtimeTimezone || undefined,
        feeds: Array.isArray(legacy.feeds) ? legacy.feeds : [],
        title: legacy.title || '📰 Daily News Digest',
        maxItemsPerFeed: legacy.maxItemsPerFeed || 3,
        lastSentAt: legacy.lastSentAt || null,
        sentLinks: Array.isArray(legacy.sentLinks) ? legacy.sentLinks : []
    };
}

function getProfileSentLinksContainer(guild, profileId) {
    if (Array.isArray(guild.dailyNewsProfiles) && guild.dailyNewsProfiles.length > 0) {
        return guild.dailyNewsProfiles.find(p => p.profileId === profileId) || null;
    }
    return profileId === 'default' ? guild.dailyNews : null;
}

async function persistSentLinks(guild, profile, newlySentLinks) {
    const container = getProfileSentLinksContainer(guild, profile.profileId);
    if (!container) return;

    const cutoff = Date.now() - SENT_LINKS_RETENTION_MS;
    const existing = Array.isArray(container.sentLinks) ? container.sentLinks : [];
    const now = new Date();

    const merged = existing
        .filter(entry => entry.sentAt && entry.sentAt.getTime() > cutoff)
        .concat(newlySentLinks.map(link => ({ link, sentAt: now })));

    container.sentLinks = merged;
    await guild.save();
}

// Scheduling a guild's digests needs its id and its profiles, and nothing else.
// Guild documents also carry embedded image Buffers, so a projection is the
// difference between reading a few hundred bytes per guild and reading whatever
// artwork that guild's admins have uploaded.
const DAILY_NEWS_FIELDS = 'guildId dailyNewsProfiles dailyNews';

function getDailyNewsProfiles(guild) {
    if (Array.isArray(guild.dailyNewsProfiles) && guild.dailyNewsProfiles.length > 0) {
        return guild.dailyNewsProfiles;
    }

    const legacyProfile = createLegacyProfile(guild);
    return legacyProfile.enabled && legacyProfile.feeds.length > 0 ? [legacyProfile] : [];
}

function normalizeArticleLink(link = '') {
    try {
        const url = new URL(link);
        const blockedParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'];
        for (const param of blockedParams) {
            url.searchParams.delete(param);
        }
        return url.toString();
    } catch {
        return link;
    }
}


// `guildId` is the guild the subscription belongs to. `channels.fetch` resolves
// an id in any guild the bot is in, so a channel from somewhere else is
// refused here rather than posted to (#1140).
async function fetchSendableChannel(client, channelId, guildId) {
    let channel;

    try {
        channel = await client.channels.fetch(channelId);
    } catch {
        channel = client.channels.cache.get(channelId) || null;
    }

    if (!channel || typeof channel.send !== 'function') return null;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return null;
    if (channel.guildId !== guildId) {
        console.error(`[rss] refusing to post to channel ${channelId}: it is not in guild ${guildId}`);
        return null;
    }

    return channel;
}
// What a subscription remembers having seen. Dates alone were not enough to
// tell "new" from "old": two posts sharing a timestamp lost the second, a post
// back-dated past the cursor was never posted, an old post re-dated by an edit
// was posted again, and a feed that carries no dates at all posted nothing.
// Each item is keyed by its guid (Atom: id), falling back to its link and then
// its title and date — hashed, because a guild document holds a list of these
// per subscription and raw permalinks run to hundreds of bytes each.
function itemKey(item) {
    const raw = feedText(item.guid) || feedText(item.id) || feedText(item.link)
        || `${feedText(item.title)}|${feedText(item.pubDate || item.isoDate)}`;
    return crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 16);
}

// Most feeds list newest first, but nothing in RSS or Atom requires it, and a
// feed that lists oldest first pinned `items[0]` to an article that never
// changes. Order is taken from the dates, not from the document: dated items
// oldest first, then any undated ones, which are taken as newer than every
// dated item and — lacking anything better — in reverse document order.
//
// An unparseable date is kept as null rather than passed on: it is also the
// embed's timestamp, and `setTimestamp(new Date('...'))` throws RangeError.
function feedEntries(parsedFeed) {
    const dated = [];
    const undated = [];
    const keys = new Set();
    for (const item of parsedFeed.items || []) {
        const key = itemKey(item);
        if (keys.has(key)) continue;
        keys.add(key);
        const date = new Date(item.pubDate || item.isoDate);
        if (Number.isNaN(date.getTime())) undated.push({ item, key, date: null });
        else dated.push({ item, key, date });
    }
    dated.sort((a, b) => a.date - b.date);
    return dated.concat(undated.reverse());
}

// How many item keys a subscription keeps. At least a feed's whole current
// window, so nothing still listed can come back as "new"; beyond that, enough
// history that an item which briefly drops off the feed and returns is still
// recognised.
const SEEN_IDS_MIN = 200;

// An unseen item dated this far before the newest one already posted is
// recorded as seen but not posted. Real back-dating (a post scheduled
// yesterday and published today) sits well inside it; a feed that changes how
// it writes its guids, which makes every item look unseen at once, does not.
const BACKDATE_GRACE_MS = 24 * 60 * 60 * 1000;

// Embed limits discord.js enforces at build time. Anything past them throws
// from the builder, and a throw inside the delivery loop leaves the cursor
// short of the item — so one over-long title used to be retried every sweep
// for good, holding back everything the feed published after it.
const EMBED_TITLE_LIMIT = 256;
const EMBED_AUTHOR_LIMIT = 256;
const EMBED_FOOTER_LIMIT = 2048;
// Enough for the standfirst of most articles — a headline alone rarely says
// whether a post is worth a click — without turning a channel into a wall.
const ITEM_SNIPPET_LIMIT = 350;

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// rss-parser hands back whatever the XML held: usually a string, but an
// element with attributes arrives as `{ _: 'text', $: {...} }`.
function feedText(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value._ === 'string') return value._.trim();
    return '';
}

// An absolute http(s) URL, or null. Feeds routinely carry root-relative links
// ("/2025/08/post") and the odd `javascript:` or empty one; the builder rejects
// all of them, so they are resolved against the feed or dropped here instead.
function absoluteHttpUrl(raw, base) {
    const text = feedText(raw);
    if (!text) return null;
    try {
        const url = new URL(text, base);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

// Relative item links resolve against the site the feed describes, falling
// back to the feed's own URL when its <link> is missing or unusable.
function feedBaseUrl(parsedFeed, feedUrl) {
    return absoluteHttpUrl(parsedFeed.link, feedUrl) || feedUrl;
}

/**
 * The embed for one feed item.
 *
 * Laid out the way Discord unfurls an article link: the feed's name and logo
 * as the author line, the headline linking to the article, a few lines of
 * text, the article's own picture shown large, and the byline in the footer.
 * It used to be a headline, 200 characters and the feed's logo, so every post
 * from a feed looked the same until it was read.
 *
 * Built only from values the builder accepts — text truncated to Discord's
 * limits, every URL resolved to absolute http(s) or left off — so no item can
 * make it throw.
 */
function buildItemEmbed(item, date, parsedFeed, feedUrl) {
    const base = feedBaseUrl(parsedFeed, feedUrl);
    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(truncate(feedText(item.title) || 'New Post', EMBED_TITLE_LIMIT));

    // A headline and a picture are a complete post; filler text is not
    // better than none.
    const snippet = truncate(feedText(item.contentSnippet), ITEM_SNIPPET_LIMIT);
    if (snippet) embed.setDescription(snippet);

    // Undated items are posted too, just without a timestamp.
    if (date) embed.setTimestamp(date);

    const link = absoluteHttpUrl(item.link, base);
    if (link) embed.setURL(link);

    const feedName = truncate(feedText(parsedFeed.title), EMBED_AUTHOR_LIMIT);
    const logo = absoluteHttpUrl(parsedFeed.image?.url, base);
    if (feedName) {
        const author = { name: feedName };
        const site = absoluteHttpUrl(parsedFeed.link, feedUrl);
        if (site) author.url = site;
        if (logo) author.iconURL = logo;
        embed.setAuthor(author);
    } else if (logo) {
        embed.setThumbnail(logo);
    }

    const image = articleImage(item, base);
    if (image) embed.setImage(image);

    const byline = articleByline(item);
    if (byline) embed.setFooter({ text: truncate(`By ${byline}`, EMBED_FOOTER_LIMIT) });

    return embed;
}

// ── Per-subscription options ────────────────────────────────────────────────

function keywordPattern(keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Whole words, in any script: "art" must not match "start", and \b only
    // knows ASCII letters.
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

function keywordList(value) {
    return Array.isArray(value) ? value.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()) : [];
}

/**
 * Whether an item passes a subscription's keyword filters. Matched as whole
 * words, ignoring case, against the headline, the text and the item's
 * categories. With include keywords, one of them has to appear; any exclude
 * keyword that appears rules the item out.
 */
function itemPassesFilters(item, feed) {
    const include = keywordList(feed.includeKeywords);
    const exclude = keywordList(feed.excludeKeywords);
    if (!include.length && !exclude.length) return true;

    const categories = Array.isArray(item.categories) ? item.categories.map(feedText) : [];
    const haystack = [feedText(item.title), feedText(item.contentSnippet), ...categories].join('\n');
    if (include.length && !include.some(k => keywordPattern(k).test(haystack))) return false;
    return !exclude.some(k => keywordPattern(k).test(haystack));
}

const MESSAGE_CONTENT_LIMIT = 2000;

/**
 * The message an item is sent as: its embed, plus — when the subscription has
 * them — the role ping and the admin's message line, with {title}, {link},
 * {feed} and {author} filled in.
 *
 * Mentions are locked to the one role the admin chose. The message line mixes
 * admin text with feed text, and neither an "@everyone" in a template nor a
 * "<@&id>" in some headline may ping anybody.
 */
function itemMessage(feed, item, parsedFeed, embed) {
    const roleId = typeof feed.mentionRoleId === 'string' && /^\d{17,20}$/.test(feed.mentionRoleId) ? feed.mentionRoleId : null;
    const parts = [];
    if (roleId) parts.push(`<@&${roleId}>`);

    const template = typeof feed.messageTemplate === 'string' ? feed.messageTemplate.trim() : '';
    if (template) {
        const values = {
            title: escapeMarkdown(feedText(item.title)),
            link: embed.data.url || '',
            feed: escapeMarkdown(feedText(parsedFeed.title)),
            author: escapeMarkdown(articleByline(item)),
        };
        parts.push(template.replace(/\{(title|link|feed|author)\}/g, (_, key) => values[key]));
    }

    const message = { embeds: [embed], allowedMentions: { parse: [], roles: roleId ? [roleId] : [] } };
    const content = truncate(parts.join(' '), MESSAGE_CONTENT_LIMIT);
    if (content) message.content = content;
    return message;
}

// A feed that publishes a burst between two sweeps posts at most this many of
// them, newest kept. The rest of the burst is still recorded as seen: a channel
// is not a backfill target, and the alternative — posting all of them — is a
// feed that reposts its archive the first time it is polled after an outage.
const MAX_ITEMS_PER_SWEEP = 5;

// Which of a feed's entries this subscription has not posted yet.
//
// A subscription saved before item keys existed has no `seenIds` (the field has
// no default, so absent and "seen nothing" stay distinguishable). It keeps the
// old date rule for one more sweep, which also records every key the feed
// currently lists; from then on keys decide. Without that step every existing
// subscription would read its whole feed as unseen on the first sweep after
// an upgrade.
function unseenEntries(feed, entries) {
    if (Array.isArray(feed.seenIds)) {
        const seen = new Set(feed.seenIds);
        const floor = feed.lastPublished ? new Date(feed.lastPublished).getTime() - BACKDATE_GRACE_MS : -Infinity;
        return entries.filter(e => !seen.has(e.key) && (!e.date || e.date.getTime() > floor));
    }
    if (feed.lastPublished) {
        return entries.filter(e => e.date && e.date > feed.lastPublished);
    }
    // First sight of a feed posts its newest item and nothing else. Without
    // that, subscribing to a feed would empty its whole archive into the
    // channel. A dated item is preferred: in a feed where most items carry a
    // date, the odd undated one is no evidence of being the newest.
    const newestDated = entries.filter(e => e.date).slice(-1);
    return newestDated.length ? newestDated : entries.slice(-1);
}

/**
 * Delivers a freshly-parsed feed to one guild's subscription: sends what is new
 * for that guild and records it as seen. Per-subscription failures are
 * contained here so one guild's deleted channel does not stop the fan-out to
 * the others.
 *
 * Returns `{ delivered, complete }`: the number of items posted, for the
 * sweep's summary line, and whether nothing is left owed to this subscription.
 */
async function deliverFeedUpdate(client, guild, feed, parsedFeed, entries) {
    const fresh = unseenEntries(feed, entries);

    // Only what was actually handled is recorded, never more. A batch that
    // stops half way must not repost the half that landed on the next sweep,
    // and must not skip the half that did not.
    const handled = new Set();
    let delivered = 0;

    // An item the filters rule out is handled by not posting it. Taken out
    // before the per-sweep cap, so filtered items do not use up its slots.
    const wanted = [];
    for (const entry of fresh) {
        if (itemPassesFilters(entry.item, feed)) wanted.push(entry);
        else handled.add(entry.key);
    }
    const toPost = wanted.slice(-MAX_ITEMS_PER_SWEEP);

    if (toPost.length) {
        try {
            const channel = await fetchSendableChannel(client, feed.channelId, guild.guildId);

            // No channel is not a delivery. Recording the burst here would drop
            // it for good on a channel that was only briefly unreachable —
            // `channels.fetch` failing with nothing in the cache looks exactly
            // like a deleted one. Leaving it costs a no-op re-check each sweep
            // while the channel is really gone, the cheaper of the two mistakes.
            if (!channel) return { delivered: 0, complete: false };

            for (const entry of toPost) {
                // An item the builder still refuses is skipped, not retried: it
                // is the item that is wrong, and it will be just as wrong on the
                // next sweep. A failed *send* is different — that throws below
                // and leaves the item unrecorded.
                let message;
                try {
                    const embed = buildItemEmbed(entry.item, entry.date, parsedFeed, feed.url);
                    message = itemMessage(feed, entry.item, parsedFeed, embed);
                } catch (error) {
                    console.error(`Skipping an RSS item from ${feed.url} that could not be rendered:`, error.message);
                    handled.add(entry.key);
                    continue;
                }

                await channel.send(message);
                delivered++;
                handled.add(entry.key);
            }

            // The whole batch landed, so whatever the per-sweep cap left
            // behind may be recorded too — those are not coming.
            for (const entry of fresh) handled.add(entry.key);
        } catch (error) {
            console.error(`Error delivering RSS update for ${feed.url} to guild ${guild.guildId}:`, error);
        }
    }

    const recorded = await recordSeen(guild, feed, entries, fresh, handled, {
        title: truncate(feedText(parsedFeed.title), FEED_TITLE_LIMIT),
        posted: delivered > 0,
    });
    return { delivered, complete: recorded && fresh.every(entry => handled.has(entry.key)) };
}

// Writes back what this sweep learned about one subscription: every key the
// feed lists except the fresh ones that did not get through, the newest date
// handled, and — for the dashboard — the feed's title, when it last posted,
// and that it is no longer failing. Nothing is written when none of it
// changed, so an idle feed costs no write per sweep. Returns false when the
// write failed.
async function recordSeen(guild, feed, entries, fresh, handled, { title, posted }) {
    const pending = new Set(fresh.filter(e => !handled.has(e.key)).map(e => e.key));
    const previous = Array.isArray(feed.seenIds) ? feed.seenIds : [];
    const previousSet = new Set(previous);

    const current = entries.map(e => e.key).filter(key => !pending.has(key));
    const nextSeen = [...new Set(current.concat(previous))]
        .slice(0, Math.max(SEEN_IDS_MIN, current.length));

    const $set = {};
    if (!Array.isArray(feed.seenIds) || nextSeen.some(key => !previousSet.has(key))) {
        $set['rssFeeds.$.seenIds'] = nextSeen;
    }

    // lastPublished is still kept: it is the backdating floor above and what a
    // subscription saved before item keys is judged by. It only ever moves
    // forward — a back-dated item that was posted does not pull it back.
    let cursor = null;
    for (const entry of fresh) {
        if (handled.has(entry.key) && entry.date && (!cursor || entry.date > cursor)) cursor = entry.date;
    }
    if (cursor && (!feed.lastPublished || cursor > new Date(feed.lastPublished))) {
        $set['rssFeeds.$.lastPublished'] = cursor;
    }

    if (title && title !== feed.title) $set['rssFeeds.$.title'] = title;
    if (posted) $set['rssFeeds.$.lastPostedAt'] = new Date();
    // A good fetch ends a failure: the dashboard stops showing the error.
    if (feed.lastError || feed.failingSince) {
        $set['rssFeeds.$.lastError'] = null;
        $set['rssFeeds.$.failingSince'] = null;
    }

    if (!Object.keys($set).length) return true;
    try {
        // Targets the one subdocument rather than rewriting the whole rssFeeds
        // array, which is also what `guild.save()` on a projected document
        // could not do.
        await Guild.updateOne({ guildId: guild.guildId, 'rssFeeds._id': feed._id }, { $set });
        return true;
    } catch (error) {
        console.error(`Error recording RSS progress for ${feed.url} in guild ${guild.guildId}:`, error);
        return false;
    }
}

const FEED_TITLE_LIMIT = 200;
const FEED_ERROR_LIMIT = 200;

// Puts a failed fetch where an admin will see it: on each subscription to the
// URL, as the error and the time it started failing. Written only when that
// changes — the first failure, or a different error — not on every failing
// sweep, and `failingSince` keeps the first failure's time.
async function recordFeedFailureOnSubscriptions(url, subscriptions, error) {
    const message = truncate(feedText(error?.message) || 'Could not fetch or read the feed.', FEED_ERROR_LIMIT);
    const now = new Date();
    for (const { guild, feed } of subscriptions) {
        if (feed.lastError === message && feed.failingSince) continue;
        const $set = { 'rssFeeds.$.lastError': message };
        if (!feed.failingSince) $set['rssFeeds.$.failingSince'] = now;
        try {
            await Guild.updateOne({ guildId: guild.guildId, 'rssFeeds._id': feed._id }, { $set });
        } catch (writeError) {
            console.error(`Error recording RSS failure for ${url} in guild ${guild.guildId}:`, writeError);
        }
    }
}

/**
 * One sweep of every subscribed feed across every guild: fetch, post what is
 * new to each subscribing channel, and advance each feed's cursor only as far
 * as delivery actually got.
 *
 * Overlap protection lives in the scheduler: this runs through `runJob`, which
 * drops a tick while the previous sweep is still in flight. A feed that keeps
 * failing is parked for a cooldown rather than retried every tick, and one
 * sweep logs a single summary line — feeds having stopped posting used to be
 * indistinguishable from nothing having been published.
 *
 * Does not throw: a per-feed failure is logged and counted, and the sweep
 * carries on to the rest.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function checkRssFeeds(client) {
    try {
        // Projected and lean: a full Guild document carries every shop item's
        // image Buffer and each giveaway's entrant list, none of which this
        // job reads.
        const guilds = await Guild.find({ 'rssFeeds.0': { $exists: true } }, 'guildId rssFeeds').lean();

        // Popular feeds are configured by many guilds; fetch each URL once per
        // sweep and fan the parsed result out to every subscription.
        const subscriptionsByUrl = new Map(); // url -> [{ guild, feed }]
        for (const guild of guilds) {
            // Per-guild job: each shard posts only for the guilds it can reach.
            if (!handlesGuild(guild.guildId, client)) continue;
            for (const feed of guild.rssFeeds) {
                if (!feed?.url) continue;
                let subs = subscriptionsByUrl.get(feed.url);
                if (!subs) subscriptionsByUrl.set(feed.url, subs = []);
                subs.push({ guild, feed });
            }
        }

        // A shared cursor over the URL list, drained by a small pool of
        // workers — bounded parallelism without chunking (no worker idles
        // while a slow feed holds up its chunk).
        const urls = [...subscriptionsByUrl.keys()];
        let next = 0;
        let posted = 0;
        let failed = 0;
        let skipped = 0;
        let unchanged = 0;
        const worker = async () => {
            while (next < urls.length) {
                const url = urls[next++];
                if (shouldSkipDeadFeed(url)) { skipped++; continue; }

                let fetched;
                try {
                    fetched = await fetchSweepFeed(url);
                    recordFeedSuccess(url);
                } catch (error) {
                    feedValidators.delete(url);
                    recordFeedFailure(url, error);
                    await recordFeedFailureOnSubscriptions(url, subscriptionsByUrl.get(url), error);
                    failed++;
                    continue;
                }
                if (!fetched) { unchanged++; continue; }

                // Delivered even when the feed lists nothing: an empty feed
                // is still a good fetch, which clears a recorded failure.
                const entries = feedEntries(fetched.parsedFeed);
                let complete = true;
                for (const { guild, feed } of subscriptionsByUrl.get(url)) {
                    const result = await deliverFeedUpdate(client, guild, feed, fetched.parsedFeed, entries);
                    posted += result.delivered;
                    if (!result.complete) complete = false;
                }

                if (complete && fetched.validators) feedValidators.set(url, fetched.validators);
                else feedValidators.delete(url);
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(RSS_FETCH_CONCURRENCY, urls.length) }, worker)
        );

        // One line per sweep, always. "Feeds stopped posting" was previously
        // indistinguishable from "nothing new was published" from the outside,
        // and the per-feed errors say what broke without ever saying how much
        // of the sweep it was.
        console.log(`[RSS] Sweep: ${urls.length} feed(s), ${posted} posted, ${unchanged} unchanged, ${failed} failed, ${skipped} parked.`);

        // A URL no subscription on this shard polls any more has no use for
        // its validators.
        for (const url of feedValidators.keys()) {
            if (!subscriptionsByUrl.has(url)) feedValidators.delete(url);
        }
    } catch (error) {
        console.error('Error checking RSS feeds:', error);
    } finally {
        // In `finally` so a sweep that threw halfway still reclaims: the prune
        // is keyed on age alone and needs nothing the sweep produced.
        pruneFeedFailureState();
    }
}

// Feed text is dropped into Markdown, where a stray `]`, `*` or `_` in a
// headline closes the link or bolds the rest of the digest. escapeMarkdown
// does not cover the link brackets, so those are escaped here — in one pass
// with backslashes, before anything else adds a backslash, so a headline's own
// `\` cannot escape the one added before its `]` and leave the `]` live.
// escapeMarkdown's own backslash pass is off: it would double these.
function digestText(text) {
    return escapeMarkdown(String(text).replace(/[\\[\]]/g, '\\$&'), { escape: false });
}

// A `)` in the URL ends a Markdown link early.
function digestLink(url) {
    return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

async function sendDailyNewsForProfile(client, guild, profile) {
    const channel = await fetchSendableChannel(client, profile.channelId, guild.guildId);
    if (!channel) {
        console.error(`Daily news channel not found for guild ${guild.guildId}, profile ${profile.profileId}`);
        return;
    }

    const allItems = [];
    const cutoffMs = Date.now() - (24 * 60 * 60 * 1000);
    let unreachable = 0;

    for (const feedUrl of profile.feeds) {
        if (shouldSkipDeadFeed(feedUrl)) { unreachable++; continue; }

        try {
            const parsedFeed = await parseFeedUrl(feedUrl);
            recordFeedSuccess(feedUrl);
            const base = feedBaseUrl(parsedFeed, feedUrl);
            const feedItems = parsedFeed.items
                .map(item => ({
                    title: feedText(item.title) || 'Untitled',
                    link: absoluteHttpUrl(item.link, base),
                    normalizedLink: normalizeArticleLink(absoluteHttpUrl(item.link, base) || ''),
                    description: item.contentSnippet?.substring(0, 150) || 'No description',
                    source: feedText(parsedFeed.title) || 'Unknown Source',
                    date: new Date(item.pubDate || item.isoDate)
                }))
                .filter(item => Number.isNaN(item.date.getTime()) || item.date.getTime() >= cutoffMs)
                .sort(compareByDateDesc)
                .slice(0, profile.maxItemsPerFeed || 3);

            allItems.push(...feedItems);
        } catch (error) {
            recordFeedFailure(feedUrl, error);
            unreachable++;
        }
    }

    const previouslySent = new Set(
        (Array.isArray(profile.sentLinks) ? profile.sentLinks : []).map(entry => entry.link)
    );

    const uniqueItems = [];
    const seenLinks = new Set();
    for (const item of allItems) {
        if (item.normalizedLink && (seenLinks.has(item.normalizedLink) || previouslySent.has(item.normalizedLink))) continue;
        seenLinks.add(item.normalizedLink);
        uniqueItems.push(item);
    }

    // A digest that posts nothing looks identical from Discord to a digest that
    // never ran, and its slot is already claimed for the day either way — so the
    // two get told apart here, in the one place that knows which it was.
    if (uniqueItems.length === 0) {
        const why = profile.feeds.length > 0 && unreachable === profile.feeds.length
            ? `all ${profile.feeds.length} feed(s) unreachable`
            : 'nothing new in the last 24h';
        console.log(`[RSS] Daily news for guild ${guild.guildId} (${profile.profileId}): sent nothing — ${why}.`);
        return;
    }

    uniqueItems.sort(compareByDateDesc);

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(profile.title)
        .setDescription('Here are the top stories from the last 24 hours:')
        .setTimestamp();

    let description = '';
    for (let i = 0; i < Math.min(uniqueItems.length, 10); i++) {
        const item = uniqueItems[i];
        const title = digestText(item.title);
        const heading = item.link ? `[${title}](${digestLink(item.link)})` : title;
        description += `\n**${i + 1}. ${heading}**\n`;
        description += `*${digestText(item.source)}* • ${digestText(item.description)}\n`;
    }

    if (description.length > 4000) {
        description = description.substring(0, 3997) + '...';
    }

    embed.setDescription(description);
    embed.setFooter({ text: `${uniqueItems.length} articles from ${profile.feeds.length} sources • last 24h` });

    await channel.send({ embeds: [embed] });

    const sentLinks = uniqueItems.slice(0, 10).map(item => item.normalizedLink).filter(Boolean);
    await persistSentLinks(guild, profile, sentLinks);
}

/**
 * Send one guild's daily news digest now.
 *
 * Failures propagate: both callers need them. The scheduled run goes through
 * `runJob`, which records the failure and files a dead-letter entry, and the
 * dashboard's "send now" button answers 500 instead of reporting success for a
 * digest that never went out.
 *
 * A profile with no feeds, or one disabled, is skipped rather than treated as
 * an error, as is a guild that no longer exists.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {?string} [profileId] one digest profile; null sends every enabled
 *   profile the guild has
 * @returns {Promise<void>}
 * @throws whatever the send failed with — deliberately not swallowed
 */
async function sendDailyNews(client, guildId, profileId = null) {
    const guild = await Guild.findOne({ guildId });
    if (!guild) return;

    const profiles = getDailyNewsProfiles(guild)
        .filter(profile => profile.enabled && Array.isArray(profile.feeds) && profile.feeds.length > 0);

    if (!profiles.length) return;

    const targetProfiles = profileId
        ? profiles.filter(profile => profile.profileId === profileId)
        : profiles;

    for (const profile of targetProfiles) {
        await sendDailyNewsForProfile(client, guild, profile);
    }
}

// The local wall-clock hour/minute in `timezone`, falling back to the
// runtime's zone when it is missing or invalid — the same zone the old
// in-memory cron jobs ran profiles without a timezone in.
function localHourMinute(timezone, now) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone || runtimeTimezone,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        }).formatToParts(now);
        return {
            hour: parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10),
            minute: parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
        };
    } catch {
        return { hour: now.getUTCHours(), minute: now.getUTCMinutes() };
    }
}

// Due once the configured local time has passed today and the last send is
// stale, not only on the exact minute (#824). The old per-profile node-cron
// jobs lived in memory: a restart, or the process being down at hh:mm,
// silently cost the day's digest. This is re-derived from the database every
// tick, so it also picks up dashboard edits with no reschedule step.
function dailyNewsDue(profile, now) {
    const safeTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(profile.time || '') ? profile.time : '09:00';
    const [dueHour, dueMinute] = safeTime.split(':').map(Number);
    const { hour, minute } = localHourMinute(profile.timezone, now);
    if (hour < dueHour || (hour === dueHour && minute < dueMinute)) return false;
    if (profile.lastSentAt && now - new Date(profile.lastSentAt) < DAILY_NEWS_REFIRE_GUARD_MS) return false;
    return true;
}

// Atomically claim the profile's daily slot before sending, so a failed send
// cannot re-fire every minute for the rest of the day and a concurrent worker
// cannot double-send. Returns false when someone else already claimed it.
async function claimDailyNewsRun(guildId, profile, isLegacy, now) {
    const cutoff = new Date(now.getTime() - DAILY_NEWS_REFIRE_GUARD_MS);
    const filter = isLegacy
        ? {
            guildId,
            'dailyNews.enabled': true,
            $or: [{ 'dailyNews.lastSentAt': null }, { 'dailyNews.lastSentAt': { $lte: cutoff } }]
        }
        : {
            guildId,
            dailyNewsProfiles: {
                $elemMatch: {
                    profileId: profile.profileId,
                    enabled: true,
                    $or: [{ lastSentAt: null }, { lastSentAt: { $lte: cutoff } }]
                }
            }
        };
    const update = isLegacy
        ? { $set: { 'dailyNews.lastSentAt': now } }
        : { $set: { 'dailyNewsProfiles.$.lastSentAt': now } };

    const res = await Guild.updateOne(filter, update);
    return res.modifiedCount === 1;
}

async function runDueDailyNews(client) {
    const now = new Date();
    const guilds = await Guild.find(
        { $or: [{ 'dailyNewsProfiles.enabled': true }, { 'dailyNews.enabled': true }] },
        DAILY_NEWS_FIELDS
    ).lean();

    for (const guild of guilds) {
        const isLegacy = !(Array.isArray(guild.dailyNewsProfiles) && guild.dailyNewsProfiles.length > 0);
        const profiles = getDailyNewsProfiles(guild)
            .filter(profile => profile.enabled && Array.isArray(profile.feeds) && profile.feeds.length > 0);

        for (const profile of profiles) {
            if (!dailyNewsDue(profile, now)) continue;
            if (!await claimDailyNewsRun(guild.guildId, profile, isLegacy, now)) continue;

            await runJob('rssService', 'sendDailyNews', () => sendDailyNews(client, guild.guildId, profile.profileId), {
                guildId: guild.guildId,
                payload: { profileId: profile.profileId },
            });
        }
    }
}

/**
 * Start the daily news scheduler. Called once at startup.
 *
 * @param {import('discord.js').Client} client
 * @returns {void}
 */
function scheduleDailyNews(client) {
    // A minute tick over persisted state, not one in-memory cron job per
    // profile: survives restarts, catches up after downtime, and needs no
    // reschedule hook when the dashboard changes a time.
    cron.schedule('* * * * *', () =>
        runJob('rssService', 'dailyNewsScheduler', () => runDueDailyNews(client))
    );
    console.log('[RSS] Daily news scheduler started');
}

module.exports = {
    checkRssFeeds, scheduleDailyNews, sendDailyNews,
    __test__: {
        feedFailCounts, feedLastFailTime, shouldSkipDeadFeed, feedValidators,
        pruneFeedFailureState, DEAD_FEED_STATE_TTL_MS,
        DEAD_FEED_THRESHOLD, DEAD_FEED_COOLDOWN_MS, RSS_FETCH_CONCURRENCY,
        dailyNewsDue, runDueDailyNews, DAILY_NEWS_REFIRE_GUARD_MS,
        feedEntries, itemKey, MAX_ITEMS_PER_SWEEP, SEEN_IDS_MIN, BACKDATE_GRACE_MS,
        buildItemEmbed, EMBED_TITLE_LIMIT, itemPassesFilters, itemMessage,
    },
};
