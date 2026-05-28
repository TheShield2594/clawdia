const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getCasesForUser } = require('../../services/caseService');

const TYPE_EMOJI = {
    ban: '🔨', kick: '👢', mute: '🔇', warn: '⚠️',
    unban: '✅', unmute: '🔊', note: '📝', appeal: '📋'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('cases')
        .setDescription('List moderation cases for a user')
        .addUserOption(o =>
            o.setName('user').setDescription('User to look up').setRequired(true))
        .addIntegerOption(o =>
            o.setName('limit').setDescription('Number of cases to show (default 10, max 25)')
                .setMinValue(1).setMaxValue(25).setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') ?? 10;

        const cases = await getCasesForUser(interaction.guild.id, user.id, limit);

        if (!cases.length) {
            return interaction.reply({ content: `No cases found for ${user.globalName ?? user.username}.`, ephemeral: true });
        }

        const lines = cases.map(c =>
            `\`#${String(c.caseId).padStart(4, '0')}\` ${TYPE_EMOJI[c.type] || '•'} **${c.type.toUpperCase()}** — ${(c.reason ?? 'No reason provided').slice(0, 60)} — <t:${Math.floor(c.createdAt.getTime() / 1000)}:d>`
        );

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Cases for ${user.globalName ?? user.username}`)
            .setThumbnail(user.displayAvatarURL())
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Showing ${cases.length} most recent case(s)` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
