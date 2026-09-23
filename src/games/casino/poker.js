const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const { placeWager } = require('../../utils/placeWager');
const { newHandId, payHand, payoutNote, settledBalance } = require('./payout');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { casinoRefusal, replayRefusal, refuseReplay } = require('./betGuard');
const { getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
const { buildDeck, handStr, compareTuple, bestHand, rankHand } = require('./pokerHands');
const {
    ANTE_PAYTABLE, CALL_MULTIPLE, anteOdds, dealerQualifies, paytableName, settleCalled,
} = require('./holdemRules');
const { boostedPayout } = require('./settlement');

// /casino poker is Casino Hold'em: ante, see your two cards and the flop, then
// fold or call twice the ante; the dealer qualifies with a pair of fours. The
// rules and the odds live in holdemRules.js.
//
// It replaced a heads-up game against a dealer "AI" that paid back about 121%
// of every stake to a player who only checked, and refunded the whole stake on
// a timeout after the river was out (#873, pass 24). A timeout here is a fold:
// the flop has been seen by then, and handing the ante back would be a free
// look at every hand.

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;
const DECISION_MS = 30_000;

const PAYTABLE_LINE = ANTE_PAYTABLE.map(row => `${row.name} ${row.pays}:1`).join(' · ') + ' · otherwise 1:1';

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

/** Everything a hand needs to be staked in full: the ante and the call. */
const fullStake = ante => ante * (1 + CALL_MULTIPLE);

// ── Game flow ────────────────────────────────────────────────────────────────

// releaseLock is called at every terminal point of a hand (fold, timeout,
// showdown, error) — "Play Again" starts a brand-new hand with its own atomic
// debit, so it isn't passed releaseLock.
async function playPoker(interaction, ante, releaseLock, onWager) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    const handId = newHandId();
    let debited = null;
    let settled = false;
    // What the player has put in: the ante, then the call. The rollback at the
    // bottom returns exactly this.
    let playerStake = ante;

    try {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        // Asked here, before the ante, so "Play Again" asks it too: a player
        // down to less than the full stake after a hand used to ante into one
        // they could only fold.
        const wallet = await User.findOne(userFilter);
        if ((wallet?.balance ?? 0) < fullStake(ante)) {
            releaseLock?.();
            return interaction.editReply({
                content: `A **${ante.toLocaleString()}** ante needs **${fullStake(ante).toLocaleString()}** coins to play out — the ante plus a call of twice it. Your balance: **${(wallet?.balance ?? 0).toLocaleString()}**`,
                embeds: [], components: [],
            });
        }

        debited = await placeWager(userFilter, ante, { onWager });

        if (!debited) {
            releaseLock?.();
            const fresh = await User.findOne(userFilter);
            return interaction.editReply({
                content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
            });
        }

        const deck = buildDeck();
        const playerHole = [deck.pop(), deck.pop()];
        const dealerHole = [deck.pop(), deck.pop()];
        const community  = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
        const flop       = community.slice(0, 3);
        const call       = ante * CALL_MULTIPLE;
        const gameId     = `poker_${interaction.id}_${Date.now()}`;

        // The player's hand so far: their two cards and the flop, exactly five.
        const soFar = rankHand([...playerHole, ...flop]);

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(COLORS.INFO)
                .setTitle("♠ Casino Hold'em — The Flop")
                .setDescription(`Fold and lose the ante, or call **${call.toLocaleString()}** coins (${CALL_MULTIPLE}× the ante) to see the turn, the river and the dealer's cards.`)
                .addFields(
                    { name: '🃏 Your Hand',  value: handStr(playerHole), inline: true },
                    { name: '🤖 Dealer',     value: '🂠  🂠',             inline: true },
                    { name: '🎴 Flop',       value: `${handStr(flop)}  🂠  🂠`, inline: false },
                    { name: '📈 You Have',   value: paytableName(soFar), inline: true },
                    { name: '💵 Ante',       value: `**${ante.toLocaleString()}** coins`, inline: true },
                )
                .setFooter({ text: `Dealer qualifies with a pair of 4s · Ante pays: ${PAYTABLE_LINE} · 30s, then the hand folds` })],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`pk_call_${gameId}`).setLabel(`Call (${call.toLocaleString()})`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`pk_fold_${gameId}`).setLabel('Fold').setStyle(ButtonStyle.Danger),
            )],
        });

        const message = await interaction.fetchReply();
        let action = 'timeout';
        try {
            const r = await message.awaitMessageComponent({
                filter: ownedBy(interaction.user.id, i => i.customId.endsWith(gameId), "This isn't your hand."),
                time: DECISION_MS,
            });
            await r.deferUpdate();
            action = r.customId.split('_')[1]; // call / fold
        } catch {
            // Timed out: a fold, below.
        }

        let called = false;
        let shortOfCall = false;
        if (action === 'call') {
            // More money on a hand already counted — no onWager, or a call
            // would score as a second game played.
            const raised = await placeWager(userFilter, call);
            if (raised) {
                debited = raised;
                playerStake += call;
                called = true;
            } else {
                shortOfCall = true;
            }
        }

        if (!called) {
            settled = true;
            releaseLock?.();
            const why = shortOfCall ? `You couldn't cover the **${call.toLocaleString()}** call, so the hand folded.`
                : action === 'fold' ? 'You folded.'
                : "⏱️ Time's up — the hand folded.";
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor(COLORS.ERROR)
                    .setTitle("♠ Casino Hold'em — Folded")
                    .setDescription(`${why} The ante of **${ante.toLocaleString()}** coins is lost.\nThe dealer had **${handStr(dealerHole)}** · the board was **${handStr(community)}**`)
                    .addFields({ name: '💰 Balance', value: `**${(await settledBalance(userFilter, debited.balance)).toLocaleString()}** coins` })
                    .setTimestamp()],
                components: [],
            });
        }

        // ── Showdown ──────────────────────────────────────────────────────────
        const playerBest = bestHand([...playerHole, ...community]);
        const dealerBest = bestHand([...dealerHole, ...community]);
        let { outcome, gross } = settleCalled(ante, playerBest, dealerBest, compareTuple(playerBest, dealerBest));

        // The lucky streak turns a loss into a push, stakes returned, before the
        // payout is computed, so the embed reads off the settled outcome.
        const streakBonus = getLuckyStreakBonus(debited);
        if (outcome === 'lose' && luckySaveEligible(playerStake) && streakBonus > 0 && Math.random() < streakBonus) {
            outcome = 'push';
            gross   = playerStake;
        }

        const totalCoinMult = getCoinMultiplier(debited) * getServerCoinMultiplier(guildSettings);
        const payout = boostedPayout(playerStake, gross, totalCoinMult);

        const showdown = await payHand(userFilter, payout, { game: 'poker', handId, phase: 'showdown' });
        settled = true;
        releaseLock?.();

        const net    = payout - playerStake;
        const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;
        const qualifies = dealerQualifies(dealerBest);

        const verdict = {
            'no-qualify': { color: '#2ecc71', title: "♠ Casino Hold'em — Dealer Doesn't Qualify",
                line: `The dealer needs a pair of 4s. The ante pays **${anteOdds(playerBest)}:1** and the call is returned.` },
            win:  { color: '#2ecc71', title: "♠ Casino Hold'em — You Win!",
                line: `The ante pays **${anteOdds(playerBest)}:1** and the call pays 1:1.` },
            push: { color: '#f39c12', title: "♠ Casino Hold'em — Push", line: 'Both bets are returned.' },
            lose: { color: '#e74c3c', title: "♠ Casino Hold'em — Dealer Wins", line: 'The ante and the call are lost.' },
        }[outcome];

        let boostNote = '';
        if (totalCoinMult > 1.0 && payout > playerStake) boostNote = `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied!*`;

        const replayId = `poker_replay_${interaction.id}_${Date.now()}`;

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(verdict.color)
                .setTitle(verdict.title)
                .setDescription(
                    `**Your best hand:** ${paytableName(playerBest)}\n` +
                    `**Dealer's best hand:** ${paytableName(dealerBest)}${qualifies ? '' : ' *(does not qualify)*'}\n\n` +
                    `${verdict.line}${boostNote}`)
                .addFields(
                    { name: '🃏 Your Hole Cards',   value: handStr(playerHole), inline: true },
                    { name: '🤖 Dealer Hole Cards', value: handStr(dealerHole), inline: true },
                    { name: '🎴 Board',              value: handStr(community),  inline: false },
                    { name: '💵 Staked',            value: `**${playerStake.toLocaleString()}** coins`, inline: true },
                    { name: payout > 0 ? '🏆 Payout' : '💀 Lost', value: `${(payout > 0 ? payout : playerStake).toLocaleString()} coins`, inline: true },
                    { name: '📊 Net',               value: `**${netStr}** coins`, inline: true },
                    { name: '💰 Balance',           value: `**${(await settledBalance(userFilter, showdown.balance)).toLocaleString()}** coins`, inline: true },
                )
                .setFooter({ text: `Casino Hold'em · Best 5 of 7 · Ante pays: ${PAYTABLE_LINE}` })
                .setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(replayId).setLabel('♠ Play Again').setStyle(ButtonStyle.Primary),
            )],
        });

        const replyMsg = await interaction.fetchReply();
        replyMsg.createMessageComponentCollector({
            filter: ownedBy(interaction.user.id, i => i.customId === replayId, "This isn't your hand."),
            max: 1,
            time: 60_000,
        }).on('collect', async i => {
            // A new hand answers to the settings as they are now, not as they
            // were when the first one was typed.
            const refused = await replayRefusal(interaction.guild.id, ante);
            if (refused) return refuseReplay(i, interaction, refused);
            await i.deferUpdate();
            await playPoker(interaction, ante, null, onWager);
        }).on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Poker] error:', err);
        releaseLock?.();
        const refunded = debited && !settled
            ? await payHand(userFilter, playerStake, { game: 'poker', handId, phase: 'rollback' })
            : null;
        const outcome = !debited ? 'No wager was taken.'
            : settled ? 'Your hand had already been settled.'
            : refunded.credited ? 'Your wager was refunded.' : 'Your wager could not be refunded.';
        await interaction.editReply({
            content: `Something went wrong. ${outcome}${refunded ? payoutNote(refunded) : ''}`,
            components: [],
        }).catch(() => {});
    }
}

module.exports = {
    name: 'poker',
    description: "Casino Hold'em — ante, see the flop, then fold or call 2× to beat the dealer",
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`The ante (min ${MIN_BET}); calling costs twice it`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(1_000_000_000)),

    async execute(interaction, { releaseLock, onWager } = {}) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            releaseLock?.();
            return interaction.reply({ content: 'Casino games are disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        // The `bet` option is the ante; the call is twice it.
        const bet     = interaction.options.getInteger('bet');
        const ante    = bet;
        const refusal = casinoRefusal(guildSettings, bet);
        if (refusal) {
            releaseLock?.();
            return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
        }
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

        // A hand can cost the ante and a call of twice it, and a player who
        // cannot cover the call can only fold. Asked up front, so nobody antes
        // into a hand they cannot finish.
        const needed = fullStake(ante);
        if ((user?.balance ?? 0) < needed) {
            releaseLock?.();
            const currency = guildSettings?.economy?.currency || '💰';
            return interaction.reply({
                content: `A **${ante.toLocaleString()}** ante needs **${currency}${needed.toLocaleString()}** to play out — the ante plus a call of twice it. Your balance: **${currency}${(user?.balance ?? 0).toLocaleString()}**`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const { shouldProceed: pkProceed, alreadyReplied: pkReplied } = await confirmBet(interaction, ante, user.balance, 'Poker', guildSettings);
        if (!pkProceed) { releaseLock?.(); return; }
        if (!pkReplied) await interaction.deferReply();
        await playPoker(interaction, ante, releaseLock, onWager);
    },
};
