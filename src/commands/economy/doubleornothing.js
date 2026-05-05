const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const THUMB          = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b2.png';
const MIN_BET        = 10;
const MAX_BET        = 5000;
const MAX_ROUNDS     = 10;
const WIN_CHANCE     = 0.5;
const ROUND_TIMEOUT  = 20_000;

// Embed color escalates as the pot grows through rounds
function potColor(round) {
    if (round <= 2)  return '#2ecc71'; // green — low stakes
    if (round <= 4)  return '#f1c40f'; // yellow
    if (round <= 6)  return '#ff9900'; // orange
    if (round <= 8)  return '#ff5500'; // deep orange
    return '#ff2200';                   // red — extreme stakes
}

// Visual round-progress track: filled green ● per completed win, empty ○ remaining
function roundTrack(streakSoFar) {
    const filled = Math.min(streakSoFar, MAX_ROUNDS);
    const empty  = MAX_ROUNDS - filled;
    return '🟢'.repeat(filled) + '⬜'.repeat(empty);
}

// Probability of surviving all remaining rounds from this point
function survivalOdds(roundsLeft) {
    return ((WIN_CHANCE ** roundsLeft) * 100).toFixed(1);
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function liveEmbed(interaction, bet, round, pot, streak) {
    const nextPot    = pot * 2;
    const roundsLeft = MAX_ROUNDS - round;
    const atMax      = round >= MAX_ROUNDS;

    const desc = atMax
        ? `🏆 **Maximum streak reached!** Cash out now before the table closes.`
        : `Risk **${nextPot.toLocaleString()}** coins, or walk away with **${pot.toLocaleString()}** coins.\n` +
          `Odds of surviving all ${roundsLeft} remaining round${roundsLeft === 1 ? '' : 's'}: **${survivalOdds(roundsLeft)}%**`;

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(potColor(round))
        .setTitle('🎰 Double or Nothing')
        .setDescription(
            `**Round ${round} of ${MAX_ROUNDS}**\n` +
            `${roundTrack(streak)}\n\n` +
            desc,
        )
        .addFields(
            { name: '💰 Current Pot', value: `**${pot.toLocaleString()}** coins`,  inline: true },
            { name: '📈 If Win',      value: `**${nextPot.toLocaleString()}** coins`, inline: true },
            { name: '🔥 Streak',      value: streak > 0 ? `**${streak}** win${streak === 1 ? '' : 's'}` : '*None yet*', inline: true },
            { name: '💸 Initial Bet', value: `${bet.toLocaleString()} coins`,       inline: true },
            { name: '🎲 Win Chance',  value: '**50%** per flip',                    inline: true },
        )
        .setFooter({ text: 'Green button = safe. Red button = risk everything.' });
}

function resultEmbed(interaction, bet, pot, streak, outcome, finalBalance) {
    const configs = {
        cashed:  { color: '#2ecc71', title: '💰 Cashed Out!',   desc: `You walked away with **${pot.toLocaleString()}** coins after a **${streak}-win** streak!\n\n*Smart move!*` },
        lost:    { color: '#e74c3c', title: '💥 Busted!',        desc: `The flip went against you — you lost **${bet.toLocaleString()}** coins after **${streak}** win${streak === 1 ? '' : 's'}.\n\n*Better luck next time!*` },
        maxed:   { color: '#FF00FF', title: '🏆 MAX STREAK!',    desc: `🎉 **UNBELIEVABLE!** You hit the ${MAX_ROUNDS}-flip maximum and auto-cashed for **${pot.toLocaleString()}** coins!\n\n*Absolute legend!*` },
        timeout: { color: '#95a5a6', title: '⏱️ Timed Out',      desc: `No decision in time — the dealer cashed you out for **${pot.toLocaleString()}** coins.` },
    };
    const { color, title, desc } = configs[outcome] ?? configs.timeout;

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(`🎰 Double or Nothing — ${title}`)
        .setDescription(desc + `\n\n${roundTrack(streak)}`)
        .addFields(
            { name: '💸 Initial Bet',  value: `${bet.toLocaleString()} coins`,         inline: true },
            { name: '🏆 Final Pot',    value: `${pot.toLocaleString()} coins`,          inline: true },
            { name: '🔥 Win Streak',   value: `${streak} flip${streak === 1 ? '' : 's'}`, inline: true },
            { name: '💰 New Balance',  value: `**${finalBalance.toLocaleString()}** coins` },
        )
        .setFooter({ text: 'Max streak: 10 wins = 1,024× your bet' })
        .setTimestamp();
}

function buildGameRow(doubleId, cashOutId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(cashOutId)
            .setLabel('💰 Cash Out')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(doubleId)
            .setLabel('🎲 Double or Nothing')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

function buildReplayRow(replayId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(replayId)
            .setLabel('🎰 Play Again')
            .setStyle(ButtonStyle.Primary),
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
        await interaction.deferReply();
        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
                return interaction.editReply({ content: 'Economy games are disabled in this server.' });
            }

            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            const debited = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true }
            );

            if (!debited) {
                return interaction.editReply({
                    content: `❌ Insufficient funds. You need **${bet.toLocaleString()}** coins to play.`,
                });
            }

            await playDoubleOrNothing(interaction, bet, userFilter, debited);

        } catch (err) {
            console.error('[DoubleOrNothing] error:', err);
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
            await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', components: [] }).catch(() => {});
        }
    },
};

async function playDoubleOrNothing(interaction, bet, userFilter, debited) {
    const doubleId  = `don_double_${interaction.id}_${Date.now()}`;
    const cashOutId = `don_cash_${interaction.id}_${Date.now()}`;

    let round   = 1;
    let pot     = bet;
    let streak  = 0;
    let settled = false;

    await interaction.editReply({
        embeds:     [liveEmbed(interaction, bet, round, pot, streak)],
        components: [buildGameRow(doubleId, cashOutId)],
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

        const replayId = `don_replay_${interaction.id}_${Date.now()}`;
        await interaction.editReply({
            embeds:     [resultEmbed(interaction, bet, pot, streak, outcome, finalBalance)],
            components: [buildReplayRow(replayId)],
        }).catch(() => {});

        // Set up replay collector
        interaction.fetchReply().then(msg => {
            const collector = msg.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id && i.customId === replayId,
                max: 1,
                time: 60_000,
            });
            collector.on('collect', async i => {
                await i.deferUpdate();
                // Re-debit for new game
                const newDebited = await User.findOneAndUpdate(
                    { ...userFilter, balance: { $gte: bet } },
                    { $inc: { balance: -bet } },
                    { new: true }
                );
                if (!newDebited) {
                    const fresh = await User.findOne(userFilter);
                    await interaction.editReply({
                        content: `❌ Not enough coins! Balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                        embeds: [], components: [],
                    });
                    return;
                }
                await playDoubleOrNothing(interaction, bet, userFilter, newDebited);
            });
            collector.on('end', (_, reason) => {
                if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
            });
        }).catch(() => {});
    };

    const playRound = async () => {
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && [doubleId, cashOutId].includes(i.customId),
            max: 1,
            time: ROUND_TIMEOUT,
        });

        collector.on('collect', async i => {
            if (settled) { await i.deferUpdate().catch(() => {}); return; }

            if (i.customId === cashOutId) {
                await i.update({ components: [buildGameRow(doubleId, cashOutId, true)] }).catch(() => {});
                await settle('cashed', pot);
                return;
            }

            // Double — flip the coin
            const won = Math.random() < WIN_CHANCE;
            if (!won) {
                pot = 0;
                await i.update({ components: [buildGameRow(doubleId, cashOutId, true)] }).catch(() => {});
                await settle('lost', 0);
                return;
            }

            pot    *= 2;
            streak += 1;
            round  += 1;

            if (round > MAX_ROUNDS) {
                await i.update({ components: [buildGameRow(doubleId, cashOutId, true)] }).catch(() => {});
                await settle('maxed', pot);
                return;
            }

            await i.update({
                embeds:     [liveEmbed(interaction, bet, round, pot, streak)],
                components: [buildGameRow(doubleId, cashOutId)],
            }).catch(() => {});

            playRound();
        });

        collector.on('end', async (_, reason) => {
            if (settled || reason !== 'time') return;
            await settle('timeout', pot);
        });
    };

    playRound();
}
