const Parser = require('rss-parser');
const Guild = require('../models/Guild');
const { EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const parser = new Parser();
let dailyNewsJobs = new Map();
const runtimeTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
        maxItemsPerFeed: legacy.maxItemsPerFeed || 3
    };
}

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
    let channel = null;

    try {
        channel = await client.channels.fetch(channelId);
    } catch {
        channel = client.channels.cache.get(channelId) || null;
    }

    if (!channel || typeof channel.send !== 'function') return null;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return null;

    return channel;
}
async function checkRssFeeds(client) {
    try {
        const guilds = await Guild.find({ 'rssFeeds.0': { $exists: true } });

        for (const guild of guilds) {
            for (const feed of guild.rssFeeds) {
                try {
                    const parsedFeed = await parser.parseURL(feed.url);
                    
                    if (parsedFeed.items.length === 0) continue;

                    const latestItem = parsedFeed.items[0];
                    const itemDate = new Date(latestItem.pubDate || latestItem.isoDate);

                    if (!feed.lastPublished || itemDate > feed.lastPublished) {
                        const channel = await fetchSendableChannel(client, feed.channelId);
                        
                        if (channel) {
                            const embed = new EmbedBuilder()
                                .setColor('#00ff00')
                                .setTitle(latestItem.title || 'New Post')
                                .setURL(latestItem.link)
                                .setDescription(latestItem.contentSnippet?.substring(0, 200) || 'No description available')
                                .setTimestamp(itemDate);

                            if (parsedFeed.image?.url) {
                                embed.setThumbnail(parsedFeed.image.url);
                            }

                            await channel.send({ embeds: [embed] });
                        }

                        feed.lastPublished = itemDate;
                        await guild.save();
                    }
                } catch (error) {
                    console.error(`Error parsing RSS feed ${feed.url}:`, error);
                }
            }
        }
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
        try {
            const parsedFeed = await parser.parseURL(feedUrl);
            const feedItems = parsedFeed.items
                .map(item => ({
                    title: item.title,
                    link: item.link,
                    normalizedLink: normalizeArticleLink(item.link),
                    description: item.contentSnippet?.substring(0, 150) || 'No description',
                    source: parsedFeed.title || 'Unknown Source',
                    date: new Date(item.pubDate || item.isoDate)
                }))
                .filter(item => !Number.isNaN(item.date.getTime()) && item.date.getTime() >= cutoffMs)
                .sort((a, b) => b.date.getTime() - a.date.getTime())
                .slice(0, profile.maxItemsPerFeed || 3);

            allItems.push(...feedItems);
        } catch (error) {
            console.error(`Error parsing daily news feed ${feedUrl}:`, error);
        }
    }

    const uniqueItems = [];
    const seenLinks = new Set();
    for (const item of allItems) {
        if (item.normalizedLink && seenLinks.has(item.normalizedLink)) continue;
        seenLinks.add(item.normalizedLink);
        uniqueItems.push(item);
    }

    if (uniqueItems.length === 0) {
        await channel.send(`No news articles found in the last 24 hours for **${profile.title}**.`);
        return;
    }

    uniqueItems.sort((a, b) => b.date - a.date);

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
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
}

async function sendDailyNews(client, guildId, profileId = null) {
    try {
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
    } catch (error) {
        console.error('Error sending daily news:', error);
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
        const job = cron.schedule(cronExpression, () => {
            sendDailyNews(client, guildId, profile.profileId);
        }, profile.timezone ? { timezone: profile.timezone } : undefined);

        dailyNewsJobs.set(jobKey, job);
        console.log(`Scheduled daily news for guild ${guildId}, profile ${profile.profileId} at ${safeTime}${profile.timezone ? ` (${profile.timezone})` : ''}`);
    } catch (error) {
        console.error(`Failed to schedule daily news for guild ${guildId}, profile ${profile.profileId}:`, error.message);
    }
}

function scheduleDailyNews(client) {
    Guild.find({}).then(guilds => {
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

    Guild.findOne({ guildId }).then(guild => {
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

module.exports = { checkRssFeeds, scheduleDailyNews, rescheduleDailyNews, sendDailyNews };
