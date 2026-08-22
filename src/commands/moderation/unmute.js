const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Remove timeout from a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to unmute')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);

        if (!member) {
            return interaction.reply({ content: 'User not found!', flags: MessageFlags.Ephemeral });
        }

        try {
            await member.timeout(null);

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('User Unmuted')
                .setDescription(`**${user.globalName ?? user.username}** has been unmuted.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Unmute error:', error);
            await interaction.reply({ content: 'Failed to unmute the user.', flags: MessageFlags.Ephemeral });
        }
    }
};