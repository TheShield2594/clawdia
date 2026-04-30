const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const KnowledgeBase = require('../../models/KnowledgeBase');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('knowledgebase')
        .setDescription('Manage the server knowledge base used as AI context')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a knowledge entry')
            .addStringOption(o => o.setName('title').setDescription('Short title for this entry').setRequired(true))
            .addStringOption(o => o.setName('content').setDescription('The knowledge content').setRequired(true))
            .addStringOption(o => o.setName('tags').setDescription('Comma-separated tags (optional)')))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a knowledge entry by ID')
            .addStringOption(o => o.setName('id').setDescription('Entry ID (from /knowledgebase list)').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List all knowledge entries'))
        .addSubcommand(sub => sub
            .setName('sync-pins')
            .setDescription('Import pinned messages from a channel as knowledge entries')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to import pins from').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const title = interaction.options.getString('title');
            const content = interaction.options.getString('content');
            const tagsRaw = interaction.options.getString('tags') || '';
            const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);

            await KnowledgeBase.create({
                guildId: interaction.guild.id,
                title,
                content,
                tags,
                addedBy: interaction.user.id
            });

            await interaction.reply({ content: `Knowledge entry added: **${title}**`, ephemeral: true });

        } else if (sub === 'remove') {
            const id = interaction.options.getString('id');
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return interaction.reply({ content: 'Invalid ID format.', ephemeral: true });
            }
            let entry;
            try {
                entry = await KnowledgeBase.findOneAndDelete({ _id: id, guildId: interaction.guild.id });
            } catch (err) {
                console.error('[knowledgebase remove]', err);
                return interaction.reply({ content: 'An internal error occurred.', ephemeral: true });
            }
            if (!entry) return interaction.reply({ content: 'Entry not found.', ephemeral: true });
            await interaction.reply({ content: `Removed entry: **${entry.title}**`, ephemeral: true });

        } else if (sub === 'list') {
            const entries = await KnowledgeBase.find({ guildId: interaction.guild.id }).sort({ createdAt: -1 }).limit(25);
            if (!entries.length) return interaction.reply({ content: 'No knowledge entries found.', ephemeral: true });

            const lines = entries.map(e => {
                const preview = e.content.length > 80 ? e.content.slice(0, 80) + '…' : e.content;
                return `\`${e._id}\`\n**${e.title}**\n${preview}`;
            });

            const embed = new EmbedBuilder()
                .setTitle('Server Knowledge Base')
                .setColor(0x5865F2)
                .setDescription(lines.join('\n\n').slice(0, 4000))
                .setFooter({ text: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` });

            await interaction.reply({ embeds: [embed], ephemeral: true });

        } else if (sub === 'sync-pins') {
            const channel = interaction.options.getChannel('channel');
            if (!channel.isTextBased()) {
                return interaction.reply({ content: 'Only text-based channels have pinned messages.', ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });

            let pins;
            try {
                pins = await channel.messages.fetchPinned();
            } catch (err) {
                console.error('[knowledgebase sync-pins] fetchPinned error:', err);
                return interaction.editReply(`Failed to fetch pinned messages: ${err.message}`);
            }
            if (pins.size === 0) {
                return interaction.editReply('No pinned messages found in that channel.');
            }

            let newCount = 0;
            for (const [, msg] of pins) {
                if (!msg.content?.trim()) continue;
                const sourceKey = `${interaction.guild.id}:${msg.id}`;
                const existing = await KnowledgeBase.findOneAndUpdate(
                    { guildId: interaction.guild.id, sourceKey },
                    {
                        $set: {
                            title: `Pin from #${channel.name} by ${msg.author.displayName || msg.author.username}`,
                            content: msg.content,
                            tags: [channel.name, 'pinned'],
                            addedBy: interaction.user.id
                        }
                    },
                    { upsert: true, setDefaultsOnInsert: true }
                );
                if (!existing) newCount++;
            }

            const total = pins.filter(m => m.content?.trim()).size;
            const updatedCount = total - newCount;
            await interaction.editReply(
                `Synced **${total}** pinned message${total !== 1 ? 's' : ''} from <#${channel.id}> — **${newCount} new**, ${updatedCount} updated.`
            );
        }
    }
};
