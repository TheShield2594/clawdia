const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

function rollCard() {
    return Math.floor(Math.random() * 13) + 1;
}

function cardLabel(value) {
    const labels = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    return labels[value] || String(value);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('higherlower')
        .setDescription('Bet on whether the next card will be higher or lower')
        .addIntegerOption(option =>
            option
                .setName('bet')
                .setDescription('How many coins to wager')
                .setMinValue(1)
                .setRequired(true)
        ),
    async execute(interaction) {
        try {
            const bet = interaction.options.getInteger('bet');
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
                return interaction.reply({ content: 'Economy games are disabled in this server.', ephemeral: true });
            }

            let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            if (!user) {
                user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
            }

            if (user.balance < bet) {
                return interaction.reply({ content: `You need ${bet.toLocaleString()} coins, but only have ${user.balance.toLocaleString()}.`, ephemeral: true });
            }

            const current = rollCard();
            const upId = `hl_up_${interaction.id}`;
            const downId = `hl_down_${interaction.id}`;

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(upId).setLabel('⬆️ Higher').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(downId).setLabel('⬇️ Lower').setStyle(ButtonStyle.Danger)
            );

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Higher or Lower')
                .setDescription(`Current card: **${cardLabel(current)}**\nBet: **${bet.toLocaleString()}** coins\nChoose quickly: higher or lower?`)
                .setFooter({ text: 'Equal cards are a push (your bet is returned).' });

            await interaction.reply({ embeds: [embed], components: [row] });

            const message = await interaction.fetchReply();
            const collector = message.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id && [upId, downId].includes(i.customId),
                max: 1,
                time: 15000
            });

            collector.on('collect', async i => {
                const next = rollCard();
                const pickedHigher = i.customId === upId;

                let resultText;
                let delta = 0;
                let color = '#f1c40f';

                if (next === current) {
                    resultText = 'Push! Same value — your coins are returned.';
                } else {
                    const won = pickedHigher ? next > current : next < current;
                    if (won) {
                        delta = bet;
                        color = '#2ecc71';
                        resultText = `You won **${bet.toLocaleString()}** coins!`;
                    } else {
                        delta = -bet;
                        color = '#e74c3c';
                        resultText = `You lost **${bet.toLocaleString()}** coins.`;
                    }
                }

                user.balance += delta;
                await user.save();

                const resultEmbed = new EmbedBuilder()
                    .setColor(color)
                    .setTitle('Higher or Lower — Result')
                    .setDescription(
                        `Your pick: **${pickedHigher ? 'Higher' : 'Lower'}**\n` +
                        `Current card: **${cardLabel(current)}**\n` +
                        `Next card: **${cardLabel(next)}**\n\n` +
                        `${resultText}`
                    )
                    .addFields({ name: 'New Balance', value: `${user.balance.toLocaleString()} coins` })
                    .setTimestamp();

                await i.update({ embeds: [resultEmbed], components: [] });
            });

            collector.on('end', async collected => {
                if (collected.size === 0) {
                    const timeoutEmbed = EmbedBuilder.from(embed)
                        .setColor('#95a5a6')
                        .setDescription(`Current card: **${cardLabel(current)}**\nBet: **${bet.toLocaleString()}** coins\n⏱️ Timed out. No coins were won or lost.`);
                    await interaction.editReply({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
                }
            });
        } catch (error) {
            console.error('HigherLower error:', error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'Failed to run Higher or Lower.', ephemeral: true });
            } else {
                await interaction.reply({ content: 'Failed to run Higher or Lower.', ephemeral: true });
            }
        }
    }
};
