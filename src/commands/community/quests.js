const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { ensureQuests, getQuestDefs } = require('../../services/questService');

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

        const defs = getQuestDefs();
        const now = new Date();

        const dailyLines = [];
        const weeklyLines = [];

        for (const def of defs) {
            const entry = user.quests.find(q => q.questId === def.questId && q.expiresAt > now);
            if (!entry) continue;

            const progress = entry.progress ?? 0;
            const completed = !!entry.completedAt;
            const bar = buildBar(progress, def.target);
            const status = completed ? '✅' : '🔄';
            const line = `${status} **${def.name}** — ${def.description}\n${bar} ${progress}/${def.target}`;

            if (def.type === 'daily') dailyLines.push(line);
            else weeklyLines.push(line);
        }

        const dailyCoin = guildSettings.quests.dailyCoinReward ?? 25;
        const dailyXp = guildSettings.quests.dailyXpReward ?? 50;
        const weeklyCoin = guildSettings.quests.weeklyCoinReward ?? 150;
        const weeklyXp = guildSettings.quests.weeklyXpReward ?? 300;

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`${interaction.user.displayName}'s Quests`)
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                {
                    name: `Daily Quests (resets in <t:${nextMidnightTs()}:R>) — +${dailyXp} XP, +${dailyCoin} coins each`,
                    value: dailyLines.join('\n\n') || 'No daily quests active.'
                },
                {
                    name: `Weekly Quests (resets <t:${nextSundayTs()}:R>) — +${weeklyXp} XP, +${weeklyCoin} coins each`,
                    value: weeklyLines.join('\n\n') || 'No weekly quests active.'
                }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};

function buildBar(current, target, length = 10) {
    const filled = Math.round((current / target) * length);
    return '[' + '█'.repeat(Math.min(filled, length)) + '░'.repeat(Math.max(length - filled, 0)) + ']';
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
