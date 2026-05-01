const User = require('../models/User');
const Guild = require('../models/Guild');
const Warning = require('../models/Warning');
const { handleAIChat } = require('../services/aiService');
const { logModeration } = require('../utils/logger');
const { ensureQuests, onMessage } = require('../services/questService');

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

// Leet-speak normalization map
const LEET_MAP = {
    '4': 'a', '@': 'a', '3': 'e', '€': 'e', '1': 'i', '!': 'i',
    '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '9': 'g',
    '6': 'b', '8': 'b'
};

// messageId -> { userId -> [timestamps] }
const spamTracker = new Map();

// Normalize leet-speak and obfuscation attempts before profanity check
function normalizeToxic(text) {
    let s = text.toLowerCase();
    // Replace leet characters
    for (const [char, replacement] of Object.entries(LEET_MAP)) {
        s = s.split(char).join(replacement);
    }
    // Collapse 3+ repeated characters to one (fuuuuck -> fuck)
    s = s.replace(/(.)\1{2,}/g, '$1');
    // Strip spaces/dots/dashes between individual letters (f u c k, f.u.c.k)
    s = s.replace(/\b(\w)([\s.\-_*]{1,2}(?=\w))+/g, (m) => m.replace(/[\s.\-_*]/g, ''));
    return s;
}

module.exports = {
    name: 'messageCreate',
    async execute(message, client) {
        if (message.author.bot || !message.guild) return;

        try {
            const guildSettings = await Guild.findOne({ guildId: message.guild.id });

            if (!guildSettings) {
                await Guild.create({ guildId: message.guild.id, name: message.guild.name });
                return;
            }

            if (guildSettings?.ai?.enabled) {
                const ai = guildSettings.ai;
                const isDefaultChannel = message.channel.id === ai.channelId;
                const persona = ai.channelPersonas?.find(p => p.channelId === message.channel.id);

                if (isDefaultChannel || persona) {
                    const isBotMentioned = message.mentions.has(client.user.id, { ignoreEveryone: true, ignoreRoles: true });
                    let isReplyToBot = false;
                    if (message.reference?.messageId) {
                        try {
                            const replied = await message.channel.messages.fetch(message.reference.messageId);
                            isReplyToBot = replied.author.id === client.user.id;
                        } catch {}
                    }

                    if (!isBotMentioned && !isReplyToBot) {
                        // Fall through to non-AI handlers (leveling, moderation, etc.)
                    } else {
                        const effectiveSettings = persona
                            ? Object.assign({}, ai.toObject ? ai.toObject() : ai, { systemPrompt: persona.systemPrompt })
                            : ai;
                        if (guildSettings.moderation?.enabled) {
                            const blocked = await handleAutoModeration(message, guildSettings);
                            if (blocked) return;
                        }
                        await handleAIChat(message, effectiveSettings);
                        return;
                    }
                }
            }

            if (guildSettings?.leveling.enabled) {
                await handleLeveling(message, guildSettings);
            }

            if (guildSettings?.moderation.enabled) {
                const blocked = await handleAutoModeration(message, guildSettings);
                if (blocked) return;
            }

            if (guildSettings?.customCommands?.length) {
                await handleCustomCommands(message, guildSettings);
            }

            await handleSuggestions(message, guildSettings);

            if (guildSettings?.bibleVerse?.autoRespond) {
                await handleBibleVerseDetection(message, guildSettings);
            }

            // Streak + quests (only for non-blocked messages)
            await handleStreakAndQuests(message, guildSettings);

        } catch (error) {
            console.error('Error in messageCreate:', error);
        }
    }
};

async function handleStreakAndQuests(message, guildSettings) {
    try {
        let user = await User.findOne({ userId: message.author.id, guildId: message.guild.id });
        if (!user) return;

        const now = new Date();
        const todayUTC = now.toISOString().slice(0, 10);

        // Streak logic
        const lastActive = user.streak?.lastActive;
        if (lastActive) {
            const lastDay = lastActive.toISOString().slice(0, 10);
            if (lastDay !== todayUTC) {
                const msAgo = now - lastActive;
                if (msAgo < 172800000) { // within 48h = streak continues
                    user.streak.current = (user.streak.current || 0) + 1;
                } else {
                    user.streak.current = 1; // broken
                }
                user.streak.longest = Math.max(user.streak.longest || 0, user.streak.current);
                user.streak.lastActive = now;
            }
        } else {
            user.streak = { current: 1, longest: 1, lastActive: now };
        }

        // Daily message counter for raider track
        const lastReset = user.lastDailyReset;
        const resetNeeded = !lastReset || lastReset.toISOString().slice(0, 10) !== todayUTC;
        if (resetNeeded) {
            user.dailyMessages = 0;
            user.lastDailyReset = now;
        }
        user.dailyMessages = (user.dailyMessages || 0) + 1;

        // Quest progress
        await ensureQuests(user, guildSettings);
        const completedQuests = await onMessage(user, guildSettings);

        await user.save();

        // Notify completed quests
        for (const reward of completedQuests) {
            if (!reward) continue;
            await message.channel.send(
                `${message.author} completed a quest! **+${reward.xp} XP, +${reward.coins} coins**`
            ).catch(() => {});
        }
    } catch (err) {
        console.error('Streak/quest error:', err);
    }
}

async function handleLeveling(message, guildSettings) {
    if (!guildSettings?.leveling?.rewardsEnabled) return;
    if (guildSettings.leveling?.noXpChannelIds?.includes(message.channel.id)) return;
    if (message.member?.roles?.cache?.some(role => guildSettings.leveling?.noXpRoleIds?.includes(role.id))) return;

    let user = await User.findOne({ userId: message.author.id, guildId: message.guild.id });

    const now = Date.now();
    if (user && user.lastXpGain && now - user.lastXpGain.getTime() < 60000) return;

    let xpGain = Math.floor(Math.random() * 15 + 10) * guildSettings.leveling.xpRate;

    // Progression track bonuses
    if (guildSettings.progressionTracks?.enabled && user) {
        const bonus = guildSettings.progressionTracks;
        if (user.track === 'creator' && message.attachments.size > 0) {
            xpGain *= 1 + (bonus.creatorBonus || 20) / 100;
        } else if (user.track === 'helper') {
            const helperChannels = bonus.helperChannels || [];
            if (helperChannels.includes(message.channel.id)) {
                xpGain *= 1 + (bonus.helperBonus || 20) / 100;
            }
        } else if (user.track === 'raider') {
            // Bonus on first 10 messages of the day
            if ((user.dailyMessages || 0) <= 10) {
                xpGain *= 1 + (bonus.raiderBonus || 20) / 100;
            }
        }
    }
    xpGain = Math.floor(xpGain);

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

            const rewardChannelId = guildSettings.leveling.rewardChannelId || guildSettings.leveling.announceChannel;
            if (guildSettings.leveling.announceInChannel && !rewardChannelId) {
                await message.reply(levelUpMsg).catch(console.error);
            } else if (rewardChannelId) {
                const ch = message.guild.channels.cache.get(rewardChannelId);
                if (ch) await ch.send(levelUpMsg).catch(console.error);
            }

            if (guildSettings.levelRoles?.length) {
                const reward = guildSettings.levelRoles
                    .filter(lr => lr.level <= user.level)
                    .sort((a, b) => b.level - a.level)[0];
                if (reward) await message.member.roles.add(reward.roleId).catch(console.error);
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

// Offense weights for behavioral scoring
const OFFENSE_WEIGHTS = { spam: 1, invite: 2, link: 1, profanity: 2 };

async function handleSuggestions(message, guildSettings) {
    const s = guildSettings.suggestions;
    if (!s?.enabled || !s.channelId) return;
    if (message.channel.id !== s.channelId) return;
    try {
        await message.react(s.upvoteEmoji || '👍').catch(() => {});
        await message.react(s.downvoteEmoji || '👎').catch(() => {});
    } catch {}
}

async function handleAutoModeration(message, guildSettings) {
    const mod = guildSettings.moderation;
    const isModerator = message.member.permissions.has('ManageMessages')
        || (mod.immunityRoleIds?.length && message.member.roles.cache.some(r => mod.immunityRoleIds.includes(r.id)));

    if (!mod.autoModEnabled) return false;

    if (mod.spamProtection) {
        if (isModerator) return false;
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
            await applyAutoModAction(message, guildSettings, 'spam', OFFENSE_WEIGHTS.spam);
            return true;
        }
    }

    if (mod.inviteFilter && !isModerator && /(discord\.gg\/|discord\.com\/invite\/)/i.test(message.content)) {
        await message.delete().catch(console.error);
        const warn = await message.channel.send(`${message.author}, invite links are not allowed!`);
        setTimeout(() => warn.delete().catch(() => {}), 5000);
        await applyAutoModAction(message, guildSettings, 'posting an invite link', OFFENSE_WEIGHTS.invite);
        return true;
    }

    if (mod.linkFilter && !isModerator && (message.content.includes('http://') || message.content.includes('https://'))) {
        await message.delete().catch(console.error);
        const warn = await message.channel.send(`${message.author}, links are not allowed!`);
        setTimeout(() => warn.delete().catch(() => {}), 5000);
        await applyAutoModAction(message, guildSettings, 'posting a link', OFFENSE_WEIGHTS.link);
        return true;
    }

    if (mod.repeatedTextFilter && !isModerator) {
        const normalized = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.length > 12 && /(.)\1{8,}/.test(normalized)) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, please avoid repeated/spammy text.`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'repeated text spam', OFFENSE_WEIGHTS.spam);
            return true;
        }
    }

    if (mod.excessiveCapsFilter && !isModerator) {
        const letters = (message.content.match(/[a-z]/gi) || []);
        const caps = (message.content.match(/[A-Z]/g) || []);
        const ratio = letters.length ? (caps.length / letters.length) * 100 : 0;
        if (letters.length >= 10 && ratio >= (mod.capsThresholdPercent || 70)) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, please avoid excessive caps.`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'excessive caps', OFFENSE_WEIGHTS.spam);
            return true;
        }
    }

    if (mod.excessiveEmojisFilter && !isModerator) {
        const unicodeEmojiCount = (message.content.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
        const customEmojiCount = (message.content.match(/<a?:\w+:\d+>/g) || []).length;
        if ((unicodeEmojiCount + customEmojiCount) >= (mod.emojiThreshold || 8)) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, too many emojis in one message.`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'excessive emojis', OFFENSE_WEIGHTS.spam);
            return true;
        }
    }

    if (mod.zalgoFilter && !isModerator) {
        const combiningMarks = (message.content.normalize('NFD').match(/[\u0300-\u036f]/g) || []).length;
        if (combiningMarks >= 6) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, zalgo/combining text is not allowed.`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'zalgo text', OFFENSE_WEIGHTS.spam);
            return true;
        }
    }

    if (mod.excessiveMentionsFilter && !isModerator) {
        const mentionCount = message.mentions.users.size + message.mentions.roles.size;
        if (mentionCount >= (mod.mentionThreshold || 5)) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, too many mentions in one message.`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'excessive mentions', OFFENSE_WEIGHTS.spam);
            return true;
        }
    }

    if (mod.profanityFilter && !isModerator) {
        const badWords = [...BASE_BAD_WORDS, ...(mod.customBadWords || [])];
        const normalized = normalizeToxic(message.content);
        const hasBadWord = badWords.some((word) => {
            const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(normalized);
        });

        if (hasBadWord) {
            await message.delete().catch(console.error);
            const warn = await message.channel.send(`${message.author}, please watch your language!`);
            setTimeout(() => warn.delete().catch(() => {}), 5000);
            await applyAutoModAction(message, guildSettings, 'using prohibited language', OFFENSE_WEIGHTS.profanity);
            return true;
        }
    }

    return false;
}

async function applyAutoModAction(message, guildSettings, reason, scoreWeight = 1) {
    const mod = guildSettings.moderation;
    const member = message.member;
    if (!member) return;

    try {
        // Record warning
        await Warning.create({
            guildId: message.guild.id,
            userId: member.id,
            moderatorId: message.client.user.id,
            reason: `[AutoMod] ${reason}`
        });

        const evidence = {
            messageId: message.id,
            jumpUrl: message.url,
            content: message.content.slice(0, 500),
            attachmentUrls: [...message.attachments.values()].map(a => a.url)
        };
        await logModeration(
            message.guild.id, 'warn', message.author, message.client.user,
            `[AutoMod] ${reason}`, { evidence }
        );

        // Behavioral score (with decay)
        let user = await User.findOne({ userId: member.id, guildId: message.guild.id });
        if (!user) {
            user = await User.create({ userId: member.id, guildId: message.guild.id });
        }

        // Apply decay: 50% every N days
        const decayDays = mod.behaviorScoreDecayDays || 7;
        if (user.lastScoreDecay) {
            const daysSince = (Date.now() - user.lastScoreDecay.getTime()) / 86400000;
            if (daysSince >= decayDays) {
                const periods = Math.floor(daysSince / decayDays);
                user.behaviorScore = user.behaviorScore * Math.pow(0.5, periods);
                user.lastScoreDecay = new Date();
            }
        } else {
            user.lastScoreDecay = new Date();
        }

        user.behaviorScore = (user.behaviorScore || 0) + scoreWeight;
        await user.save();

        const score = user.behaviorScore;
        const banAt = mod.behaviorScoreBanAt || 30;
        const kickAt = mod.behaviorScoreKickAt || 20;
        const muteAt = mod.behaviorScoreMuteAt || 10;

        if (banAt > 0 && score >= banAt && member.bannable) {
            await member.ban({ reason: `[AutoMod] Behavior score ${Math.round(score)} reached ban threshold` });
            await logModeration(message.guild.id, 'ban', message.author, message.client.user,
                `[AutoMod] Behavior score ${Math.round(score)} >= ${banAt}`);
        } else if (kickAt > 0 && score >= kickAt && member.kickable) {
            await member.kick(`[AutoMod] Behavior score ${Math.round(score)} reached kick threshold`);
            await logModeration(message.guild.id, 'kick', message.author, message.client.user,
                `[AutoMod] Behavior score ${Math.round(score)} >= ${kickAt}`);
        } else if (muteAt > 0 && score >= muteAt && member.moderatable) {
            await member.timeout(10 * 60 * 1000, `[AutoMod] Behavior score ${Math.round(score)} reached mute threshold`);
            await logModeration(message.guild.id, 'mute', message.author, message.client.user,
                `[AutoMod] Behavior score ${Math.round(score)} >= ${muteAt}`, { duration: 10 });
            // Notify user with appeal info if enabled
            if (mod.appealsEnabled) {
                const latestCase = await require('../models/Case').findOne(
                    { guildId: message.guild.id, targetUserId: member.id },
                    {}, { sort: { createdAt: -1 } }
                );
                if (latestCase) {
                    await message.author.send(
                        `You have been auto-muted in **${message.guild.name}**.\n` +
                        `Reason: ${reason}\n\n` +
                        `To appeal, use \`/appeal\` in ${message.guild.name} with Case ID **#${latestCase.caseId}**.`
                    ).catch(() => {});
                }
            }
        } else {
            const warnCount = await Warning.countDocuments({ guildId: message.guild.id, userId: member.id });
            const kickThreshold = mod.kickThreshold || 0;
            const banThreshold = mod.banThreshold || 0;

            if (banThreshold > 0 && warnCount >= banThreshold && member.bannable) {
                await member.ban({ reason: `[AutoMod] Warning count ${warnCount} reached ban threshold (${banThreshold})` });
                await logModeration(message.guild.id, 'ban', message.author, message.client.user,
                    `[AutoMod] Warning count ${warnCount} >= ban threshold ${banThreshold}`);
            } else if (kickThreshold > 0 && warnCount >= kickThreshold && member.kickable) {
                await member.kick(`[AutoMod] Warning count ${warnCount} reached kick threshold (${kickThreshold})`);
                await logModeration(message.guild.id, 'kick', message.author, message.client.user,
                    `[AutoMod] Warning count ${warnCount} >= kick threshold ${kickThreshold}`);
            } else if (warnCount >= (mod.warnThreshold || 3)) {
                await message.author.send(
                    `You have received **${warnCount}** warnings in **${message.guild.name}**. ` +
                    `Further violations may result in a mute or kick.`
                ).catch(() => {});
            }
        }
    } catch (err) {
        console.error('AutoMod action error:', err);
    }
}

async function handleBibleVerseDetection(message, guildSettings) {
    const { detectVerseReferences, lookupVerse, createVerseEmbed } = require('../services/bibleService');
    const refs = detectVerseReferences(message.content);
    if (!refs.length) return;

    const translation = guildSettings.bibleVerse?.translation || 'kjv';
    const verseData = await lookupVerse(refs[0], translation);
    if (!verseData?.text) return;

    await message.reply({ embeds: [createVerseEmbed(verseData)] }).catch(() => {});
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
