const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('massban')
        .setDescription('Ban multiple users by ID — useful for raid cleanup')
        .addStringOption(o =>
            o.setName('user_ids')
                .setDescription('Space or comma-separated list of user IDs')
                .setRequired(true))
        .addStringOption(o =>
            o.setName('reason')
                .setDescription('Reason applied to all bans')
                .setMaxLength(1024)
                .setRequired(false))
        .addIntegerOption(o =>
            o.setName('delete_days')
                .setDescription('Days of messages to delete per user (0–7)')
                .setMinValue(0)
                .setMaxValue(7)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply();

        const raw        = interaction.options.getString('user_ids');
        const reason     = interaction.options.getString('reason') || 'Mass ban';
        const deleteDays = interaction.options.getInteger('delete_days') ?? 0;

        const ids = [...new Set(raw.split(/[\s,]+/).filter(id => /^\d{17,20}$/.test(id)))];

        if (ids.length === 0) {
            return interaction.editReply('No valid user IDs found. Provide 17–20 digit Discord IDs.');
        }
        if (ids.length > 50) {
            return interaction.editReply('Maximum 50 users per mass ban. Split into multiple calls if needed.');
        }

        const succeeded = [];
        const failed    = [];

        for (const userId of ids) {
            if (userId === interaction.user.id || userId === interaction.client.user.id) {
                failed.push(userId);
                continue;
            }
            try {
                await interaction.guild.members.ban(userId, {
                    deleteMessageSeconds: deleteDays * 86400,
                    reason: `[MassBan] ${reason}`
                });
                succeeded.push(userId);

                const fetchedUser = await interaction.client.users.fetch(userId).catch(() => ({ id: userId, tag: userId }));
                await logModeration(interaction.guild.id, 'ban', fetchedUser, interaction.user, `[MassBan] ${reason}`);
            } catch {
                failed.push(userId);
            }
        }

        const embed = new EmbedBuilder()
            .setColor(failed.length === 0 ? '#ff0000' : '#ff9900')
            .setTitle('Mass Ban Complete')
            .addFields(
                { name: 'Banned', value: `${succeeded.length} user(s)`, inline: true },
                { name: 'Failed', value: `${failed.length} user(s)`, inline: true },
                { name: 'Reason', value: reason.slice(0, 1024) }
            )
            .setTimestamp();

        if (failed.length > 0) {
            embed.addFields({ name: 'Failed IDs', value: failed.slice(0, 20).join(', ') });
        }

        await interaction.editReply({ embeds: [embed] });
    }
};
