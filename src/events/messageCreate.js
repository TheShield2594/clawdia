const User = require('../models/User');
const Guild = require('../models/Guild');
const Reminder = require('../models/Reminder');
const { handleAIChat } = require('../services/aiService');
const { ensureQuests, onMessage, onStreakUpdate, notifyQuestComplete, notifyQuestNearComplete, notifyDailyQuestReset } = require('../services/questService');
const { getStreakMultiplier, checkNewMilestones } = require('../utils/streakMultiplier');
const { hasEffect, consumeEffect, getXpMultiplier, getServerXpMultiplier } = require('../services/effectsService');
const { checkRivalry } = require('../services/rivalryService');
const { checkAndAward, announceAchievements } = require('../services/achievementService');
const { checkAndBroadcastWealthMilestone } = require('../utils/wealthMilestone');
const { maybeTriggerChatEvent } = require('../services/chatEventService');
const { applyXpGain, announceLevelUp } = require('../services/levelingService');
const autoMod = require('../services/autoModService');
const { handleAutoModeration } = autoMod;
const { getGuildSettings } = require('../utils/guildSettingsCache');
const { saveWithBalanceDelta } = require('../utils/balanceDelta');
const { BoundedRateLimiter } = require('../utils/boundedRateLimiter');
const { withUserLock } = require('../utils/userMutex');

// The bot's own mention token, as a regex.
//
// This was rebuilt with `new RegExp` on every mention-triggered message (#930).
// The id is fixed for the life of the process, but it is only knowable once the
// client has logged in — hence built on first use rather than at module load,
// and keyed on the id so a client that logs in as someone else (a test, a token
// swap) does not keep the stale pattern.
let mentionPattern = null;
function getMentionPattern(botId) {
    if (mentionPattern?.botId !== botId) {
        mentionPattern = { botId, regex: new RegExp(`<@!?${botId}>`, 'g') };
    }
    // Shared and `g`-flagged, so `lastIndex` is state between calls. `replace`
    // resets it for us; nothing here may switch to `test`/`exec` without
    // clearing it first.
    return mentionPattern.regex;
}

module.exports = {
    name: 'messageCreate',
    // Exported for unit testing only. Auto-moderation moved to
    // services/autoModService (messageUpdate needs it too); these stay here so
    // the tests that pin the two caches keep addressing them where they always
    // have.
    _getCustomBadWordRegexes: autoMod._getCustomBadWordRegexes,
    // Likewise: the mention pattern is built once per bot id (#930), and the
    // only way to see that from outside is to ask for it twice.
    _getMentionPattern: getMentionPattern,
    // The spam window's backing store. Exposed so a test can assert the sweep
    // actually reclaims it (#600) — a leak is invisible from the outside,
    // because a tracker that never forgets behaves identically until it is the
    // thing using the memory.
    _spamLimiter: autoMod._spamLimiter,
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
                            .replace(getMentionPattern(client.user.id), '')
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
            //
            // What the lock must not contain is a Discord REST call. The lock
            // exists to serialise this user's document writes; awaiting a
            // `channel.send` inside it makes the hold time include Discord's
            // rate-limit queueing, and a holder stuck behind a 429 can reach
            // the 15-second timeout override — which exists to break deadlocks,
            // so hitting it reintroduces the very lost update the lock is here
            // to prevent (#894). Level-up embeds, quest notifications and
            // streak messages are therefore *queued* under the lock and sent
            // after it, the way `sideWork` already settles outside it.
            const { blocked, sideWork, announcements } = await withUserLock(
                `${message.guild.id}:${message.author.id}`,
                async () => {
                    const announcements = [];
                    let sharedUser = null;
                    if (guildSettings?.leveling.enabled) {
                        sharedUser = await handleLeveling(message, guildSettings, announcements);
                    }

                    if (guildSettings?.moderation.enabled) {
                        const stopped = await handleAutoModeration(message, guildSettings);
                        // A blocked message never reaches the streak/quest write, so the
                        // XP handleLeveling applied has nothing to ride along on.
                        if (stopped) {
                            await flushPendingUser(sharedUser);
                            // Any level-up queued above still goes out: it did
                            // before this message was blocked, and blocking the
                            // message is not a reason to swallow the promotion.
                            return { blocked: true, sideWork: [], announcements };
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
                        const persisted = await handleStreakAndQuests(message, guildSettings, sharedUser, announcements);
                        if (!persisted) await flushPendingUser(sharedUser);
                    } catch (err) {
                        console.error('Error in messageCreate:', err);
                    }

                    return { blocked: false, sideWork, announcements };
                },
            );

            // The lock is released by here, so a slow or rate-limited Discord
            // response delays only these messages — not this user's next one.
            await sendAnnouncements(announcements);

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

// Dispatches the Discord sends collected while the user lock was held, in the
// order they were queued — which is the order they were awaited in before they
// moved out of the lock, so a level-up embed still precedes the quest
// completion it triggered.
//
// Sequential rather than parallel for the same reason: these land in one
// channel, and firing them together lets Discord order them however it likes.
// One failing send must not skip the rest, so each is guarded.
async function sendAnnouncements(announcements) {
    for (const announce of announcements ?? []) {
        try {
            await announce();
        } catch (err) {
            console.error('Announcement error:', err);
        }
    }
}

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

// The one path this handler increments on every single message, and so the one
// it is worth keeping out of the document save.
const DAILY_COUNTER_PATH = 'dailyMessages';

async function handleStreakAndQuests(message, guildSettings, existingUser = null, announcements = []) {
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
        const dailyMessagesAtLoad = user.dailyMessages || 0;
        user.dailyMessages = dailyMessagesAtLoad + 1;

        // Quest progress
        const { assignedNewDaily } = await ensureQuests(user, guildSettings);
        const { completed: completedQuests, nearComplete: nearCompleteQuests } = await onMessage(user, guildSettings);
        const streakQuests = await onStreakUpdate(user, guildSettings);
        completedQuests.push(...streakQuests.completed);
        nearCompleteQuests.push(...streakQuests.nearComplete);

        const newlyEarned = await checkAndAward(user, guildSettings).catch(() => []);

        // The steady-state message changes nothing but the daily counter: same
        // UTC day, so the streak stands; quests finished for the day or turned
        // off, so no progress moved; XP on cooldown, so no levelling either.
        // Writing the whole document back for that `+1` is what made this path
        // cost a read *and* a write per message per active chatter (#893), so
        // when the counter is all that is pending it goes out as the `$inc` it
        // always was, and `save()` is skipped entirely.
        //
        // The decision reads `modifiedPaths()` rather than re-deriving "could
        // anything have changed?" by hand: it is the very list `save()` would
        // write, so a handler added to this chain later cannot quietly fall
        // through the gap and stop being persisted. Anything beyond the counter
        // — a streak rollover, quest progress, a milestone's coins, a fresh
        // achievement — puts it back on the full save below.
        //
        // A document that cannot report its modified paths falls to the full
        // save: the sentinel matches no path, so the counter-only branch is not
        // taken. Skipping a write on a guess is how XP goes missing.
        const pending = user.modifiedPaths?.() ?? ['*'];
        if (pending.length && pending.every(path => path === DAILY_COUNTER_PATH)) {
            const delta = (user.dailyMessages || 0) - dailyMessagesAtLoad;
            await User.updateOne(
                { userId: user.userId, guildId: user.guildId },
                { $inc: { [DAILY_COUNTER_PATH]: delta } },
            );
            // The in-memory value already counts this message and the `$inc`
            // has just made the stored one agree, so the path is settled.
            // Clearing the flag is what stops the caller's backstop flush from
            // saving the whole document to write a field that is already right.
            user.unmarkModified?.(DAILY_COUNTER_PATH);
        } else if (pending.length) {
            await saveWithBalanceDelta(User, user, balanceAtLoad, {
                service: 'messageCreate',
                jobName: 'streakAndQuestRewards',
                guildId: message.guild.id,
            });
        }
        // Nothing modified at all is also "persisted": there is nothing left
        // for the caller's flush to write.
        persisted = true;

        // Check wealth milestones after any coins may have been awarded (streak rewards, etc.)
        checkAndBroadcastWealthMilestone(message.client, guildSettings, user, message.channel).catch(() => {});

        if (newlyEarned.length) {
            announceAchievements(message.client, guildSettings, user, message.member, newlyEarned).catch(() => null);
        }

        // Everything below is a Discord send. Queued in the order it used to be
        // awaited in, and dispatched by the caller once the user lock is
        // released — see the note at the withUserLock call (#894). The message
        // text is built here, while the values it reports are the ones this
        // pass computed, rather than read back at send time.
        announcements.push(
            () => notifyQuestComplete(guildSettings, message.member, completedQuests, message.channel, user),
            () => notifyQuestNearComplete(guildSettings, message.member, nearCompleteQuests, message.channel),
        );
        if (assignedNewDaily) {
            announcements.push(() => notifyDailyQuestReset(guildSettings, message.member, user, message.channel));
        }

        if (shieldActivated) {
            const text = `🔥🛡️ <@${message.author.id}> Your **Streak Shield** protected your streak! (consumed)`;
            announcements.push(() => message.channel.send(text).catch(() => {}));
        }

        for (const milestone of newMilestones) {
            const multiplier = getStreakMultiplier(user.streak.current);
            const text =
                `🔥 <@${message.author.id}> **${milestone.days}-day streak milestone!** ` +
                `You earned **${milestone.coins.toLocaleString()} coins** and the **${milestone.badge}** badge! ` +
                `You're now earning **${multiplier}x** coins and XP.`;
            announcements.push(() => message.channel.send(text).catch(() => {}));
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
async function handleLeveling(message, guildSettings, announcements = []) {
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
            // Queued, not awaited: the embed and the level-role grant are both
            // REST calls, and the caller sends them once the lock is released.
            announcements.push(() =>
                announceLevelUp(user, guildSettings, message.member, message.guild, message.channel));
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


async function handleSuggestions(message, guildSettings) {
    const s = guildSettings.suggestions;
    if (!s?.enabled || !s.channelId) return;
    if (message.channel.id !== s.channelId) return;
    try {
        await message.react(s.upvoteEmoji || '👍').catch(() => {});
        await message.react(s.downvoteEmoji || '👎').catch(() => {});
    } catch {}
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

