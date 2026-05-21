const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');
const { applySepia } = require('../../utils/canvasFilters');

const W           = 400;
const H           = 530;
const AVATAR_SIZE = 200;
const AVATAR_X    = (W - AVATAR_SIZE) / 2;
const AVATAR_Y    = 135;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wanted')
        .setDescription('Generate a Wild West "Wanted" poster with a user\'s avatar')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('The wanted criminal (defaults to you)')
                .setRequired(false)),

    async execute(interaction) {
        const rl = checkImageRateLimit(interaction.user.id);
        if (rl.limited) {
            return interaction.reply({ content: rl.message, ephemeral: true });
        }

        const target = interaction.options.getUser('user') || interaction.user;

        try {
            await interaction.deferReply();
            const avatar = await loadImage(target.displayAvatarURL({ extension: 'png', size: 256 }));

            const canvas = createCanvas(W, H);
            const ctx    = canvas.getContext('2d');

            // Parchment background
            ctx.fillStyle = '#c8a86b';
            ctx.fillRect(0, 0, W, H);

            // Edge darkening
            const vignette = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W);
            vignette.addColorStop(0, 'rgba(200,168,107,0)');
            vignette.addColorStop(1, 'rgba(60,30,0,0.55)');
            ctx.fillStyle = vignette;
            ctx.fillRect(0, 0, W, H);

            // Borders
            ctx.strokeStyle = '#4a2c00';
            ctx.lineWidth   = 8;
            ctx.strokeRect(12, 12, W - 24, H - 24);
            ctx.strokeStyle = '#7a5200';
            ctx.lineWidth   = 3;
            ctx.strokeRect(22, 22, W - 44, H - 44);

            // WANTED header
            ctx.textAlign    = 'center';
            ctx.shadowColor  = 'rgba(0,0,0,0.4)';
            ctx.shadowBlur   = 6;
            ctx.font         = 'bold 74px Georgia, serif';
            ctx.fillStyle    = '#2b1500';
            ctx.fillText('WANTED', W / 2, 88);

            // DEAD OR ALIVE
            ctx.shadowBlur = 0;
            ctx.font       = 'bold 22px Georgia, serif';
            ctx.fillStyle  = '#3d1a00';
            ctx.fillText('DEAD OR ALIVE', W / 2, 118);

            // Avatar photo frame
            ctx.fillStyle = '#3a2000';
            ctx.fillRect(AVATAR_X - 6, AVATAR_Y - 6, AVATAR_SIZE + 12, AVATAR_SIZE + 12);
            ctx.fillStyle = '#d4b07a';
            ctx.fillRect(AVATAR_X - 3, AVATAR_Y - 3, AVATAR_SIZE + 6,  AVATAR_SIZE + 6);

            ctx.drawImage(avatar, AVATAR_X, AVATAR_Y, AVATAR_SIZE, AVATAR_SIZE);

            const imgData = ctx.getImageData(AVATAR_X, AVATAR_Y, AVATAR_SIZE, AVATAR_SIZE);
            applySepia(imgData);
            ctx.putImageData(imgData, AVATAR_X, AVATAR_Y);

            // Username (truncate if needed)
            const displayName = target.username.length > 18 ? target.username.slice(0, 17) + '…' : target.username;
            ctx.font          = 'bold 26px Georgia, serif';
            ctx.fillStyle     = '#1a0a00';
            ctx.fillText(displayName, W / 2, AVATAR_Y + AVATAR_SIZE + 38);

            // Reward — deterministic per user so it doesn't change on repeat calls
            const seed    = parseInt(target.id.slice(-6), 16) % 9000 + 1000;
            const reward  = '$' + seed.toLocaleString();
            ctx.font      = 'bold 18px Georgia, serif';
            ctx.fillStyle = '#2b1500';
            ctx.fillText('REWARD', W / 2, AVATAR_Y + AVATAR_SIZE + 68);
            ctx.font      = 'bold 34px Georgia, serif';
            ctx.fillStyle = '#5a2d00';
            ctx.fillText(reward, W / 2, AVATAR_Y + AVATAR_SIZE + 105);

            ctx.font      = 'italic 14px Georgia, serif';
            ctx.fillStyle = '#3a1a00';
            ctx.fillText('Contact your local sheriff', W / 2, AVATAR_Y + AVATAR_SIZE + 130);

            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'wanted.png' });
            await interaction.editReply({ files: [attachment] });
        } catch {
            const msg = '❌ Could not generate the wanted poster. Please try again.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(msg);
            } else {
                await interaction.reply({ content: msg, ephemeral: true });
            }
        }
    },
};
