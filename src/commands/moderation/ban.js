const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../utils/logger');
const TempBan = require('../../models/TempBan');

const DURATION_RE = /^(\d+)(m|h|d)$/i;

function parseDuration(str) {
    if (!str) return null;
    const m = str.trim().match(DURATION_RE);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit === 'm') return n * 60_000;
    if (unit === 'h') return n * 3_600_000;
    if (unit === 'd') return n * 86_400_000;
    return null;
}

function formatDuration(ms) {
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    return parts.join(' ') || '< 1m';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member from the server')
        .addUserOption(o =>
            o.setName('user')
                .setDescription('The user to ban')
                .setRequired(true))
        .addStringOption(o =>
            o.setName('reason')
                .setDescription('Reason for the ban')
                .setRequired(false))
        .addStringOption(o =>
            o.setName('duration')
                .setDescription('Temporary ban duration e.g. 30m, 12h, 7d (omit for permanent)')
                .setRequired(false))
        .addIntegerOption(o =>
            o.setName('delete_days')
                .setDescription('Delete messages from the last X days (0–7)')
                .setMinValue(0)
                .setMaxValue(7)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        const user        = interaction.options.getUser('user');
        const reason      = interaction.options.getString('reason') || 'No reason provided';
        const durationStr = interaction.options.getString('duration');
        const deleteDays  = interaction.options.getInteger('delete_days') || 0;

        if (user.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot ban yourself.', ephemeral: true });
        }
        if (user.id === interaction.client.user.id) {
            return interaction.reply({ content: 'I cannot ban myself.', ephemeral: true });
        }

        const member = interaction.guild.members.cache.get(user.id);
        if (member && !member.bannable) {
            return interaction.reply({ content: 'I cannot ban this user — they may have higher permissions.', ephemeral: true });
        }

        let durationMs = null;
        if (durationStr) {
            durationMs = parseDuration(durationStr);
            if (!durationMs) {
                return interaction.reply({ content: 'Invalid duration format. Use e.g. `30m`, `12h`, `7d`.', ephemeral: true });
            }
        }

        try {
            await interaction.guild.members.ban(user, { deleteMessageSeconds: deleteDays * 86400, reason });

            if (durationMs) {
                await TempBan.create({
                    guildId:     interaction.guild.id,
                    userId:      user.id,
                    moderatorId: interaction.user.id,
                    reason,
                    expiresAt:   new Date(Date.now() + durationMs)
                });
            }

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle(durationMs ? 'User Temporarily Banned' : 'User Banned')
                .setDescription(`**${user.tag}** has been banned from the server.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.tag }
                )
                .setTimestamp();

            if (durationMs) {
                embed.addFields(
                    { name: 'Duration', value: formatDuration(durationMs), inline: true },
                    { name: 'Expires', value: `<t:${Math.floor((Date.now() + durationMs) / 1000)}:R>`, inline: true }
                );
            }

            await interaction.reply({ embeds: [embed] });
            await logModeration(interaction.guild.id, 'ban', user, interaction.user, reason,
                durationMs ? { duration: Math.round(durationMs / 60000) } : {});
        } catch (error) {
            console.error('Ban error:', error);
            await interaction.reply({ content: 'Failed to ban the user.', ephemeral: true });
        }
    }
};
