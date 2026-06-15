const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../models/User');

const MEMORY_CAP = 10;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ai')
        .setDescription('AI assistant utilities')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('memories')
                .setDescription('View and manage your pinned AI memories')
                .addIntegerOption(opt =>
                    opt.setName('delete')
                        .setDescription('Delete a memory by its number (from the list)')
                        .setMinValue(1)
                        .setMaxValue(MEMORY_CAP)
                )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub !== 'memories') return;

        const deleteIndex = interaction.options.getInteger('delete');

        let userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!userDoc) {
            userDoc = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
        }

        const memories = userDoc.pinnedMemories || [];

        if (deleteIndex != null) {
            const idx = deleteIndex - 1;
            if (idx < 0 || idx >= memories.length) {
                return interaction.reply({ content: `No memory #${deleteIndex} found. You have ${memories.length} pinned memory/memories.`, ephemeral: true });
            }
            memories.splice(idx, 1);
            userDoc.pinnedMemories = memories;
            await userDoc.save();
            return interaction.reply({ content: `🗑️ Memory #${deleteIndex} deleted. You now have **${memories.length}** pinned memory/memories.`, ephemeral: true });
        }

        if (memories.length === 0) {
            return interaction.reply({
                content: '📌 You have no pinned memories. React with 📌 to a bot message to save it as a memory.',
                ephemeral: true
            });
        }

        const lines = memories.map((m, i) => {
            const preview = m.content.length > 80 ? m.content.slice(0, 80) + '…' : m.content;
            return `**${i + 1}.** ${preview}`;
        });

        const embed = new EmbedBuilder()
            .setTitle('📌 Your Pinned Memories')
            .setColor('#f1c40f')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: `${memories.length}/${MEMORY_CAP} slots used · Use /ai memories delete:<number> to remove one` });

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
