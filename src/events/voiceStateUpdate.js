const { handleVoiceStateUpdate } = require('../services/tempVoiceService');
const Guild = require('../models/Guild');
const User = require('../models/User');

// userId -> joinTimestamp (ms)
const voiceJoinTimes = new Map();

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        await handleVoiceStateUpdate(oldState, newState, client);
        await handleVoiceXp(oldState, newState);
    }
};

async function handleVoiceXp(oldState, newState) {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const guildId = (newState.guild || oldState.guild)?.id;
    if (!guildId) return;

    const joinedVoice = !oldState.channelId && newState.channelId;
    const leftVoice = oldState.channelId && !newState.channelId;

    if (joinedVoice) {
        voiceJoinTimes.set(`${guildId}:${member.id}`, Date.now());
        return;
    }

    if (!leftVoice) return;

    const key = `${guildId}:${member.id}`;
    const joinedAt = voiceJoinTimes.get(key);
    if (!joinedAt) return;
    voiceJoinTimes.delete(key);

    try {
        const guildSettings = await Guild.findOne({ guildId });
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
    } catch (err) {
        console.error('Voice XP error:', err);
    }
}
