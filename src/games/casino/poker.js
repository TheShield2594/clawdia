const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier } = require('../../services/effectsService');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;
const MAX_BET = 5000;

const SUITS  = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK   = Object.fromEntries(VALUES.map((v, i) => [v, i + 2]));

function buildDeck() {
    const deck = [];
    for (const suit of SUITS) for (const value of VALUES) deck.push({ suit, value });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardStr(c) { return `${c.value}${c.suit}`; }
function handStr(hand) { return hand.map(cardStr).join('  '); }

function rankHand(hand) {
    const ranks = hand.map(c => RANK[c.value]).sort((a, b) => a - b);
    const suits = hand.map(c => c.suit);
    const freq  = {};
    for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
    // Sort groups: highest count first, then highest rank first within same count
    const entries  = Object.entries(freq).map(([r, c]) => [Number(r), c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const counts   = entries.map(e => e[1]);
    const tiebreak = entries.map(e => e[0]);
    const flush    = suits.every(s => s === suits[0]);
    const straight = ranks[4] - ranks[0] === 4 && new Set(ranks).size === 5;
    // Special case: A-2-3-4-5 wheel straight — ace plays as 1
    const wheel = JSON.stringify(ranks) === JSON.stringify([2, 3, 4, 5, 14]);

    if ((straight || wheel) && flush) return { score: 8, name: 'Straight Flush', tiebreak: wheel ? [5,4,3,2,1] : [...ranks].reverse() };
    if (counts[0] === 4)             return { score: 7, name: 'Four of a Kind',  tiebreak };
    if (counts[0] === 3 && counts[1] === 2) return { score: 6, name: 'Full House', tiebreak };
    if (flush)                       return { score: 5, name: 'Flush',            tiebreak: [...ranks].reverse() };
    if (straight || wheel)           return { score: 4, name: 'Straight',         tiebreak: wheel ? [5,4,3,2,1] : [...ranks].reverse() };
    if (counts[0] === 3)             return { score: 3, name: 'Three of a Kind',  tiebreak };
    if (counts[0] === 2 && counts[1] === 2) return { score: 2, name: 'Two Pair', tiebreak };
    if (counts[0] === 2)             return { score: 1, name: 'One Pair',         tiebreak };
    return { score: 0, name: 'High Card', tiebreak: [...ranks].reverse() };
}

function compareTuple(a, b) {
    if (a.score !== b.score) return a.score - b.score;
    for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
        const av = a.tiebreak[i] ?? 0;
        const bv = b.tiebreak[i] ?? 0;
        if (av !== bv) return av - bv;
    }
    return 0;
}

// Best 5 from 7 cards — compare full rank+tiebreak tuple
function bestHand(cards) {
    let best = null;
    for (let i = 0; i < cards.length - 1; i++) {
        for (let j = i + 1; j < cards.length; j++) {
            const five = cards.filter((_, idx) => idx !== i && idx !== j);
            const h    = rankHand(five);
            if (!best || compareTuple(h, best) > 0) best = { ...h, cards: five };
        }
    }
    return best;
}

function compareHands(playerAll, dealerAll) {
    const p   = bestHand(playerAll);
    const d   = bestHand(dealerAll);
    const cmp = compareTuple(p, d);
    if (cmp > 0) return { result: 'win',  playerHand: p, dealerHand: d };
    if (cmp < 0) return { result: 'lose', playerHand: p, dealerHand: d };
    return { result: 'push', playerHand: p, dealerHand: d };
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

// Poker rounds: pre-flop -> flop (3) -> turn (1) -> river (1)
async function playPoker(interaction, bet) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let debited = null;
    let settled = false;

    try {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        debited = await User.findOneAndUpdate(
            { ...userFilter, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true }
        );

        if (!debited) {
            const fresh = await User.findOne(userFilter);
            return interaction.editReply({
                content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
            });
        }

        const delay = ms => new Promise(r => setTimeout(r, ms));
        const deck = buildDeck();

        const playerHole = [deck.pop(), deck.pop()];
        const dealerHole = [deck.pop(), deck.pop()];
        const community  = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];

        let pot = bet;
        let playerStake = bet; // tracks only what the player has actually contributed
        let folded = false;

        const gameId = `poker_${interaction.id}_${Date.now()}`;

        // --- Pre-flop ---
        const preFlopEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor('#5865F2')
            .setTitle('♠ Poker — Pre-Flop')
            .addFields(
                { name: '🃏 Your Hand', value: handStr(playerHole), inline: false },
                { name: '🤖 Dealer Hand', value: '🂠  🂠', inline: false },
                { name: '🎴 Community', value: '🂠  🂠  🂠  🂠  🂠', inline: false },
                { name: '💰 Pot', value: `**${pot.toLocaleString()}** coins`, inline: true },
                { name: '💵 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true },
            )
            .setFooter({ text: 'Check to see the flop free · Raise doubles the pot' });

        const preFlopRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pk_check_${gameId}`).setLabel('Check').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`pk_raise_${gameId}`).setLabel(`Raise (${bet.toLocaleString()})`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`pk_fold_${gameId}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
        );

        await interaction.editReply({ embeds: [preFlopEmbed], components: [preFlopRow] });

        // Collect pre-flop action
        const msg1 = await interaction.fetchReply();
        let preFlopAction;
        try {
            const r = await msg1.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id && i.customId.endsWith(gameId),
                time: 30_000,
            });
            await r.deferUpdate();
            preFlopAction = r.customId.split('_')[1];
        } catch {
            // Timeout — refund
            settled = true;
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } });
            return interaction.editReply({ content: '⏱️ Time\'s up! Bet refunded.', embeds: [], components: [] }).catch(() => {});
        }

        if (preFlopAction === 'fold') {
            folded = true;
        } else if (preFlopAction === 'raise') {
            // Try to deduct the extra bet
            const raised = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true }
            );
            if (raised) {
                debited = raised;
                playerStake += bet;
                pot += bet * 2; // player raise + simulated dealer call
            }
            // If they can't afford the raise, treat as check
        }

        if (folded) {
            settled = true;
            const foldEmbed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#e74c3c')
                .setTitle('♠ Poker — Folded')
                .setDescription(`You folded. The dealer had: **${handStr(dealerHole)}**`)
                .addFields({ name: '💰 Balance', value: `**${debited.balance.toLocaleString()}** coins` })
                .setTimestamp();
            return interaction.editReply({ embeds: [foldEmbed], components: [] });
        }

        // --- Flop ---
        const flop    = community.slice(0, 3);
        const flopStr = handStr(flop);

        const flopEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor('#5865F2')
            .setTitle('♠ Poker — The Flop')
            .addFields(
                { name: '🃏 Your Hand', value: handStr(playerHole), inline: false },
                { name: '🤖 Dealer Hand', value: '🂠  🂠', inline: false },
                { name: '🎴 Community', value: `${flopStr}  🂠  🂠`, inline: false },
                { name: '💰 Pot', value: `**${pot.toLocaleString()}** coins`, inline: true },
            )
            .setFooter({ text: 'Check to continue free · Raise doubles pot' });

        const flopRound = `flopround_${Date.now()}`;
        const flopRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pk_check_${flopRound}`).setLabel('Check').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`pk_raise_${flopRound}`).setLabel(`Raise (${Math.min(bet, debited.balance).toLocaleString()})`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`pk_fold_${flopRound}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
        );

        await interaction.editReply({ embeds: [flopEmbed], components: [flopRow] });
        await delay(300);

        const msg2 = await interaction.fetchReply();
        let flopAction;
        try {
            const r = await msg2.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id && i.customId.endsWith(flopRound),
                time: 30_000,
            });
            await r.deferUpdate();
            flopAction = r.customId.split('_')[1];
        } catch {
            settled = true;
            await User.findOneAndUpdate(userFilter, { $inc: { balance: playerStake } });
            return interaction.editReply({ content: '⏱️ Time\'s up! Bet refunded.', embeds: [], components: [] }).catch(() => {});
        }

        if (flopAction === 'fold') {
            folded = true;
        } else if (flopAction === 'raise') {
            const raiseAmt = Math.min(bet, debited.balance);
            if (raiseAmt > 0) {
                const raised = await User.findOneAndUpdate(
                    { ...userFilter, balance: { $gte: raiseAmt } },
                    { $inc: { balance: -raiseAmt } },
                    { new: true }
                );
                if (raised) {
                    debited = raised;
                    playerStake += raiseAmt;
                    pot += raiseAmt * 2;
                }
            }
        }

        if (folded) {
            settled = true;
            const foldEmbed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#e74c3c')
                .setTitle('♠ Poker — Folded')
                .setDescription(`You folded. The dealer had: **${handStr(dealerHole)}**\nCommunity: **${flopStr} (+ 2 more)**`)
                .addFields({ name: '💰 Balance', value: `**${debited.balance.toLocaleString()}** coins` })
                .setTimestamp();
            return interaction.editReply({ embeds: [foldEmbed], components: [] });
        }

        // --- Turn + River (reveal together, no more betting) ---
        const turnCard  = community[3];
        const riverCard = community[4];

        await delay(400);

        // Showdown
        const playerAll = [...playerHole, ...community];
        const dealerAll = [...dealerHole, ...community];
        const { result, playerHand, dealerHand } = compareHands(playerAll, dealerAll);

        const coinMult      = getCoinMultiplier(debited);
        const serverMult    = getServerCoinMultiplier(guildSettings);
        const totalCoinMult = coinMult * serverMult;
        const streakBonus   = getLuckyStreakBonus(debited);

        let grossPayout = 0;
        let outcome     = result;

        if (result === 'win')  grossPayout = playerStake * 2;
        if (result === 'push') grossPayout = playerStake;
        if (result === 'lose' && streakBonus > 0 && Math.random() < streakBonus) {
            grossPayout = playerStake;
            outcome = 'push';
        }

        let adjustedPayout = grossPayout;
        if (grossPayout > playerStake && totalCoinMult > 1.0) {
            adjustedPayout = playerStake + Math.round((grossPayout - playerStake) * totalCoinMult);
        }

        let updated = debited;
        if (adjustedPayout > 0) {
            updated = await User.findOneAndUpdate(
                userFilter,
                { $inc: { balance: adjustedPayout } },
                { new: true }
            );
        }
        settled = true;

        const totalIn = playerStake;
        const net     = adjustedPayout - totalIn;
        const netStr  = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

        let color, title;
        if (outcome === 'win')  { color = '#2ecc71'; title = '♠ Poker — You Win!'; }
        else if (outcome === 'push') { color = '#f39c12'; title = '♠ Poker — Split Pot'; }
        else                    { color = '#e74c3c'; title = '♠ Poker — Dealer Wins'; }

        const communityStr = `${handStr(flop)}  ${cardStr(turnCard)}  ${cardStr(riverCard)}`;
        let boostNote = '';
        if (totalCoinMult > 1.0 && adjustedPayout > playerStake) boostNote = `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied!*`;

        const showdownEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor(color)
            .setTitle(title)
            .setDescription(`**Your best hand:** ${playerHand.name}\n**Dealer's best hand:** ${dealerHand.name}${boostNote}`)
            .addFields(
                { name: '🃏 Your Hole Cards', value: handStr(playerHole), inline: true },
                { name: '🤖 Dealer Hole Cards', value: handStr(dealerHole), inline: true },
                { name: '🎴 Community', value: communityStr, inline: false },
                { name: '💰 Pot',     value: `**${pot.toLocaleString()}** coins`, inline: true },
                { name: adjustedPayout > 0 ? '🏆 Payout' : '💀 Lost', value: adjustedPayout > 0 ? `${adjustedPayout.toLocaleString()} coins` : `${totalIn.toLocaleString()} coins`, inline: true },
                { name: '📊 Net',     value: `**${netStr}** coins`, inline: true },
                { name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true },
            )
            .setFooter({ text: 'Texas Hold\'em · Best 5 of 7 cards' })
            .setTimestamp();

        const replayId = `poker_replay_${interaction.id}_${Date.now()}`;
        const replayRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('♠ Play Again').setStyle(ButtonStyle.Primary),
        );

        await interaction.editReply({ embeds: [showdownEmbed], components: [replayRow] });

        const replyMsg = await interaction.fetchReply();
        replyMsg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        }).on('collect', async i => {
            await i.deferUpdate();
            await playPoker(interaction, bet);
        }).on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Poker] error:', err);
        if (debited && !settled) {
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } })
                .catch(e => console.error('[Poker] rollback failed:', e));
        }
        await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', components: [] }).catch(() => {});
    }
}

module.exports = {
    name: 'poker',
    description: 'Texas Hold\'em — beat the dealer\'s best 5-card hand',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (${MIN_BET}–${MAX_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            return interaction.reply({ content: 'Casino games are disabled on this server.', ephemeral: true });
        }

        const bet  = interaction.options.getInteger('bet');
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

        if ((user?.balance ?? 0) < bet) {
            const currency = guildSettings?.economy?.currency || '💰';
            return interaction.reply({
                content: `You don't have enough ${currency}. Your balance: **${currency}${(user?.balance ?? 0).toLocaleString()}**`,
                ephemeral: true,
            });
        }

        const { shouldProceed: pkProceed, alreadyReplied: pkReplied } = await confirmBet(interaction, bet, user.balance, 'Poker', guildSettings);
        if (!pkProceed) return;
        if (!pkReplied) await interaction.deferReply();
        await playPoker(interaction, bet);
    },
};
