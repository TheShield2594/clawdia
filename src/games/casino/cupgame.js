const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const { placeWager } = require('../../utils/placeWager');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');
const {
    BASE_WIN_MULT,
    MAX_ROUNDS,
    shufflesForRound,
    payoutForRound,
} = require('./cupgameOdds');
const { ownedBy } = require('../../utils/collectorOwner');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0bd.png';
const MIN_BET = 10;

const QUEEN  = '🂽';
const DECOYS = ['🂡', '🂱'];
const HIDDEN = '🂠';

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

function buildReveal(queenPos) {
    let di = 0;
    return [0, 1, 2].map(i => i === queenPos ? QUEEN : DECOYS[di++]);
}

// releaseLock is held through double-or-nothing recursion (still the same
// hand) and called once the hand truly settles — final loss/win or a cash-out
// — but not held through "Play Again", since a replay re-debits atomically
// just like any fresh bet.
async function playMonte(interaction, bet, round = 1, releaseLock, onWager) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let debited = null;
    let settled = false;

    // Only debit on round 1 — subsequent rounds reuse the same session bet
    if (round === 1) {
        try {
            debited = await placeWager(userFilter, bet, { onWager });

            if (!debited) {
                releaseLock?.();
                const fresh = await User.findOne(userFilter);
                return interaction.editReply({
                    content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                });
            }
        } catch (err) {
            console.error('[Monte] debit error:', err);
            releaseLock?.();
            return interaction.editReply({ content: 'Something went wrong. Your bet was not deducted.' }).catch(() => {});
        }
    }

    try {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const delay = ms => new Promise(r => setTimeout(r, ms));

        let queenPos = Math.floor(Math.random() * 3);
        const initialCards = buildReveal(queenPos);

        const currentPayout = payoutForRound(bet, round);
        const nextPayout    = round < MAX_ROUNDS ? payoutForRound(bet, round + 1) : null;
        const roundLabel    = round > 1 ? ` — Round ${round} of ${MAX_ROUNDS}` : '';
        const doubleLabel   = round > 1 ? ` **(${BASE_WIN_MULT}× × ${Math.pow(2, round - 1)}× = ${(BASE_WIN_MULT * Math.pow(2, round - 1)).toFixed(1)}×)**` : '';

        const revealEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor('#f1c40f')
            .setTitle(`🃏 Three Card Monte${roundLabel} — Watch the Queen!`)
            .setDescription(
                `The **Queen** is at position **${queenPos + 1}**!\n\n` +
                `> ${initialCards.join('   ')}\n` +
                `> 1️⃣  ·  2️⃣  ·  3️⃣`,
            )
            .addFields(
                { name: '💰 Bet',      value: `**${bet.toLocaleString()}** coins`,          inline: true },
                { name: '🏆 Win Pays', value: `**${currentPayout.toLocaleString()}** coins${doubleLabel}`, inline: true },
            )
            .setFooter({ text: 'Watch the Queen — shuffling begins soon…' });

        await interaction.editReply({ embeds: [revealEmbed] });
        await delay(1800);

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(COLORS.INFO)
                .setTitle(`🃏 Three Card Monte${roundLabel} — Cards Flipped!`)
                .setDescription(
                    `Cards are now face down — follow the Queen!\n\n` +
                    `> ${HIDDEN}   ${HIDDEN}   ${HIDDEN}\n` +
                    `> 1️⃣  ·  2️⃣  ·  3️⃣`,
                )
                .addFields({ name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true })
                .setFooter({ text: 'Shuffling begins…' })],
        });
        await delay(700);

        const steps = shufflesForRound(round);

        for (let step = 0; step < steps; step++) {
            let a, b;
            do {
                a = Math.floor(Math.random() * 3);
                b = Math.floor(Math.random() * 3);
            } while (a === b);

            if (queenPos === a) queenPos = b;
            else if (queenPos === b) queenPos = a;

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor(COLORS.INFO)
                    .setTitle(`🃏 Three Card Monte${roundLabel} — Shuffling…`)
                    .setDescription(
                        `Swap ${step + 1}/${steps} — cards **${a + 1}** ↔ **${b + 1}**\n\n` +
                        `> ${HIDDEN}   ${HIDDEN}   ${HIDDEN}\n` +
                        `> 1️⃣  ·  2️⃣  ·  3️⃣`,
                    )
                    .addFields({ name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true })
                    .setFooter({ text: 'Keep your eye on the Queen!' })],
            });
            await delay(550);
        }

        // Weakly correlated "tell": right slightly above chance (40%), giving
        // EV ≈ +0.12 at 2.8× payout — flavor hint, not a profitable signal.
        const tellCard = Math.random() < 0.40 ? queenPos : Math.floor(Math.random() * 3);
        const tellText = Math.random() < 0.40
            ? `\n\n👁️ *You notice card **${tellCard + 1}** seems slightly warped…*`
            : '';

        const gameId = `monte_${interaction.id}_${Date.now()}`;

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#f1c40f')
                .setTitle(`🃏 Three Card Monte${roundLabel} — Find the Queen!`)
                .setDescription(
                    `Shuffling done! Where's the Queen?${tellText}\n\n` +
                    `> ${HIDDEN}   ${HIDDEN}   ${HIDDEN}\n` +
                    `> 1️⃣  ·  2️⃣  ·  3️⃣`,
                )
                .addFields(
                    { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,             inline: true },
                    { name: '🏆 Win Pays', value: `**${currentPayout.toLocaleString()}** coins`,  inline: true },
                    nextPayout ? { name: '🎲 Double-or-Nothing', value: `**${nextPayout.toLocaleString()}** coins (${shufflesForRound(round + 1)} shuffles)`, inline: true } : { name: '​', value: '​', inline: true },
                )
                .setFooter({ text: 'You have 30 seconds to choose.' })],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`monte_1_${gameId}`).setLabel('Card 1').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`monte_2_${gameId}`).setLabel('Card 2').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`monte_3_${gameId}`).setLabel('Card 3').setStyle(ButtonStyle.Primary),
            )],
        });

        const msg = await interaction.fetchReply();
        let guess;
        try {
            const resp = await msg.awaitMessageComponent({
                filter: ownedBy(
                    interaction.user.id,
                    i => i.customId.startsWith('monte_') && i.customId.endsWith(gameId),
                    "This isn't your game.",
                ),
                time: 30_000,
            });
            await resp.deferUpdate();
            guess = parseInt(resp.customId.split('_')[1], 10) - 1;
        } catch {
            settled = true;
            const timeoutRefund = round > 1 ? payoutForRound(bet, round - 1) : bet;
            await User.findOneAndUpdate(userFilter, { $inc: { balance: timeoutRefund } });
            const timeoutMsg = round > 1
                ? `⏱️ Time's up! Paid out **${timeoutRefund.toLocaleString()}** coins (your Round ${round - 1} winnings).`
                : '⏱️ Time\'s up! Your bet was refunded.';
            releaseLock?.();
            return interaction.editReply({ content: timeoutMsg, embeds: [], components: [] }).catch(() => {});
        }

        const won = guess === queenPos;

        const userDoc          = round === 1 ? debited : await User.findOne(userFilter);
        const luckyActive      = hasEffect(userDoc, 'lucky_charm');
        const luckyStreakBonus = getLuckyStreakBonus(userDoc);
        const coinMult         = getCoinMultiplier(userDoc);
        const serverMult       = getServerCoinMultiplier(guildSettings);
        const totalCoinMult    = coinMult * serverMult;

        let charmTriggered  = false;
        let streakTriggered = false;
        let grossPayout     = won ? currentPayout : 0;

        const luckySavable = luckySaveEligible(bet);
        if (!won && luckySavable && luckyActive && Math.random() < 0.20) {
            grossPayout    = bet;
            charmTriggered = true;
        }
        if (!won && !charmTriggered && luckySavable && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
            grossPayout     = bet;
            streakTriggered = true;
        }

        let adjustedPayout = grossPayout;
        if (grossPayout > bet && totalCoinMult > 1.0) {
            adjustedPayout = bet + Math.round((grossPayout - bet) * totalCoinMult);
        }

        const reveal = buildReveal(queenPos);

        if (!won || round >= MAX_ROUNDS || charmTriggered || streakTriggered) {
            // Final result — pay out and show Play Again
            let updated = userDoc;
            if (adjustedPayout > 0) {
                updated = await User.findOneAndUpdate(userFilter, { $inc: { balance: adjustedPayout } }, { new: true });
            }
            settled = true;

            const net    = adjustedPayout - bet;
            const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

            let color, title, desc;
            if (won && round >= MAX_ROUNDS) {
                color = '#FFD700';
                title = `🃏 Correct! Maximum Escalation — ${(BASE_WIN_MULT * Math.pow(2, round - 1)).toFixed(1)}× Payout!`;
                desc  = `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\n🏆 You went all the way! **${adjustedPayout.toLocaleString()}** coins!`;
            } else if (won) {
                color = '#2ecc71';
                title = '🃏 Correct! You found the Queen!';
                desc  = `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\n🎉 You picked **Card ${guess + 1}** — the Queen was there! **${BASE_WIN_MULT}×** payout!`;
            } else if (charmTriggered || streakTriggered) {
                color = '#f39c12';
                title = '🃏 Wrong Card — Lucky Save!';
                desc  = `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\nYou picked **Card ${guess + 1}** but the Queen was at **Card ${queenPos + 1}**.\n${charmTriggered ? '🍀 **Lucky Charm** returned your bet!' : '🎯 **Lucky Streak** returned your bet!'}`;
            } else {
                color = '#e74c3c';
                title = round > 1 ? `🃏 Wrong Card — Lost ${(BASE_WIN_MULT * Math.pow(2, round - 1)).toFixed(1)}× payout!` : '🃏 Wrong Card!';
                desc  = `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\nYou picked **Card ${guess + 1}** but the Queen was at **Card ${queenPos + 1}**.`;
            }

            if (totalCoinMult > 1.0 && adjustedPayout > bet) desc += `\n> 🚀 *${totalCoinMult.toFixed(1)}× Coin Booster applied!*`;

            const replayId = `monte_replay_${interaction.id}_${Date.now()}`;

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor(color)
                    .setTitle(title)
                    .setDescription(desc)
                    .addFields(
                        { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,                                                   inline: true },
                        { name: adjustedPayout > 0 ? '🏆 Payout' : '💀 Lost', value: `${(adjustedPayout > 0 ? adjustedPayout : bet).toLocaleString()} coins`, inline: true },
                        { name: '📊 Net',     value: `**${netStr}** coins`,                                                                 inline: true },
                        { name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`,                               inline: true },
                    )
                    .setFooter({ text: `Round ${round}/${MAX_ROUNDS} · ${steps} shuffles · Queen odds 1-in-3` })
                    .setTimestamp()],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(replayId).setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary),
                )],
            });

            const replyMsg = await interaction.fetchReply();
            replyMsg.createMessageComponentCollector({
                filter: ownedBy(interaction.user.id, i => i.customId === replayId, "This isn't your game."),
                max: 1,
                time: 60_000,
            }).on('collect', async i => {
                await i.deferUpdate();
                await playMonte(interaction, bet, 1, null, onWager);
            }).on('end', (_, reason) => {
                if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
            });
            releaseLock?.();

        } else {
            // Won, and more rounds available — offer double-or-nothing
            settled = true; // Session bet is tracked; payout credited only on final result or take-money

            const takeId   = `monte_take_${interaction.id}_${Date.now()}`;
            const doubleId = `monte_double_${interaction.id}_${Date.now()}`;

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setAuthor(embedAuthor(interaction))
                    .setThumbnail(THUMB)
                    .setColor(COLORS.SUCCESS)
                    .setTitle(`🃏 Correct! Round ${round}/${MAX_ROUNDS} Complete!`)
                    .setDescription(
                        `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\n` +
                        `🎉 You found the Queen at **Card ${guess + 1}**!\n\n` +
                        `> 💰 **Take ${currentPayout.toLocaleString()} coins** (safe)\n` +
                        `> 🎲 **Double or Nothing** — ${shufflesForRound(round + 1)} shuffles for **${nextPayout.toLocaleString()} coins**`
                    )
                    .addFields(
                        { name: '💰 Take Now',       value: `**${currentPayout.toLocaleString()}** coins`,  inline: true },
                        { name: '🎲 Risk for',       value: `**${nextPayout.toLocaleString()}** coins`,     inline: true },
                        { name: '⚠️ If Wrong',       value: `**0** coins — lose everything`,               inline: true },
                    )
                    .setFooter({ text: '30 seconds to decide · Wrong guess next round = no payout' })],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(takeId).setLabel(`💰 Take ${currentPayout.toLocaleString()} coins`).setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(doubleId).setLabel(`🎲 Double or Nothing (${shufflesForRound(round + 1)} shuffles)`).setStyle(ButtonStyle.Danger),
                )],
            });

            const decisionMsg = await interaction.fetchReply();
            let decided = false;
            try {
                const decision = await decisionMsg.awaitMessageComponent({
                    filter: ownedBy(interaction.user.id, i => [takeId, doubleId].includes(i.customId), "This isn't your game."),
                    time: 30_000,
                });
                decided = true;
                await decision.deferUpdate();

                if (decision.customId === takeId) {
                    // Cash out with current round payout
                    let adjustedTake = currentPayout;
                    if (totalCoinMult > 1.0) {
                        adjustedTake = bet + Math.round((currentPayout - bet) * totalCoinMult);
                    }
                    const updated  = await User.findOneAndUpdate(userFilter, { $inc: { balance: adjustedTake } }, { new: true });
                    const net      = adjustedTake - bet;
                    const netStr   = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;
                    const replayId = `monte_replay_${interaction.id}_${Date.now()}`;

                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setAuthor(embedAuthor(interaction))
                            .setThumbnail(THUMB)
                            .setColor(COLORS.SUCCESS)
                            .setTitle('🃏 Cashed Out!')
                            .setDescription(`> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\n💰 You took the money after Round ${round}!`)
                            .addFields(
                                { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,              inline: true },
                                { name: '🏆 Payout',  value: `**${adjustedTake.toLocaleString()}** coins`,     inline: true },
                                { name: '📊 Net',     value: `**${netStr}** coins`,                           inline: true },
                                { name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true },
                            )
                            .setTimestamp()],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(replayId).setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary),
                        )],
                    });

                    const replyMsg = await interaction.fetchReply();
                    replyMsg.createMessageComponentCollector({
                        filter: ownedBy(interaction.user.id, i => i.customId === replayId, "This isn't your game."),
                        max: 1, time: 60_000,
                    }).on('collect', async i => {
                        await i.deferUpdate();
                        await playMonte(interaction, bet, 1, null, onWager);
                    }).on('end', (_, reason) => {
                        if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
                    });
                    releaseLock?.();

                } else {
                    // Double or Nothing — recurse with next round (no payout yet)
                    await playMonte(interaction, bet, round + 1, releaseLock, onWager);
                }

            } catch {
                if (!decided) {
                    // Timeout — auto cash out
                    let adjustedTake = currentPayout;
                    if (totalCoinMult > 1.0) {
                        adjustedTake = bet + Math.round((currentPayout - bet) * totalCoinMult);
                    }
                    const updated = await User.findOneAndUpdate(userFilter, { $inc: { balance: adjustedTake } }, { new: true });
                    await interaction.editReply({
                        content: `⏱️ Time's up — cashed out **${adjustedTake.toLocaleString()}** coins automatically! Balance: **${(updated?.balance ?? 0).toLocaleString()}**`,
                        embeds: [], components: [],
                    }).catch(() => {});
                    releaseLock?.();
                }
            }
        }

    } catch (err) {
        console.error('[Monte] error:', err);
        if (!settled) {
            const rollbackAmount = round > 1 ? payoutForRound(bet, round - 1) : bet;
            await User.findOneAndUpdate(userFilter, { $inc: { balance: rollbackAmount } })
                .catch(e => console.error('[Monte] rollback failed:', e));
        }
        await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', components: [] }).catch(() => {});
        releaseLock?.();
    }
}

module.exports = {
    name: 'cupgame',
    description: 'Three Card Monte — find the Queen, then push your luck with double-or-nothing escalation!',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (min ${MIN_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(1_000_000_000)),

    async execute(interaction, { releaseLock, onWager } = {}) {
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

        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, user.balance, 'Three Card Monte', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }
        if (!alreadyReplied) await interaction.deferReply();
        await playMonte(interaction, bet, 1, releaseLock, onWager);
    },
};
