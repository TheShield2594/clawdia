const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b1.png';

const RESPONSES = {
    positive: [
        'It is certain.',
        'It is decidedly so.',
        'Without a doubt.',
        'Yes, definitely.',
        'You may rely on it.',
        'As I see it, yes.',
        'Most likely.',
        'Outlook good.',
        'Yes.',
        'Signs point to yes.',
    ],
    neutral: [
        'Reply hazy, try again.',
        'Ask again later.',
        'Better not tell you now.',
        'Cannot predict now.',
        'Concentrate and ask again.',
    ],
    negative: [
        "Don't count on it.",
        'My reply is no.',
        'My sources say no.',
        'Outlook not so good.',
        'Very doubtful.',
    ],
};

// Matches the original 10:5:5 distribution (50% positive, 25% neutral, 25% negative)
function pickResponse() {
    const r = Math.random();
    const type = r < 0.5 ? 'positive' : r < 0.75 ? 'neutral' : 'negative';
    const pool = RESPONSES[type];
    return { type, text: pool[Math.floor(Math.random() * pool.length)] };
}

const TYPE_CONFIG = {
    positive: { color: '#2ecc71', emoji: '✅', outlook: 'Positive'    },
    neutral:  { color: '#f39c12', emoji: '🤔', outlook: 'Uncertain'   },
    negative: { color: '#e74c3c', emoji: '❌', outlook: 'Negative'    },
};

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function ballEmbed(interaction, question, response) {
    const { type, text } = response;
    const { color, emoji, outlook } = TYPE_CONFIG[type];

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🎱 Magic 8-Ball')
        .setDescription(`> *"${question}"*`)
        .addFields(
            { name: `${emoji} The 8-Ball Says`,  value: `**${text}**`,  inline: false },
            { name: '🔮 Outlook',                value: outlook,         inline: true  },
            { name: '​',                          value: '​',             inline: true  },
        )
        .setFooter({ text: '🎱 Ask again below — or shake for a new question' })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('8ball')
        .setDescription('Ask the magic 8-ball a yes/no question')
        .addStringOption(opt =>
            opt.setName('question')
                .setDescription('Your yes/no question')
                .setRequired(true)
                .setMaxLength(200)),

    async execute(interaction) {
        const question = interaction.options.getString('question');
        await interaction.deferReply();
        await playBall(interaction, question);
    },
};

async function playBall(interaction, question) {
    const response   = pickResponse();
    const askAgainId = `8ball_again_${interaction.id}_${Date.now()}`;
    const newQId     = `8ball_newq_${interaction.id}_${Date.now()}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(askAgainId)
            .setLabel('🎱 Shake Again')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(newQId)
            .setLabel('❓ New Question')
            .setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({
        embeds:     [ballEmbed(interaction, question, response)],
        components: [row],
    });

    const msg = await interaction.fetchReply();
    const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && [askAgainId, newQId].includes(i.customId),
        max:    1,
        time:   60_000,
    });

    collector.on('collect', async i => {
        if (i.customId === askAgainId) {
            // Same question, new shake
            await i.deferUpdate();
            await playBall(interaction, question);
        } else {
            // New Question — open a modal for input
            const modal = new ModalBuilder()
                .setCustomId(`8ball_modal_${interaction.id}_${Date.now()}`)
                .setTitle('🎱 Ask the Magic 8-Ball')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('question_input')
                            .setLabel('Your yes/no question')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('Will I win the lottery?')
                            .setRequired(true)
                            .setMaxLength(200),
                    ),
                );

            await i.showModal(modal);

            // Wait for modal submission
            const submitted = await i.awaitModalSubmit({
                filter: mi => mi.user.id === interaction.user.id,
                time:   60_000,
            }).catch(() => null);

            if (!submitted) {
                // Modal timed out — just clean up buttons
                await interaction.editReply({ components: [] }).catch(() => {});
                return;
            }

            const newQuestion = submitted.fields.getTextInputValue('question_input');
            await submitted.deferUpdate().catch(() => {});
            await playBall(interaction, newQuestion);
        }
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
    });
}
