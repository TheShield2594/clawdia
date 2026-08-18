const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');
const Guild = require('../../models/Guild');
const User  = require('../../models/User');
const { logTransaction } = require('../../utils/logTransaction');
const { createReplaySession, replayButtonRow } = require('../../utils/replaySession');
const { refundWager } = require('../../utils/refundWager');
const { delay } = require('../../utils/delay');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b2.png';

const MIN_BET   = 10;
const HOUSE_CUT = 0.05; // 5% rake on both bet modes, matching coinflip's solo wager

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
    __test__: { payoutMultiplier, callWon, callLabel, rollBar },

    data: new SlashCommandBuilder()
        .setName('roll')
        .setDescription('Roll a die')
        .addIntegerOption(opt =>
            opt.setName('sides')
                .setDescription('Number of sides (default: 6, max: 100)')
                .setRequired(false)
                .setMinValue(2)
                .setMaxValue(100))
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription('Wager coins on the roll (omit for a casual roll)')
                .setRequired(false)
                .setMinValue(MIN_BET))
        .addStringOption(opt =>
            opt.setName('guess')
                .setDescription('High/low call for your wager (ignored if "number" is set)')
                .setRequired(false)
                .addChoices(
                    { name: '⬆️ High half',  value: 'high' },
                    { name: '⬇️ Low half',   value: 'low'  },
                ))
        .addIntegerOption(opt =>
            opt.setName('number')
                .setDescription('Bet on an exact number instead of high/low — pays out big')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(100)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.rollEnabled === false) {
            return interaction.reply({ content: 'Dice roll is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        const sides  = interaction.options.getInteger('sides') || 6;
        const bet    = interaction.options.getInteger('bet');
        const guess  = interaction.options.getString('guess');
        const number = interaction.options.getInteger('number');

        if (!bet) {
            await interaction.deferReply();
            return playRoll(interaction, sides);
        }

        if (number != null && number > sides) {
            return interaction.reply({ content: `Your exact-number guess must be between 1 and ${sides} for a d${sides}.`, flags: MessageFlags.Ephemeral });
        }
        if (number == null && !guess) {
            return interaction.reply({ content: 'Betting requires a `guess` (high/low) or an exact `number`.', flags: MessageFlags.Ephemeral });
        }

        const maxBet = guildSettings?.economy?.duelMaxBet ?? 10_000;
        if (bet > maxBet) {
            return interaction.reply({ content: `The maximum roll wager here is **${maxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();
        return playRollBet(interaction, guildSettings, sides, bet, number != null ? { type: 'exact', number } : { type: guess });
    },
};

async function playRoll(interaction, sides) {
    const replayId = `roll_replay_${interaction.id}`;
    let session    = null;

    async function render() {
        const result = Math.floor(Math.random() * sides) + 1;
        return interaction.editReply({
            embeds:     [resultEmbed(interaction, result, sides)],
            components: session?.ended ? [] : [replayButtonRow(replayId, { emoji: '🎲', label: 'Roll Again' })],
        });
    }

    const message = await render();

    session = createReplaySession({
        interaction,
        message,
        customIds: [replayId],
        label:     'roll',
        claim:     `Those dice are ${interaction.user}'s — run \`/roll\` to roll your own.`,
        async onCollect(button) {
            await button.deferUpdate();
            await render();
        },
    });
}


const refund = (userId, guildId, amount, note) =>
    refundWager({ userId, guildId, amount, type: 'roll', note });

// Exact-number bets pay out at sides:1 odds (before the house cut). High/low pays
// at true odds for the split (sides / winning-number-count) rather than a flat 2x —
// on odd-sided dice the low half has one fewer number than the high half, so a flat
// 2x would give "high" bettors better-than-even odds at the same payout.
function payoutMultiplier(call, sides) {
    if (call.type === 'exact') return sides;
    const half         = Math.floor(sides / 2);
    const winningCount = call.type === 'high' ? sides - half : half;
    return sides / winningCount;
}

function callLabel(call, sides) {
    if (call.type === 'exact') return `exact **${call.number}**`;
    const half = Math.floor(sides / 2);
    return call.type === 'high' ? `**high** (${half + 1}–${sides})` : `**low** (1–${half})`;
}

function callWon(call, result, sides) {
    if (call.type === 'exact') return result === call.number;
    const half = Math.floor(sides / 2);
    return call.type === 'high' ? result > half : result <= half;
}

async function playRollBet(interaction, guildSettings, sides, bet, call) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    const guildId  = interaction.guild.id;

    const debited = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId, balance: { $gte: bet } },
        { $inc: { balance: -bet } },
        { new: true }
    );
    if (!debited) {
        return interaction.editReply({ content: `You don't have **${currency}${bet.toLocaleString()}** to wager.` });
    }

    // Work the payout out before the roll so it can be shown while the dice are
    // still in the air, rather than only turning up in the result.
    const multiplier  = payoutMultiplier(call, sides);
    const grossPayout = Math.floor(bet * multiplier * (1 - HOUSE_CUT));
    const stakeLine   = `Wager: **${currency}${bet.toLocaleString()}** on ${callLabel(call, sides)} · pays **${(grossPayout / bet).toFixed(2)}x**`;
    for (let f = 0; f < 4; f++) {
        // Animation frames are cosmetic — a transient editReply failure here shouldn't
        // abort the roll and strand the bet that was already debited above.
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('🎲 Dice Roll')
                .setDescription(`🎲 **Rolling…**\n\n${stakeLine}`)
                .setFooter({ text: `d${sides}` })],
        }).catch(() => {});
        await delay(300);
    }

    const result = Math.floor(Math.random() * sides) + 1;
    const won    = callWon(call, result, sides);
    const profit = grossPayout - bet;

    let updated = debited;
    if (won) {
        try {
            updated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId },
                { $inc: { balance: grossPayout } },
                { new: true }
            );
        } catch (error) {
            // The stake is gone and the win can't be paid. Return it rather
            // than let a database hiccup pocket the wager.
            console.error('[roll] payout failed, returning the stake:', error);
            await refund(interaction.user.id, guildId, bet, 'Roll bet — payout failed, stake returned');
            return interaction.editReply({
                content: `You rolled **${result}** and called it — but the payout failed, so your **${currency}${bet.toLocaleString()}** has been returned. Try again in a moment.`,
                embeds:  [],
            }).catch(() => {});
        }
    }
    logTransaction({
        userId:  interaction.user.id,
        guildId,
        type:    'roll',
        amount:  won ? profit : -bet,
        balance: updated?.balance ?? 0,
        note:    `Roll bet — called ${callLabel(call, sides)}, rolled ${result} on d${sides}`,
    });

    const embed = new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(won ? '#2ecc71' : '#e74c3c')
        .setTitle(won ? `🎲 ${result}! You called it!` : `🎲 ${result}. Not your call.`)
        .setDescription(
            won
                ? `You called ${callLabel(call, sides)} and rolled **${result}** on a d${sides}.\n\n💰 **+${currency}${profit.toLocaleString()}**`
                : `You called ${callLabel(call, sides)}, but rolled **${result}** on a d${sides}.\n\n💸 **-${currency}${bet.toLocaleString()}**`
        )
        .addFields(
            { name: '📈 Roll',    value: rollBar(result, sides), inline: false },
            { name: '💰 Balance', value: `**${currency}${(updated?.balance ?? 0).toLocaleString()}**`, inline: true },
        )
        .setFooter({ text: won ? 'The house keeps 5% — quit while you\'re ahead?' : 'The dice hold no grudges. Probably.' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}
