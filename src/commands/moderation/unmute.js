const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Remove timeout from a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to unmute')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);

        if (!member) {
            return interaction.reply({ content: 'User not found!', ephemeral: true });
        }

        try {
            await member.timeout(null);

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('User Unmuted')
                .setDescription(`**${user.tag}** has been unmuted.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Unmute error:', error);
            await interaction.reply({ content: 'Failed to unmute the user.', ephemeral: true });
        }
    }
};