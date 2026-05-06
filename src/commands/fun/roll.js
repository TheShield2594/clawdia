const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const Guild = require('../../models/Guild');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b2.png';

// Unicode die faces for d6 only
const D6_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

// Color based on how high the result is relative to max (green = high, red = low)
function resultColor(result, sides) {
    const pct = result / sides;
    if (pct >= 0.85) return '#2ecc71'; // top 15% — green
    if (pct >= 0.50) return '#5865F2'; // above average — blurple
    if (pct >= 0.20) return '#f39c12'; // below average — orange
    return '#e74c3c';                   // bottom 20% — red
}

function outcomeLabel(result, sides) {
    const pct = result / sides;
    if (pct >= 0.85) return '🔥 **Great roll!**';
    if (pct >= 0.50) return '✅ Above average';
    if (pct >= 0.20) return '📉 Below average';
    return '💀 **Low roll!**';
}

// Progress bar showing where the result sits on the die range
function rollBar(result, sides) {
    const total  = 16;
    const filled = Math.round((result / sides) * total);
    const empty  = total - filled;
    return `\`${'█'.repeat(filled)}${'░'.repeat(empty)}\` ${result}/${sides}`;
}

function resultEmbed(interaction, result, sides) {
    const isD6      = sides === 6;
    const faceStr   = isD6 ? `\n\n${D6_FACES[result]}` : '';
    const color     = resultColor(result, sides);
    const outcome   = outcomeLabel(result, sides);
    const percentile = Math.round((result / sides) * 100);

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🎲 Dice Roll')
        .setDescription(`${outcome}${faceStr}`)
        .addFields(
            { name: '🎲 Result',     value: `**${result}**`,      inline: true },
            { name: '🎯 Die',        value: `d${sides}`,          inline: true },
            { name: '📊 Percentile', value: `**${percentile}th**`, inline: true },
            { name: '📈 Roll',       value: rollBar(result, sides), inline: false },
        )
        .setFooter({ text: `d${sides} — minimum 1, maximum ${sides}` })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roll')
        .setDescription('Roll a die')
        .addIntegerOption(opt =>
            opt.setName('sides')
                .setDescription('Number of sides (default: 6, max: 100)')
                .setRequired(false)
                .setMinValue(2)
                .setMaxValue(100)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.rollEnabled === false) {
            return interaction.reply({ content: 'Dice roll is disabled on this server.', ephemeral: true });
        }
        const sides = interaction.options.getInteger('sides') || 6;
        await interaction.deferReply();
        await playRoll(interaction, sides);
    },
};

async function playRoll(interaction, sides) {
    const result   = Math.floor(Math.random() * sides) + 1;
    const replayId = `roll_replay_${interaction.id}_${Date.now()}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(replayId)
            .setLabel('🎲 Roll Again')
            .setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({
        embeds:     [resultEmbed(interaction, result, sides)],
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
        await playRoll(interaction, sides);
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
    });
}
