const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const Case = require('../../models/Case');
const { logModeration } = require('../../services/moderationLogService');
const { applyEscalation, findStepForCount } = require('../../services/escalationService');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const User = require('../../models/User');
const { fitDescription, truncate, EMBED_LIMITS } = require('../../utils/embedFields');
const COLORS = require('../../utils/embedColors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Manage member warnings')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Issue a warning to a member')
                .addUserOption(o => o.setName('user').setDescription('The user to warn').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(true))
                .addBooleanOption(o => o.setName('bypass_escalation').setDescription('Suppress auto-escalation for this warning (requires Manage Messages)').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all warnings for a member')
                .addUserOption(o => o.setName('user').setDescription('The user to look up').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a warning by its case ID')
                .addIntegerOption(o => o.setName('case_id').setDescription('The case ID of the warning to remove').setRequired(true).setMinValue(1)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const user   = interaction.options.getUser('user');
            const reason = interaction.options.getString('reason');
            const bypassRequested = interaction.options.getBoolean('bypass_escalation') === true;

            if (user.bot) return interaction.reply({ content: 'You cannot warn bots.', flags: MessageFlags.Ephemeral });

            await interaction.deferReply();

            try {
                const triggeringCase = await logModeration(interaction.guild.id, 'warn', user, interaction.user, reason);

                // Track last warning date for Clean Record achievement
                try {
                    await User.findOneAndUpdate(
                        { userId: user.id, guildId: interaction.guild.id },
                        { $set: { lastWarnedAt: new Date() } },
                        { upsert: true }
                    );
                } catch (updateErr) {
                    console.error(`[warn] Failed to set lastWarnedAt for user ${user.id} in guild ${interaction.guild.id}:`, updateErr);
                }

                const warningCount = await Case.countDocuments({
                    guildId: interaction.guild.id,
                    targetUserId: user.id,
                    type: 'warn'
                });

                const canBypass = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
                const bypassEscalation = bypassRequested && canBypass;

                const guildSettings = await getGuildSettings(interaction.guild.id);
                // Only ever read by the bypass branches below, to say what the
                // bypass suppressed — when escalation is going to run,
                // applyEscalation looks the step up itself. The condition used
                // to be `!bypassEscalation`, which computed it in exactly the
                // case nothing reads it and left it null in the case that does:
                // "would have triggered MUTE at 3 warnings" was unreachable,
                // and every honoured bypass claimed there was no step anyway.
                const matchedStep = bypassEscalation
                    ? findStepForCount(guildSettings?.moderation?.escalation?.ladder, warningCount)
                    : null;

                const embed = new EmbedBuilder()
                    .setColor(COLORS.WARN)
                    .setTitle('User Warned')
                    .setDescription(`**${user.globalName ?? user.username}** has been warned.`)
                    .addFields(
                        { name: 'Reason', value: truncate(reason, EMBED_LIMITS.FIELD_VALUE) },
                        { name: 'Total Warnings', value: warningCount.toString() },
                        { name: 'Moderator', value: interaction.user.globalName ?? interaction.user.username }
                    )
                    .setTimestamp();

                if (bypassRequested && !canBypass) {
                    embed.addFields({ name: 'Escalation Bypass', value: 'Requested but ignored — requires Manage Messages.' });
                } else if (bypassEscalation && matchedStep === null) {
                    embed.addFields({ name: 'Escalation', value: 'Bypassed (no matching step at this count anyway).' });
                } else if (bypassEscalation) {
                    embed.addFields({ name: 'Escalation', value: `Bypassed — would have triggered ${matchedStep?.action?.toUpperCase()} at ${warningCount} warnings.` });
                }

                await interaction.editReply({ embeds: [embed] });
                await user.send(`You have been warned in **${interaction.guild.name}** for: ${reason}`).catch(() => {});

                if (!bypassEscalation && guildSettings?.moderation?.escalation?.enabled) {
                    const result = await applyEscalation({
                        guild: interaction.guild,
                        targetUser: user,
                        warningCount,
                        triggeringCase,
                        client: interaction.client
                    });
                    if (result?.applied) {
                        await interaction.followUp({
                            embeds: [new EmbedBuilder()
                                .setColor(COLORS.WARN)
                                .setTitle('Auto-Escalation Triggered')
                                .setDescription(`Threshold **${result.step.threshold}** reached — applied **${result.step.action.toUpperCase()}**${result.step.durationMinutes ? ` for ${result.step.durationMinutes} minute(s)` : ''}.`)
                                .addFields({ name: 'Target', value: `${user.globalName ?? user.username}`, inline: true })
                                .setTimestamp()]
                        }).catch(() => {});
                    } else if (result?.skipped) {
                        await interaction.followUp({
                            content: `Auto-escalation step **${result.step.threshold} → ${result.step.action.toUpperCase()}** skipped: ${result.reason}`,
                            flags: MessageFlags.Ephemeral
                        }).catch(() => {});
                    } else if (result?.error) {
                        await interaction.followUp({
                            content: `Auto-escalation step **${result.step.threshold} → ${result.step.action.toUpperCase()}** failed — see logs.`,
                            flags: MessageFlags.Ephemeral
                        }).catch(() => {});
                    }
                }
            } catch (error) {
                console.error('Warn error:', error);
                if (!interaction.replied) {
                    await interaction.editReply({ content: 'Failed to warn the user.' });
                }
            }
        } else if (sub === 'list') {
            const user = interaction.options.getUser('user');

            try {
                const warnings = await Case.find({
                    guildId: interaction.guild.id,
                    targetUserId: user.id,
                    type: 'warn'
                }).sort({ createdAt: -1 }).limit(20);

                if (!warnings.length) {
                    return interaction.reply({ content: `${user.globalName ?? user.username} has no warnings.`, flags: MessageFlags.Ephemeral });
                }

                // `reason` is a required string option with no length cap, so
                // it arrives at up to Discord's own 6,000-character ceiling —
                // one long-winded warning was enough to put this list past the
                // 4,096 an embed description allows, and discord.js throws
                // rather than truncating. Cap each line, then drop whole lines
                // off the end and say how many, so a moderator sees the recent
                // warnings instead of an error.
                const PER_WARNING = 300;
                const lines = warnings.map(w => {
                    const date = w.createdAt.toISOString().slice(0, 10);
                    return truncate(`**#${w.caseId}** \`${date}\` — ${w.reason}`, PER_WARNING);
                });
                const { text, omitted } = fitDescription(lines);

                const embed = new EmbedBuilder()
                    .setColor(COLORS.WARN)
                    .setTitle(`Warnings for ${user.globalName ?? user.username}`)
                    .setDescription(text)
                    .setFooter({ text: `${warnings.length - omitted} of ${warnings.length} warning(s) shown · use /warn remove <case_id> to clear one` })
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Warn list error:', error);
                if (!interaction.replied) {
                    await interaction.reply({ content: 'Failed to fetch warnings.', flags: MessageFlags.Ephemeral });
                }
            }
        } else if (sub === 'remove') {
            const caseId = interaction.options.getInteger('case_id');

            try {
                const warnCase = await Case.findOne({
                    guildId: interaction.guild.id,
                    caseId,
                    type: 'warn'
                });

                if (!warnCase) {
                    return interaction.reply({ content: `Warning case #${caseId} not found in this server.`, flags: MessageFlags.Ephemeral });
                }

                await Case.deleteOne({ _id: warnCase._id });

                const embed = new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle('Warning Removed')
                    .setDescription(`Case **#${caseId}** has been deleted.`)
                    .addFields(
                        { name: 'Original Reason', value: truncate(warnCase.reason, EMBED_LIMITS.FIELD_VALUE) },
                        { name: 'Removed by', value: interaction.user.globalName ?? interaction.user.username }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Warn remove error:', error);
                if (!interaction.replied) {
                    await interaction.reply({ content: 'Failed to remove the warning.', flags: MessageFlags.Ephemeral });
                }
            }
        }
    }
};
