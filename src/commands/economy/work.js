const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('work')
        .setDescription('Work to earn some coins'),
    cooldown: 3600,
    async execute(interaction) {
        try {
            let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (!user) {
                user = await User.create({
                    userId: interaction.user.id,
                    guildId: interaction.guild.id
                });
            }

            const now = Date.now();
            const workCooldown = 3600000;

            if (user.lastWork && now - user.lastWork.getTime() < workCooldown) {
                const timeLeft = workCooldown - (now - user.lastWork.getTime());
                const minutes = Math.floor(timeLeft / 60000);
                
                return interaction.reply({
                    content: `You're too tired to work! Rest for ${minutes} more minutes.`,
                    ephemeral: true
                });
            }

            const workMin = guildSettings?.economy.workMin || 50;
            const workMax = guildSettings?.economy.workMax || 150;
            const earned = Math.floor(Math.random() * (workMax - workMin + 1)) + workMin;

            const defaultJobs = [
                'developer', 'designer', 'teacher', 'chef', 'driver',
                'doctor', 'engineer', 'artist', 'musician', 'writer'
            ];
            const guildJobs = guildSettings?.jobs?.length > 0
                ? guildSettings.jobs.map(j => j.emoji ? `${j.emoji} ${j.name}` : j.name)
                : defaultJobs;
            const job = guildJobs[Math.floor(Math.random() * guildJobs.length)];

            user.balance += earned;
            user.lastWork = new Date();
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Work Complete!')
                .setDescription(`You worked as a **${job}** and earned **${earned}** coins!`)
                .addFields(
                    { name: 'New Balance', value: `${user.balance.toLocaleString()} coins` }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Work error:', error);
            await interaction.reply({ content: 'Failed to work.', ephemeral: true });
        }
    }
};