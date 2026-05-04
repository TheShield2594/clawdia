const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

const MIN_BET = 10;
const MAX_BET = 5000;
const MAX_ROUNDS = 10;          // cap pot at 1024x the original bet
const WIN_CHANCE = 0.5;         // fair coin flip
const ROUND_TIMEOUT_MS = 20000; // per-round decision window

function liveEmbed(username, bet, round, pot, streak) {
    const nextPot = pot * 2;
    return new EmbedBuilder()
        .setColor('#f1c40f')
        .setTitle('🎰 Double or Nothing')
        .setDescription(
            `Round **${round}** of ${MAX_ROUNDS}\n` +
            `Streak: **${'🔥'.repeat(Math.min(streak, 10)) || '—'}**\n\n` +
            `Current pot: **${pot.toLocaleString()}** coins\n` +
            (round < MAX_ROUNDS
                ? `Risk it for **${nextPot.toLocaleString()}**, or walk away with **${pot.toLocaleString()}**.`
                : `You've maxed out the streak — cash out before the table closes!`)
        )
        .addFields(
            { name: 'Initial bet', value: `${bet.toLocaleString()} coins`, inline: true },
            { name: 'Win chance',  value: `${Math.round(WIN_CHANCE * 100)}%`,    inline: true },
        )
        .setFooter({ text: `Player: ${username}` });
}

function resultEmbed({ username, bet, pot, streak, outcome, finalBalance }) {
    const colors = { won: '#2ecc71', lost: '#e74c3c', cashed: '#3498db', timeout: '#95a5a6' };
    let title;
    let description;

    switch (outcome) {
        case 'cashed':
            title = '💰 Cashed Out';
            description = `You walked away with **${pot.toLocaleString()}** coins after a **${streak}-win** streak.`;
            break;
        case 'lost':
            title = '💥 Busted!';
            description = `The flip went against you — you lost **${bet.toLocaleString()}** coins after a **${streak}-win** streak.`;
            break;
        case 'maxed':
            title = '🏆 Max Streak!';
            description = `You hit the ${MAX_ROUNDS}-win cap and auto-cashed for **${pot.toLocaleString()}** coins.`;
            break;
        case 'timeout':
            title = '⏱️ Timed Out';
            description = `No decision in time — the dealer cashed you out for **${pot.toLocaleString()}** coins.`;
            break;
    }

    return new EmbedBuilder()
        .setColor(colors[outcome] || '#95a5a6')
        .setTitle(`🎰 Double or Nothing — ${title}`)
        .setDescription(description)
        .addFields({ name: 'New Balance', value: `${finalBalance.toLocaleString()} coins` })
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
}

function buildRow(doubleId, cashOutId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(doubleId)
            .setLabel('🎲 Double or Nothing')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(cashOutId)
            .setLabel('💰 Cash Out')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('doubleornothing')
        .setDescription('Bet on a coin flip — keep doubling your pot or walk away.')
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to wager (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true)),
    cooldown: 5,

    async execute(interaction) {
        const bet = interaction.options.getInteger('bet');
        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
                return interaction.reply({ content: 'Economy games are disabled in this server.', ephemeral: true });
            }

            // Ensure the user document exists.
            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            // Atomic balance deduction; only succeeds if the user can cover the bet.
            const debited = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true }
            );

            if (!debited) {
                return interaction.reply({
                    content: `Insufficient funds. You need ${bet.toLocaleString()} coins to play.`,
                    ephemeral: true
                });
            }

            const username  = interaction.user.username;
            const doubleId  = `don_double_${interaction.id}`;
            const cashOutId = `don_cash_${interaction.id}`;

            // Round 1 is already won by virtue of paying in: the pot starts at the bet
            // and the player decides whether to risk it for double, or take it back.
            let round  = 1;
            let pot    = bet;
            let streak = 0;
            let settled = false;

            await interaction.reply({
                embeds: [liveEmbed(username, bet, round, pot, streak)],
                components: [buildRow(doubleId, cashOutId)],
            });

            const message = await interaction.fetchReply();

            const settle = async (outcome, payout) => {
                if (settled) return;
                settled = true;

                let finalBalance = debited.balance;
                if (payout > 0) {
                    const credited = await User.findOneAndUpdate(
                        userFilter,
                        { $inc: { balance: payout } },
                        { new: true }
                    );
                    if (credited) finalBalance = credited.balance;
                }

                await interaction.editReply({
                    embeds: [resultEmbed({ username, bet, pot, streak, outcome, finalBalance })],
                    components: [],
                }).catch(() => {});
            };

            const playRound = async () => {
                const collector = message.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id && [doubleId, cashOutId].includes(i.customId),
                    max: 1,
                    time: ROUND_TIMEOUT_MS,
                });

                collector.on('collect', async i => {
                    if (settled) {
                        await i.deferUpdate().catch(() => {});
                        return;
                    }

                    if (i.customId === cashOutId) {
                        await i.update({ components: [buildRow(doubleId, cashOutId, true)] }).catch(() => {});
                        await settle('cashed', pot);
                        return;
                    }

                    // Doubling — flip the coin.
                    const won = Math.random() < WIN_CHANCE;

                    if (!won) {
                        pot = 0;
                        await i.update({ components: [buildRow(doubleId, cashOutId, true)] }).catch(() => {});
                        await settle('lost', 0);
                        return;
                    }

                    pot *= 2;
                    streak += 1;
                    round += 1;

                    if (round > MAX_ROUNDS) {
                        await i.update({ components: [buildRow(doubleId, cashOutId, true)] }).catch(() => {});
                        await settle('maxed', pot);
                        return;
                    }

                    await i.update({
                        embeds: [liveEmbed(username, bet, round, pot, streak)],
                        components: [buildRow(doubleId, cashOutId)],
                    }).catch(() => {});

                    playRound();
                });

                collector.on('end', async (_, reason) => {
                    if (settled || reason !== 'time') return;
                    // No decision: refund the current pot rather than the original bet,
                    // so the player isn't punished for any winning streak so far.
                    await settle('timeout', pot);
                });
            };

            playRound();
        } catch (error) {
            console.error('[DoubleOrNothing] error:', error);
            // Best-effort refund if we crashed after debiting.
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
            const msg = { content: 'Something went wrong. Your wager was refunded.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(msg).catch(() => {});
            } else {
                await interaction.reply(msg).catch(() => {});
            }
        }
    }
};
