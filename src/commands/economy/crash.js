const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../models/User');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4a5.png';
const GROWTH  = 1.12;
const TICK_MS = 1200;
const MIN_BET = 10;
const MAX_BET = 5000;

function generateCrashPoint() {
    const r = Math.random();
    if (r < 0.01) return 1.00;
    return Math.min(100.00, parseFloat((0.99 / r).toFixed(2)));
}

function multiplierAt(tick) {
    return parseFloat(Math.pow(GROWTH, tick).toFixed(2));
}

function ticksUntilCrash(crashPoint) {
    return Math.ceil(Math.log(crashPoint) / Math.log(GROWTH));
}

function multLabel(m) {
    return m >= 10 ? m.toFixed(1) + 'x' : m.toFixed(2) + 'x';
}

// Color transitions from calm green → danger red as multiplier climbs
function crashColor(m, cashedOut) {
    if (cashedOut) return '#00cc66';
    if (m < 1.5)  return '#00ff88';
    if (m < 2.0)  return '#44ff44';
    if (m < 3.0)  return '#aaee00';
    if (m < 5.0)  return '#ffdd00';
    if (m < 8.0)  return '#ffaa00';
    if (m < 15.0) return '#ff6600';
    return '#ff2200';
}

// Risk label changes as multiplier rises
function riskLabel(m) {
    if (m < 1.5)  return '🟢 Safe Zone';
    if (m < 2.0)  return '🟢 Low Risk';
    if (m < 3.0)  return '🟡 Moderate';
    if (m < 5.0)  return '🟡 Risky';
    if (m < 8.0)  return '🟠 High Risk';
    if (m < 15.0) return '🔴 Danger!';
    return '🚨 EXTREME!';
}

// Log-scale bar that fills on a 1x–100x range, with zone color blocks
function progressBar(m) {
    const total  = 20;
    const filled = Math.min(total, Math.round((Math.log(m) / Math.log(100)) * total));
    const empty  = total - filled;
    const glyph  = m < 5 ? '▰' : m < 15 ? '▮' : '█';
    const bar    = glyph.repeat(filled) + '▱'.repeat(empty);
    return `\`${bar}\``;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function liveEmbed(multiplier, bet, interaction, cashedOut, cashedOutAt) {
    const label  = multLabel(multiplier);
    const color  = crashColor(multiplier, cashedOut);
    const risk   = riskLabel(multiplier);
    const bar    = progressBar(multiplier);

    let desc;
    if (cashedOut) {
        desc = `✅ **Cashed out at ${multLabel(cashedOutAt)}** — riding out the crash…\n\n${bar}  ${label}`;
    } else {
        desc = `🚀 **Multiplier rising** — hit Cash Out before it crashes!\n\n${bar}  **${label}**`;
    }

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('💥 Crash')
        .setDescription(desc)
        .addFields(
            { name: '📈 Multiplier', value: `**${label}**`,                       inline: true },
            { name: '⚠️ Risk Level', value: risk,                                  inline: true },
            { name: '💰 Bet',        value: `${bet.toLocaleString()} coins`,       inline: true },
        )
        .setFooter({ text: 'Cash out before it crashes to secure your winnings!' });
}

function crashedEmbed(crashPoint, bet, cashedOut, cashedOutAt, newBalance, interaction) {
    const crashLabel = multLabel(crashPoint);
    let color, headline, fields;

    if (cashedOut) {
        const payout = Math.floor(bet * cashedOutAt);
        const net    = payout - bet;
        color    = '#00cc66';
        headline = `✅ You cashed out at **${multLabel(cashedOutAt)}** before the crash!`;
        fields   = [
            { name: '💸 Bet',           value: `${bet.toLocaleString()} coins`,    inline: true },
            { name: '🏆 Payout',        value: `${payout.toLocaleString()} coins`, inline: true },
            { name: '📊 Net',           value: `**+${net.toLocaleString()}** coins`, inline: true },
            { name: '💥 Crashed At',    value: `**${crashLabel}**`,                inline: true },
            { name: '💰 New Balance',   value: `**${newBalance.toLocaleString()}** coins`, inline: true },
        ];
    } else {
        color    = '#ff3333';
        headline = `💀 You didn't cash out in time! Everything is gone.`;
        fields   = [
            { name: '💥 Crashed At',  value: `**${crashLabel}**`,                  inline: true },
            { name: '💀 Lost',        value: `${bet.toLocaleString()} coins`,       inline: true },
            { name: '💰 New Balance', value: `**${newBalance.toLocaleString()}** coins`, inline: true },
        ];
    }

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(`💥 Crashed at ${crashLabel}!`)
        .setDescription(headline)
        .addFields(fields)
        .setFooter({ text: 'The house always has a 1% edge — play responsibly!' })
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

function buildResultRow(replayId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(replayId)
            .setLabel('💥 Play Again')
            .setStyle(ButtonStyle.Primary),
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
        await playCrash(interaction, bet);
    },
};

async function playCrash(interaction, bet) {
    try {
        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

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
            const fresh = await User.findOne(userFilter);
            return interaction.editReply({
                content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                components: [],
            });
        }

        const crash    = generateCrashPoint();
        const cashOutId = `crash_co_${interaction.id}_${Date.now()}`;

        // Instant crash — no time to react
        if (crash <= 1.00) {
            const replayId = `crash_replay_${interaction.id}_${Date.now()}`;
            const fresh    = await User.findOne(userFilter);
            await interaction.editReply({
                embeds:     [crashedEmbed(1.00, bet, false, 0, fresh?.balance ?? debited.balance, interaction)],
                components: [buildResultRow(replayId)],
            });
            setupReplay(interaction, replayId, bet);
            return;
        }

        let tick        = 0;
        let currentMult = multiplierAt(0);
        let cashedOut   = false;
        let cashedOutAt = 0;
        let gameOver    = false;
        const crashTick   = ticksUntilCrash(crash);
        const collectorMs = (crashTick + 3) * TICK_MS + 8000;

        await interaction.editReply({
            embeds:     [liveEmbed(currentMult, bet, interaction, false, 0)],
            components: [buildCashOutRow(cashOutId, currentMult, false)],
        });

        const message   = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === cashOutId,
            max:    1,
            time:   collectorMs,
        });

        collector.on('collect', async i => {
            if (gameOver || cashedOut) { await i.deferUpdate().catch(() => {}); return; }

            cashedOut   = true;
            cashedOutAt = currentMult;
            const payout = Math.floor(bet * cashedOutAt);

            await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: payout } },
            );

            await i.update({
                embeds:     [liveEmbed(currentMult, bet, interaction, true, cashedOutAt)],
                components: [buildCashOutRow(cashOutId, currentMult, true)],
            }).catch(() => {});
        });

        const interval = setInterval(async () => {
            if (gameOver) return;

            tick++;
            currentMult = multiplierAt(tick);

            if (currentMult >= crash) {
                gameOver = true;
                clearInterval(interval);
                collector.stop('crashed');

                const freshUser  = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                const replayId   = `crash_replay_${interaction.id}_${Date.now()}`;

                await interaction.editReply({
                    embeds:     [crashedEmbed(crash, bet, cashedOut, cashedOutAt, freshUser?.balance ?? debited.balance, interaction)],
                    components: [buildResultRow(replayId)],
                }).catch(() => {});

                setupReplay(interaction, replayId, bet);
                return;
            }

            if (!cashedOut) {
                await interaction.editReply({
                    embeds:     [liveEmbed(currentMult, bet, interaction, false, 0)],
                    components: [buildCashOutRow(cashOutId, currentMult, false)],
                }).catch(() => {});
            }
        }, TICK_MS);

        collector.on('end', (_, reason) => {
            if (reason !== 'crashed' && !gameOver) {
                gameOver = true;
                clearInterval(interval);
            }
        });

    } catch (err) {
        console.error('[Crash] error:', err);
        await interaction.editReply({ content: 'Something went wrong. Please try again.', components: [] }).catch(() => {});
    }
}

function setupReplay(interaction, replayId, bet) {
    interaction.fetchReply().then(msg => {
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        });
        collector.on('collect', async i => {
            await i.deferUpdate();
            await playCrash(interaction, bet);
        });
        collector.on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });
    }).catch(() => {});
}
