const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');

const MAX_WIDTH     = 800;
const CAPTION_H     = 70;
const FONT_SIZE     = 28;
const LINE_HEIGHT   = FONT_SIZE * 1.25;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('caption')
        .setDescription('Add a caption to any image URL')
        .addStringOption(opt =>
            opt.setName('image_url')
                .setDescription('URL of the image to caption')
                .setRequired(true))
        .addStringOption(opt =>
            opt.setName('text')
                .setDescription('Caption text')
                .setRequired(true)
                .setMaxLength(200)),

    async execute(interaction) {
        const { limited, wait } = checkImageRateLimit(interaction.user.id);
        if (limited) {
            return interaction.reply({
                content: `⏱️ You're using image commands too fast! Please wait **${wait}s** before trying again.`,
                ephemeral: true,
            });
        }

        const imageUrl = interaction.options.getString('image_url');
        const text     = interaction.options.getString('text');

        if (!isValidHttpUrl(imageUrl)) {
            return interaction.reply({
                content: '❌ Please provide a valid image URL (must start with http:// or https://).',
                ephemeral: true,
            });
        }

        await interaction.deferReply();

        try {
            const src   = await loadImage(imageUrl);
            const scale = src.width > MAX_WIDTH ? MAX_WIDTH / src.width : 1;
            const w     = Math.round(src.width  * scale);
            const h     = Math.round(src.height * scale);

            // Measure how many lines the caption needs and size canvas accordingly
            const measCanvas = createCanvas(w, 1);
            const measCtx    = measCanvas.getContext('2d');
            measCtx.font     = `bold ${FONT_SIZE}px Arial`;
            const lines      = wrapText(measCtx, text, w - 20);
            const captionH   = Math.max(CAPTION_H, lines.length * LINE_HEIGHT + 20);

            const canvas = createCanvas(w, h + captionH);
            const ctx    = canvas.getContext('2d');

            // White caption bar at top
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, captionH);

            // Caption text
            ctx.font         = `bold ${FONT_SIZE}px Arial`;
            ctx.fillStyle    = '#000000';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            const startY     = (captionH - (lines.length - 1) * LINE_HEIGHT) / 2;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], w / 2, startY + i * LINE_HEIGHT);
            }

            // Image below caption
            ctx.drawImage(src, 0, captionH, w, h);

            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'caption.png' });
            await interaction.editReply({ files: [attachment] });
        } catch {
            await interaction.editReply('❌ Could not load that image. Make sure the URL points to a valid image.');
        }
    },
};

function isValidHttpUrl(str) {
    try {
        const { protocol } = new URL(str);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line    = '';
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measureText(candidate).width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines;
}
