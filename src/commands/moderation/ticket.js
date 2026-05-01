const {
    SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType
} = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Ticket system')
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Configure the ticket system')
                .addChannelOption(o => o.setName('category').setDescription('Category to create tickets in').setRequired(true))
                .addRoleOption(o => o.setName('support_role').setDescription('Role that can see tickets').setRequired(true))
                .addChannelOption(o => o.setName('log_channel').setDescription('Channel to log closed tickets'))
                .addStringOption(o => o.setName('open_message').setDescription('Message sent when a ticket is opened')))
        .addSubcommand(sub =>
            sub.setName('open')
                .setDescription('Open a support ticket'))
        .addSubcommand(sub =>
            sub.setName('close')
                .setDescription('Close this ticket'))
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a user to this ticket')
                .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a user from this ticket')
                .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'You need Manage Server permission to set up tickets.', ephemeral: true });
            }

            const category = interaction.options.getChannel('category');
            const supportRole = interaction.options.getRole('support_role');
            const logChannel = interaction.options.getChannel('log_channel');
            const openMessage = interaction.options.getString('open_message');

            if (category.type !== ChannelType.GuildCategory) {
                return interaction.reply({ content: 'Please select a category channel.', ephemeral: true });
            }

            guildSettings.tickets.enabled = true;
            guildSettings.tickets.categoryId = category.id;
            guildSettings.tickets.supportRoleId = supportRole.id;
            if (logChannel) guildSettings.tickets.logChannelId = logChannel.id;
            if (openMessage) guildSettings.tickets.openMessage = openMessage;
            await guildSettings.save();

            await interaction.reply({
                content: `Ticket system enabled.\nCategory: ${category}\nSupport role: ${supportRole}${logChannel ? `\nLog channel: ${logChannel}` : ''}`
            });

        } else if (sub === 'open') {
            if (!guildSettings.tickets.enabled) {
                return interaction.reply({ content: 'The ticket system is not configured. Ask an admin to run `/ticket setup`.', ephemeral: true });
            }

            const category = interaction.guild.channels.cache.get(guildSettings.tickets.categoryId);
            if (!category) {
                return interaction.reply({ content: 'Ticket category not found. Ask an admin to re-run `/ticket setup`.', ephemeral: true });
            }

            const existing = interaction.guild.channels.cache.find(
                ch => ch.name === `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}` &&
                      ch.parentId === category.id
            );
            if (existing) {
                return interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
            }

            guildSettings.tickets.count += 1;
            await guildSettings.save();

            const channel = await interaction.guild.channels.create({
                name: `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
                type: ChannelType.GuildText,
                parent: category.id,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: ['ViewChannel'] },
                    { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
                    { id: guildSettings.tickets.supportRoleId, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'] },
                    { id: interaction.client.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'] }
                ]
            });

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`Ticket #${guildSettings.tickets.count}`)
                .setDescription(guildSettings.tickets.openMessage)
                .addFields({ name: 'Opened by', value: interaction.user.toString() })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close')
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒')
            );

            await channel.send({ content: `${interaction.user} <@&${guildSettings.tickets.supportRoleId}>`, embeds: [embed], components: [row] });
            await interaction.reply({ content: `Your ticket has been opened: ${channel}`, ephemeral: true });

        } else if (sub === 'close') {
            await closeTicket(interaction, guildSettings);

        } else if (sub === 'add') {
            const user = interaction.options.getUser('user');
            await interaction.channel.permissionOverwrites.create(user, {
                ViewChannel: true, SendMessages: true, ReadMessageHistory: true
            });
            await interaction.reply({ content: `Added ${user} to the ticket.` });

        } else if (sub === 'remove') {
            const user = interaction.options.getUser('user');
            if (user.id === interaction.guild.ownerId) {
                return interaction.reply({ content: 'Cannot remove the server owner.', ephemeral: true });
            }
            await interaction.channel.permissionOverwrites.delete(user);
            await interaction.reply({ content: `Removed ${user} from the ticket.` });
        }
    }
};

async function closeTicket(interaction, guildSettings) {
    const channel = interaction.channel;

    if (!channel.name.startsWith('ticket-')) {
        return interaction.reply({ content: 'This command can only be used in a ticket channel.', ephemeral: true });
    }

    const hasSupportRole = guildSettings.tickets.supportRoleId &&
        interaction.member.roles.cache.has(guildSettings.tickets.supportRoleId);
    const isChannelOwner = channel.permissionOverwrites.cache.has(interaction.user.id);

    if (!hasSupportRole && !isChannelOwner && !interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({ content: 'You do not have permission to close this ticket.', ephemeral: true });
    }

    await interaction.reply({ content: 'Closing ticket in 5 seconds...' });

    if (guildSettings.tickets.logChannelId) {
        const logChannel = interaction.guild.channels.cache.get(guildSettings.tickets.logChannelId);
        if (logChannel) {
            const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
            let transcript = `Ticket Transcript: #${channel.name}\nClosed by: ${interaction.user.tag}\nDate: ${new Date().toUTCString()}\n${'─'.repeat(60)}\n`;
            if (messages) {
                const sorted = [...messages.values()].reverse();
                for (const msg of sorted) {
                    const time = msg.createdAt.toUTCString();
                    transcript += `[${time}] ${msg.author.tag}: ${msg.content || ''}`;
                    if (msg.attachments.size) transcript += ` [${msg.attachments.map(a => a.url).join(', ')}]`;
                    transcript += '\n';
                }
            }
            const { AttachmentBuilder } = require('discord.js');
            const file = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), { name: `${channel.name}-transcript.txt` });
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Ticket Closed')
                .addFields(
                    { name: 'Channel', value: channel.name, inline: true },
                    { name: 'Closed by', value: interaction.user.toString(), inline: true }
                )
                .setTimestamp();
            await logChannel.send({ embeds: [embed], files: [file] }).catch(console.error);
        }
    }

    setTimeout(() => channel.delete().catch(console.error), 5000);
}

module.exports.closeTicket = closeTicket;
