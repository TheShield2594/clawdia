const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;
const MAX_BET = 5000;

const SUITS  = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const value of VALUES) deck.push({ suit, value });
    }
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardValue(card) {
    if (['J', 'Q', 'K'].includes(card.value)) return 10;
    if (card.value === 'A') return 11;
    return parseInt(card.value, 10);
}

function handTotal(hand) {
    let total = hand.reduce((sum, c) => sum + cardValue(c), 0);
    let aces  = hand.filter(c => c.value === 'A').length;
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}

function displayHand(hand, hideSecond = false) {
    return hand.map((c, i) => (hideSecond && i === 1) ? '🂠' : `${c.value}${c.suit}`).join('  ');
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

function buildEmbed(interaction, playerHand, dealerHand, bet, currency, status, color, hideDealer) {
    const playerTotal = handTotal(playerHand);
    const dealerShown = hideDealer ? cardValue(dealerHand[0]) : handTotal(dealerHand);

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🃏 Blackjack')
        .addFields(
            { name: `Dealer's Hand (${hideDealer ? dealerShown : dealerShown})`, value: displayHand(dealerHand, hideDealer), inline: false },
            { name: `Your Hand (${playerTotal})`, value: displayHand(playerHand), inline: false },
            { name: 'Bet', value: `${currency}${bet.toLocaleString()}`, inline: true },
            { name: 'Status', value: status, inline: true },
        )
        .setFooter({ text: 'Blackjack pays 3:2 · Dealer stands on 17' })
        .setTimestamp();
}

function buildButtons(gameId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`bj_hit_${gameId}`)
            .setLabel('Hit')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`bj_stand_${gameId}`)
            .setLabel('Stand')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('blackjack')
        .setDescription('Play blackjack against the dealer')
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (${MIN_BET}–${MAX_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false || guildSettings?.economy?.blackjackEnabled === false) {
            return interaction.reply({ content: 'Blackjack is disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const bet      = interaction.options.getInteger('bet');

        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });

        if (user.balance < bet) {
            return interaction.reply({ content: `You don't have enough ${currency}. Your balance: **${currency}${user.balance.toLocaleString()}**`, ephemeral: true });
        }

        // Deduct bet upfront
        user.balance -= bet;
        await user.save();

        const deck       = buildDeck();
        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];
        const gameId     = `${interaction.user.id}_${Date.now()}`;

        // Natural blackjack check — push if dealer also has 21
        if (handTotal(playerHand) === 21) {
            if (handTotal(dealerHand) === 21) {
                user.balance += bet;
                await user.save();
                const embed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, '🤝 Push — both got blackjack', '#f39c12', false);
                return interaction.reply({ embeds: [embed], components: [buildButtons(gameId, true)] });
            }
            const payout = Math.floor(bet * 1.5);
            user.balance += bet + payout;
            await user.save();
            const embed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, `🎉 Blackjack! +${currency}${payout.toLocaleString()}`, '#2ecc71', false);
            return interaction.reply({ embeds: [embed], components: [buildButtons(gameId, true)] });
        }

        await interaction.reply({
            embeds:     [buildEmbed(interaction, playerHand, dealerHand, bet, currency, '🎲 Your turn', '#5865F2', true)],
            components: [buildButtons(gameId)],
        });

        const msg       = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && (i.customId === `bj_hit_${gameId}` || i.customId === `bj_stand_${gameId}`),
            time:   60_000,
        });

        collector.on('collect', async i => {
            await i.deferUpdate();

            if (i.customId === `bj_hit_${gameId}`) {
                playerHand.push(deck.pop());
                const total = handTotal(playerHand);

                if (total > 21) {
                    collector.stop('bust');
                    const embed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, `💥 Bust! -${currency}${bet.toLocaleString()}`, '#e74c3c', false);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] });
                }

                if (total === 21) {
                    collector.stop('stand');
                } else {
                    const embed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, '🎲 Your turn', '#5865F2', true);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId)] });
                }
            }

            if (i.customId === `bj_stand_${gameId}` || handTotal(playerHand) === 21) {
                collector.stop('stand');
            }
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'bust') return; // already handled above

            // Dealer draws to 17+
            while (handTotal(dealerHand) < 17) dealerHand.push(deck.pop());

            const playerTotal = handTotal(playerHand);
            const dealerTotal = handTotal(dealerHand);

            let color, status;
            let freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            if (!freshUser) freshUser = user;

            if (dealerTotal > 21 || playerTotal > dealerTotal) {
                freshUser.balance += bet * 2;
                status = `✅ You win! +${currency}${bet.toLocaleString()}`;
                color  = '#2ecc71';
            } else if (playerTotal === dealerTotal) {
                freshUser.balance += bet;
                status = `🤝 Push — bet returned`;
                color  = '#f39c12';
            } else {
                status = `❌ Dealer wins. -${currency}${bet.toLocaleString()}`;
                color  = '#e74c3c';
            }

            await freshUser.save();

            const embed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, status, color, false);
            await interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] }).catch(() => {});
        });
    },
};
