const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;

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
    const entries  = Object.entries(freq).map(([r, c]) => [Number(r), c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const counts   = entries.map(e => e[1]);
    const tiebreak = entries.map(e => e[0]);
    const flush    = suits.every(s => s === suits[0]);
    const straight = ranks[4] - ranks[0] === 4 && new Set(ranks).size === 5;
    const wheel    = JSON.stringify(ranks) === JSON.stringify([2, 3, 4, 5, 14]);

    if ((straight || wheel) && flush) return { score: 8, name: 'Straight Flush', tiebreak: wheel ? [5,4,3,2,1] : [...ranks].reverse() };
    if (counts[0] === 4)              return { score: 7, name: 'Four of a Kind',  tiebreak };
    if (counts[0] === 3 && counts[1] === 2) return { score: 6, name: 'Full House', tiebreak };
    if (flush)                        return { score: 5, name: 'Flush',            tiebreak: [...ranks].reverse() };
    if (straight || wheel)            return { score: 4, name: 'Straight',         tiebreak: wheel ? [5,4,3,2,1] : [...ranks].reverse() };
    if (counts[0] === 3)              return { score: 3, name: 'Three of a Kind',  tiebreak };
    if (counts[0] === 2 && counts[1] === 2) return { score: 2, name: 'Two Pair',  tiebreak };
    if (counts[0] === 2)              return { score: 1, name: 'One Pair',         tiebreak };
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

// ── Dealer AI ────────────────────────────────────────────────────────────────

// Pre-flop hand category based on hole cards.
function preFlopCategory(hole) {
    const [c1, c2] = [...hole].sort((a, b) => RANK[b.value] - RANK[a.value]);
    const r1     = RANK[c1.value];
    const r2     = RANK[c2.value];
    const suited = c1.suit === c2.suit;
    const isPair = r1 === r2;

    if (isPair) {
        if (r1 >= RANK['J']) return 'monster';  // JJ–AA
        if (r1 >= RANK['9']) return 'premium';  // 99–TT
        if (r1 >= RANK['6']) return 'playable'; // 66–88
        return 'weak';                           // 22–55
    }
    if (r1 === RANK['A'] && r2 === RANK['K'])                       return 'monster';  // AK
    if (r1 === RANK['A'] && r2 >= RANK['J'])                        return 'premium';  // AQ, AJ
    if (r1 === RANK['A'] && r2 === RANK['10'] && suited)            return 'premium';  // ATs
    if (r1 === RANK['A'] && r2 >= RANK['8'])                        return 'playable'; // A8–AT
    if (r1 === RANK['K'] && r2 >= RANK['Q'])                        return 'playable'; // KQ, KQs
    if (r1 === RANK['K'] && r2 >= RANK['J'] && suited)              return 'playable'; // KJs
    if (suited && r1 - r2 <= 2 && r2 >= RANK['7'])                  return 'playable'; // suited connectors
    return 'weak';
}

// Dealer pre-flop action: raise / check / fold
function dealerPreFlopAction(category) {
    const r = Math.random();
    switch (category) {
        case 'monster':  return 'raise';
        case 'premium':  return r < 0.60 ? 'raise' : 'check';
        case 'playable': return r < 0.25 ? 'fold'  : 'check';
        default:         return r < 0.60 ? 'fold'  : 'check';
    }
}

// Post-flop equity estimate (0–1) for dealer's hand relative to player.
// Returns dealer's approximate chance of winning based on current board.
function dealerPostFlopEquity(dealerHole, playerHole, community) {
    const dBest = bestHand([...dealerHole, ...community]);
    const pBest = bestHand([...playerHole, ...community]);
    const cmp   = compareTuple(dBest, pBest);
    // compareTuple can return unbounded values; use sign only
    if (cmp > 0) return 0.65; // dealer ahead
    if (cmp === 0) return 0.50; // tied
    return 0.35; // player ahead
}

// Dealer post-flop decision: fold or continue (check/raise).
// Folds if equity < potOdds threshold (simplified pot-odds calculation).
function dealerPostFlopAction(equity, pot, callAmount) {
    const potOdds = callAmount / (pot + callAmount);
    if (equity < potOdds - 0.05) return 'fold'; // not getting the right price
    if (equity > 0.70) return 'raise';
    return 'check';
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

// ── Game flow ────────────────────────────────────────────────────────────────

// releaseLock is called at every terminal point of a hand (dealer/player
// fold at any street, showdown, or a timeout refund) — "Play Again" starts
// a brand-new hand with its own atomic debit, so it isn't passed releaseLock.
async function playPoker(interaction, bet, releaseLock) {
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
            releaseLock?.();
            const fresh = await User.findOne(userFilter);
            return interaction.editReply({
                content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
            });
        }

        const delay = ms => new Promise(r => setTimeout(r, ms));
        const deck  = buildDeck();

        const playerHole = [deck.pop(), deck.pop()];
        const dealerHole = [deck.pop(), deck.pop()];
        const community  = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];

        // Dealer antes the same as the player — pot starts at 2× bet
        let pot         = bet * 2; // player ante + dealer ante (simulated house money)
        let playerStake = bet;
        let folded      = false;

        const dealerCategory = preFlopCategory(dealerHole);

        // Dealer acts pre-flop before player sees their choice
        const dealerPreAction = dealerPreFlopAction(dealerCategory);
        let dealerRaised = dealerPreAction === 'raise';

        // If dealer folds pre-flop (very weak hand), player wins immediately
        if (dealerPreAction === 'fold') {
            settled = true;
            releaseLock?.();
            const coinMult   = getCoinMultiplier(debited);
            const serverMult = getServerCoinMultiplier(guildSettings);
            const totalMult  = coinMult * serverMult;
            const baseWin    = Math.floor(bet * 1.5); // small early-exit bonus
            let winAmount    = baseWin;
            if (totalMult > 1.0) winAmount = bet + Math.round((baseWin - bet) * totalMult);

            const updated = await User.findOneAndUpdate(userFilter, { $inc: { balance: winAmount } }, { new: true });

            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor('#2ecc71')
                    .setTitle('♠ Poker — Dealer Folded Pre-Flop!')
                    .setDescription(
                        `The dealer peeked at their hand (**${handStr(dealerHole)}**) and folded immediately.\n\n` +
                        `🏆 You collect the early pot!`,
                    )
                    .addFields(
                        { name: '🃏 Dealer Hand',  value: handStr(dealerHole),                          inline: true },
                        { name: '🏆 Payout',       value: `**${winAmount.toLocaleString()}** coins`,    inline: true },
                        { name: '📊 Net',          value: `**+${(winAmount - bet).toLocaleString()}** coins`, inline: true },
                        { name: '💰 Balance',      value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true },
                    )
                    .setFooter({ text: 'Dealer had a weak hand — quick win!' })
                    .setTimestamp()],
                components: [],
            });
        }

        if (dealerRaised) {
            // Dealer raised → pot grows; player must call or fold
            pot += bet; // dealer's raise into pot
        }

        const gameId = `poker_${interaction.id}_${Date.now()}`;

        // ── Pre-flop: show player their hand and dealer's decision ──────────────
        const dealerLine = dealerRaised
            ? `🤖 **Dealer raised!** (pot is now **${pot.toLocaleString()}** coins — call or fold)`
            : `🤖 Dealer checks.`;

        const preFlopActions = dealerRaised
            ? [
                new ButtonBuilder().setCustomId(`pk_call_${gameId}`).setLabel(`Call (${bet.toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${gameId}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ]
            : [
                new ButtonBuilder().setCustomId(`pk_check_${gameId}`).setLabel('Check').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`pk_raise_${gameId}`).setLabel(`Raise (${bet.toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${gameId}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ];

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('♠ Poker — Pre-Flop')
                .addFields(
                    { name: '🃏 Your Hand',    value: handStr(playerHole), inline: false },
                    { name: '🤖 Dealer',       value: dealerLine,          inline: false },
                    { name: '🎴 Community',    value: '🂠  🂠  🂠  🂠  🂠',  inline: false },
                    { name: '💰 Pot',          value: `**${pot.toLocaleString()}** coins`, inline: true },
                    { name: '💵 Your Stake',   value: `**${playerStake.toLocaleString()}** coins`, inline: true },
                )
                .setFooter({ text: dealerRaised ? 'Dealer has a strong hand — call or fold!' : 'Check free · Raise doubles action' })],
            components: [new ActionRowBuilder().addComponents(...preFlopActions)],
        });

        const msg1 = await interaction.fetchReply();
        let preFlopAction;
        try {
            const r = await msg1.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id && i.customId.endsWith(gameId),
                time: 30_000,
            });
            await r.deferUpdate();
            preFlopAction = r.customId.split('_')[1]; // check / raise / call / fold
        } catch {
            settled = true;
            releaseLock?.();
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } });
            return interaction.editReply({ content: '⏱️ Time\'s up! Bet refunded.', embeds: [], components: [] }).catch(() => {});
        }

        if (preFlopAction === 'fold') {
            folded = true;
        } else if (preFlopAction === 'call' || preFlopAction === 'raise') {
            // Player calls dealer raise or makes their own raise
            const extraBet = bet;
            const raised = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: extraBet } },
                { $inc: { balance: -extraBet } },
                { new: true }
            );
            if (raised) {
                debited = raised;
                playerStake += extraBet;
                pot += extraBet * (preFlopAction === 'raise' ? 2 : 1);
            } else if (preFlopAction === 'call') {
                // Can't afford to call dealer's raise → forced fold
                folded = true;
            }
            // 'raise' with insufficient funds silently becomes a check
        }

        if (folded) {
            settled = true;
            releaseLock?.();
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

        // ── Flop ────────────────────────────────────────────────────────────────
        const flop    = community.slice(0, 3);
        const flopStr = handStr(flop);

        // Dealer evaluates post-flop equity and decides action
        const equity       = dealerPostFlopEquity(dealerHole, playerHole, flop);
        const dFlopAction  = dealerPostFlopAction(equity, pot, bet);
        const dealerFlopLine = dFlopAction === 'fold'
            ? `🤖 **Dealer folds!** (equity too low to continue)`
            : dFlopAction === 'raise'
            ? `🤖 **Dealer bets** — they like their hand! (${(equity * 100).toFixed(0)}% equity)`
            : `🤖 Dealer checks. (${(equity * 100).toFixed(0)}% equity)`;

        if (dFlopAction === 'fold') {
            // Dealer folds on the flop — player wins the pot
            settled = true;
            releaseLock?.();
            const coinMult   = getCoinMultiplier(debited);
            const serverMult = getServerCoinMultiplier(guildSettings);
            const totalMult  = coinMult * serverMult;
            let winPayout    = pot;
            if (totalMult > 1.0) winPayout = playerStake + Math.round((pot - playerStake) * totalMult);

            await User.findOneAndUpdate(userFilter, { $inc: { balance: winPayout } }, { new: true });

            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor('#2ecc71')
                    .setTitle('♠ Poker — Dealer Folded on the Flop!')
                    .setDescription(
                        `**Flop:** ${flopStr}\n\n` +
                        `The dealer checked their pot odds and folded. You win!\n\n` +
                        `**Dealer's hand:** ${handStr(dealerHole)} → *${bestHand([...dealerHole, ...flop])?.name}*`,
                    )
                    .addFields(
                        { name: '🃏 Your Hand',  value: handStr(playerHole),          inline: true },
                        { name: '🏆 Payout',     value: `**${winPayout.toLocaleString()}** coins`, inline: true },
                        { name: '📊 Net',        value: `**+${(winPayout - playerStake).toLocaleString()}** coins`, inline: true },
                    )
                    .setFooter({ text: 'Dealer\'s pot odds didn\'t justify calling' })
                    .setTimestamp()],
                components: [],
            });
        }

        if (dFlopAction === 'raise') pot += bet; // dealer bets into the pot

        const flopRound = `flopround_${Date.now()}`;
        const flopActions = dFlopAction === 'raise'
            ? [
                new ButtonBuilder().setCustomId(`pk_call_${flopRound}`).setLabel(`Call (${bet.toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${flopRound}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ]
            : [
                new ButtonBuilder().setCustomId(`pk_check_${flopRound}`).setLabel('Check').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`pk_raise_${flopRound}`).setLabel(`Raise (${Math.min(bet, debited.balance).toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${flopRound}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ];

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('♠ Poker — The Flop')
                .addFields(
                    { name: '🃏 Your Hand',  value: handStr(playerHole),          inline: false },
                    { name: '🤖 Dealer',     value: dealerFlopLine,               inline: false },
                    { name: '🎴 Community',  value: `${flopStr}  🂠  🂠`,          inline: false },
                    { name: '💰 Pot',        value: `**${pot.toLocaleString()}** coins`, inline: true },
                )
                .setFooter({ text: 'Check or Raise · Fold to surrender' })],
            components: [new ActionRowBuilder().addComponents(...flopActions)],
        });
        await delay(200);

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
            releaseLock?.();
            await User.findOneAndUpdate(userFilter, { $inc: { balance: playerStake } });
            return interaction.editReply({ content: '⏱️ Time\'s up! Bet refunded.', embeds: [], components: [] }).catch(() => {});
        }

        if (flopAction === 'fold') {
            folded = true;
        } else if (flopAction === 'call' || flopAction === 'raise') {
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
                    pot += raiseAmt * (flopAction === 'raise' ? 2 : 1);
                } else if (flopAction === 'call') {
                    // Can't afford to call dealer's bet → forced fold
                    folded = true;
                }
            } else if (flopAction === 'call') {
                // Zero balance → can't call → forced fold
                folded = true;
            }
        }

        if (folded) {
            settled = true;
            releaseLock?.();
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

        // ── Turn ─────────────────────────────────────────────────────────────
        await delay(400);

        const turnCard  = community[3];
        const turnStr   = cardStr(turnCard);
        const turnBoard = [...flop, turnCard];

        const turnEquity      = dealerPostFlopEquity(dealerHole, playerHole, turnBoard);
        const dTurnAction     = dealerPostFlopAction(turnEquity, pot, bet);
        const dealerTurnLine  = dTurnAction === 'fold'
            ? '🤖 **Dealer folds!** (not getting the right price)'
            : dTurnAction === 'raise'
            ? `🤖 **Dealer bets** — they like the turn! (${(turnEquity * 100).toFixed(0)}% equity)`
            : `🤖 Dealer checks. (${(turnEquity * 100).toFixed(0)}% equity)`;

        if (dTurnAction === 'fold') {
            settled = true;
            releaseLock?.();
            const coinMult   = getCoinMultiplier(debited);
            const serverMult = getServerCoinMultiplier(guildSettings);
            const totalMult  = coinMult * serverMult;
            let winPayout    = pot;
            if (totalMult > 1.0) winPayout = playerStake + Math.round((pot - playerStake) * totalMult);
            await User.findOneAndUpdate(userFilter, { $inc: { balance: winPayout } }, { new: true });
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor('#2ecc71')
                    .setTitle('♠ Poker — Dealer Folded on the Turn!')
                    .setDescription(`**Turn:** ${turnStr}\n\nThe dealer couldn't justify calling. You win!\n\n**Dealer's hand:** ${handStr(dealerHole)} → *${bestHand([...dealerHole, ...turnBoard])?.name}*`)
                    .addFields(
                        { name: '🃏 Your Hand',  value: handStr(playerHole),           inline: true },
                        { name: '🏆 Payout',     value: `**${winPayout.toLocaleString()}** coins`, inline: true },
                        { name: '📊 Net',        value: `**+${(winPayout - playerStake).toLocaleString()}** coins`, inline: true },
                    )
                    .setFooter({ text: "Dealer's pot odds didn't justify calling the turn" })
                    .setTimestamp()],
                components: [],
            });
        }

        if (dTurnAction === 'raise') pot += bet;

        const turnRound = `turnround_${Date.now()}`;
        const turnActions = dTurnAction === 'raise'
            ? [
                new ButtonBuilder().setCustomId(`pk_call_${turnRound}`).setLabel(`Call (${bet.toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${turnRound}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ]
            : [
                new ButtonBuilder().setCustomId(`pk_check_${turnRound}`).setLabel('Check').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`pk_raise_${turnRound}`).setLabel(`Raise (${Math.min(bet, debited.balance).toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${turnRound}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ];

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('♠ Poker — The Turn')
                .addFields(
                    { name: '🃏 Your Hand',  value: handStr(playerHole),                     inline: false },
                    { name: '🤖 Dealer',     value: dealerTurnLine,                           inline: false },
                    { name: '🎴 Community',  value: `${flopStr}  ${turnStr}  🂠`,             inline: false },
                    { name: '💰 Pot',        value: `**${pot.toLocaleString()}** coins`,      inline: true },
                )
                .setFooter({ text: 'Check or Raise · Fold to surrender' })],
            components: [new ActionRowBuilder().addComponents(...turnActions)],
        });
        await delay(200);

        const msg3 = await interaction.fetchReply();
        let turnAction;
        try {
            const r = await msg3.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id && i.customId.endsWith(turnRound),
                time: 30_000,
            });
            await r.deferUpdate();
            turnAction = r.customId.split('_')[1];
        } catch {
            settled = true;
            releaseLock?.();
            await User.findOneAndUpdate(userFilter, { $inc: { balance: playerStake } });
            return interaction.editReply({ content: '⏱️ Time\'s up! Bet refunded.', embeds: [], components: [] }).catch(() => {});
        }

        if (turnAction === 'fold') {
            folded = true;
        } else if (turnAction === 'call' || turnAction === 'raise') {
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
                    pot += raiseAmt * (turnAction === 'raise' ? 2 : 1);
                } else if (turnAction === 'call') {
                    folded = true;
                }
            } else if (turnAction === 'call') {
                folded = true;
            }
        }

        if (folded) {
            settled = true;
            releaseLock?.();
            const foldEmbed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#e74c3c')
                .setTitle('♠ Poker — Folded')
                .setDescription(`You folded. The dealer had: **${handStr(dealerHole)}**\nCommunity: **${flopStr}  ${turnStr} (+ 1 more)**`)
                .addFields({ name: '💰 Balance', value: `**${debited.balance.toLocaleString()}** coins` })
                .setTimestamp();
            return interaction.editReply({ embeds: [foldEmbed], components: [] });
        }

        // ── River ─────────────────────────────────────────────────────────────
        await delay(400);

        const riverCard = community[4];
        const riverStr  = cardStr(riverCard);
        const riverBoard = [...turnBoard, riverCard];

        const riverEquity      = dealerPostFlopEquity(dealerHole, playerHole, riverBoard);
        const dRiverAction     = dealerPostFlopAction(riverEquity, pot, bet);
        const dealerRiverLine  = dRiverAction === 'fold'
            ? '🤖 **Dealer folds!** (river missed them)'
            : dRiverAction === 'raise'
            ? `🤖 **Dealer bets** — they like the river! (${(riverEquity * 100).toFixed(0)}% equity)`
            : `🤖 Dealer checks. (${(riverEquity * 100).toFixed(0)}% equity)`;

        if (dRiverAction === 'fold') {
            settled = true;
            releaseLock?.();
            const coinMult   = getCoinMultiplier(debited);
            const serverMult = getServerCoinMultiplier(guildSettings);
            const totalMult  = coinMult * serverMult;
            let winPayout    = pot;
            if (totalMult > 1.0) winPayout = playerStake + Math.round((pot - playerStake) * totalMult);
            await User.findOneAndUpdate(userFilter, { $inc: { balance: winPayout } }, { new: true });
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor('#2ecc71')
                    .setTitle('♠ Poker — Dealer Folded on the River!')
                    .setDescription(`**River:** ${riverStr}\n\nThe dealer missed the river and folded. You win!\n\n**Dealer's hand:** ${handStr(dealerHole)} → *${bestHand([...dealerHole, ...riverBoard])?.name}*`)
                    .addFields(
                        { name: '🃏 Your Hand',  value: handStr(playerHole),           inline: true },
                        { name: '🏆 Payout',     value: `**${winPayout.toLocaleString()}** coins`, inline: true },
                        { name: '📊 Net',        value: `**+${(winPayout - playerStake).toLocaleString()}** coins`, inline: true },
                    )
                    .setFooter({ text: "Dealer missed the river — their loss, your gain" })
                    .setTimestamp()],
                components: [],
            });
        }

        if (dRiverAction === 'raise') pot += bet;

        const riverRound = `riverround_${Date.now()}`;
        const riverActions = dRiverAction === 'raise'
            ? [
                new ButtonBuilder().setCustomId(`pk_call_${riverRound}`).setLabel(`Call (${bet.toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${riverRound}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ]
            : [
                new ButtonBuilder().setCustomId(`pk_check_${riverRound}`).setLabel('Check').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`pk_raise_${riverRound}`).setLabel(`Raise (${Math.min(bet, debited.balance).toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${riverRound}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
              ];

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('♠ Poker — The River')
                .addFields(
                    { name: '🃏 Your Hand',  value: handStr(playerHole),                     inline: false },
                    { name: '🤖 Dealer',     value: dealerRiverLine,                          inline: false },
                    { name: '🎴 Community',  value: `${flopStr}  ${turnStr}  ${riverStr}`,   inline: false },
                    { name: '💰 Pot',        value: `**${pot.toLocaleString()}** coins`,      inline: true },
                )
                .setFooter({ text: 'Last chance — Check, Raise, or Fold before showdown' })],
            components: [new ActionRowBuilder().addComponents(...riverActions)],
        });
        await delay(200);

        const msg4 = await interaction.fetchReply();
        let riverAction;
        try {
            const r = await msg4.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id && i.customId.endsWith(riverRound),
                time: 30_000,
            });
            await r.deferUpdate();
            riverAction = r.customId.split('_')[1];
        } catch {
            settled = true;
            releaseLock?.();
            await User.findOneAndUpdate(userFilter, { $inc: { balance: playerStake } });
            return interaction.editReply({ content: '⏱️ Time\'s up! Bet refunded.', embeds: [], components: [] }).catch(() => {});
        }

        if (riverAction === 'fold') {
            folded = true;
        } else if (riverAction === 'call' || riverAction === 'raise') {
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
                    pot += raiseAmt * (riverAction === 'raise' ? 2 : 1);
                } else if (riverAction === 'call') {
                    folded = true;
                }
            } else if (riverAction === 'call') {
                folded = true;
            }
        }

        if (folded) {
            settled = true;
            releaseLock?.();
            const foldEmbed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#e74c3c')
                .setTitle('♠ Poker — Folded')
                .setDescription(`You folded on the river. The dealer had: **${handStr(dealerHole)}**\nCommunity: **${flopStr}  ${turnStr}  ${riverStr}**`)
                .addFields({ name: '💰 Balance', value: `**${debited.balance.toLocaleString()}** coins` })
                .setTimestamp();
            return interaction.editReply({ embeds: [foldEmbed], components: [] });
        }

        // ── Showdown ──────────────────────────────────────────────────────────
        await delay(400);

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
        if (result === 'lose' && luckySaveEligible(playerStake) && streakBonus > 0 && Math.random() < streakBonus) {
            grossPayout = playerStake;
            outcome = 'push';
        }

        let adjustedPayout = grossPayout;
        if (grossPayout > playerStake && totalCoinMult > 1.0) {
            adjustedPayout = playerStake + Math.round((grossPayout - playerStake) * totalCoinMult);
        }

        let updated = debited;
        if (adjustedPayout > 0) {
            updated = await User.findOneAndUpdate(userFilter, { $inc: { balance: adjustedPayout } }, { new: true });
        }
        settled = true;
        releaseLock?.();

        const net    = adjustedPayout - playerStake;
        const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

        let color, title;
        if (outcome === 'win')       { color = '#2ecc71'; title = '♠ Poker — You Win!'; }
        else if (outcome === 'push') { color = '#f39c12'; title = '♠ Poker — Split Pot'; }
        else                         { color = '#e74c3c'; title = '♠ Poker — Dealer Wins'; }

        const communityStr = `${flopStr}  ${turnStr}  ${riverStr}`;
        let boostNote = '';
        if (totalCoinMult > 1.0 && adjustedPayout > playerStake) boostNote = `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied!*`;

        const replayId = `poker_replay_${interaction.id}_${Date.now()}`;

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(color)
                .setTitle(title)
                .setDescription(`**Your best hand:** ${playerHand.name}\n**Dealer's best hand:** ${dealerHand.name}${boostNote}`)
                .addFields(
                    { name: '🃏 Your Hole Cards',   value: handStr(playerHole),    inline: true },
                    { name: '🤖 Dealer Hole Cards',  value: handStr(dealerHole),    inline: true },
                    { name: '🎴 Community',           value: communityStr,            inline: false },
                    { name: '💰 Pot',                value: `**${pot.toLocaleString()}** coins`, inline: true },
                    { name: adjustedPayout > 0 ? '🏆 Payout' : '💀 Lost', value: adjustedPayout > 0 ? `${adjustedPayout.toLocaleString()} coins` : `${playerStake.toLocaleString()} coins`, inline: true },
                    { name: '📊 Net',                value: `**${netStr}** coins`,   inline: true },
                    { name: '💰 Balance',            value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true },
                )
                .setFooter({ text: 'Texas Hold\'em · Best 5 of 7 · Dealer AI uses pre-flop ranges + pot odds' })
                .setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(replayId).setLabel('♠ Play Again').setStyle(ButtonStyle.Primary),
            )],
        });

        const replyMsg = await interaction.fetchReply();
        replyMsg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        }).on('collect', async i => {
            await i.deferUpdate();
            await playPoker(interaction, bet, null);
        }).on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Poker] error:', err);
        releaseLock?.();
        if (debited && !settled) {
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } })
                .catch(e => console.error('[Poker] rollback failed:', e));
        }
        await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', components: [] }).catch(() => {});
    }
}

module.exports = {
    name: 'poker',
    description: 'Texas Hold\'em — beat the dealer AI using pre-flop ranges and pot-odds decisions',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (min ${MIN_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(1_000_000_000)),

    async execute(interaction, { releaseLock } = {}) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            releaseLock?.();
            return interaction.reply({ content: 'Casino games are disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const bet          = interaction.options.getInteger('bet');
        const casinoMaxBet = guildSettings?.economy?.casinoMaxBet ?? 0;
        if (casinoMaxBet > 0 && bet > casinoMaxBet) {
            releaseLock?.();
            return interaction.reply({ content: `❌ The casino bet limit on this server is **${casinoMaxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

        if ((user?.balance ?? 0) < bet) {
            releaseLock?.();
            const currency = guildSettings?.economy?.currency || '💰';
            return interaction.reply({
                content: `You don't have enough ${currency}. Your balance: **${currency}${(user?.balance ?? 0).toLocaleString()}**`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const { shouldProceed: pkProceed, alreadyReplied: pkReplied } = await confirmBet(interaction, bet, user.balance, 'Poker', guildSettings);
        if (!pkProceed) { releaseLock?.(); return; }
        if (!pkReplied) await interaction.deferReply();
        await playPoker(interaction, bet, releaseLock);
    },
};
