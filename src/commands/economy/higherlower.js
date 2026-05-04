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
    cooldown: 5,
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

            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            let user = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true }
            );

            if (!user) {
                await User.findOneAndUpdate(
                    userFilter,
                    { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id, balance: 0 } },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                user = await User.findOneAndUpdate(
                    { ...userFilter, balance: { $gte: bet } },
                    { $inc: { balance: -bet } },
                    { new: true }
                );
            }

            if (!user) {
                return interaction.reply({ content: `Insufficient funds. You need ${bet.toLocaleString()} coins to place this bet.`, ephemeral: true });
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
                let delta = 0;

                try {
                    const next = rollCard();
                    const pickedHigher = i.customId === upId;

                    let resultText;
                    let color = '#f1c40f';

                    if (next === current) {
                        delta = bet;
                        resultText = 'Push! Same value — your coins are returned.';
                    } else {
                        const won = pickedHigher ? next > current : next < current;
                        if (won) {
                            delta = bet * 2;
                            color = '#2ecc71';
                            resultText = `You won **${bet.toLocaleString()}** coins!`;
                        } else {
                            resultText = `You lost **${bet.toLocaleString()}** coins.`;
                        }
                    }

                    user = await User.findOneAndUpdate(
                        userFilter,
                        { $inc: { balance: delta } },
                        { new: true }
                    );

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
                } catch (collectError) {
                    console.error('HigherLower collect error:', collectError);

                    if (delta !== 0) {
                        try {
                            await User.findOneAndUpdate(userFilter, { $inc: { balance: -delta } });
                        } catch (revertError) {
                            console.error('HigherLower revert error:', revertError);
                        }
                    }

                    try {
                        await i.update({ content: 'Something went wrong while processing your pick. Your wager was refunded.', embeds: [], components: [] });
                    } catch (updateError) {
                        try {
                            await i.reply({ content: 'Something went wrong while processing your pick. Your wager was refunded.', ephemeral: true });
                        } catch (replyError) {}
                    }
                }
            });

            collector.on('end', async collected => {
                if (collected.size === 0) {
                    const timeoutEmbed = EmbedBuilder.from(embed)
                        .setColor('#95a5a6')
                        .setDescription(`Current card: **${cardLabel(current)}**\nBet: **${bet.toLocaleString()}** coins\n⏱️ Timed out. Your wager was refunded.`);
                    await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
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
