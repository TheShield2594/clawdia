const User = require('../models/User');
const Guild = require('../models/Guild');
const Case = require('../models/Case');
const Reminder = require('../models/Reminder');
const { handleAIChat } = require('../services/aiService');
const { logModeration } = require('../services/moderationLogService');
const { ensureQuests, onMessage, onStreakUpdate, notifyQuestComplete, notifyQuestNearComplete, notifyDailyQuestReset } = require('../services/questService');
const { getStreakMultiplier, checkNewMilestones } = require('../utils/streakMultiplier');
const { hasEffect, consumeEffect, getXpMultiplier, getServerXpMultiplier } = require('../services/effectsService');
const { checkRivalry } = require('../services/rivalryService');
const { checkAndAward, announceAchievements } = require('../services/achievementService');
const { checkAndBroadcastWealthMilestone } = require('../utils/wealthMilestone');
const { maybeTriggerChatEvent } = require('../services/chatEventService');
const { applyXpGain, announceLevelUp } = require('../services/levelingService');
const BASE_BAD_WORDS = require('../data/profanityList');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const { saveWithBalanceDelta } = require('../utils/balanceDelta');
const { BoundedRateLimiter } = require('../utils/boundedRateLimiter');
const { withUserLock } = require('../utils/userMutex');

function compileBadWordRegex(word) {
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
}

// Pre-compile base word regexes once at module load — avoids per-message regex construction
const BASE_BAD_WORD_REGEXES = BASE_BAD_WORDS.map(compileBadWordRegex);

// The base list above is compiled once, but a guild's own additions used to be
// rebuilt from scratch on every message that reached the profanity filter. They
// change only when an admin edits the word list, so they are compiled once and
// kept here until that happens.
//
// The entry is keyed on the word list itself rather than on a settings version:
// the cached settings object is replaced wholesale on every invalidation, and a
// TTL expiry alone would otherwise force a recompile that changed nothing. A
// guild whose list is unchanged keeps its regexes across settings reloads.
//
// guildId -> { signature, regexes }
const customBadWordRegexes = new Map();

// Bounds memory across a large guild count, the same way guildSettingsCache
// does: FIFO by insertion order, and an evicted guild simply recompiles on its
// next filtered message.
const MAX_CUSTOM_BAD_WORD_GUILDS = 5_000;

function getCustomBadWordRegexes(guildId, customBadWords) {
    const words = customBadWords || [];
    if (!words.length) return [];

    // A NUL separator cannot appear in a word an admin typed into the
    // dashboard, so no two distinct lists share a signature.
    const signature = words.join('\u0000');
    const cached = customBadWordRegexes.get(guildId);
    if (cached && cached.signature === signature) return cached.regexes;

    const regexes = words.map(compileBadWordRegex);
    if (customBadWordRegexes.size >= MAX_CUSTOM_BAD_WORD_GUILDS && !customBadWordRegexes.has(guildId)) {
        customBadWordRegexes.delete(customBadWordRegexes.keys().next().value);
    }
    customBadWordRegexes.set(guildId, { signature, regexes });
    return regexes;
}

// Leet-speak normalization map
const LEET_MAP = {
    '4': 'a', '@': 'a', '3': 'e', '€': 'e', '1': 'i', '!': 'i',
    '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '9': 'g',
    '6': 'b', '8': 'b'
};

// One entry per (guild, user) seen inside the spam window.
//
// This was a `Map<guildId, Map<userId, timestamps>>` with nothing that ever
// removed an entry: a user's array was pruned only when *that same user* posted
// again, so a visitor who said one word in one guild two months ago was still
// resident, and the outer map grew a guild entry per guild for the life of the
// process (#600). The bounded limiter is what the rest of the bot already uses
// for exactly this — a hard key ceiling with FIFO eviction, plus a sweep that
// drops keys whose timestamps have all aged out.
//
// The key is `guildId:userId` rather than a nested map because the ceiling has
// to bound the whole thing; a cap on the outer map alone bounds nothing, since
// the arrays hang off the inner ones. Eviction only forgives whatever a user
// had accumulated, which costs them a longer run-up to the threshold — the same
// trade every other limiter here makes.
const SPAM_MAX_KEYS = 20_000;

// The dashboard offers 1–60 seconds for the window, so 60s is the longest one
// any guild can be running. The sweep uses it, which is what makes the sweep
// safe: `cleanup` only drops a key once every timestamp on it predates the
// window it is given, so sweeping on the *widest* configurable window can never
// forget a message some guild's narrower window would still have counted.
const SPAM_MIN_WINDOW_MS = 1_000;
const SPAM_MAX_WINDOW_MS = 60_000;

const spamLimiter = new BoundedRateLimiter(SPAM_MAX_KEYS);
setInterval(() => spamLimiter.cleanup(SPAM_MAX_WINDOW_MS), SPAM_MAX_WINDOW_MS).unref();

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
    // Exported for unit testing only
    _getCustomBadWordRegexes: getCustomBadWordRegexes,
    // The spam window's backing store. Exposed so a test can assert the sweep
    // actually reclaims it (#600) — a leak is invisible from the outside,
    // because a tracker that never forgets behaves identically until it is the
    // thing using the memory.
    _spamLimiter: spamLimiter,
    async execute(message, client) {
        if (message.author.bot || !message.guild) return;

        try {
            // Cached read: this fires on every message, and the handlers below
            // only ever read from the settings object. See utils/guildSettingsCache
            // — the returned object is shared and must not be mutated.
            const guildSettings = await getGuildSettings(message.guild.id);

            if (!guildSettings) {
                await Guild.create({ guildId: message.guild.id, name: message.guild.name });
                return;
            }

            if (guildSettings?.ai?.enabled) {
                const ai = guildSettings.ai;
                const hasChannelRestriction = !!ai.channelId;
                const isDefaultChannel = hasChannelRestriction && message.channel.id === ai.channelId;
                const persona = ai.channelPersonas?.find(p => p.channelId === message.channel.id);

                if (!hasChannelRestriction || isDefaultChannel || persona) {
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
                        // Strip bot mention tokens once, and use the result for
                        // everything downstream. NL reminder detection needs the real
                        // content, and so does the chat handler: it was reading
                        // `message.content` itself, so `@Clawdia !reset` never matched
                        // the reset command and the raw `<@id>` token went into the
                        // model prompt on every mention-triggered message (#820).
                        const strippedContent = message.content
                            .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
                            .trim();
                        const reminderHandled = await handleNLReminder(message, strippedContent);
                        if (!reminderHandled) {
                            await handleAIChat(message, effectiveSettings, strippedContent);
                        }
                        return;
                    }
                }
            }

            // Everything that touches the author's User document runs inside a
            // per-user lock (#617). One read serves the whole chain — handleLeveling
            // mutates the document and hands it back unsaved, handleStreakAndQuests
            // keeps mutating that same object and performs the single write — and
            // `save()` writes each modified path as an absolute `$set`. Two messages
            // from the same user overlapping in that window is one message's worth of
            // XP, quest progress and streak state written back to what it was before.
            // See utils/userMutex.js for why an in-process lock is the right size here.
            const { blocked, sideWork } = await withUserLock(
                `${message.guild.id}:${message.author.id}`,
                async () => {
                    let sharedUser = null;
                    if (guildSettings?.leveling.enabled) {
                        sharedUser = await handleLeveling(message, guildSettings);
                    }

                    if (guildSettings?.moderation.enabled) {
                        const stopped = await handleAutoModeration(message, guildSettings);
                        // A blocked message never reaches the streak/quest write, so the
                        // XP handleLeveling applied has nothing to ride along on.
                        if (stopped) {
                            await flushPendingUser(sharedUser);
                            return { blocked: true, sideWork: [] };
                        }
                    }

                    // Automod was the only handler with a say over these — past that
                    // gate they touch different data, issue unrelated writes, and share
                    // no document with the chain below, so they start here and settle
                    // alongside it rather than queueing behind it. They are awaited
                    // outside the lock, so their outcomes are captured now: an early
                    // rejection must not be an unhandled one while the lock is held.
                    const sideWork = [
                        handleSuggestions(message, guildSettings),
                        guildSettings?.bibleVerse?.autoRespond
                            ? handleBibleVerseDetection(message, guildSettings)
                            : null,
                        // Natural language reminders — available to everyone, any channel
                        handleNLReminder(message),
                    ].map(work => Promise.resolve(work).then(
                        value  => ({ status: 'fulfilled', value }),
                        reason => ({ status: 'rejected', reason }),
                    ));

                    // Streak + quests — reuses the document handleLeveling already
                    // loaded and saves it once. It reports whether that write landed;
                    // when it bailed out early or threw before saving, the XP still has
                    // to be persisted.
                    try {
                        const persisted = await handleStreakAndQuests(message, guildSettings, sharedUser);
                        if (!persisted) await flushPendingUser(sharedUser);
                    } catch (err) {
                        console.error('Error in messageCreate:', err);
                    }

                    return { blocked: false, sideWork };
                },
            );

            for (const outcome of await Promise.all(sideWork)) {
                if (outcome.status === 'rejected') console.error('Error in messageCreate:', outcome.reason);
            }
            if (blocked) return;

            // Ambient chat events (airdrops, crates, trivia) — fire-and-forget
            maybeTriggerChatEvent(message, guildSettings).catch(() => {});

        } catch (error) {
            console.error('Error in messageCreate:', error);
        }
    }
};

// Backstop for the paths that never reach the streak/quest write: the XP applied
// by handleLeveling lives only in memory until something saves the document.
// Only called when that write is known not to have happened, so it can never race
// the fire-and-forget saves (wealth milestones, achievements) that follow it.
async function flushPendingUser(user) {
    if (!user?.isModified?.()) return;
    try {
        await user.save();
    } catch (err) {
        console.error('Pending user save error:', err.message);
    }
}

async function handleStreakAndQuests(message, guildSettings, existingUser = null) {
    // Reported back to the caller so it knows whether the XP handleLeveling
    // applied has been persisted. Set only once the write has actually landed —
    // a failure after that point still leaves the document saved.
    let persisted = false;
    try {
        const user = existingUser ?? await User.findOne({ userId: message.author.id, guildId: message.guild.id });
        if (!user) return false;

        // Every coin this path awards — streak milestones, quest completions — is
        // folded into one `$inc` at the save below. `save()` writes `balance` as an
        // absolute `$set`, and a message handler runs on every message: a casino
        // debit landing between this read and that save would simply be erased.
        const balanceAtLoad = user.balance ?? 0;

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
                    // Award a streak freeze at every 30-day interval (max 2 banked)
                    if (user.streak.current % 30 === 0 && (user.streak.freezes ?? 0) < 2) {
                        user.streak.freezes = (user.streak.freezes ?? 0) + 1;
                    }
                } else if (msAgo <= 259200000 && hasEffect(user, 'streak_shield')) { // 48–72h: one missed day, shield applies
                    consumeEffect(user, 'streak_shield');
                    user.streak.current = (user.streak.current || 0) + 1;
                    shieldActivated = true;
                } else {
                    // Streak broken — flag for freeze restore prompt on next /daily
                    const brokenStreak = user.streak.current || 0;
                    if (brokenStreak > 1 && (user.streak.freezes ?? 0) > 0) {
                        user.streak.pendingRestore = brokenStreak;
                    }
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
        const streakQuests = await onStreakUpdate(user, guildSettings);
        completedQuests.push(...streakQuests.completed);
        nearCompleteQuests.push(...streakQuests.nearComplete);

        const newlyEarned = await checkAndAward(user, guildSettings).catch(() => []);

        await saveWithBalanceDelta(User, user, balanceAtLoad, {
            service: 'messageCreate',
            jobName: 'streakAndQuestRewards',
            guildId: message.guild.id,
        });
        persisted = true;

        // Check wealth milestones after any coins may have been awarded (streak rewards, etc.)
        checkAndBroadcastWealthMilestone(message.client, guildSettings, user, message.channel).catch(() => {});

        if (newlyEarned.length) {
            announceAchievements(message.client, guildSettings, user, message.member, newlyEarned).catch(() => null);
        }

        await notifyQuestComplete(guildSettings, message.member, completedQuests, message.channel, user);
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
    return persisted;
}

// Applies levelling XP in memory and returns the document without saving it.
// The caller hands the same document to handleStreakAndQuests, which mutates it
// further and issues the one write that covers both — a second fetch and a second
// save of the same user on every message is what this avoids.
async function handleLeveling(message, guildSettings) {
    if (!guildSettings?.leveling?.rewardsEnabled) return null;
    if (guildSettings.leveling?.noXpChannelIds?.includes(message.channel.id)) return null;
    if (message.member?.roles?.cache?.some(role => guildSettings.leveling?.noXpRoleIds?.includes(role.id))) return null;

    const user = await User.findOne({ userId: message.author.id, guildId: message.guild.id });

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
        const { leveled } = applyXpGain(user, xpGain);
        user.messages += 1;
        user.lastXpGain = new Date();
        if (leveled) {
            await announceLevelUp(user, guildSettings, message.member, message.guild, message.channel);
        }

        // Standings are computed from the in-memory values, so they do not need
        // the write to have landed first.
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
        // Clamped to the range the dashboard's own input offers. Nothing
        // validates `spamWindow` on the way into the database, and the sweep
        // above is only sound while no guild's window outruns it.
        const windowMs = Math.min(
            Math.max((mod.spamWindow || 5) * 1000, SPAM_MIN_WINDOW_MS),
            SPAM_MAX_WINDOW_MS
        );
        const threshold = mod.spamThreshold || 5;

        const key = `${guildId}:${userId}`;

        if (spamLimiter.hit(key, windowMs) >= threshold) {
            // Forget the burst that just earned a punishment, so the next
            // message starts a fresh count instead of tripping the same
            // still-full window again.
            spamLimiter.reset(key);
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
        const customRegexes = getCustomBadWordRegexes(message.guild.id, mod.customBadWords);
        const hasBadWord = BASE_BAD_WORD_REGEXES.some(re => re.test(normalized))
            || customRegexes.some(re => re.test(normalized));

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
        // `??`, not `||`. Each of these is documented as "0 = disabled" beside
        // its dashboard field, the schema allows `min: 0`, and the guards below
        // test `> 0` for exactly that reason — but `||` reads 0 as absent and
        // hands back the default, so an operator who turned auto-ban off got it
        // silently re-armed at 30 and the `> 0` guards were unreachable (#783).
        const banAt = mod.behaviorScoreBanAt ?? 30;
        const kickAt = mod.behaviorScoreKickAt ?? 20;
        const muteAt = mod.behaviorScoreMuteAt ?? 10;

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
// Natural language reminder detection (available to everyone)
// ------------------------------------------------------------------

// Regex patterns ordered from most specific to least.
// Each pattern can be time-first ("remind me in 2h to X") or task-first ("remind me to X in 2h").
const REMINDER_REGEXES = [
    // --- Time-first patterns ---
    // "remind me in 2 hours to/about X"
    { re: /remind(?:\s+me)?\s+in\s+(\d+)\s*(minute|min|hour|hr|day)s?\s+(?:to|about)\s+(.+)/i,
      parse: (m) => ({ amount: +m[1], unit: m[2].toLowerCase(), text: m[3] }) },
    // "remind me in an/a hour/minute/day to/about X"
    { re: /remind(?:\s+me)?\s+in\s+an?\s+(minute|min|hour|hr|day)\s+(?:to|about)\s+(.+)/i,
      parse: (m) => ({ amount: 1, unit: m[1].toLowerCase(), text: m[2] }) },
    // "remind me tomorrow at 9am to/about X"
    { re: /remind(?:\s+me)?\s+tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|about)\s+(.+)/i,
      parse: (m) => ({ tomorrow: true, hour: +m[1], min: +(m[2] || 0), ampm: m[3], text: m[4] }) },
    // "remind me at 3pm to/about X"
    { re: /remind(?:\s+me)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|about)\s+(.+)/i,
      parse: (m) => ({ hour: +m[1], min: +(m[2] || 0), ampm: m[3], text: m[4] }) },
    // "remind me next week/month to/about X"
    { re: /remind(?:\s+me)?\s+next\s+(week|month)\s+(?:to|about)\s+(.+)/i,
      parse: (m) => ({ amount: m[1] === 'week' ? 7 : 30, unit: 'day', text: m[2] }) },
    // "remind me tomorrow to/about X" (no specific time — 9am next day)
    { re: /remind(?:\s+me)?\s+tomorrow\s+(?:to|about)\s+(.+)/i,
      parse: (m) => ({ tomorrow: true, hour: 9, min: 0, ampm: 'am', text: m[1] }) },

    // --- Task-first patterns ("remind me to X [time]") ---
    // "remind me to/about X in 2 hours"
    { re: /remind(?:\s+me)?\s+(?:to|about)\s+(.+?)\s+in\s+(\d+)\s*(minute|min|hour|hr|day)s?\.?\s*$/i,
      parse: (m) => ({ amount: +m[2], unit: m[3].toLowerCase(), text: m[1] }) },
    // "remind me to/about X in an/a hour/minute/day"
    { re: /remind(?:\s+me)?\s+(?:to|about)\s+(.+?)\s+in\s+an?\s+(minute|min|hour|hr|day)\.?\s*$/i,
      parse: (m) => ({ amount: 1, unit: m[2].toLowerCase(), text: m[1] }) },
    // "remind me to/about X tomorrow at 9am" — must come before generic "at" rule
    { re: /remind(?:\s+me)?\s+(?:to|about)\s+(.+?)\s+tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\.?\s*$/i,
      parse: (m) => ({ tomorrow: true, hour: +m[2], min: +(m[3] || 0), ampm: m[4], text: m[1] }) },
    // "remind me to/about X at 3pm"
    { re: /remind(?:\s+me)?\s+(?:to|about)\s+(.+?)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\.?\s*$/i,
      parse: (m) => ({ hour: +m[2], min: +(m[3] || 0), ampm: m[4], text: m[1] }) },
    // "remind me to/about X next week/month"
    { re: /remind(?:\s+me)?\s+(?:to|about)\s+(.+?)\s+next\s+(week|month)\.?\s*$/i,
      parse: (m) => ({ amount: m[2] === 'week' ? 7 : 30, unit: 'day', text: m[1] }) },
    // "remind me to/about X tomorrow" (no specific time — 9am next day)
    { re: /remind(?:\s+me)?\s+(?:to|about)\s+(.+?)\s+tomorrow\.?\s*$/i,
      parse: (m) => ({ tomorrow: true, hour: 9, min: 0, ampm: 'am', text: m[1] }) },

    // --- Legacy / alias patterns ---
    // "set a reminder for 10 minutes to/about X"
    { re: /set\s+(?:a\s+)?reminder\s+(?:for\s+)?(\d+)\s*(minute|min|hour|hr|day)s?\s+(?:to|about)\s+(.+)/i,
      parse: (m) => ({ amount: +m[1], unit: m[2].toLowerCase(), text: m[3] }) },
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
// One key per user who recently tripped the cooldown. A plain Map here grew an
// entry per user forever; the bounded limiter FIFO-evicts at the cap, and the
// sweep drops keys whose window has fully aged out (same shape as aiService's).
const NL_REMINDER_MAX_KEYS = 10_000;
const nlReminderLimiter = new BoundedRateLimiter(NL_REMINDER_MAX_KEYS);
setInterval(() => nlReminderLimiter.cleanup(NL_REMINDER_COOLDOWN_MS), 15 * 60 * 1000).unref();

function sanitizeReminderText(text) {
    // Normalize first to prevent Unicode normalization attacks / length bypass tricks.
    const normalized = text.normalize('NFC');
    const sanitized = normalized
        // Strip @everyone, @here, and role/user mention tokens
        .replace(/@(everyone|here)/gi, '')
        .replace(/<@[!&]?\d+>/g, '')
        // Strip URLs — reminder text should never need a link
        .replace(/https?:\/\/\S+/gi, '')
        // Strip control characters and non-printable code points
        .replace(/\p{Cc}/gu, '')
        .trim()
        .slice(0, NL_REMINDER_MAX_TEXT);
    return sanitized;
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

        // Per-user cooldown. The limiter records the attempt as it checks it, so
        // a create that fails downstream still counts — the cooldown paces how
        // often a user can *trigger* the path, not how often they succeed.
        if (!nlReminderLimiter.check(message.author.id, NL_REMINDER_COOLDOWN_MS, 1)) return false;

        // Cap pending reminders per user
        const pending = await Reminder.countDocuments({ userId: message.author.id, completed: false }).catch(() => NL_REMINDER_MAX_PENDING);
        if (pending >= NL_REMINDER_MAX_PENDING) return false;

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

