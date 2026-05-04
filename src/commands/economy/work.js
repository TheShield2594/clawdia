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

            const jobTiers = [
                { name: 'Intern', minShifts: 0, payMultiplier: 1, jobs: ['assistant', 'cashier', 'dishwasher', 'courier'] },
                { name: 'Skilled Worker', minShifts: 10, payMultiplier: 1.2, jobs: ['developer', 'designer', 'teacher', 'chef', 'driver'] },
                { name: 'Senior Specialist', minShifts: 25, payMultiplier: 1.45, jobs: ['engineer', 'artist', 'musician', 'writer', 'analyst'] },
                { name: 'Executive', minShifts: 50, payMultiplier: 1.8, jobs: ['director', 'architect', 'surgeon', 'producer', 'founder'] }
            ];

            const currentShifts = user.shiftsWorked || 0;
            const activeTier = [...jobTiers].reverse().find(tier => currentShifts >= tier.minShifts) || jobTiers[0];
            const nextTier = jobTiers.find(tier => tier.minShifts > currentShifts);

            const tierMin = Math.floor(workMin * activeTier.payMultiplier);
            const tierMax = Math.floor(workMax * activeTier.payMultiplier);
            const earned = Math.floor(Math.random() * (tierMax - tierMin + 1)) + tierMin;

            const guildJobs = guildSettings?.jobs?.length > 0
                ? guildSettings.jobs.map(j => j.emoji ? `${j.emoji} ${j.name}` : j.name)
                : activeTier.jobs;
            const job = guildJobs[Math.floor(Math.random() * guildJobs.length)];

            user.balance += earned;
            user.shiftsWorked = currentShifts + 1;
            user.lastWork = new Date();
            await user.save();

            const leveledUpTier = jobTiers.find(tier => tier.minShifts === user.shiftsWorked);

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Work Complete!')
                .setDescription(`You worked as a **${job}** and earned **${earned}** coins!`)
                .addFields(
                    { name: 'Career Tier', value: `${activeTier.name} (${user.shiftsWorked.toLocaleString()} shifts worked)` },
                    { name: 'New Balance', value: `${user.balance.toLocaleString()} coins` },
                    {
                        name: 'Next Promotion',
                        value: nextTier
                            ? `${nextTier.name} in **${(nextTier.minShifts - user.shiftsWorked).toLocaleString()}** shifts`
                            : 'You have reached the highest career tier!'
                    }
                )
                .setTimestamp();

            if (leveledUpTier && leveledUpTier.minShifts > 0) {
                embed.addFields({
                    name: '🎉 Promotion Unlocked!',
                    value: `You advanced to **${leveledUpTier.name}** and now earn higher pay per shift!`
                });
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Work error:', error);
            await interaction.reply({ content: 'Failed to work.', ephemeral: true });
        }
    }
};
