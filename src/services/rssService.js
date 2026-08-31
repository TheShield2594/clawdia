const Parser = require('rss-parser');
const Guild = require('../models/Guild');
const { EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const { safeFetchFeed } = require('../utils/safeFeedFetch');
const { runJob } = require('../utils/jobRunner');
const COLORS = require('../utils/embedColors');

const parser = new Parser();

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
// Most feeds list newest first, but nothing in RSS or Atom requires it, and a
// feed that lists oldest first pinned `items[0]` to an article that never
// changes — so the sweep advanced its cursor once and then had nothing new to
// say for the rest of the feed's life. Order is taken from the dates, not from
// the document.
//
// An item whose pubDate does not parse is dropped rather than posted: its date
// is both the "is this new" test and the embed's timestamp, and
// `setTimestamp(new Date('...'))` on an unparseable one throws RangeError —
// which, on a feed being seen for the first time, aborted the delivery before
// the cursor was written and so repeated on every sweep, forever.
function datedItems(parsedFeed) {
    return (parsedFeed.items || [])
        .map(item => ({ item, date: new Date(item.pubDate || item.isoDate) }))
        .filter(entry => !Number.isNaN(entry.date.getTime()))
        .sort((a, b) => a.date - b.date);
}

// A feed that publishes a burst between two sweeps posts at most this many of
// them, newest kept. The cursor still advances past the whole burst: a channel
// is not a backfill target, and the alternative — posting all of them — is a
// feed that reposts its archive the first time it is polled after an outage.
const MAX_ITEMS_PER_SWEEP = 5;

/**
 * Delivers a freshly-parsed feed to one guild's subscription: sends what is new
 * for that guild and advances its lastPublished cursor. Per-subscription
 * failures are contained here so one guild's deleted channel does not stop the
 * fan-out to the others.
 *
 * Returns the number of items posted, for the sweep's summary line.
 */
async function deliverFeedUpdate(client, guild, feed, parsedFeed, entries) {
    // First sight of a feed posts its newest item and nothing else. Without
    // that, subscribing to a feed would empty its whole archive into the
    // channel.
    const fresh = feed.lastPublished
        ? entries.filter(entry => entry.date > feed.lastPublished)
        : entries.slice(-1);
    if (!fresh.length) return 0;

    const toPost = fresh.slice(-MAX_ITEMS_PER_SWEEP);

    // The cursor is moved to what was actually delivered, never past it. A
    // batch that stops half way must not repost the half that landed on the
    // next sweep, and must not skip the half that did not.
    let delivered = 0;
    let cursor = null;

    try {
        const channel = await fetchSendableChannel(client, feed.channelId);

        // No channel is not a delivery. Advancing the cursor here would drop
        // the whole burst for good on a channel that was only briefly
        // unreachable — `channels.fetch` failing with nothing in the cache
        // looks exactly like a deleted one. Leaving it where it is costs a
        // no-op re-check each sweep while the channel is really gone, which is
        // the cheaper of the two mistakes.
        if (!channel) return 0;

        for (const { item, date } of toPost) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.INFO)
                .setTitle(item.title || 'New Post')
                .setURL(item.link)
                .setDescription(item.contentSnippet?.substring(0, 200) || 'No description available')
                .setTimestamp(date);

            if (parsedFeed.image?.url) {
                embed.setThumbnail(parsedFeed.image.url);
            }

            await channel.send({ embeds: [embed] });
            delivered++;
            cursor = date;
        }

        // The whole batch landed, so the cursor may also skip whatever the
        // per-sweep cap left behind — those are not coming.
        cursor = fresh[fresh.length - 1].date;
    } catch (error) {
        console.error(`Error delivering RSS update for ${feed.url} to guild ${guild.guildId}:`, error);
    }

    if (cursor) {
        try {
            // Targets the one subdocument rather than rewriting the whole
            // rssFeeds array, which is also what `guild.save()` on a
            // projected document could not do.
            await Guild.updateOne(
                { guildId: guild.guildId, 'rssFeeds._id': feed._id },
                { $set: { 'rssFeeds.$.lastPublished': cursor } }
            );
        } catch (error) {
            console.error(`Error advancing the RSS cursor for ${feed.url} in guild ${guild.guildId}:`, error);
        }
    }

    return delivered;
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
        const worker = async () => {
            while (next < urls.length) {
                const url = urls[next++];
                if (shouldSkipDeadFeed(url)) { skipped++; continue; }

                let parsedFeed;
                try {
                    parsedFeed = await parseFeedUrl(url);
                    recordFeedSuccess(url);
                } catch (error) {
                    recordFeedFailure(url, error);
                    failed++;
                    continue;
                }

                const entries = datedItems(parsedFeed);
                if (!entries.length) continue;

                for (const { guild, feed } of subscriptionsByUrl.get(url)) {
                    posted += await deliverFeedUpdate(client, guild, feed, parsedFeed, entries);
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(RSS_FETCH_CONCURRENCY, urls.length) }, worker)
        );

        // One line per sweep, always. "Feeds stopped posting" was previously
        // indistinguishable from "nothing new was published" from the outside,
        // and the per-feed errors say what broke without ever saying how much
        // of the sweep it was.
        console.log(`[RSS] Sweep: ${urls.length} feed(s), ${posted} posted, ${failed} failed, ${skipped} parked.`);
    } catch (error) {
        console.error('Error checking RSS feeds:', error);
    } finally {
        // In `finally` so a sweep that threw halfway still reclaims: the prune
        // is keyed on age alone and needs nothing the sweep produced.
        pruneFeedFailureState();
    }
}

async function sendDailyNewsForProfile(client, guild, profile) {
    const channel = await fetchSendableChannel(client, profile.channelId);
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
            const feedItems = parsedFeed.items
                .map(item => ({
                    title: item.title,
                    link: item.link,
                    normalizedLink: normalizeArticleLink(item.link),
                    description: item.contentSnippet?.substring(0, 150) || 'No description',
                    source: parsedFeed.title || 'Unknown Source',
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
        description += `\n**${i + 1}. [${item.title}](${item.link})**\n`;
        description += `*${item.source}* • ${item.description}\n`;
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
        feedFailCounts, feedLastFailTime, shouldSkipDeadFeed,
        pruneFeedFailureState, DEAD_FEED_STATE_TTL_MS,
        DEAD_FEED_THRESHOLD, DEAD_FEED_COOLDOWN_MS, RSS_FETCH_CONCURRENCY,
        dailyNewsDue, runDueDailyNews, DAILY_NEWS_REFIRE_GUARD_MS,
        datedItems, MAX_ITEMS_PER_SWEEP,
    },
};
