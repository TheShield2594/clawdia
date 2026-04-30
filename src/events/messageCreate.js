const User = require('../models/User');
const Guild = require('../models/Guild');
const Warning = require('../models/Warning');
const { handleAIChat } = require('../services/aiService');
const { logModeration } = require('../utils/logger');

const BASE_BAD_WORDS = [
    'nigger', 'nigga', 'faggot', 'fag', 'retard', 'chink', 'spic', 'kike',
    'cunt', 'whore', 'slut', 'bitch', 'bastard', 'asshole', 'dick', 'cock',
    'pussy', 'fuck', 'shit', 'piss', 'crap', 'damn', 'hell', 'ass',
    'motherfucker', 'motherfucking', 'fucker', 'fucking', 'bullshit',
    'twat', 'wanker', 'prick', 'arsehole', 'bollocks', 'shithead',
    'jackass', 'dumbass', 'smartass', 'dipshit', 'douchebag',
    'tranny', 'dyke', 'wetback', 'beaner', 'cracker', 'gook', 'towelhead',
    'raghead', 'sandnigger', 'zipperhead', 'nig', 'coon', 'jigaboo',
    'spook', 'porch monkey', 'jungle bunny', 'tar baby'
];

// messageId -> { userId -> [timestamps] }
const spamTracker = new Map();

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

            if (guildSettings?.ai?.enabled) {
                const ai = guildSettings.ai;
                const isDefaultChannel = message.channel.id === ai.channelId;
                const persona = ai.channelPersonas?.find(p => p.channelId === message.channel.id);

                if (isDefaultChannel || persona) {
                    // Merge persona system prompt over the guild default when present
                    const effectiveSettings = persona
                        ? Object.assign({}, ai.toObject ? ai.toObject() : ai, { systemPrompt: persona.systemPrompt })
                        : ai;
                    await handleAIChat(message, effectiveSettings);
                    return;
                }
            }

            if (guildSettings?.leveling.enabled) {
                await handleLeveling(message, guildSettings);
            }

            if (guildSettings?.moderation.enabled) {
                await handleAutoModeration(message, guildSettings);
            }

            if (guildSettings?.customCommands?.length) {
                await handleCustomCommands(message, guildSettings);
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
                const ch = message.guild.channels.cache.get(guildSettings.leveling.announceChannel);
                if (ch) await ch.send(levelUpMsg).catch(console.error);
            }

            if (guildSettings.levelRoles?.length) {
                const reward = guildSettings.levelRoles
                    .filter(lr => lr.level <= user.level)
                    .sort((a, b) => b.level - a.level)[0];

                if (reward) {
                    await message.member.roles.add(reward.roleId).catch(console.error);
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
    const mod = guildSettings.moderation;
    const isModerator = message.member.permissions.has('ManageMessages');

    if (!mod.autoModEnabled) return;

    if (mod.spamProtection) {
        const guildId = message.guild.id;
        const userId = message.author.id;
        const now = Date.now();
        const windowMs = (mod.spamWindow || 5) * 1000;
        const threshold = mod.spamThreshold || 5;

        if (!spamTracker.has(guildId)) spamTracker.set(guildId, new Map());
        const guildMap = spamTracker.get(guildId);
        if (!guildMap.has(userId)) guildMap.set(userId, []);

        const timestamps = guildMap.get(userId).filter(t => now - t < windowMs);
        timestamps.push(now);
        guildMap.set(userId, timestamps);

        if (timestamps.length >= threshold) {
            guildMap.set(userId, []);
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, slow down! You're sending messages too fast.`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'spam');
            return;
        }
    }

    if (mod.inviteFilter && !isModerator && /(discord\.gg\/|discord\.com\/invite\/)/i.test(content)) {
        await message.delete().catch(console.error);
        const warn = await message.channel.send(`${message.author}, invite links are not allowed!`);
        setTimeout(() => warn.delete().catch(() => {}), 5000);
        await applyAutoModAction(message, guildSettings, 'posting an invite link');
        return;
    }

    if (mod.linkFilter && (content.includes('http://') || content.includes('https://'))) {
        if (!isModerator) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, links are not allowed!`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'posting a link');
            return;
        }
    }

    if (mod.profanityFilter && !isModerator) {
        const badWords = [...BASE_BAD_WORDS, ...(mod.customBadWords || [])];
        const hasBadWord = badWords.some((word) => {
            const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(content);
        });

        if (hasBadWord) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, please watch your language!`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'using prohibited language');
        }
    }
}

async function applyAutoModAction(message, guildSettings, reason) {
    const mod = guildSettings.moderation;
    const member = message.member;
    if (!member) return;

    try {
        await Warning.create({
            guildId: message.guild.id,
            userId: member.id,
            moderatorId: message.client.user.id,
            reason: `[AutoMod] ${reason}`
        });

        const warnCount = await Warning.countDocuments({
            guildId: message.guild.id,
            userId: member.id
        });

        await logModeration(message.guild.id, 'warn', message.author, message.client.user, `[AutoMod] ${reason}`);

        const banThreshold = mod.banThreshold || 0;
        const kickThreshold = mod.kickThreshold || 5;
        const warnThreshold = mod.warnThreshold || 3;

        if (banThreshold > 0 && warnCount >= banThreshold && member.bannable) {
            await member.ban({ reason: `[AutoMod] Reached ${banThreshold} warnings` });
            await logModeration(message.guild.id, 'ban', message.author, message.client.user, `[AutoMod] Reached ${banThreshold} warnings`);
        } else if (warnCount >= kickThreshold && member.kickable) {
            await member.kick(`[AutoMod] Reached ${kickThreshold} warnings`);
            await logModeration(message.guild.id, 'kick', message.author, message.client.user, `[AutoMod] Reached ${kickThreshold} warnings`);
        } else if (warnCount >= warnThreshold) {
            try {
                await message.author.send(`You have received ${warnCount} warnings in **${message.guild.name}**. Further violations may result in a kick.`);
            } catch { /* DMs closed */ }
        }
    } catch (err) {
        console.error('AutoMod action error:', err);
    }
}

async function handleCustomCommands(message, guildSettings) {
    const content = message.content.trim().toLowerCase();
    const prefix = guildSettings.prefix || '!';

    if (!content.startsWith(prefix) && !content.startsWith('/')) return;

    const commandName = content.startsWith(prefix)
        ? content.slice(prefix.length).split(/\s+/)[0]
        : content.slice(1).split(/\s+/)[0];

    const cmd = guildSettings.customCommands.find(c => c.name === commandName);
    if (!cmd) return;

    const response = cmd.response
        .replace(/{user}/g, `<@${message.author.id}>`)
        .replace(/{server}/g, message.guild.name)
        .replace(/{memberCount}/g, message.guild.memberCount);

    await message.reply(response).catch(console.error);
}
