const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

const HEADS_THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1fa99.png';

// Spinning frame — single rotating coin
const SPIN_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function spinningEmbed(interaction, frame) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(HEADS_THUMB)
        .setColor('#f39c12')
        .setTitle('🪙 Coin Flip')
        .setDescription(`${SPIN_FRAMES[frame % SPIN_FRAMES.length]} **Flipping…**`)
        .setFooter({ text: 'Heads or Tails?' });
}

function resultEmbed(interaction, result) {
    const isHeads = result === 'Heads';
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(HEADS_THUMB)
        .setColor(isHeads ? '#f39c12' : '#95a5a6')
        .setTitle(isHeads ? '🪙 Heads!' : '🪙 Tails!')
        .setDescription(
            isHeads
                ? '👑 **HEADS!** The coin landed face-up.'
                : '🔘 **TAILS!** The coin landed face-down.',
        )
        .addFields(
            { name: '🎲 Result',  value: `**${result}**`, inline: true },
            { name: '📊 Odds',    value: '**50 / 50**',   inline: true },
        )
        .setFooter({ text: 'Feeling lucky? Flip again!' })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Flip a coin — heads or tails?'),

    async execute(interaction) {
        await interaction.deferReply();
        await playCoinFlip(interaction);
    },
};

async function playCoinFlip(interaction) {
    const delay = ms => new Promise(r => setTimeout(r, ms));

    // 4-frame spin animation
    for (let f = 0; f < 4; f++) {
        await interaction.editReply({ embeds: [spinningEmbed(interaction, f)], components: [] });
        await delay(300);
    }

    const result   = Math.random() < 0.5 ? 'Heads' : 'Tails';
    const replayId = `coinflip_replay_${interaction.id}_${Date.now()}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(replayId)
            .setLabel('🪙 Flip Again')
            .setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({
        embeds:     [resultEmbed(interaction, result)],
        components: [row],
    });

    const msg = await interaction.fetchReply();
    const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && i.customId === replayId,
        max:    1,
        time:   60_000,
    });

    collector.on('collect', async i => {
        await i.deferUpdate();
        await playCoinFlip(interaction);
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
    });
}
