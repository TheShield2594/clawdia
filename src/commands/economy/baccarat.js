const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b4.png';
const MIN_BET = 10;
const MAX_BET = 5000;

const PAYOUT = {
    player: { profitMult: 1.0  },
    banker: { profitMult: 0.95 },
    tie:    { profitMult: 8.0  },
};

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

// Suit colors for display (♥ ♦ are red)
function suitColor(suit) {
    return suit === '♥' || suit === '♦' ? '🔴' : '⚫';
}

function buildShoe(decks = 8) {
    const shoe = [];
    for (let d = 0; d < decks; d++)
        for (const suit of SUITS)
            for (const rank of RANKS)
                shoe.push({ rank, suit });
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

function formatCard(c) {
    return `\`${c.rank}${c.suit}\``;
}

function formatHand(cards) {
    return cards.map(formatCard).join(' ');
}

function playCoup(shoe) {
    const player = [shoe.pop(), shoe.pop()];
    const banker = [shoe.pop(), shoe.pop()];

    const pTotal = handTotal(player);
    const bTotal = handTotal(banker);

    if (pTotal >= 8 || bTotal >= 8) return { player, banker, natural: true };

    let playerThird = null;
    if (pTotal <= 5) { playerThird = shoe.pop(); player.push(playerThird); }

    const bankerCurrent = handTotal(banker);
    let bankerDraws = false;
    if (playerThird === null) {
        bankerDraws = bankerCurrent <= 5;
    } else {
        const t = cardValue(playerThird);
        if (bankerCurrent <= 2) bankerDraws = true;
        else if (bankerCurrent === 3) bankerDraws = t !== 8;
        else if (bankerCurrent === 4) bankerDraws = t >= 2 && t <= 7;
        else if (bankerCurrent === 5) bankerDraws = t >= 4 && t <= 7;
        else if (bankerCurrent === 6) bankerDraws = t === 6 || t === 7;
    }
    if (bankerDraws) banker.push(shoe.pop());

    return { player, banker, natural: false };
}

function determineWinner(player, banker) {
    const p = handTotal(player);
    const b = handTotal(banker);
    if (p > b) return 'player';
    if (b > p) return 'banker';
    return 'tie';
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

// Total bar: filled pips up to 9
function totalBar(n) {
    return '🟦'.repeat(n) + '⬜'.repeat(9 - n);
}

function dealingEmbed(phase, player, banker, pick, bet, interaction) {
    const descriptions = {
        deal1: '🃏 *Dealing first round of cards…*',
        deal2: '🃏 *Dealing second round of cards…*',
        draw:  '🃏 *Applying drawing rules…*',
    };

    const pTotal = handTotal(player);
    const bTotal = handTotal(banker);

    const fields = [];
    if (phase === 'deal1') {
        fields.push(
            { name: '🧍 Player', value: `${formatCard(player[0])}  \`?\``, inline: true },
            { name: '🏛️ Banker', value: `${formatCard(banker[0])}  \`?\``, inline: true },
        );
    } else {
        fields.push(
            { name: `🧍 Player — ${pTotal}`, value: formatHand(player), inline: true },
            { name: `🏛️ Banker — ${bTotal}`, value: formatHand(banker), inline: true },
        );
    }

    const pickLabel = pick === 'tie' ? 'Tie' : pick === 'player' ? 'Player' : 'Banker';
    fields.push(
        { name: '​', value: '​', inline: false },
        { name: '🎯 Your Bet', value: `${pickLabel} — ${bet.toLocaleString()} coins`, inline: true },
    );

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#3b82f6')
        .setTitle('🎴 Baccarat — Dealing…')
        .setDescription(descriptions[phase] ?? '🃏 *Resolving hand…*')
        .addFields(fields)
        .setFooter({ text: 'Natural (8 or 9) ends the hand immediately  •  Banker pays 5% commission' });
}

function resultEmbed({ pick, winner, player, banker, natural, bet, profit, balance, interaction }) {
    const pTotal = handTotal(player);
    const bTotal = handTotal(banker);
    const won    = winner === pick;
    const isPush = winner === 'tie' && (pick === 'player' || pick === 'banker');

    const winnerLabel = winner === 'tie' ? 'Tie' : winner === 'player' ? 'Player' : 'Banker';
    const pickLabel   = pick   === 'tie' ? 'Tie' : pick   === 'player' ? 'Player' : 'Banker';
    const netStr      = profit >= 0 ? `+${profit.toLocaleString()}` : `${profit.toLocaleString()}`;

    let color, headline;
    if (isPush) {
        color    = '#3b82f6';
        headline = `🤝 **Tie — Push!** Your ${pickLabel} bet is returned.`;
    } else if (won) {
        color    = '#2ecc71';
        headline = `🏆 **${winnerLabel} wins!** Your ${pickLabel} bet pays out!`;
    } else {
        color    = '#e74c3c';
        headline = `💀 **${winnerLabel} wins.** Your ${pickLabel} bet loses.`;
    }

    const naturalTag = natural ? '  ⚡ *Natural!*' : '';

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(`🎴 Baccarat — ${winnerLabel} Wins${natural ? ' (Natural)' : ''}`)
        .setDescription(`${headline}${naturalTag}`)
        .addFields(
            { name: `🧍 Player — ${pTotal}`, value: formatHand(player) + '\n' + totalBar(pTotal), inline: true },
            { name: `🏛️ Banker — ${bTotal}`, value: formatHand(banker) + '\n' + totalBar(bTotal), inline: true },
            { name: '​', value: '​', inline: false },
            { name: '🎯 Your Bet',  value: `${pickLabel} — ${bet.toLocaleString()} coins`, inline: true },
            { name: '📊 Net',       value: `**${netStr}** coins`,                          inline: true },
            { name: '💰 Balance',   value: `**${balance.toLocaleString()}** coins`,        inline: true },
        )
        .setFooter({ text: 'Player ≈ 44.6% · Banker ≈ 45.9% · Tie ≈ 9.5%  •  Banker commission 5%' })
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
                    { name: 'Player (1:1)',                      value: 'player' },
                    { name: 'Banker (0.95:1 — 5% commission)',   value: 'banker' },
                    { name: 'Tie (8:1)',                         value: 'tie'    },
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
        await playBaccarat(interaction, pick, bet);
    },
};

async function playBaccarat(interaction, pick, bet) {
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

        const debited = await User.findOneAndUpdate(
            { ...userFilter, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true },
        );

        if (!debited) {
            return interaction.editReply({
                content: `❌ Not enough coins to wager **${bet.toLocaleString()}**.`,
            });
        }

        const shoe   = buildShoe();
        const { player, banker, natural } = playCoup(shoe);
        const winner = determineWinner(player, banker);

        const delay = ms => new Promise(r => setTimeout(r, ms));

        // Deal animation — 3 frames
        await interaction.editReply({ embeds: [dealingEmbed('deal1', player, banker, pick, bet, interaction)] });
        await delay(900);
        await interaction.editReply({ embeds: [dealingEmbed('deal2', player, banker, pick, bet, interaction)] });
        await delay(900);
        if (!natural && (player.length > 2 || banker.length > 2)) {
            await interaction.editReply({ embeds: [dealingEmbed('draw', player, banker, pick, bet, interaction)] });
            await delay(900);
        }

        // Resolve payout
        let credit = 0;
        let profit = -bet;

        if (winner === pick) {
            profit = Math.floor(bet * PAYOUT[pick].profitMult);
            credit = bet + profit;
        } else if (winner === 'tie' && (pick === 'player' || pick === 'banker')) {
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

        const replayId = `baccarat_replay_${interaction.id}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('🎴 Play Again').setStyle(ButtonStyle.Primary),
        );

        await interaction.editReply({
            embeds: [resultEmbed({ pick, winner, player, banker, natural, bet, profit, balance: updated.balance, interaction })],
            components: [row],
        });

        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        });
        collector.on('collect', async i => {
            await i.deferUpdate();
            await playBaccarat(interaction, pick, bet);
        });
        collector.on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Baccarat] error:', err);
        await interaction.editReply({ content: 'Something went wrong while dealing the cards. Please try again.', components: [] }).catch(() => {});
    }
}
