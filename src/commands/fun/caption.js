const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');

const MAX_WIDTH   = 800;
const MAX_DIM     = 4000;
const CAPTION_H   = 70;
const FONT_SIZE   = 28;
const LINE_HEIGHT = FONT_SIZE * 1.25;

const _measCtx = createCanvas(1, 1).getContext('2d');

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
        const rl = checkImageRateLimit(interaction.user.id);
        if (rl.limited) {
            return interaction.reply({ content: rl.message, ephemeral: true });
        }

        const imageUrl = interaction.options.getString('image_url');
        const text     = interaction.options.getString('text');

        if (!isValidHttpUrl(imageUrl)) {
            return interaction.reply({
                content: '❌ Please provide a valid image URL (must start with http:// or https://).',
                ephemeral: true,
            });
        }

        try {
            await interaction.deferReply();

            const src = await loadImage(imageUrl);
            if (src.width > MAX_DIM || src.height > MAX_DIM) {
                return interaction.editReply(`❌ Image is too large. Maximum dimensions are ${MAX_DIM}×${MAX_DIM} pixels.`);
            }

            const scale = src.width > MAX_WIDTH ? MAX_WIDTH / src.width : 1;
            const w     = Math.round(src.width  * scale);
            const h     = Math.round(src.height * scale);

            _measCtx.font  = `bold ${FONT_SIZE}px Arial`;
            const lines    = wrapText(_measCtx, text, w - 20);
            const captionH = Math.max(CAPTION_H, lines.length * LINE_HEIGHT + 20);

            const canvas = createCanvas(w, h + captionH);
            const ctx    = canvas.getContext('2d');

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, captionH);

            ctx.font         = `bold ${FONT_SIZE}px Arial`;
            ctx.fillStyle    = '#000000';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            const startY     = (captionH - (lines.length - 1) * LINE_HEIGHT) / 2;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], w / 2, startY + i * LINE_HEIGHT);
            }

            ctx.drawImage(src, 0, captionH, w, h);

            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'caption.png' });
            await interaction.editReply({ files: [attachment] });
        } catch (err) {
            console.error('caption: image load or render failed', err);
            const msg = '❌ Could not load that image. Make sure the URL points to a valid image.';
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(msg);
                } else {
                    await interaction.reply({ content: msg, ephemeral: true });
                }
            } catch (replyErr) {
                console.error('caption: failed to send error reply', replyErr);
            }
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
