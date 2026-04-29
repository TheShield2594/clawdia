const Parser = require('rss-parser');
const Guild = require('../models/Guild');
const { EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const parser = new Parser();
let dailyNewsJobs = new Map();

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
                        const channel = client.channels.cache.get(feed.channelId);
                        
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

async function sendDailyNews(client, guildId) {
    try {
        const guild = await Guild.findOne({ guildId });
        
        if (!guild || !guild.dailyNews.enabled || !guild.dailyNews.feeds.length) {
            return;
        }

        const channel = client.channels.cache.get(guild.dailyNews.channelId);
        if (!channel) {
            console.error(`Daily news channel not found for guild ${guildId}`);
            return;
        }

        const allItems = [];

        for (const feedUrl of guild.dailyNews.feeds) {
            try {
                const parsedFeed = await parser.parseURL(feedUrl);
                const feedItems = parsedFeed.items
                    .slice(0, guild.dailyNews.maxItemsPerFeed)
                    .map(item => ({
                        title: item.title,
                        link: item.link,
                        description: item.contentSnippet?.substring(0, 150) || 'No description',
                        source: parsedFeed.title || 'Unknown Source',
                        date: new Date(item.pubDate || item.isoDate)
                    }));
                
                allItems.push(...feedItems);
            } catch (error) {
                console.error(`Error parsing daily news feed ${feedUrl}:`, error);
            }
        }

        if (allItems.length === 0) {
            await channel.send('No news articles found today.');
            return;
        }

        allItems.sort((a, b) => b.date - a.date);

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(guild.dailyNews.title)
            .setDescription('Here are today\'s top stories from your selected sources:')
            .setTimestamp();

        let description = '';
        for (let i = 0; i < Math.min(allItems.length, 10); i++) {
            const item = allItems[i];
            description += `\n**${i + 1}. [${item.title}](${item.link})**\n`;
            description += `*${item.source}* • ${item.description}\n`;
        }

        if (description.length > 4000) {
            description = description.substring(0, 3997) + '...';
        }

        embed.setDescription(description);
        embed.setFooter({ text: `${allItems.length} articles from ${guild.dailyNews.feeds.length} sources` });

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Error sending daily news:', error);
    }
}

function scheduleDailyNews(client) {
    Guild.find({ 'dailyNews.enabled': true }).then(guilds => {
        for (const guild of guilds) {
            const [hour, minute] = guild.dailyNews.time.split(':').map(Number);
            const cronExpression = `${minute} ${hour} * * *`;
            
            if (dailyNewsJobs.has(guild.guildId)) {
                dailyNewsJobs.get(guild.guildId).stop();
            }
            
            const job = cron.schedule(cronExpression, () => {
                sendDailyNews(client, guild.guildId);
            });
            
            dailyNewsJobs.set(guild.guildId, job);
            console.log(`Scheduled daily news for guild ${guild.guildId} at ${guild.dailyNews.time}`);
        }
    }).catch(error => {
        console.error('Error scheduling daily news:', error);
    });
}

function rescheduleDailyNews(client, guildId) {
    Guild.findOne({ guildId }).then(guild => {
        if (!guild || !guild.dailyNews.enabled) {
            if (dailyNewsJobs.has(guildId)) {
                dailyNewsJobs.get(guildId).stop();
                dailyNewsJobs.delete(guildId);
            }
            return;
        }

        const [hour, minute] = guild.dailyNews.time.split(':').map(Number);
        const cronExpression = `${minute} ${hour} * * *`;
        
        if (dailyNewsJobs.has(guildId)) {
            dailyNewsJobs.get(guildId).stop();
        }
        
        const job = cron.schedule(cronExpression, () => {
            sendDailyNews(client, guildId);
        });
        
        dailyNewsJobs.set(guildId, job);
        console.log(`Rescheduled daily news for guild ${guildId} at ${guild.dailyNews.time}`);
    }).catch(error => {
        console.error('Error rescheduling daily news:', error);
    });
}

module.exports = { checkRssFeeds, scheduleDailyNews, rescheduleDailyNews, sendDailyNews };