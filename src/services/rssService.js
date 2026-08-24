const Parser = require('rss-parser');
const Guild = require('../models/Guild');
const { EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const { safeFetchFeed } = require('../utils/safeFeedFetch');
const { runJob } = require('../utils/jobRunner');
const COLORS = require('../utils/embedColors');

const parser = new Parser();

// Feed URLs are operator-supplied, so every poll is an outbound request to a
// destination a guild admin chose. Route them through the SSRF-safe fetcher
// (private/reserved IPs blocked, DNS pinned against rebinding, redirects and
// body size bounded) rather than rss-parser's own parseURL, which would happily
// fetch the cloud metadata endpoint or the internal MongoDB host and relay the
// response into a Discord channel.
async function parseFeedUrl(url) {
    return parser.parseString(await safeFetchFeed(url));
}
const dailyNewsJobs = new Map();
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
/**
 * Delivers a freshly-parsed feed to one guild's subscription: sends the embed
 * if the latest item is new for that guild, and advances its lastPublished
 * cursor. Per-subscription failures are contained here so one guild's deleted
 * channel does not stop the fan-out to the others.
 */
async function deliverFeedUpdate(client, guild, feed, parsedFeed, latestItem, itemDate) {
    try {
        // Not `itemDate <= lastPublished`: an unparseable pubDate gives an
        // invalid Date, which compares false both ways, and it must skip (as
        // it always has) rather than post with a timestamp that cannot render.
        if (feed.lastPublished && !(itemDate > feed.lastPublished)) return;

        const channel = await fetchSendableChannel(client, feed.channelId);

        if (channel) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.INFO)
                .setTitle(latestItem.title || 'New Post')
                .setURL(latestItem.link)
                .setDescription(latestItem.contentSnippet?.substring(0, 200) || 'No description available')
                .setTimestamp(itemDate);

            if (parsedFeed.image?.url) {
                embed.setThumbnail(parsedFeed.image.url);
            }

            await channel.send({ embeds: [embed] });
        }

        // Targets the one subdocument rather than rewriting the whole
        // rssFeeds array, which is also what `guild.save()` on a
        // projected document could not do.
        await Guild.updateOne(
            { guildId: guild.guildId, 'rssFeeds._id': feed._id },
            { $set: { 'rssFeeds.$.lastPublished': itemDate } }
        );
    } catch (error) {
        console.error(`Error delivering RSS update for ${feed.url} to guild ${guild.guildId}:`, error);
    }
}

// Overlap protection lives in the scheduler: this runs through runJob, which
// drops a tick while the previous sweep is still in flight.
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
        const worker = async () => {
            while (next < urls.length) {
                const url = urls[next++];
                if (shouldSkipDeadFeed(url)) continue;

                let parsedFeed;
                try {
                    parsedFeed = await parseFeedUrl(url);
                    recordFeedSuccess(url);
                } catch (error) {
                    recordFeedFailure(url, error);
                    continue;
                }

                if (parsedFeed.items.length === 0) continue;

                const latestItem = parsedFeed.items[0];
                const itemDate = new Date(latestItem.pubDate || latestItem.isoDate);

                for (const { guild, feed } of subscriptionsByUrl.get(url)) {
                    await deliverFeedUpdate(client, guild, feed, parsedFeed, latestItem, itemDate);
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(RSS_FETCH_CONCURRENCY, urls.length) }, worker)
        );
    } catch (error) {
        console.error('Error checking RSS feeds:', error);
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

    for (const feedUrl of profile.feeds) {
        if (shouldSkipDeadFeed(feedUrl)) continue;

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

    if (uniqueItems.length === 0) return;

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
 * Failures propagate: both callers need them. The scheduled run goes through
 * runJob, which records the failure and files a dead-letter entry, and the
 * dashboard's "send now" button answers 500 instead of reporting success for a
 * digest that never went out.
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

function scheduleProfileJob(client, guildId, profile) {
    const safeTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(profile.time || '') ? profile.time : '09:00';
    const [hour, minute] = safeTime.split(':').map(Number);
    const cronExpression = `${minute} ${hour} * * *`;
    const jobKey = `${guildId}:${profile.profileId}`;

    if (dailyNewsJobs.has(jobKey)) {
        dailyNewsJobs.get(jobKey).stop();
    }

    try {
        const job = cron.schedule(cronExpression, () =>
            runJob('rssService', 'sendDailyNews', () => sendDailyNews(client, guildId, profile.profileId), {
                guildId,
                payload: { profileId: profile.profileId },
            }),
        profile.timezone ? { timezone: profile.timezone } : undefined);

        dailyNewsJobs.set(jobKey, job);
        console.log(`Scheduled daily news for guild ${guildId}, profile ${profile.profileId} at ${safeTime}${profile.timezone ? ` (${profile.timezone})` : ''}`);
    } catch (error) {
        console.error(`Failed to schedule daily news for guild ${guildId}, profile ${profile.profileId}:`, error.message);
    }
}

function scheduleDailyNews(client) {
    Guild.find({}, DAILY_NEWS_FIELDS).lean().then(guilds => {
        for (const guild of guilds) {
            const profiles = getDailyNewsProfiles(guild)
                .filter(profile => profile.enabled && Array.isArray(profile.feeds) && profile.feeds.length > 0);
            for (const profile of profiles) {
                scheduleProfileJob(client, guild.guildId, profile);
            }
        }
    }).catch(error => {
        console.error('Error scheduling daily news:', error);
    });
}

function rescheduleDailyNews(client, guildId) {
    for (const [key, job] of dailyNewsJobs.entries()) {
        if (key.startsWith(`${guildId}:`)) {
            job.stop();
            dailyNewsJobs.delete(key);
        }
    }

    // Same three fields the startup sweep reads. Without the projection this
    // pulled the guild's shop-item and activity-item image Buffers into memory
    // on every dashboard save that touched a daily-news setting.
    Guild.findOne({ guildId }, DAILY_NEWS_FIELDS).lean().then(guild => {
        if (!guild) return;

        const profiles = getDailyNewsProfiles(guild)
            .filter(profile => profile.enabled && Array.isArray(profile.feeds) && profile.feeds.length > 0);

        for (const profile of profiles) {
            scheduleProfileJob(client, guildId, profile);
        }
    }).catch(error => {
        console.error('Error rescheduling daily news:', error);
    });
}

module.exports = {
    checkRssFeeds, scheduleDailyNews, rescheduleDailyNews, sendDailyNews,
    __test__: {
        feedFailCounts, feedLastFailTime, shouldSkipDeadFeed,
        DEAD_FEED_THRESHOLD, DEAD_FEED_COOLDOWN_MS, RSS_FETCH_CONCURRENCY,
    },
};
