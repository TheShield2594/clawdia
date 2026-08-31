const { handleVoiceStateUpdate } = require('../services/tempVoiceService');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const User = require('../models/User');
const { checkRivalry } = require('../services/rivalryService');

// `${guildId}:${userId}` -> joinTimestamp (ms)
const voiceJoinTimes = new Map();

// A join is cleared only by the matching leave, and the leave can simply never
// arrive: the bot is removed from a guild while people are still in voice, or a
// gateway gap swallows the transition. Every such entry is permanent, so this
// map is bounded the way every other one in this repo is (guildSettingsCache,
// BoundedRateLimiter) — a sweep of entries older than any plausible session,
// plus a hard FIFO cap for the case where joins arrive faster than the sweep.
const MAX_VOICE_SESSION_MS = 24 * 60 * 60 * 1000;
const VOICE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRACKED_VOICE_SESSIONS = 5_000;
let lastVoiceSweepAt = 0;

/**
 * Drops joins older than a session could plausibly be.
 *
 * Amortised over joins rather than run from a timer, because this module owns
 * no schedule — src/services/scheduler is the only place that may register one
 * (tests/schedulerOwnsJobs.test.js enforces that) — and a sweep is only ever
 * needed while joins are actually happening. The interval keeps it O(n) per
 * hour rather than per join.
 */
function sweepVoiceJoinTimes(now) {
    if (now - lastVoiceSweepAt < VOICE_SWEEP_INTERVAL_MS) return;
    lastVoiceSweepAt = now;
    const cutoff = now - MAX_VOICE_SESSION_MS;
    for (const [key, joinedAt] of voiceJoinTimes) {
        if (joinedAt <= cutoff) voiceJoinTimes.delete(key);
    }
}

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        await handleVoiceStateUpdate(oldState, newState, client);
        await handleVoiceXp(oldState, newState, client);
    },
    __test__: {
        voiceJoinTimes,
        MAX_VOICE_SESSION_MS,
        VOICE_SWEEP_INTERVAL_MS,
        MAX_TRACKED_VOICE_SESSIONS,
        resetVoiceJoinTimes() {
            voiceJoinTimes.clear();
            lastVoiceSweepAt = 0;
        },
    },
};

async function handleVoiceXp(oldState, newState, client) {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const guildId = (newState.guild || oldState.guild)?.id;
    if (!guildId) return;

    const joinedVoice = !oldState.channelId && newState.channelId;
    const leftVoice = oldState.channelId && !newState.channelId;

    const key = `${guildId}:${member.id}`;

    if (joinedVoice) {
        const now = Date.now();
        sweepVoiceJoinTimes(now);
        // FIFO eviction, as in BoundedRateLimiter. An evicted join forfeits
        // only that one session's voice XP, which is a better failure than
        // growth with no ceiling.
        if (!voiceJoinTimes.has(key) && voiceJoinTimes.size >= MAX_TRACKED_VOICE_SESSIONS) {
            voiceJoinTimes.delete(voiceJoinTimes.keys().next().value);
        }
        voiceJoinTimes.set(key, now);
        return;
    }

    if (!leftVoice) return;

    const joinedAt = voiceJoinTimes.get(key);
    if (!joinedAt) return;
    voiceJoinTimes.delete(key);

    // Past the sweep's cutoff this entry was going to be discarded, so paying it
    // out would make the award depend on whether a sweep happened to have run —
    // a 30-hour join worth 5,400 XP or nothing, decided by timing. It is also
    // the shape of a join whose leave was lost and whose "session" is really the
    // gap until the user rejoined. Discard it either way.
    if (Date.now() - joinedAt > MAX_VOICE_SESSION_MS) return;

    try {
        const guildSettings = await getGuildSettings(guildId);
        if (!guildSettings?.leveling?.enabled || !guildSettings.leveling.voiceXpEnabled) return;
        if (!guildSettings.leveling.rewardsEnabled) return;
        if (guildSettings.leveling.noXpRoleIds?.length &&
            member.roles.cache.some(r => guildSettings.leveling.noXpRoleIds.includes(r.id))) return;

        const minutesSpent = (Date.now() - joinedAt) / 60000;
        if (minutesSpent < 1) return;

        const xpGain = Math.floor(minutesSpent * 3 * (guildSettings.leveling.voiceXpRate || 1.0));
        if (xpGain <= 0) return;

        let user = await User.findOne({ userId: member.id, guildId });
        if (!user) {
            user = await User.create({ userId: member.id, guildId, xp: xpGain, messages: 0 });
            return;
        }

        user.xp += xpGain;
        const guild = newState.guild || oldState.guild;
        const rewardChannelId = guildSettings.leveling.rewardChannelId || guildSettings.leveling.announceChannel;

        while (user.xp >= user.level * 100 + 100) {
            const threshold = user.level * 100 + 100;
            user.xp -= threshold;
            user.level += 1;

            const levelUpMsg = (guildSettings.leveling.levelUpMessage || 'Congratulations {user}! You reached level {level}!')
                .replace(/{user}/g, `<@${member.id}>`)
                .replace(/{level}/g, user.level);
            if (rewardChannelId) {
                const ch = guild.channels.cache.get(rewardChannelId);
                if (ch) await ch.send(levelUpMsg).catch(() => {});
            }
            if (guildSettings.levelRoles?.length) {
                const reward = guildSettings.levelRoles.filter(lr => lr.level <= user.level).sort((a, b) => b.level - a.level)[0];
                if (reward) await member.roles.add(reward.roleId).catch(() => {});
            }
        }

        await user.save();
        if (guild) checkRivalry(client, guild, user).catch(() => {});
    } catch (err) {
        console.error('Voice XP error:', err);
    }
}
