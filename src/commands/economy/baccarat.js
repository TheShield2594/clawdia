const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

const MIN_BET = 10;
const MAX_BET = 5000;

// Standard Punto Banco payouts.
// Banker wins pay even money minus a 5% commission. Tie pays 8:1 (bet returned).
const PAYOUT = {
    player: { profitMult: 1.0 },
    banker: { profitMult: 0.95 },
    tie:    { profitMult: 8.0 },
};

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

function buildShoe(decks = 8) {
    const shoe = [];
    for (let d = 0; d < decks; d++) {
        for (const suit of SUITS) {
            for (const rank of RANKS) {
                shoe.push({ rank, suit });
            }
        }
    }
    // Fisher–Yates shuffle.
    for (let i = shoe.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
    return shoe;
}

function cardValue(card) {
    if (card.rank === 'A') return 1;
    if (['10', 'J', 'Q', 'K'].includes(card.rank)) return 0;
    return parseInt(card.rank, 10);
}

function handTotal(cards) {
    return cards.reduce((sum, c) => sum + cardValue(c), 0) % 10;
}

function formatHand(cards) {
    return cards.map(c => `\`${c.rank}${c.suit}\``).join(' ');
}

// Plays out a Baccarat coup using the standard third-card drawing rules.
function playCoup(shoe) {
    const player = [shoe.pop(), shoe.pop()];
    const banker = [shoe.pop(), shoe.pop()];

    const pTotal = handTotal(player);
    const bTotal = handTotal(banker);

    // Natural: 8 or 9 on either first two cards ends the coup immediately.
    if (pTotal >= 8 || bTotal >= 8) {
        return { player, banker, natural: true };
    }

    let playerThird = null;
    if (pTotal <= 5) {
        playerThird = shoe.pop();
        player.push(playerThird);
    }

    // Banker rules depend on whether player drew, and on the rank-value of player's third card.
    const bankerCurrent = handTotal(banker);
    let bankerDraws = false;

    if (playerThird === null) {
        // Player stood (had 6 or 7): banker draws on 0-5, stands on 6-7.
        bankerDraws = bankerCurrent <= 5;
    } else {
        const t = cardValue(playerThird);
        if (bankerCurrent <= 2) bankerDraws = true;
        else if (bankerCurrent === 3) bankerDraws = t !== 8;
        else if (bankerCurrent === 4) bankerDraws = t >= 2 && t <= 7;
        else if (bankerCurrent === 5) bankerDraws = t >= 4 && t <= 7;
        else if (bankerCurrent === 6) bankerDraws = t === 6 || t === 7;
        // Banker 7: stands.
    }

    if (bankerDraws) {
        banker.push(shoe.pop());
    }

    return { player, banker, natural: false };
}

function determineWinner(player, banker) {
    const p = handTotal(player);
    const b = handTotal(banker);
    if (p > b) return 'player';
    if (b > p) return 'banker';
    return 'tie';
}

function resultEmbed({ pick, winner, player, banker, natural, bet, profit, balance, username }) {
    const pTotal = handTotal(player);
    const bTotal = handTotal(banker);
    const won = winner === pick;

    const winnerLabel = winner === 'tie' ? 'Tie' : winner === 'player' ? 'Player' : 'Banker';
    const pickLabel   = pick   === 'tie' ? 'Tie' : pick   === 'player' ? 'Player' : 'Banker';

    let color, headline;
    if (won) {
        color    = '#2ecc71';
        headline = `🏆 **${winnerLabel} wins** — your bet pays out!`;
    } else {
        color    = '#e74c3c';
        headline = `💀 **${winnerLabel} wins** — your ${pickLabel} bet loses.`;
    }

    const naturalTag = natural ? '  *(Natural)*' : '';
    const netStr     = profit >= 0 ? `+${profit.toLocaleString()}` : `${profit.toLocaleString()}`;

    return new EmbedBuilder()
        .setColor(color)
        .setTitle('🎴 Baccarat')
        .setDescription(`${headline}${naturalTag}`)
        .addFields(
            { name: `🧍 Player — ${pTotal}`, value: formatHand(player), inline: true },
            { name: `🏛️ Banker — ${bTotal}`, value: formatHand(banker), inline: true },
            { name: '​', value: '​', inline: false },
            { name: '🎯 Your Bet',  value: `${pickLabel} — ${bet.toLocaleString()} coins`, inline: true },
            { name: '📊 Net',       value: `${netStr} coins`, inline: true },
            { name: '💰 Balance',   value: `${balance.toLocaleString()} coins`, inline: true },
        )
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('baccarat')
        .setDescription('Bet on Player, Banker, or Tie in a hand of Baccarat')
        .addStringOption(opt =>
            opt.setName('side')
                .setDescription('Which outcome to bet on')
                .setRequired(true)
                .addChoices(
                    { name: 'Player (1:1)',         value: 'player' },
                    { name: 'Banker (0.95:1, 5% commission)', value: 'banker' },
                    { name: 'Tie (8:1)',            value: 'tie'    },
                ))
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to wager (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true)),
    cooldown: 5,

    async execute(interaction) {
        const pick = interaction.options.getString('side');
        const bet  = interaction.options.getInteger('bet');

        await interaction.deferReply();

        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
                return interaction.editReply({ content: 'Economy games are disabled in this server.' });
            }

            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );

            // Atomic deduct: only succeeds if balance covers the bet.
            const debited = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true },
            );

            if (!debited) {
                return interaction.editReply({
                    content: `You don't have enough coins to wager **${bet.toLocaleString()}**.`,
                });
            }

            const shoe = buildShoe();
            const { player, banker, natural } = playCoup(shoe);
            const winner = determineWinner(player, banker);

            // Compute payout. Loser bets are gone; winner bets get stake + profit credited.
            // Tie pushes Player/Banker bets (stake returned, no profit).
            let credit = 0;
            let profit = -bet;

            if (winner === pick) {
                profit = Math.floor(bet * PAYOUT[pick].profitMult);
                credit = bet + profit;
            } else if (winner === 'tie' && (pick === 'player' || pick === 'banker')) {
                // Push: refund the stake, no profit.
                credit = bet;
                profit = 0;
            }

            let updated = debited;
            if (credit > 0) {
                updated = await User.findOneAndUpdate(
                    userFilter,
                    { $inc: { balance: credit } },
                    { new: true },
                );
            }

            await interaction.editReply({
                embeds: [resultEmbed({
                    pick,
                    winner,
                    player,
                    banker,
                    natural,
                    bet,
                    profit,
                    balance: updated.balance,
                    username: interaction.user.username,
                })],
            });
        } catch (err) {
            console.error('[Baccarat] error:', err);
            await interaction.editReply({ content: 'Something went wrong while dealing the cards. Please try again.' }).catch(() => {});
        }
    },
};
