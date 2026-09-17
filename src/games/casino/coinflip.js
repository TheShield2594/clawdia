'use strict';

// `/casino coinflip` — call the coin against the house (#1019).
//
// This was `/coinflip`'s solo-vs-house mode. Folded into the casino, the stake
// goes through `placeWager`'s compare-and-set (which also feeds the progressive
// jackpot and the wagering achievements) and the win is paid by
// `games/casino/payout.js` — keyed, retried, and filed for `payouts:replay` when
// it will not land — instead of the raw `$inc` the fun-command version used. The
// casual no-stakes flip and the PvP challenge did not fit a house game and were
// dropped with the old command; `/duel` covers player-vs-player wagering.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { placeWager } = require('../../utils/placeWager');
const { confirmBet } = require('../../utils/confirmBet');
const { delay } = require('../../utils/delay');
const COLORS = require('../../utils/embedColors');
const { newHandId, payHand, payoutNote, settledBalance } = require('./payout');
const { HEADS, TAILS, RAKE, winPayout } = require('./coinflipOdds');

const HEADS_THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1fa99.png';
const SPIN_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const SPIN_MS     = 300;
const MIN_BET     = 10;

const flip = () => (Math.random() < 0.5 ? HEADS : TAILS);
const pip  = side => (side === HEADS ? '👑' : '🔘');

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

// Cosmetic frames: a transient edit failure here shouldn't abort a flip whose
// wager has already been debited.
async function spin(interaction, stakeLine) {
    for (let f = 0; f < 4; f++) {
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(HEADS_THUMB)
                .setColor(COLORS.WARN)
                .setTitle('🪙 Coin Flip')
                .setDescription(`${SPIN_FRAMES[f % SPIN_FRAMES.length]} **Flipping…**\n\n${stakeLine}`)
                .setFooter({ text: 'Heads or Tails?' })],
            components: [],
        }).catch(() => {});
        await delay(SPIN_MS);
    }
}

module.exports = {
    name: 'coinflip',
    description: 'Call a coin flip against the house.',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(o => o
            .setName('bet')
            .setDescription('Coins to wager on the flip.')
            .setMinValue(MIN_BET)
            .setMaxValue(1_000_000_000)
            .setRequired(true))
        .addStringOption(o => o
            .setName('side')
            .setDescription('Call it. Omit and the coin picks your side for you.')
            .addChoices(
                { name: '👑 Heads', value: HEADS },
                { name: '🔘 Tails', value: TAILS },
            )),

    async execute(interaction, { releaseLock, onWager } = {}) {
        const bet           = interaction.options.getInteger('bet');
        const side          = interaction.options.getString('side');
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        const casinoMaxBet = guildSettings?.economy?.casinoMaxBet ?? 0;
        if (casinoMaxBet > 0 && bet > casinoMaxBet) {
            releaseLock?.();
            return interaction.reply({ content: `❌ The casino bet limit on this server is **${casinoMaxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }

        const user   = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const wallet = user?.balance ?? 0;
        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, wallet, 'Coinflip', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }
        if (!alreadyReplied) await interaction.deferReply();

        await playCoinflip(interaction, guildSettings, bet, side, releaseLock, onWager);
    },
};

async function playCoinflip(interaction, guildSettings, bet, side, releaseLock, onWager) {
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

    // The coin doesn't care which side you call, so an uncalled flip is settled
    // on a side picked for the player — same odds, one less decision.
    const call = side ?? flip();
    await spin(
        interaction,
        `Wager: **${currency}${bet.toLocaleString()}** · You call ${pip(call)} **${call}** · pays **${(2 - RAKE).toFixed(2)}x**`,
    );

    const result = flip();
    const won    = result === call;
    const payout = won ? winPayout(bet) : 0;

    const paid = await payHand(userFilter, payout, { game: 'coinflip', handId, phase: 'settle' });
    releaseLock?.();
    const balanceAfter = await settledBalance(userFilter, paid.balance);
    const profit = payout - bet;

    const embed = new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(HEADS_THUMB)
        .setColor(won ? '#2ecc71' : '#e74c3c')
        .setTitle(won ? `🪙 ${result}! You called it!` : `🪙 ${result}. Not your side.`)
        .setDescription((won
            ? `You called ${pip(call)} **${call}** and the coin agreed.\n\n💰 **+${currency}${profit.toLocaleString()}**`
            : `You called ${pip(call)} **${call}**, the coin said **${result}**.\n\n💸 **-${currency}${bet.toLocaleString()}**`)
            + payoutNote(paid))
        .addFields({ name: '💰 Balance', value: `**${currency}${balanceAfter.toLocaleString()}**`, inline: true })
        .setFooter({ text: won ? 'The house keeps 5% — quit while you\'re ahead?' : 'The coin holds no grudges. Probably.' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}
