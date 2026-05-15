const User = require('../models/User');
const Guild = require('../models/Guild');
const Case = require('../models/Case');
const Reminder = require('../models/Reminder');
const { handleAIChat } = require('../services/aiService');
const { runAgent } = require('../services/agentService');
const { logModeration } = require('../utils/logger');
const { ensureQuests, onMessage, notifyQuestComplete, notifyQuestNearComplete, notifyDailyQuestReset } = require('../services/questService');
const { getStreakMultiplier, checkNewMilestones } = require('../utils/streakMultiplier');
const { hasEffect, consumeEffect, getXpMultiplier, getServerXpMultiplier } = require('../services/effectsService');
const { checkRivalry } = require('../services/rivalryService');
const { checkAndAward, announceAchievements } = require('../services/achievementService');
const BASE_BAD_WORDS = require('../data/profanityList');

// Pre-compile base word regexes once at module load — avoids per-message regex construction
const BASE_BAD_WORD_REGEXES = BASE_BAD_WORDS.map(word => {
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
});

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
                        // Strip bot mention tokens so NL reminder detection works on the real content
                        const strippedContent = message.content
                            .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
                            .trim();
                        const reminderHandled = await handleNLReminder(message, strippedContent);
                        if (!reminderHandled) {
                            await handleAIChat(message, effectiveSettings);
                        }
                        return;
                    }
                }
            }

            // Agent channel — only the server owner's messages are handled; others fall through normally
            const agentChannel = guildSettings?.integrations?.agentChannels?.find(
                ch => ch.channelId === message.channel.id
            );
            if (agentChannel && message.guild.ownerId === message.author.id) {
                await handleAgentChannel(message, guildSettings, agentChannel);
                return;
            }

            let sharedUser = null;
            if (guildSettings?.leveling.enabled) {
                sharedUser = await handleLeveling(message, guildSettings);
            }

            if (guildSettings?.moderation.enabled) {
                const blocked = await handleAutoModeration(message, guildSettings);
                if (blocked) return;
            }

            await handleSuggestions(message, guildSettings);

            if (guildSettings?.bibleVerse?.autoRespond) {
                await handleBibleVerseDetection(message, guildSettings);
            }

            // Natural language reminders — available to everyone, any channel
            await handleNLReminder(message);

            // Streak + quests (only for non-blocked messages)
            // Reuse user fetched by handleLeveling when available — avoids a second DB round-trip
            await handleStreakAndQuests(message, guildSettings, sharedUser);

        } catch (error) {
            console.error('Error in messageCreate:', error);
        }
    }
};

async function handleStreakAndQuests(message, guildSettings, existingUser = null) {
    try {
        let user = existingUser ?? await User.findOne({ userId: message.author.id, guildId: message.guild.id });
        if (!user) return;

        const now = new Date();
        const todayUTC = now.toISOString().slice(0, 10);

        // Streak logic
        const lastActive = user.streak?.lastActive;
        let shieldActivated = false;
        if (lastActive) {
            const lastDay = lastActive.toISOString().slice(0, 10);
            if (lastDay !== todayUTC) {
                const msAgo = now - lastActive;
                if (msAgo < 172800000) { // within 48h = streak continues
                    user.streak.current = (user.streak.current || 0) + 1;
                } else if (msAgo <= 259200000 && hasEffect(user, 'streak_shield')) { // 48–72h: one missed day, shield applies
                    consumeEffect(user, 'streak_shield');
                    user.streak.current = (user.streak.current || 0) + 1;
                    shieldActivated = true;
                } else {
                    user.streak.current = 1; // broken
                }
                user.streak.longest = Math.max(user.streak.longest || 0, user.streak.current);
                user.streak.lastActive = now;
            }
        } else {
            user.streak = { current: 1, longest: 1, lastActive: now, claimedMilestones: [] };
        }

        // Milestone rewards
        const newMilestones = checkNewMilestones(user);
        for (const milestone of newMilestones) {
            user.balance += milestone.coins;
            if (!user.streak.claimedMilestones) user.streak.claimedMilestones = [];
            user.streak.claimedMilestones.push(milestone.days);
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
        const { assignedNewDaily } = await ensureQuests(user, guildSettings);
        const { completed: completedQuests, nearComplete: nearCompleteQuests } = await onMessage(user, guildSettings);

        const newlyEarned = await checkAndAward(user, guildSettings).catch(() => []);

        await user.save();

        if (newlyEarned.length) {
            announceAchievements(message.client, guildSettings, user, message.member, newlyEarned).catch(() => null);
        }

        await notifyQuestComplete(guildSettings, message.member, completedQuests, message.channel);
        await notifyQuestNearComplete(guildSettings, message.member, nearCompleteQuests, message.channel);
        if (assignedNewDaily) {
            await notifyDailyQuestReset(guildSettings, message.member, user, message.channel);
        }

        if (shieldActivated) {
            await message.channel.send(
                `🔥🛡️ <@${message.author.id}> Your **Streak Shield** protected your streak! (consumed)`
            ).catch(() => {});
        }

        for (const milestone of newMilestones) {
            const multiplier = getStreakMultiplier(user.streak.current);
            await message.channel.send(
                `🔥 <@${message.author.id}> **${milestone.days}-day streak milestone!** ` +
                `You earned **${milestone.coins.toLocaleString()} coins** and the **${milestone.badge}** badge! ` +
                `You're now earning **${multiplier}x** coins and XP.`
            ).catch(() => {});
        }
    } catch (err) {
        console.error('Streak/quest error:', err);
    }
}

async function handleLeveling(message, guildSettings) {
    if (!guildSettings?.leveling?.rewardsEnabled) return null;
    if (guildSettings.leveling?.noXpChannelIds?.includes(message.channel.id)) return null;
    if (message.member?.roles?.cache?.some(role => guildSettings.leveling?.noXpRoleIds?.includes(role.id))) return null;

    let user = await User.findOne({ userId: message.author.id, guildId: message.guild.id });

    const now = Date.now();
    // Return the user even when XP is on cooldown so handleStreakAndQuests can reuse it
    if (user && user.lastXpGain && now - user.lastXpGain.getTime() < 60000) return user;

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

    // Streak multiplier — anticipate today's streak increment so the multiplier
    // reflects the updated streak even though handleStreakAndQuests runs after this.
    if (user) {
        const lastActive = user.streak?.lastActive;
        const todayUTC = new Date().toISOString().slice(0, 10);
        let effectiveStreak = user.streak?.current ?? 0;
        if (lastActive && lastActive.toISOString().slice(0, 10) !== todayUTC) {
            const msAgo = Date.now() - lastActive.getTime();
            effectiveStreak = msAgo < 172800000 ? effectiveStreak + 1 : 1;
        }
        xpGain *= getStreakMultiplier(effectiveStreak);
        xpGain *= getXpMultiplier(user);
    }
    xpGain *= getServerXpMultiplier(guildSettings);
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
        checkRivalry(message.client, message.guild, user).catch(() => {});
        return user;
    } else {
        const newUser = await User.create({
            userId: message.author.id,
            guildId: message.guild.id,
            xp: xpGain,
            messages: 1,
            lastXpGain: new Date()
        });
        return newUser;
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

    if (mod.spamProtection && !isModerator) {
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
        const normalized = normalizeToxic(message.content);
        const customRegexes = (mod.customBadWords || []).map(word => {
            const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i');
        });
        const hasBadWord = [...BASE_BAD_WORD_REGEXES, ...customRegexes].some(re => re.test(normalized));

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
            const warnCount = await Case.countDocuments({ guildId: message.guild.id, targetUserId: member.id, type: 'warn' });
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
    // NIV is not available for on-demand lookup; fall back to KJV so auto-respond still works
    const effectiveTranslation = translation === 'niv' ? 'kjv' : translation;
    const verseData = await lookupVerse(refs[0], effectiveTranslation);
    if (!verseData?.text) return;

    await message.reply({ embeds: [createVerseEmbed(verseData)] }).catch(() => {});
}

// ------------------------------------------------------------------
// Agent channel handler
// ------------------------------------------------------------------
// Strip leading bot mention tokens so they don't waste agent context
function cleanAgentMessage(content, botId) {
    return content
        .replace(new RegExp(`^\\s*<@!?${botId}>\\s*:?\\s*`, ''), '')
        .trim();
}

async function handleAgentChannel(message, guildSettings, agentChannel) {
    await message.channel.sendTyping().catch(() => {});

    const userMessage = cleanAgentMessage(message.content, message.client.user.id);

    try {
        const reply = await runAgent({
            guildId: message.guild.id,
            guildSettings,
            userMessage,
            channelFocus: agentChannel.focus || '',
            enabledApps: agentChannel.enabledApps || [],
            userName: message.member?.displayName || message.author.username
        });
        await message.reply({ content: reply, allowedMentions: { parse: [] } })
            .catch(() => message.channel.send({ content: reply, allowedMentions: { parse: [] } }));
    } catch (err) {
        console.error('[AgentChannel] Error:', err.message);
        await message.reply({ content: '⚠️ Something went wrong running the agent. Check your API keys and try again.', allowedMentions: { parse: [] } }).catch(() => {});
    }
}

// ------------------------------------------------------------------
// Natural language reminder detection (available to everyone)
// ------------------------------------------------------------------

// Regex patterns ordered from most specific to least
const REMINDER_REGEXES = [
    // "remind me in 2 hours to do X" / "remind me in 30 minutes about X"
    { re: /remind me in (\d+)\s*(minute|min|hour|hr|day)s?\s+(?:to|about)\s+(.+)/i,      parse: (m) => ({ amount: +m[1], unit: m[2].toLowerCase(), text: m[3] }) },
    // "remind me tomorrow at 9am to X"
    { re: /remind me tomorrow at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|about)\s+(.+)/i, parse: (m) => ({ tomorrow: true, hour: +m[1], min: +(m[2] || 0), ampm: m[3], text: m[4] }) },
    // "remind me at 3pm to X"
    { re: /remind me at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|about)\s+(.+)/i,      parse: (m) => ({ hour: +m[1], min: +(m[2] || 0), ampm: m[3], text: m[4] }) },
    // "set a reminder for 10 minutes to X"
    { re: /set (?:a )?reminder (?:for )?(\d+)\s*(minute|min|hour|hr|day)s?\s+(?:to|about)\s+(.+)/i, parse: (m) => ({ amount: +m[1], unit: m[2].toLowerCase(), text: m[3] }) },
    // "remind me tomorrow to/about X" or "remind me to/about X tomorrow" (no specific time — 9am next day)
    { re: /remind(?:\s+me)?\s+tomorrow\s+(?:to|about)\s+(.+)/i,                          parse: (m) => ({ tomorrow: true, hour: 9, min: 0, ampm: 'am', text: m[1] }) },
    { re: /remind(?:\s+me)?\s+(?:to|about)\s+(.+?)\s+tomorrow\b/i,                       parse: (m) => ({ tomorrow: true, hour: 9, min: 0, ampm: 'am', text: m[1] }) },
];

function parseRelativeMs(amount, unit) {
    const u = unit.toLowerCase();
    if (u.startsWith('min')) return amount * 60_000;
    if (u.startsWith('hr') || u.startsWith('hour')) return amount * 3_600_000;
    if (u.startsWith('day')) return amount * 86_400_000;
    return null;
}

function resolveAbsoluteTime(hour, min, ampm, tomorrow) {
    const now = new Date();

    function makeTarget(h) {
        const t = new Date(now);
        t.setHours(h, min || 0, 0, 0);
        if (tomorrow) t.setDate(t.getDate() + 1);
        else if (t <= now) t.setDate(t.getDate() + 1);
        return t;
    }

    if (ampm) {
        let h = hour;
        if (ampm.toLowerCase() === 'pm' && h < 12) h += 12;
        if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
        return makeTarget(h);
    }

    // No am/pm — pick the soonest future occurrence (try both AM and PM candidates)
    const candidates = [hour % 24, (hour % 12) + 12].map(makeTarget);
    return candidates.reduce((best, t) => (t < best ? t : best));
}

const NL_REMINDER_MAX_TEXT = 200;
const NL_REMINDER_MAX_PENDING = 10;
const NL_REMINDER_COOLDOWN_MS = 30_000; // 30 seconds between NL-created reminders per user
const nlReminderLastUsed = new Map(); // userId → timestamp

function sanitizeReminderText(text) {
    return text
        // Strip @everyone, @here, and role/user mention tokens
        .replace(/@(everyone|here)/gi, '')
        .replace(/<@[!&]?\d+>/g, '')
        .trim()
        .slice(0, NL_REMINDER_MAX_TEXT);
}

async function handleNLReminder(message, contentOverride) {
    const content = (contentOverride ?? message.content).trim();
    if (content.length < 5) return false;
    if (!/remind/i.test(content)) return false;

    for (const { re, parse } of REMINDER_REGEXES) {
        const m = content.match(re);
        if (!m) continue;

        const parsed = parse(m);
        let remindAt;

        if (parsed.amount != null) {
            const ms = parseRelativeMs(parsed.amount, parsed.unit);
            if (!ms) continue;
            remindAt = new Date(Date.now() + ms);
        } else {
            remindAt = resolveAbsoluteTime(parsed.hour, parsed.min, parsed.ampm, parsed.tomorrow);
        }

        const reminderText = sanitizeReminderText(parsed.text);
        if (!reminderText) continue;

        // Per-user cooldown
        const lastUsed = nlReminderLastUsed.get(message.author.id) || 0;
        if (Date.now() - lastUsed < NL_REMINDER_COOLDOWN_MS) return false;

        // Cap pending reminders per user
        const pending = await Reminder.countDocuments({ userId: message.author.id, completed: false }).catch(() => NL_REMINDER_MAX_PENDING);
        if (pending >= NL_REMINDER_MAX_PENDING) return false;

        nlReminderLastUsed.set(message.author.id, Date.now());

        try {
            await Reminder.create({
                userId:    message.author.id,
                guildId:   message.guild?.id || null,
                channelId: message.channel.id,
                message:   reminderText,
                remindAt
            });

            const unixTs = Math.floor(remindAt.getTime() / 1000);
            await message.reply({ content: `✅ Got it! I'll remind you <t:${unixTs}:R> about: **${reminderText}**`, allowedMentions: { parse: [] } }).catch(() => {});
        } catch (err) {
            console.error('[NLReminder] Failed to create reminder:', err.message);
            return false;
        }
        return true;
    }
    return false;
}

