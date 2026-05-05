const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('suggest')
        .setDescription('Submit a suggestion to the server')
        .addStringOption(o =>
            o.setName('suggestion')
                .setDescription('Your suggestion')
                .setRequired(true)
                .setMaxLength(1000)),

    async execute(interaction) {
        const text          = interaction.options.getString('suggestion');
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!guildSettings?.suggestions?.enabled || !guildSettings.suggestions.channelId) {
            return interaction.reply({ content: 'Suggestions are not enabled on this server.', ephemeral: true });
        }

        const channel = interaction.guild.channels.cache.get(guildSettings.suggestions.channelId);
        if (!channel) {
            return interaction.reply({ content: 'The suggestions channel no longer exists. Contact a server admin.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setAuthor({
                name: interaction.member?.displayName || interaction.user.username,
                iconURL: interaction.user.displayAvatarURL()
            })
            .setTitle('💡 New Suggestion')
            .setDescription(text)
            .setFooter({ text: `Submitted by ${interaction.user.tag}` })
            .setTimestamp();

        try {
            const msg = await channel.send({ embeds: [embed] });
            await msg.react(guildSettings.suggestions.upvoteEmoji || '👍').catch(() => {});
            await msg.react(guildSettings.suggestions.downvoteEmoji || '👎').catch(() => {});
            await interaction.reply({ content: `Your suggestion has been posted in ${channel}!`, ephemeral: true });
        } catch (error) {
            console.error('Suggest command error:', error);
            await interaction.reply({ content: 'Failed to post your suggestion. I may not have permission to send messages in that channel.', ephemeral: true });
        }
    }
};
