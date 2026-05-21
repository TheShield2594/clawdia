const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');

const TEMPLATES = [
    { name: 'Drake',                  value: '181913649' },
    { name: 'Distracted Boyfriend',   value: '112126428' },
    { name: 'This Is Fine',           value: '55311130'  },
    { name: 'Change My Mind',         value: '129242436' },
    { name: 'Two Buttons',            value: '87743020'  },
    { name: 'One Does Not Simply',    value: '61579'     },
    { name: 'Surprised Pikachu',      value: '155067746' },
    { name: 'Mocking SpongeBob',      value: '102156234' },
    { name: 'Woman Yelling at Cat',   value: '188390779' },
    { name: "Gru's Plan",             value: '131940431' },
    { name: 'Expanding Brain',        value: '93895088'  },
    { name: 'Always Has Been',        value: '252600902' },
    { name: 'Bernie Sanders',         value: '222403160' },
    { name: 'UNO Draw 25 Cards',      value: '217743513' },
];

const cache = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (entry.expires <= now) cache.delete(key);
    }
}, 10 * 60_000).unref();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('meme')
        .setDescription('Generate a classic meme using a popular template')
        .addStringOption(opt =>
            opt.setName('template')
                .setDescription('The meme template to use')
                .setRequired(true)
                .addChoices(...TEMPLATES))
        .addStringOption(opt =>
            opt.setName('top_text')
                .setDescription('Top caption text')
                .setRequired(true)
                .setMaxLength(200))
        .addStringOption(opt =>
            opt.setName('bottom_text')
                .setDescription('Bottom caption text')
                .setRequired(false)
                .setMaxLength(200)),

    async execute(interaction) {
        const rl = checkImageRateLimit(interaction.user.id);
        if (rl.limited) {
            return interaction.reply({ content: rl.message, ephemeral: true });
        }

        const templateId = interaction.options.getString('template');
        const topText    = interaction.options.getString('top_text');
        const bottomText = interaction.options.getString('bottom_text') || '';

        const cacheKey = JSON.stringify([templateId, topText, bottomText]);
        const cached   = cache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return interaction.reply({ embeds: [buildEmbed(interaction, cached.url, templateId)] });
        }

        const username = process.env.IMGFLIP_USERNAME;
        const password = process.env.IMGFLIP_PASSWORD;
        if (!username || !password) {
            return interaction.reply({
                content: '❌ Meme generation is not configured. Ask an admin to set `IMGFLIP_USERNAME` and `IMGFLIP_PASSWORD`.',
                ephemeral: true,
            });
        }

        try {
            await interaction.deferReply();

            const params = new URLSearchParams({ template_id: templateId, username, password, text0: topText, text1: bottomText });
            const { data } = await axios.post('https://api.imgflip.com/caption_image', params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10_000,
            });

            if (!data.success) {
                return interaction.editReply(`❌ Imgflip API error: ${data.error_message || 'Unknown error'}`);
            }

            const url = data.data.url;
            cache.set(cacheKey, { url, expires: Date.now() + 5 * 60_000 });
            await interaction.editReply({ embeds: [buildEmbed(interaction, url, templateId)] });
        } catch {
            const msg = '❌ Failed to generate meme. Please try again later.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(msg);
            } else {
                await interaction.reply({ content: msg, ephemeral: true });
            }
        }
    },
};

function buildEmbed(interaction, url, templateId) {
    const name = TEMPLATES.find(t => t.value === templateId)?.name || 'Meme';
    return new EmbedBuilder()
        .setColor('#ff6b6b')
        .setTitle(`🎭 ${name}`)
        .setImage(url)
        .setFooter({
            text: `Requested by ${interaction.user.username} • Powered by Imgflip`,
            iconURL: interaction.user.displayAvatarURL(),
        })
        .setTimestamp();
}
