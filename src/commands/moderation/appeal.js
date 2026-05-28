const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getCase } = require('../../services/caseService');
const Case = require('../../models/Case');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('appeal')
        .setDescription('Appeal a moderation case against you')
        .addIntegerOption(o =>
            o.setName('case_id').setDescription('Case ID to appeal').setRequired(true).setMinValue(1))
        .addStringOption(o =>
            o.setName('reason').setDescription('Why should this action be reversed?').setRequired(true)),

    async execute(interaction) {
        const caseId = interaction.options.getInteger('case_id');
        const reason = interaction.options.getString('reason');

        await interaction.deferReply({ ephemeral: true });

        const modCase = await getCase(interaction.guild.id, caseId);

        if (!modCase) {
            return interaction.editReply({ content: `Case #${caseId} not found.` });
        }
        if (modCase.targetUserId !== interaction.user.id) {
            return interaction.editReply({ content: 'You can only appeal cases that are against you.' });
        }
        if (modCase.status === 'appealed') {
            return interaction.editReply({ content: 'This case is already under appeal.' });
        }
        if (['appeal_approved', 'appeal_denied', 'closed'].includes(modCase.status)) {
            return interaction.editReply({ content: 'This case cannot be appealed.' });
        }

        // Mark as appealed and add appeal note
        await Case.updateOne(
            { guildId: interaction.guild.id, caseId },
            {
                status: 'appealed',
                $push: {
                    notes: {
                        moderatorId: interaction.user.id,
                        content: `[APPEAL] ${reason}`,
                        createdAt: new Date()
                    }
                }
            }
        );

        await interaction.editReply({
            content: 'Your appeal has been submitted. Moderators have been notified.',
        });

        // Post to appeal channel / mod log
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const alertChannelId = guildSettings?.moderation?.appealChannelId
            || guildSettings?.moderation?.logChannelId;
        if (!alertChannelId) return;

        let channel = interaction.guild.channels.cache.get(alertChannelId);
        if (!channel) {
            try {
                channel = await interaction.guild.channels.fetch(alertChannelId);
            } catch {
                return;
            }
        }
        if (!channel || !channel.isTextBased()) return;

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Appeal Filed — Case #${caseId}`)
            .addFields(
                { name: 'User', value: `${interaction.user.globalName ?? interaction.user.username} (<@${interaction.user.id}>)`, inline: true },
                { name: 'Original Action', value: modCase.type.toUpperCase(), inline: true },
                { name: 'Original Reason', value: modCase.reason },
                { name: 'Appeal Reason', value: reason }
            )
            .setFooter({ text: 'Use /closecase to resolve after review' })
            .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(console.error);
    }
};
