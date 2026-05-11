const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');
const { simulate } = require('../../services/escalationService');

const ACTION_CHOICES = [
    { name: 'Mute (timeout)', value: 'mute' },
    { name: 'Kick',           value: 'kick' },
    { name: 'Ban (permanent)', value: 'ban' },
    { name: 'Tempban',        value: 'tempban' }
];

function describeStep(step) {
    let parts = [`**${step.threshold} warns →** ${step.action.toUpperCase()}`];
    if (step.durationMinutes) parts.push(`${step.durationMinutes}m`);
    parts.push(step.dmUser ? 'DM ✓' : 'DM ✗');
    return parts.join(' · ');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('escalation')
        .setDescription('Configure the warning auto-escalation ladder')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Show the current escalation ladder'))
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add or replace a step in the escalation ladder')
                .addIntegerOption(o => o.setName('threshold').setDescription('Warning count that triggers this step').setMinValue(1).setRequired(true))
                .addStringOption(o => o.setName('action').setDescription('Action to apply').setRequired(true).addChoices(...ACTION_CHOICES))
                .addIntegerOption(o => o.setName('duration_minutes').setDescription('Duration in minutes (mute/tempban only)').setMinValue(1).setRequired(false))
                .addBooleanOption(o => o.setName('dm_user').setDescription('DM the user when this fires (default: true)').setRequired(false))
                .addStringOption(o => o.setName('reason').setDescription('Custom reason template (supports {count})').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a step from the ladder')
                .addIntegerOption(o => o.setName('threshold').setDescription('Warning count of the step to remove').setMinValue(1).setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('Remove every step from the ladder'))
        .addSubcommand(sub =>
            sub.setName('reset')
                .setDescription('Reset the ladder to the default (3→mute10m, 5→mute1h, 7→kick, 10→ban)'))
        .addSubcommand(sub =>
            sub.setName('toggle')
                .setDescription('Enable or disable auto-escalation')
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable auto-escalation').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('simulate')
                .setDescription('Preview what would happen at a given warning count')
                .addIntegerOption(o => o.setName('count').setDescription('Number of warnings to simulate').setMinValue(1).setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId },
            { $setOnInsert: { guildId, name: interaction.guild.name } },
            { upsert: true, new: true }
        );
        const escalation = guildSettings.moderation.escalation;

        if (sub === 'list') {
            const ladder = (escalation?.ladder || []).slice().sort((a, b) => a.threshold - b.threshold);
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Escalation Ladder')
                .setDescription(ladder.length ? ladder.map(describeStep).join('\n') : '_No steps configured._')
                .addFields({ name: 'Status', value: escalation?.enabled ? '✅ Enabled' : '❌ Disabled', inline: true })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'add') {
            const threshold       = interaction.options.getInteger('threshold');
            const action          = interaction.options.getString('action');
            const durationMinutes = interaction.options.getInteger('duration_minutes');
            const dmUserOpt       = interaction.options.getBoolean('dm_user');
            const reasonOpt       = interaction.options.getString('reason');

            if ((action === 'mute' || action === 'tempban') && !durationMinutes) {
                return interaction.reply({
                    content: `Action **${action}** requires \`duration_minutes\`.`,
                    ephemeral: true
                });
            }
            if (action === 'mute' && durationMinutes > 40320) {
                return interaction.reply({ content: 'Mute duration cannot exceed 40320 minutes (28 days).', ephemeral: true });
            }

            const ladder = (escalation?.ladder || []).filter(s => s.threshold !== threshold);
            ladder.push({
                threshold,
                action,
                durationMinutes: (action === 'mute' || action === 'tempban') ? durationMinutes : null,
                dmUser: dmUserOpt == null ? true : dmUserOpt,
                reason: reasonOpt || 'Automatic escalation: {count} warnings reached'
            });
            ladder.sort((a, b) => a.threshold - b.threshold);

            await Guild.updateOne({ guildId }, { $set: { 'moderation.escalation.ladder': ladder } });

            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Escalation Step Saved')
                    .setDescription(describeStep(ladder.find(s => s.threshold === threshold)))
                    .setTimestamp()]
            });
        }

        if (sub === 'remove') {
            const threshold = interaction.options.getInteger('threshold');
            const ladder = (escalation?.ladder || []).filter(s => s.threshold !== threshold);
            if (ladder.length === (escalation?.ladder || []).length) {
                return interaction.reply({ content: `No step found at threshold **${threshold}**.`, ephemeral: true });
            }
            await Guild.updateOne({ guildId }, { $set: { 'moderation.escalation.ladder': ladder } });
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#ff9900')
                    .setTitle('Escalation Step Removed')
                    .setDescription(`Removed step at threshold **${threshold}**.`)
                    .setTimestamp()]
            });
        }

        if (sub === 'clear') {
            await Guild.updateOne({ guildId }, { $set: { 'moderation.escalation.ladder': [] } });
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#ff9900')
                    .setTitle('Escalation Ladder Cleared')
                    .setDescription('All steps have been removed.')
                    .setTimestamp()]
            });
        }

        if (sub === 'reset') {
            const defaults = [
                { threshold: 3,  action: 'mute', durationMinutes: 10,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
                { threshold: 5,  action: 'mute', durationMinutes: 60,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
                { threshold: 7,  action: 'kick', durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
                { threshold: 10, action: 'ban',  durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' }
            ];
            await Guild.updateOne({ guildId }, { $set: { 'moderation.escalation.ladder': defaults } });
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Escalation Ladder Reset')
                    .setDescription(defaults.map(describeStep).join('\n'))
                    .setTimestamp()]
            });
        }

        if (sub === 'toggle') {
            const enabled = interaction.options.getBoolean('enabled');
            await Guild.updateOne({ guildId }, { $set: { 'moderation.escalation.enabled': enabled } });
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(enabled ? '#00ff00' : '#ff0000')
                    .setTitle(`Auto-Escalation ${enabled ? 'Enabled' : 'Disabled'}`)
                    .setTimestamp()]
            });
        }

        if (sub === 'simulate') {
            const count = interaction.options.getInteger('count');
            const step = simulate(escalation?.ladder || [], count);
            const embed = new EmbedBuilder()
                .setColor(step ? '#cc3300' : '#888888')
                .setTitle(`Simulation: ${count} warning(s)`)
                .setDescription(step
                    ? `Would trigger **${step.action.toUpperCase()}**${step.durationMinutes ? ` for ${step.durationMinutes} minute(s)` : ''}.\nReason: ${step.reason.replace(/\{count\}/g, count)}`
                    : `No ladder step matches **${count}**. No auto-action would fire.`)
                .setFooter({ text: escalation?.enabled ? 'Escalation is enabled.' : 'Escalation is currently disabled — nothing would actually fire.' })
                .setTimestamp();
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
};
