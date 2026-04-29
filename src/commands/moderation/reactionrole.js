const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reactionrole')
        .setDescription('Manage reaction roles')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Attach a reaction role to a message')
                .addStringOption(o => o.setName('message_id').setDescription('ID of the message').setRequired(true))
                .addStringOption(o => o.setName('emoji').setDescription('Emoji to react with').setRequired(true))
                .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
                .addChannelOption(o => o.setName('channel').setDescription('Channel containing the message (defaults to current)')))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a reaction role from a message')
                .addStringOption(o => o.setName('message_id').setDescription('ID of the message').setRequired(true))
                .addStringOption(o => o.setName('emoji').setDescription('Emoji to remove').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all reaction roles in this server'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'add') {
            const messageId = interaction.options.getString('message_id');
            const emoji = interaction.options.getString('emoji');
            const role = interaction.options.getRole('role');
            const channel = interaction.options.getChannel('channel') ?? interaction.channel;

            let targetMessage;
            try {
                targetMessage = await channel.messages.fetch(messageId);
            } catch {
                return interaction.reply({ content: 'Could not find that message. Make sure the message ID and channel are correct.', ephemeral: true });
            }

            if (role.managed || role.id === interaction.guild.id) {
                return interaction.reply({ content: 'That role cannot be assigned.', ephemeral: true });
            }

            if (interaction.guild.members.me.roles.highest.comparePositionTo(role) <= 0) {
                return interaction.reply({ content: 'My highest role is below that role — I cannot assign it.', ephemeral: true });
            }

            const existing = guildSettings.reactionRoles.find(
                rr => rr.messageId === messageId && rr.emoji === emoji
            );
            if (existing) {
                return interaction.reply({ content: 'A reaction role with that emoji already exists on that message.', ephemeral: true });
            }

            await targetMessage.react(emoji).catch(() => null);

            guildSettings.reactionRoles.push({ messageId, channelId: channel.id, emoji, roleId: role.id });
            await guildSettings.save();

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Reaction Role Added')
                .addFields(
                    { name: 'Message', value: `[Jump](${targetMessage.url})`, inline: true },
                    { name: 'Emoji', value: emoji, inline: true },
                    { name: 'Role', value: role.toString(), inline: true }
                );

            await interaction.reply({ embeds: [embed] });

        } else if (sub === 'remove') {
            const messageId = interaction.options.getString('message_id');
            const emoji = interaction.options.getString('emoji');

            const before = guildSettings.reactionRoles.length;
            guildSettings.reactionRoles = guildSettings.reactionRoles.filter(
                rr => !(rr.messageId === messageId && rr.emoji === emoji)
            );

            if (guildSettings.reactionRoles.length === before) {
                return interaction.reply({ content: 'No reaction role found with that message ID and emoji.', ephemeral: true });
            }

            await guildSettings.save();
            await interaction.reply({ content: `Reaction role removed for emoji ${emoji} on message \`${messageId}\`.` });

        } else if (sub === 'list') {
            if (guildSettings.reactionRoles.length === 0) {
                return interaction.reply({ content: 'No reaction roles configured in this server.', ephemeral: true });
            }

            const lines = guildSettings.reactionRoles.map(rr => {
                const channelMention = `<#${rr.channelId}>`;
                const roleMention = `<@&${rr.roleId}>`;
                return `${rr.emoji} → ${roleMention} (msg \`${rr.messageId}\` in ${channelMention})`;
            });

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Reaction Roles')
                .setDescription(lines.join('\n'));

            await interaction.reply({ embeds: [embed] });
        }
    }
};
