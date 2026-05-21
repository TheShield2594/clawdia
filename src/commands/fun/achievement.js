const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas } = require('canvas');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');

const W         = 420;
const H         = 90;
const ICON_SIZE = 58;
const PAD       = 16;

// Minimal diamond-sword-style icon drawn with canvas primitives
function drawIcon(ctx, x, y, size) {
    const s = size / 18;

    // Blade — cyan/aqua pixels along the diagonal
    ctx.fillStyle = '#5de0e6';
    const blade = [
        [9,1],[10,1],[8,2],[9,2],[7,3],[8,3],[6,4],[7,4],
        [5,5],[6,5],[4,6],[5,6],[3,7],[4,7],[2,8],[3,8],
    ];
    for (const [bx, by] of blade) ctx.fillRect(x + bx * s, y + by * s, s, s);

    // Guard — lighter blue horizontal bar
    ctx.fillStyle = '#8aeef2';
    const guard = [[1,8],[2,8],[3,8],[4,8],[5,8]];
    for (const [gx, gy] of guard) ctx.fillRect(x + gx * s, y + gy * s, s, s);

    // Handle — brown
    ctx.fillStyle = '#8b5e3c';
    const handle = [[2,9],[2,10],[2,11],[2,12],[1,10],[3,10]];
    for (const [hx, hy] of handle) ctx.fillRect(x + hx * s, y + hy * s, s, s);
}

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
            return interaction.reply({ content: rl.message, ephemeral: true });
        }

        const text = interaction.options.getString('text');

        try {
            await interaction.deferReply();
            const canvas = createCanvas(W, H);
            const ctx    = canvas.getContext('2d');

            // Dark background
            ctx.fillStyle = '#3c3c3c';
            ctx.fillRect(0, 0, W, H);

            // Minecraft-style bevel border
            ctx.fillStyle = '#5a5a5a';
            ctx.fillRect(0, 0, W, 3);       // top
            ctx.fillRect(0, 0, 3, H);       // left
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, H - 3, W, 3);   // bottom
            ctx.fillRect(W - 3, 0, 3, H);   // right

            // Icon background slot
            const iconX = PAD;
            const iconY = (H - ICON_SIZE) / 2;
            ctx.fillStyle = '#2a2a2a';
            ctx.fillRect(iconX, iconY, ICON_SIZE, ICON_SIZE);
            ctx.strokeStyle = '#111111';
            ctx.lineWidth   = 2;
            ctx.strokeRect(iconX, iconY, ICON_SIZE, ICON_SIZE);
            ctx.strokeStyle = '#555555';
            ctx.lineWidth   = 1;
            ctx.strokeRect(iconX + 2, iconY + 2, ICON_SIZE - 4, ICON_SIZE - 4);

            drawIcon(ctx, iconX + 2, iconY + 2, ICON_SIZE - 4);

            // Text
            const textX = iconX + ICON_SIZE + 14;
            ctx.textBaseline = 'top';

            ctx.font      = 'bold 15px Arial, sans-serif';
            ctx.fillStyle = '#ffdf00';
            ctx.fillText('Achievement Unlocked!', textX, 20);

            const maxTextWidth = W - textX - PAD;
            let fontSize = 21;
            ctx.font = `bold ${fontSize}px Arial, sans-serif`;
            while (ctx.measureText(text).width > maxTextWidth && fontSize > 10) {
                fontSize--;
                ctx.font = `bold ${fontSize}px Arial, sans-serif`;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, textX, 46);

            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'achievement.png' });
            await interaction.editReply({ files: [attachment] });
        } catch (err) {
            console.error('achievement: render failed', err);
            const msg = '❌ Could not generate the achievement. Please try again.';
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(msg);
                } else {
                    await interaction.reply({ content: msg, ephemeral: true });
                }
            } catch (replyErr) {
                console.error('achievement: failed to send error reply', replyErr);
            }
        }
    },
};
