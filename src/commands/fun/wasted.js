const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');

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
        const { limited, wait } = checkImageRateLimit(interaction.user.id);
        if (limited) {
            return interaction.reply({
                content: `⏱️ You're using image commands too fast! Please wait **${wait}s** before trying again.`,
                ephemeral: true,
            });
        }

        const target = interaction.options.getUser('user') || interaction.user;
        await interaction.deferReply();

        try {
            const avatar = await loadImage(target.displayAvatarURL({ extension: 'png', size: SIZE }));

            const canvas = createCanvas(SIZE, SIZE);
            const ctx    = canvas.getContext('2d');

            ctx.drawImage(avatar, 0, 0, SIZE, SIZE);

            // Grayscale
            const img    = ctx.getImageData(0, 0, SIZE, SIZE);
            const { data } = img;
            for (let i = 0; i < data.length; i += 4) {
                const g  = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                data[i]     = g;
                data[i + 1] = g;
                data[i + 2] = g;
            }
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
            await interaction.editReply('❌ Could not generate the wasted image. Please try again.');
        }
    },
};
