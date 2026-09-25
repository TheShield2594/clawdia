'use strict';

// `/casino dice` — bet on the roll of a die against the house (#1019).
//
// This was `/roll`'s betting mode. Like `/casino coinflip`, the stake goes
// through `placeWager` and the win through `games/casino/payout.js`, so the two
// wagering games the audit had left outside the casino now carry every guard the
// rest of it does — the bet limit, the confirmation prompt, the jackpot feed and
// a keyed, replayable payout. The casual no-stakes roll was dropped with the old
// command. The payout maths live in `diceOdds.js`.

const { secureRandom } = require('../../utils/secureRandom');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { placeWager } = require('../../utils/placeWager');
const { confirmBet } = require('../../utils/confirmBet');
const { casinoRefusal } = require('./betGuard');
const { delay } = require('../../utils/delay');
const COLORS = require('../../utils/embedColors');
const { newHandId, payHand, payoutNote, settledBalance } = require('./payout');
const { grossPayout, callLabel, callWon, rollBar } = require('./diceOdds');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b2.png';
const MIN_BET = 10;

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

module.exports = {
    name: 'dice',
    description: 'Roll a die and bet high/low or on an exact number.',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(o => o
            .setName('bet')
            .setDescription('Coins to wager on the roll.')
            .setMinValue(MIN_BET)
            .setMaxValue(1_000_000_000)
            .setRequired(true))
        .addStringOption(o => o
            .setName('guess')
            .setDescription('High/low call for your wager (ignored if "number" is set).')
            .addChoices(
                { name: '⬆️ High half', value: 'high' },
                { name: '⬇️ Low half',  value: 'low'  },
            ))
        .addIntegerOption(o => o
            .setName('number')
            .setDescription('Bet on an exact number instead of high/low — pays out big.')
            .setMinValue(1)
            .setMaxValue(100))
        .addIntegerOption(o => o
            .setName('sides')
            .setDescription('Number of sides (default: 6, max: 100).')
            .setMinValue(2)
            .setMaxValue(100)),

    async execute(interaction, { releaseLock, onWager } = {}) {
        const bet    = interaction.options.getInteger('bet');
        const guess  = interaction.options.getString('guess');
        const number = interaction.options.getInteger('number');
        const sides  = interaction.options.getInteger('sides') || 6;

        if (number != null && number > sides) {
            releaseLock?.();
            return interaction.reply({ content: `Your exact-number guess must be between 1 and ${sides} for a d${sides}.`, flags: MessageFlags.Ephemeral });
        }
        if (number == null && !guess) {
            releaseLock?.();
            return interaction.reply({ content: 'A dice bet needs a `guess` (high/low) or an exact `number`.', flags: MessageFlags.Ephemeral });
        }

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const refusal = casinoRefusal(guildSettings, bet);
        if (refusal) {
            releaseLock?.();
            return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
        }

        const user   = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const wallet = user?.balance ?? 0;
        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, wallet, 'Dice', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }
        if (!alreadyReplied) await interaction.deferReply();

        const call = number != null ? { type: 'exact', number } : { type: guess };
        await playDice(interaction, guildSettings, bet, sides, call, releaseLock, onWager);
    },
};

async function playDice(interaction, guildSettings, bet, sides, call, releaseLock, onWager) {
    const currency   = guildSettings?.economy?.currency ?? '💰';
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    const handId     = newHandId();

    const debited = await placeWager(userFilter, bet, { onWager });
    if (!debited) {
        releaseLock?.();
        const fresh = await User.findOne(userFilter);
        return interaction.editReply({
            content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
            embeds: [], components: [],
        }).catch(() => {});
    }

    // The gross return is worked out before the roll so it can be shown while the
    // dice are still in the air.
    const grossWin  = grossPayout(bet, call, sides);
    const stakeLine = `Wager: **${currency}${bet.toLocaleString()}** on ${callLabel(call, sides)} · pays **${(grossWin / bet).toFixed(2)}x**`;
    for (let f = 0; f < 4; f++) {
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(COLORS.INFO)
                .setTitle('🎲 Dice Roll')
                .setDescription(`🎲 **Rolling…**\n\n${stakeLine}`)
                .setFooter({ text: `d${sides}` })],
            components: [],
        }).catch(() => {});
        await delay(300);
    }

    const result = Math.floor(secureRandom() * sides) + 1;
    const won    = callWon(call, result, sides);
    const payout = won ? grossWin : 0;

    const paid = await payHand(userFilter, payout, { game: 'dice', handId, phase: 'settle' });
    releaseLock?.();
    const balanceAfter = await settledBalance(userFilter, paid.balance);
    const profit = payout - bet;

    const embed = new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(won ? '#2ecc71' : '#e74c3c')
        .setTitle(won ? `🎲 ${result}! You called it!` : `🎲 ${result}. Not your call.`)
        .setDescription((won
            ? `You called ${callLabel(call, sides)} and rolled **${result}** on a d${sides}.\n\n💰 **+${currency}${profit.toLocaleString()}**`
            : `You called ${callLabel(call, sides)}, but rolled **${result}** on a d${sides}.\n\n💸 **-${currency}${bet.toLocaleString()}**`)
            + payoutNote(paid))
        .addFields(
            { name: '📈 Roll',    value: rollBar(result, sides), inline: false },
            { name: '💰 Balance', value: `**${currency}${balanceAfter.toLocaleString()}**`, inline: true },
        )
        .setFooter({ text: won ? 'The house keeps 5% — quit while you\'re ahead?' : 'The dice hold no grudges. Probably.' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}
