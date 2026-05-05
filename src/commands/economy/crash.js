const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../models/User');

// Multiplier grows by 12% each tick; ticks fire every 1.2 s (safe under Discord's rate limit).
// 2x ≈ 6 s | 5x ≈ 14 s | 10x ≈ 21 s | 50x ≈ 36 s
const GROWTH  = 1.12;
const TICK_MS = 1200;
const MIN_BET = 10;
const MAX_BET = 5000;

// Standard provably-fair crash distribution: E[crashPoint] = 99 (1 % house edge).
function generateCrashPoint() {
    const r = Math.random();
    if (r < 0.01) return 1.00;                                  // 1 % instant-bust
    return Math.min(100.00, parseFloat((0.99 / r).toFixed(2))); // cap at 100x
}

function multiplierAt(tick) {
    return parseFloat(Math.pow(GROWTH, tick).toFixed(2));
}

// How many ticks until the multiplier first equals or exceeds the crash point.
function ticksUntilCrash(crashPoint) {
    return Math.ceil(Math.log(crashPoint) / Math.log(GROWTH));
}

function multLabel(m) {
    return m >= 10 ? m.toFixed(1) + 'x' : m.toFixed(2) + 'x';
}

// Horizontal bar that fills up on a log scale relative to the crash cap (100x).
function progressBar(current) {
    const filled = Math.min(20, Math.round((Math.log(current) / Math.log(100)) * 20));
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

function liveEmbed(multiplier, bet, username, cashedOut, cashedOutAt) {
    const label = multLabel(multiplier);
    const bar   = progressBar(multiplier);
    const isSafe = !cashedOut;

    let desc;
    if (cashedOut) {
        desc = `✅ Cashed out at **${multLabel(cashedOutAt)}** — waiting for crash…\n\n\`${bar}\``;
    } else {
        desc = `🚀 Multiplier rising — cash out before it crashes!\n\n\`${bar}\``;
    }

    return new EmbedBuilder()
        .setColor(cashedOut ? '#00cc66' : '#ff9900')
        .setTitle('💥 Crash')
        .setDescription(desc)
        .addFields(
            { name: '📈 Multiplier', value: `**${label}**`, inline: true },
            { name: '💰 Bet',        value: `${bet.toLocaleString()} coins`, inline: true },
        )
        .setFooter({ text: `Player: ${username}` });
}

function crashedEmbed(crashPoint, bet, cashedOut, cashedOutAt, newBalance, username) {
    const crashLabel = multLabel(crashPoint);
    let color, resultDesc;

    if (cashedOut) {
        const payout = Math.floor(bet * cashedOutAt);
        const net    = payout - bet;
        color      = '#00cc66';
        resultDesc = `✅ Cashed out at **${multLabel(cashedOutAt)}**\n🏆 Won **${payout.toLocaleString()}** coins *(+${net.toLocaleString()})*`;
    } else {
        color      = '#ff3333';
        resultDesc = `❌ You didn't cash out in time!\n💀 Lost **${bet.toLocaleString()}** coins`;
    }

    return new EmbedBuilder()
        .setColor(color)
        .setTitle('💥 Crashed!')
        .setDescription(`**CRASHED at ${crashLabel}**\n\n${resultDesc}`)
        .addFields({ name: '💰 New Balance', value: `${newBalance.toLocaleString()} coins` })
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
}

function buildCashOutRow(id, multiplier, disabled) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(id)
            .setLabel(disabled ? '✅ Cashed Out' : `💰 Cash Out  ${multLabel(multiplier)}`)
            .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
            .setDisabled(disabled),
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('crash')
        .setDescription('Bet on a rising multiplier — cash out before it crashes!')
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to bet (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true)),
    cooldown: 10,

    async execute(interaction) {
        const bet = interaction.options.getInteger('bet');
        await interaction.deferReply();

        try {
            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            // Atomic debit: only proceeds if balance covers the bet.
            const debited = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true }
            );

            if (!debited) {
                const fresh = await User.findOne(userFilter);
                return interaction.editReply({
                    content: `You don't have enough coins! Wallet: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                });
            }

            const crash     = generateCrashPoint();
            const username  = interaction.user.username;
            const cashOutId = `crash_co_${interaction.id}`;

            // --- Instant crash (1.00x) — no time to react ---
            if (crash <= 1.00) {
                return interaction.editReply({
                    embeds: [crashedEmbed(1.00, bet, false, 0, user.balance, username)],
                });
            }

            // --- Send initial embed with Cash Out button ---
            let tick            = 0;
            let currentMult     = multiplierAt(0);
            let cashedOut       = false;
            let cashedOutAt     = 0;
            let gameOver        = false;
            const crashTick     = ticksUntilCrash(crash);
            // Add a generous buffer so the collector stays alive past the crash tick.
            const collectorMs   = (crashTick + 3) * TICK_MS + 8000;

            await interaction.editReply({
                embeds:     [liveEmbed(currentMult, bet, username, false, 0)],
                components: [buildCashOutRow(cashOutId, currentMult, false)],
            });

            const message   = await interaction.fetchReply();
            const collector = message.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id && i.customId === cashOutId,
                max:    1,
                time:   collectorMs,
            });

            // --- Handle cash-out button click ---
            collector.on('collect', async i => {
                if (gameOver || cashedOut) {
                    await i.deferUpdate().catch(() => {});
                    return;
                }

                cashedOut    = true;
                cashedOutAt  = currentMult;
                const payout = Math.floor(bet * cashedOutAt);

                // Credit payout atomically.
                await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $inc: { balance: payout } },
                );

                await i.update({
                    embeds:     [liveEmbed(currentMult, bet, username, true, cashedOutAt)],
                    components: [buildCashOutRow(cashOutId, currentMult, true)],
                }).catch(() => {});
            });

            // --- Tick loop ---
            const interval = setInterval(async () => {
                if (gameOver) return;

                tick++;
                currentMult = multiplierAt(tick);

                // Crash condition: we've hit or passed the crash point.
                if (currentMult >= crash) {
                    gameOver = true;
                    clearInterval(interval);
                    collector.stop('crashed');

                    const freshUser = await User.findOne({
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                    });

                    await interaction.editReply({
                        embeds:     [crashedEmbed(crash, bet, cashedOut, cashedOutAt, freshUser.balance, username)],
                        components: [],
                    }).catch(() => {});

                    return;
                }

                // Only update live embed when the player hasn't cashed out yet.
                if (!cashedOut) {
                    await interaction.editReply({
                        embeds:     [liveEmbed(currentMult, bet, username, false, 0)],
                        components: [buildCashOutRow(cashOutId, currentMult, false)],
                    }).catch(() => {});
                }
            }, TICK_MS);

            // Safety net: if the collector times out before the interval fires the crash
            // (shouldn't happen given the buffer, but guards against edge cases).
            collector.on('end', (_, reason) => {
                if (reason !== 'crashed' && !gameOver) {
                    gameOver = true;
                    clearInterval(interval);
                }
            });

        } catch (err) {
            console.error('[Crash] error:', err);
            await interaction.editReply({ content: 'Something went wrong. Please try again.' }).catch(() => {});
        }
    },
};
