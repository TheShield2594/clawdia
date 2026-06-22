'use strict';

const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { createAchievementCard } = require('../../utils/cardGenerator');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('achievement')
        .setDescription('Display a Minecraft-style achievement popup with custom text')
        .addStringOption(opt =>
            opt.setName('text')
                .setDescription('Achievement name (e.g. "First Blood")')
                .setRequired(true)
                .setMaxLength(50)),

    async execute(interaction) {
        const rl = checkImageRateLimit(interaction.user.id);
        if (rl.limited) {
            return interaction.reply({ content: rl.message, flags: MessageFlags.Ephemeral });
        }

        const text = interaction.options.getString('text');

        try {
            await interaction.deferReply();
            const buf        = await createAchievementCard(text, null, null);
            const attachment = new AttachmentBuilder(buf, { name: 'achievement.png' });
            await interaction.editReply({ files: [attachment] });
        } catch (err) {
            console.error('achievement: render failed', err);
            const msg = '❌ Could not generate the achievement. Please try again.';
            try {
                if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
                else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
            } catch { /* ignore */ }
        }
    },
};
