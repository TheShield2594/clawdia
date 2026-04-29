const User = require('../models/User');
const Guild = require('../models/Guild');
const { handleAIChat } = require('../services/aiService');

module.exports = {
    name: 'messageCreate',
    async execute(message, client) {
        if (message.author.bot || !message.guild) return;

        try {
            const guildSettings = await Guild.findOne({ guildId: message.guild.id });
            
            if (!guildSettings) {
                await Guild.create({
                    guildId: message.guild.id,
                    name: message.guild.name
                });
            }

            if (guildSettings?.ai.enabled && message.channel.id === guildSettings.ai.channelId) {
                const provider = guildSettings.ai.provider || 'openai';
                const apiKey = provider === 'openai' ? guildSettings.ai.openaiKey : guildSettings.ai.geminiKey;
                await handleAIChat(message, guildSettings.ai.systemPrompt, provider, apiKey);
                return;
            }

            if (guildSettings?.leveling.enabled) {
                await handleLeveling(message, guildSettings);
            }

            if (guildSettings?.moderation.enabled) {
                await handleAutoModeration(message, guildSettings);
            }
        } catch (error) {
            console.error('Error in messageCreate:', error);
        }
    }
};

async function handleLeveling(message, guildSettings) {
    const user = await User.findOne({ userId: message.author.id, guildId: message.guild.id });
    
    const now = Date.now();
    if (user && user.lastXpGain && now - user.lastXpGain.getTime() < 60000) {
        return;
    }

    const xpGain = Math.floor(Math.random() * 15 + 10) * guildSettings.leveling.xpRate;
    
    if (user) {
        user.xp += xpGain;
        user.messages += 1;
        user.lastXpGain = new Date();
        
        const requiredXp = user.level * 100 + 100;
        
        if (user.xp >= requiredXp) {
            user.level += 1;
            user.xp = 0;
            
            const levelUpMsg = guildSettings.leveling.levelUpMessage
                .replace(/{user}/g, `<@${message.author.id}>`)
                .replace(/{level}/g, user.level);
            
            if (guildSettings.leveling.announceInChannel) {
                await message.reply(levelUpMsg).catch(console.error);
            } else if (guildSettings.leveling.announceChannel) {
                const channel = message.guild.channels.cache.get(guildSettings.leveling.announceChannel);
                if (channel) {
                    await channel.send(levelUpMsg).catch(console.error);
                }
            }
        }
        
        await user.save();
    } else {
        await User.create({
            userId: message.author.id,
            guildId: message.guild.id,
            xp: xpGain,
            messages: 1,
            lastXpGain: new Date()
        });
    }
}

async function handleAutoModeration(message, guildSettings) {
    const content = message.content.toLowerCase();
    
    if (guildSettings.moderation.inviteFilter && content.includes('discord.gg/')) {
        await message.delete().catch(console.error);
        await message.channel.send(`${message.author}, invite links are not allowed!`).then(msg => {
            setTimeout(() => msg.delete(), 5000);
        });
        return;
    }
    
    if (guildSettings.moderation.linkFilter && (content.includes('http://') || content.includes('https://'))) {
        const hasPermission = message.member.permissions.has('ManageMessages');
        if (!hasPermission) {
            await message.delete().catch(console.error);
            await message.channel.send(`${message.author}, links are not allowed!`).then(msg => {
                setTimeout(() => msg.delete(), 5000);
            });
            return;
        }
    }
    
    if (guildSettings.moderation.profanityFilter) {
        const badWords = ['badword1', 'badword2'];
        const hasBadWord = badWords.some(word => content.includes(word));
        
        if (hasBadWord) {
            await message.delete().catch(console.error);
            await message.channel.send(`${message.author}, please watch your language!`).then(msg => {
                setTimeout(() => msg.delete(), 5000);
            });
        }
    }
}