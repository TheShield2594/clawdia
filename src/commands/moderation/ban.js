const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial, resolveMember } = require('../../utils/moderationHierarchy');
const { sendPublicResponse, sendEphemeralResponse } = require('../../utils/interactionAck');
const TempBan = require('../../models/TempBan');
const COLORS = require('../../utils/embedColors');

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

    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.BanMembers],

    // Acknowledged up front by the dispatcher (#995): resolveMember below can
    // miss the member cache and fetch from the gateway, which — stacked on the
    // dispatcher's own settings and cooldown reads — can outrun Discord's
    // three-second window. A public deferral keeps the success embed in the
    // channel; refusals are delivered ephemerally by sendEphemeralResponse.
    deferral: { ephemeral: false },
    async execute(interaction) {
        const user        = interaction.options.getUser('user');
        const reason      = interaction.options.getString('reason') || 'No reason provided';
        const durationStr = interaction.options.getString('duration');
        const deleteDays  = interaction.options.getInteger('delete_days') || 0;

        if (user.id === interaction.user.id) {
            return sendEphemeralResponse(interaction, { content: 'You cannot ban yourself.' });
        }
        if (user.id === interaction.client.user.id) {
            return sendEphemeralResponse(interaction, { content: 'I cannot ban myself.' });
        }

        const { member, indeterminate } = await resolveMember(interaction.guild, user.id);
        // Not the same as "not in the guild": we could not find out. Proceeding
        // would skip both checks below on a target who may well outrank you.
        if (indeterminate) {
            return sendEphemeralResponse(interaction, {
                content: 'I could not look this user up just now, so I have not banned them. Try again in a moment.',
            });
        }

        if (member && !member.bannable) {
            return sendEphemeralResponse(interaction, { content: 'I cannot ban this user — they may have higher permissions.' });
        }

        // `bannable` above answered whether the bot outranks the target. This
        // answers whether the moderator does.
        const denial = hierarchyDenial(interaction.member, member, 'ban');
        if (denial) {
            return sendEphemeralResponse(interaction, { content: denial });
        }

        let durationMs = null;
        if (durationStr) {
            durationMs = parseDuration(durationStr);
            if (durationMs === null) {
                return sendEphemeralResponse(interaction, { content: 'Invalid duration format. Use e.g. `30m`, `12h`, `7d`.' });
            }
        }

        try {
            if (durationMs) {
                await TempBan.findOneAndUpdate(
                    { guildId: interaction.guild.id, userId: user.id },
                    { moderatorId: interaction.user.id, reason, expiresAt: new Date(Date.now() + durationMs) },
                    { upsert: true }
                );
            }

            await interaction.guild.members.ban(user, { deleteMessageSeconds: deleteDays * 86400, reason });

            const embed = new EmbedBuilder()
                .setColor(COLORS.ERROR)
                .setTitle(durationMs ? 'User Temporarily Banned' : 'User Banned')
                .setDescription(`**${user.globalName ?? user.username}** has been banned from the server.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.globalName ?? interaction.user.username }
                )
                .setTimestamp();

            if (durationMs) {
                embed.addFields(
                    { name: 'Duration', value: formatDuration(durationMs), inline: true },
                    { name: 'Expires', value: `<t:${Math.floor((Date.now() + durationMs) / 1000)}:R>`, inline: true }
                );
            }

            await sendPublicResponse(interaction, { embeds: [embed] });
            await logModeration(interaction.guild.id, 'ban', user, interaction.user, reason,
                durationMs ? { duration: Math.round(durationMs / 60000) } : {});
        } catch (error) {
            console.error('Ban error:', error);
            await sendEphemeralResponse(interaction, { content: 'Failed to ban the user.' }).catch(() => {});
        }
    }
};
