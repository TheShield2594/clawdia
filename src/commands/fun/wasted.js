const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');
const { applyGrayscale } = require('../../utils/canvasFilters');

const SIZE = 512;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wasted')
        .setDescription('Overlay the GTA "Wasted" screen on a user\'s avatar')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('The user to waste (defaults to you)')
                .setRequired(false)),

    async execute(interaction) {
        const rl = checkImageRateLimit(interaction.user.id);
        if (rl.limited) {
            return interaction.reply({ content: rl.message, ephemeral: true });
        }

        const target = interaction.options.getUser('user') || interaction.user;

        try {
            await interaction.deferReply();
            const avatar = await loadImage(target.displayAvatarURL({ extension: 'png', size: SIZE }));

            const canvas = createCanvas(SIZE, SIZE);
            const ctx    = canvas.getContext('2d');

            ctx.drawImage(avatar, 0, 0, SIZE, SIZE);

            const img = ctx.getImageData(0, 0, SIZE, SIZE);
            applyGrayscale(img);
            ctx.putImageData(img, 0, 0);

            // Dark red vignette
            const vignette = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.25, SIZE / 2, SIZE / 2, SIZE * 0.75);
            vignette.addColorStop(0, 'rgba(100, 0, 0, 0.1)');
            vignette.addColorStop(1, 'rgba(80, 0, 0, 0.55)');
            ctx.fillStyle = vignette;
            ctx.fillRect(0, 0, SIZE, SIZE);

            // WASTED text
            ctx.font         = 'bold 84px Impact, Arial Black, sans-serif';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor  = '#000000';
            ctx.shadowBlur   = 16;
            ctx.fillStyle    = '#cc0000';
            ctx.fillText('WASTED', SIZE / 2, SIZE / 2);
            ctx.shadowBlur   = 0;
            ctx.strokeStyle  = '#550000';
            ctx.lineWidth    = 4;
            ctx.strokeText('WASTED', SIZE / 2, SIZE / 2);

            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'wasted.png' });
            await interaction.editReply({
                content: `💀 **${target.username}** has been wasted.`,
                files: [attachment],
            });
        } catch {
            const msg = '❌ Could not generate the wasted image. Please try again.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(msg);
            } else {
                await interaction.reply({ content: msg, ephemeral: true });
            }
        }
    },
};
