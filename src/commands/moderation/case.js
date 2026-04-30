const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getCase } = require('../../services/caseService');

const TYPE_COLORS = {
    ban: '#ff0000', kick: '#ff9900', mute: '#ff6600',
    warn: '#ffff00', unban: '#00ff00', unmute: '#00ff00',
    note: '#888888', appeal: '#5865F2'
};

const STATUS_EMOJI = {
    open: '🔴', closed: '🟢', appealed: '🟡',
    appeal_approved: '✅', appeal_denied: '❌'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('case')
        .setDescription('View a moderation case')
        .addIntegerOption(o =>
            o.setName('id').setDescription('Case ID number').setRequired(true).setMinValue(1))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const caseId = interaction.options.getInteger('id');
        const modCase = await getCase(interaction.guild.id, caseId);

        if (!modCase) {
            return interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor(TYPE_COLORS[modCase.type] || '#999999')
            .setTitle(`Case #${modCase.caseId} — ${modCase.type.toUpperCase()}`)
            .addFields(
                { name: 'Target', value: `<@${modCase.targetUserId}> (${modCase.targetUserId})`, inline: true },
                { name: 'Moderator', value: `<@${modCase.moderatorId}>`, inline: true },
                { name: 'Status', value: `${STATUS_EMOJI[modCase.status] || '⚪'} ${modCase.status}`, inline: true },
                { name: 'Reason', value: modCase.reason }
            )
            .setTimestamp(modCase.createdAt);

        if (modCase.duration) {
            embed.addFields({ name: 'Duration', value: `${modCase.duration} minutes`, inline: true });
        }

        if (modCase.evidence?.jumpUrl) {
            embed.addFields({ name: 'Evidence', value: `[Jump to message](${modCase.evidence.jumpUrl})`, inline: true });
        }
        if (modCase.evidence?.content) {
            embed.addFields({ name: 'Message Snapshot', value: modCase.evidence.content.slice(0, 300) });
        }

        if (modCase.assignedModId) {
            embed.addFields({ name: 'Assigned To', value: `<@${modCase.assignedModId}>`, inline: true });
        }
        if (modCase.slaDeadline && modCase.status === 'open') {
            embed.addFields({ name: 'SLA Deadline', value: `<t:${Math.floor(modCase.slaDeadline.getTime() / 1000)}:R>`, inline: true });
        }
        if (modCase.resolution) {
            embed.addFields({ name: 'Resolution', value: modCase.resolution });
        }

        if (modCase.notes?.length) {
            const notesText = modCase.notes
                .slice(-3)
                .map((n, i) => `**${i + 1}.** <@${n.moderatorId}>: ${n.content}`)
                .join('\n');
            embed.addFields({ name: `Notes (last ${Math.min(3, modCase.notes.length)})`, value: notesText });
        }

        if (modCase.labels?.length) {
            embed.addFields({ name: 'Labels', value: modCase.labels.join(', '), inline: true });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
