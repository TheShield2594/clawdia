const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const {
    openTicket, closeTicket, postTicketPanel, isSupportMember, findOpenTicket,
} = require('../../services/ticketService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Open a private ticket with the moderators, or manage the ticket system')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('open')
                .setDescription('Open a private ticket with the server team')
                .addStringOption(o =>
                    o.setName('subject').setDescription('What do you need help with?').setMaxLength(200)))
        .addSubcommand(sub =>
            sub.setName('close')
                .setDescription('Close the ticket in this thread')
                .addStringOption(o =>
                    o.setName('reason').setDescription('Why the ticket is being closed').setMaxLength(200)))
        .addSubcommand(sub =>
            sub.setName('panel')
                .setDescription('Post an "Open a ticket" button in this channel (Manage Server)')),

    // Opening a ticket creates a thread, adds members and posts an embed, which
    // can run past Discord's three-second window; every reply here is ephemeral,
    // so an ephemeral deferral up front is safe for all three subcommands.
    deferral: 'ephemeral',

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const settings = await getGuildSettings(interaction.guild.id);

        if (sub === 'open') {
            const subject = interaction.options.getString('subject') || '';
            const result = await openTicket({ guild: interaction.guild, member: interaction.member, subject, settings });
            return interaction.editReply({
                content: result.ok ? `🎫 Ticket opened: <#${result.thread.id}>` : result.message,
            });
        }

        if (sub === 'close') {
            const threadId = interaction.channelId;
            const record = await findOpenTicket(interaction.guild.id, threadId);
            if (!record) {
                return interaction.editReply({ content: 'Run this inside an open ticket thread to close it.' });
            }
            const isOpener = record.openerId === interaction.user.id;
            if (!isOpener && !isSupportMember(interaction.member, settings)) {
                return interaction.editReply({ content: 'Only support staff or the person who opened this ticket can close it.' });
            }
            const reason = interaction.options.getString('reason') || 'Closed';
            await closeTicket({ guild: interaction.guild, guildId: interaction.guild.id, threadId, closedById: interaction.user.id, reason });
            return interaction.editReply({ content: '🔒 Ticket closed.' });
        }

        // panel — Manage Server only, and only in a normal text channel.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.editReply({ content: 'You need the **Manage Server** permission to post a ticket panel.' });
        }
        if (interaction.channel?.type !== ChannelType.GuildText) {
            return interaction.editReply({ content: 'Post the ticket panel in a normal text channel.' });
        }
        if (!settings?.tickets?.enabled) {
            return interaction.editReply({ content: 'Enable tickets in the dashboard before posting a panel.' });
        }
        try {
            await postTicketPanel(interaction.channel, settings);
            return interaction.editReply({ content: 'Posted the ticket panel here.' });
        } catch (err) {
            console.error('[tickets] panel post failed:', err.message);
            return interaction.editReply({ content: 'I could not post the panel here — check my permissions in this channel.' });
        }
    },
};
