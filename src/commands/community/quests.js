const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { ensureQuests, getDailyPool, getWeeklyPool, getCategoryEmojis, getDifficultyColors } = require('../../services/questService');

const DIFFICULTY_EMBED_COLORS = { easy: 0x57F287, medium: 0xFEE75C, hard: 0xED4245 };
const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('quests')
        .setDescription('View your active daily and weekly quests'),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!guildSettings?.quests?.enabled) {
            return interaction.reply({ content: 'Quests are not enabled on this server.', ephemeral: true });
        }

        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) {
            user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
        }

        await ensureQuests(user, guildSettings);
        await user.save();

        const catEmojis  = getCategoryEmojis();
        const diffColors = getDifficultyColors();
        const dailyPool  = getDailyPool();
        const weeklyPool = getWeeklyPool();
        const now        = new Date();

        const dailyCoin   = guildSettings.quests.dailyCoinReward   ?? 25;
        const dailyXp     = guildSettings.quests.dailyXpReward     ?? 50;
        const weeklyCoin  = guildSettings.quests.weeklyCoinReward  ?? 150;
        const weeklyXp    = guildSettings.quests.weeklyXpReward    ?? 300;

        const dailyLines  = [];
        const weeklyLines = [];

        const activeQuests = user.quests.filter(q => q.expiresAt > now);

        for (const entry of activeQuests) {
            const def = [...dailyPool, ...weeklyPool].find(d => d.questId === entry.questId);
            if (!def) continue;

            const isDaily    = dailyPool.some(d => d.questId === def.questId);
            const progress   = entry.progress ?? 0;
            const completed  = !!entry.completedAt;
            const mult       = def.difficulty === 'hard' ? 3 : def.difficulty === 'medium' ? 1.75 : 1;
            const rewardXp   = Math.round((isDaily ? dailyXp   : weeklyXp)   * mult);
            const rewardCoin = Math.round((isDaily ? dailyCoin : weeklyCoin) * mult);

            const bar        = buildBar(progress, def.target);
            const catEmoji   = catEmojis[def.category] ?? '🗺️';
            const diffDot    = diffColors[def.difficulty] ?? '🟢';
            const diffLabel  = DIFFICULTY_LABELS[def.difficulty] ?? 'Easy';
            const statusMark = completed ? '✅' : '🔄';

            const line = [
                `${statusMark} ${catEmoji} **${def.name}** ${diffDot} \`${diffLabel}\``,
                `${def.description}`,
                `${bar} **${progress}**/${def.target}`,
                `Reward: **+${rewardXp} XP**, **+${rewardCoin} coins**`,
            ].join('\n');

            if (isDaily) dailyLines.push(line);
            else         weeklyLines.push(line);
        }

        const completedDailyCount  = activeQuests.filter(q => q.completedAt && dailyPool.some(d => d.questId === q.questId)).length;
        const completedWeeklyCount = activeQuests.filter(q => q.completedAt && weeklyPool.some(d => d.questId === q.questId)).length;
        const totalDaily  = dailyLines.length;
        const totalWeekly = weeklyLines.length;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({
                name: `${interaction.user.displayName}'s Quest Board`,
                iconURL: interaction.user.displayAvatarURL({ dynamic: true })
            })
            .setDescription(
                `Daily resets <t:${nextMidnightTs()}:R> · Weekly resets <t:${nextSundayTs()}:R>\n` +
                `Progress: **${completedDailyCount}/${totalDaily}** daily · **${completedWeeklyCount}/${totalWeekly}** weekly`
            )
            .addFields(
                {
                    name: `📅 Daily Quests — base +${dailyXp} XP / +${dailyCoin} coins (scaled by difficulty)`,
                    value: dailyLines.join('\n\n') || '_No daily quests active._'
                },
                {
                    name: `📆 Weekly Quests — base +${weeklyXp} XP / +${weeklyCoin} coins (scaled by difficulty)`,
                    value: weeklyLines.join('\n\n') || '_No weekly quests active._'
                },
                {
                    name: 'Difficulty multipliers',
                    value: '🟢 Easy ×1.0 · 🟡 Medium ×1.75 · 🔴 Hard ×3.0',
                    inline: false
                }
            )
            .setFooter({ text: 'Complete quests to earn XP, coins, and season pass progress.' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};

function buildBar(current, target, length = 12) {
    const filled = Math.min(Math.round((current / target) * length), length);
    return '`[' + '█'.repeat(filled) + '░'.repeat(length - filled) + ']`';
}

function nextMidnightTs() {
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    return Math.floor(d / 1000);
}

function nextSundayTs() {
    const d = new Date();
    const days = (7 - d.getUTCDay()) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d / 1000);
}
