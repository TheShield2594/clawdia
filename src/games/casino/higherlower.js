const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const { placeWager } = require('../../utils/placeWager');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { casinoRefusal, replayRefusal, refuseReplay } = require('./betGuard');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');
const {
    MAX_SESSION_MULT,
    rollCard,
    cardLabel,
    probabilities,
    winChance,
    nextMult,
} = require('./higherlowerOdds');
const { ownedBy } = require('../../utils/collectorOwner');
const { newHandId, payHand, payoutNote, settledBalance } = require('./payout');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;
function cardDisplay(card) {
    const lbl  = cardLabel(card.value);
    const suit = card.suit;
    const pad  = lbl.length === 2 ? '' : ' ';
    return [
        '┌───────┐',
        `│ ${lbl}${pad}    │`,
        `│       │`,
        `│   ${suit}   │`,
        `│       │`,
        `│    ${pad}${lbl} │`,
        '└───────┘',
    ].join('\n');
}

function cardInline(card) {
    return `**${cardLabel(card.value)}${card.suit}**`;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function questionEmbed(card, bet, history, interaction, streak, mult, cashValue) {
    const prob    = probabilities(card.value);
    const histStr = history.length ? history.map(c => cardInline(c)).join(' → ') : '*No history yet*';

    const streakLine = streak > 0
        ? `\n> 🔥 **${streak}-win streak** · ${mult.toFixed(2)}× · worth **${cashValue.toLocaleString()}** now`
        : '';

    // Each call shows its own odds and what winning it pays: a call is priced
    // by its odds, so the two sides pay differently off the same card.
    const sideField = pickedHigher => {
        const share = pickedHigher ? prob.higher : prob.lower;
        if (share <= 0) return '*Impossible*';
        const win = Math.floor(bet * nextMult(mult, card.value, pickedHigher));
        return `${(winChance(card.value, pickedHigher) * 100).toFixed(0)}% · win → **${win.toLocaleString()}**`;
    };

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.INFO)
        .setTitle('🃏 Higher or Lower')
        .setDescription(`**Current Card**\n\`\`\`\n${cardDisplay(card)}\n\`\`\`${streakLine}`)
        .addFields(
            { name: '⬆️ Higher',  value: sideField(true),                                inline: true },
            { name: '⬇️ Lower',   value: sideField(false),                               inline: true },
            { name: '🟰 Tie',     value: `${(prob.equal * 100).toFixed(0)}% → push`,     inline: true },
            { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,             inline: true },
            { name: '📜 History', value: histStr,                                        inline: false },
        )
        .setFooter({ text: 'Odds shown leave out ties  •  Equal value = push  •  15s to choose' });
}

function riskEmbed(interaction, current, next, pickedHigher, bet, streak, mult, payout) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#f1c40f')
        .setTitle(`🃏 Correct! 🔥×${streak}`)
        .setDescription(
            `✅ ${cardInline(current)} → ${cardInline(next)} — **${pickedHigher ? 'Higher' : 'Lower'}** was right!\n\n` +
            `> 💰 **Cash out: ${payout.toLocaleString()} coins** (${mult.toFixed(2)}× your bet)\n` +
            `> 🎴 Or draw another card — each correct call pays by its odds\n` +
            (mult >= MAX_SESSION_MULT
                ? '\n> ⚠️ *Max multiplier reached — cash out is the same regardless.*'
                : '')
        )
        .addFields(
            { name: '💰 Bet',        value: `**${bet.toLocaleString()}** coins`,     inline: true },
            { name: '🏆 Cash Out',   value: `**${payout.toLocaleString()}** coins`,  inline: true },
        )
        .setFooter({ text: '30s to decide · Wrong guess = lose everything' });
}

function lossEmbed(interaction, current, next, pickedHigher, bet, newBalance) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.ERROR)
        .setTitle('🃏 Wrong!')
        .setDescription(`❌ ${cardInline(current)} → ${cardInline(next)} — you guessed **${pickedHigher ? 'Higher' : 'Lower'}** incorrectly.\n\n💀 You lost your bet.`)
        .addFields(
            { name: '💰 Lost',    value: `**${bet.toLocaleString()}** coins`,          inline: true },
            { name: '💰 Balance', value: `**${newBalance.toLocaleString()}** coins`,   inline: true },
        )
        .setTimestamp();
}

function cashOutEmbed(interaction, bet, payout, newBalance, streak, mult, note = '') {
    const net    = payout - bet;
    const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.SUCCESS)
        .setTitle(`🃏 Cashed Out! 🔥×${streak}`)
        .setDescription(`💰 You locked in **${payout.toLocaleString()}** coins at **${mult.toFixed(2)}×**!${note}`)
        .addFields(
            { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,          inline: true },
            { name: '🏆 Payout',  value: `**${payout.toLocaleString()}** coins`,       inline: true },
            { name: '📊 Net',     value: `**${netStr}** coins`,                        inline: true },
            { name: '💰 Balance', value: `**${newBalance.toLocaleString()}** coins`,   inline: true },
        )
        .setTimestamp();
}

function timeoutEmbed(interaction, card, returned, streak, newBalance, note = '') {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.NEUTRAL)
        .setTitle('🃏 Higher or Lower — Timed Out')
        .setDescription(streak > 0
            ? `⏱️ You didn't pick in time, so the streak was cashed out: **${returned.toLocaleString()}** coins.${note}`
            : `⏱️ You didn't pick in time. Your bet of **${returned.toLocaleString()}** coins has been refunded.${note}`)
        .addFields(
            { name: '🃏 Card Was',  value: cardInline(card),                          inline: true },
            { name: '💰 Balance',   value: `**${newBalance.toLocaleString()}** coins`, inline: true },
        )
        .setTimestamp();
}

function playAgainRow(id) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id).setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary),
    );
}

module.exports = {
    name: 'higherlower',
    description: 'Bet higher or lower on the next card — build a streak and cash out to multiply your bet',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to wager (min ${MIN_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(1_000_000_000)
                .setRequired(true)),

    async execute(interaction, { releaseLock, onWager } = {}) {
        const bet = interaction.options.getInteger('bet');
        const [user, guildSettings] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id }),
        ]);
        const wallet = user?.balance ?? 0;

        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            releaseLock?.();
            return interaction.reply({ content: 'Economy games are disabled in this server.', flags: MessageFlags.Ephemeral });
        }

        const refusal = casinoRefusal(guildSettings, bet);
        if (refusal) {
            releaseLock?.();
            return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
        }

        const { shouldProceed: hlProceed, alreadyReplied: hlReplied } = await confirmBet(interaction, bet, wallet, 'Higher or Lower', guildSettings);
        if (!hlProceed) { releaseLock?.(); return; }
        if (!hlReplied) await interaction.deferReply();

        try {
            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            const debited = await placeWager(userFilter, bet, { onWager });

            if (!debited) {
                releaseLock?.();
                return interaction.editReply({
                    content: `❌ Insufficient funds. You need **${bet.toLocaleString()}** coins.`,
                });
            }

            await playHigherLower(interaction, bet, userFilter, guildSettings, [], 0, releaseLock, onWager);

        } catch (err) {
            console.error('[HigherLower] error:', err);
            releaseLock?.();
            await interaction.editReply({ content: 'Failed to run Higher or Lower.' }).catch(() => {});
        }
    },
};

// streak = number of consecutive correct guesses in the current session (starts at 0).
// mult = the session multiplier those guesses built, priced by their odds, and
// cashValue = what the session is worth in coins now: the stake before the
// first win, the cash-out after each one (coin boosters included).
// A session ends when the player cashes out, loses, or starts a new game.
// releaseLock is called as soon as the hand resolves to a final state (win/
// loss/cash-out/timeout) — NOT held through "Play Again", since a replay
// re-runs the same atomic debit as any fresh bet and can't double-spend even
// if another casino game starts in parallel once this hand has settled.
async function playHigherLower(interaction, bet, userFilter, guildSettings, history, streak, releaseLock, onWager, handId = newHandId(), mult = 1, cashValue = bet) {
    const current = rollCard();
    const canHigh = probabilities(current.value).higher > 0;
    const canLow  = probabilities(current.value).lower  > 0;

    const upId   = `hl_up_${interaction.id}_${Date.now()}`;
    const downId = `hl_down_${interaction.id}_${Date.now()}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(upId)
            .setLabel('⬆️ Higher')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!canHigh),
        new ButtonBuilder()
            .setCustomId(downId)
            .setLabel('⬇️ Lower')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!canLow),
    );

    await interaction.editReply({
        embeds:     [questionEmbed(current, bet, history, interaction, streak, mult, cashValue)],
        components: [row],
    });

    const message   = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, i => [upId, downId].includes(i.customId), "This isn't your game."),
        max:    1,
        time:   15_000,
    });

    collector.on('collect', async i => {
        // Set as soon as a settlement has been credited, and read by the outer
        // catch below. The lucky saves pay and then render; a render that threw
        // sent the catch down its own refund path, under a different key, and
        // the player was paid twice for one hand.
        let settledHere = false;
        try {
            const next         = rollCard();
            const pickedHigher = i.customId === upId;

            // Fetch user for effect checks
            const userDoc    = await User.findOne(userFilter);
            const luckyActive = hasEffect(userDoc, 'lucky_charm');
            const coinMult   = getCoinMultiplier(userDoc);
            const serverMult = getServerCoinMultiplier(guildSettings);
            const totalMult  = coinMult * serverMult;
            const lsBonus    = getLuckyStreakBonus(userDoc);

            // Determine outcome
            if (next.value === current.value) {
                // Tie: push — refund this round and continue session without changing streak
                const newHistory = [...history, current];
                await i.deferUpdate();
                await playHigherLower(interaction, bet, userFilter, guildSettings, newHistory.slice(-5), streak, releaseLock, onWager, handId, mult, cashValue);
                return;
            }

            const won = pickedHigher ? next.value > current.value : next.value < current.value;

            // Lucky Charm on loss: return bet silently and end session (low-stakes bets only)
            if (!won && luckySaveEligible(bet) && luckyActive && Math.random() < 0.20) {
                const saved = await payHand(userFilter, bet,
                    { game: 'higherlower', handId, phase: 'lucky-save:charm' });
                settledHere = true;
                const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                await i.update({
                    embeds: [new EmbedBuilder()
                        .setAuthor(embedAuthor(interaction))
                        .setThumbnail(THUMB)
                        .setColor(COLORS.WARN)
                        .setTitle('🃏 Wrong — Lucky Save!')
                        .setDescription(`${cardInline(current)} → ${cardInline(next)}\n🍀 **Lucky Charm** returned your bet!${payoutNote(saved)}`)
                        .addFields({ name: '💰 Balance', value: `**${(await settledBalance(userFilter, saved.balance)).toLocaleString()}** coins`, inline: true })
                        .setTimestamp()],
                    components: [playAgainRow(replayId)],
                });
                attachReplay(message, replayId, interaction, bet, userFilter, guildSettings, onWager);
                releaseLock?.();
                return;
            }

            // Lucky Streak on loss: return bet silently and end session (low-stakes bets only)
            if (!won && luckySaveEligible(bet) && lsBonus > 0 && Math.random() < lsBonus) {
                const saved = await payHand(userFilter, bet,
                    { game: 'higherlower', handId, phase: 'lucky-save:streak' });
                settledHere = true;
                const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                await i.update({
                    embeds: [new EmbedBuilder()
                        .setAuthor(embedAuthor(interaction))
                        .setThumbnail(THUMB)
                        .setColor(COLORS.WARN)
                        .setTitle('🃏 Wrong — Lucky Streak Save!')
                        .setDescription(`${cardInline(current)} → ${cardInline(next)}\n🎯 **Lucky Streak** returned your bet!${payoutNote(saved)}`)
                        .addFields({ name: '💰 Balance', value: `**${(await settledBalance(userFilter, saved.balance)).toLocaleString()}** coins`, inline: true })
                        .setTimestamp()],
                    components: [playAgainRow(replayId)],
                });
                attachReplay(message, replayId, interaction, bet, userFilter, guildSettings, onWager);
                releaseLock?.();
                return;
            }

            if (!won) {
                // Loss — bet already deducted, credit nothing
                const updated = await User.findOne(userFilter);
                const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                await i.update({
                    embeds:     [lossEmbed(interaction, current, next, pickedHigher, bet, updated?.balance ?? 0)],
                    components: [playAgainRow(replayId)],
                });
                attachReplay(message, replayId, interaction, bet, userFilter, guildSettings, onWager);
                releaseLock?.();
                return;
            }

            // WIN — calculate payout and present cash-out / risk-another choice
            const newStreak = streak + 1;
            const newMult   = nextMult(mult, current.value, pickedHigher);
            let rawPayout   = Math.floor(bet * newMult);

            // Apply coin/server multiplier to profit only. A certain call can
            // price the session below the stake, and multiplying that "profit"
            // would have multiplied the loss.
            if (totalMult > 1.0 && rawPayout > bet) {
                rawPayout = bet + Math.round((rawPayout - bet) * totalMult);
            }

            const newHistory = [...history, current];
            const cashId     = `hl_cash_${interaction.id}_${Date.now()}`;
            const riskId     = `hl_risk_${interaction.id}_${Date.now()}`;

            const riskRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(cashId)
                    .setLabel(`💰 Cash Out — ${rawPayout.toLocaleString()} coins`)
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(riskId)
                    .setLabel('🎴 Risk It')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(newMult >= MAX_SESSION_MULT),
            );

            await i.update({
                embeds:     [riskEmbed(interaction, current, next, pickedHigher, bet, newStreak, newMult, rawPayout)],
                components: [riskRow],
            });

            const riskMsg = await interaction.fetchReply();
            const riskCollector = riskMsg.createMessageComponentCollector({
                filter: ownedBy(interaction.user.id, r => [cashId, riskId].includes(r.customId), "This isn't your game."),
                max:    1,
                time:   30_000,
            });

            riskCollector.on('collect', async r => {
                let payoutCredited = false;
                try {
                    if (r.customId === cashId) {
                        // Cash out — credit the accumulated payout
                        const cashed   = await payHand(userFilter, rawPayout,
                            { game: 'higherlower', handId, phase: 'cashout' });
                        payoutCredited = true;
                        const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                        await r.update({
                            embeds:     [cashOutEmbed(interaction, bet, rawPayout, await settledBalance(userFilter, cashed.balance), newStreak, newMult, payoutNote(cashed))],
                            components: [playAgainRow(replayId)],
                        });
                        attachReplay(riskMsg, replayId, interaction, bet, userFilter, guildSettings, onWager);
                        releaseLock?.();
                    } else {
                        // Risk another card — recurse without paying out
                        await r.deferUpdate();
                        await playHigherLower(interaction, bet, userFilter, guildSettings, newHistory.slice(-5), newStreak, releaseLock, onWager, handId, newMult, rawPayout);
                    }
                } catch (riskErr) {
                    console.error('[HigherLower] risk collect error:', riskErr);
                    const returned = payoutCredited
                        ? { credited: true, owed: false, balance: null }
                        : await payHand(userFilter, bet,
                            { game: 'higherlower', handId, phase: 'risk-error' });
                    await interaction.editReply({
                        content: payoutCredited
                            ? `Something went wrong showing the result — your cash-out was settled.${payoutNote(returned)}`
                            : `Something went wrong. ${returned.credited ? 'Your wager was refunded.' : 'Your wager could not be refunded.'}${payoutNote(returned)}`,
                        embeds: [], components: [],
                    }).catch(() => {});
                    releaseLock?.();
                }
            });

            riskCollector.on('end', async (collected, _reason) => {
                if (collected.size > 0) return;
                // Timeout on risk screen — auto cash out
                const cashed   = await payHand(userFilter, rawPayout,
                    { game: 'higherlower', handId, phase: 'cashout' });
                const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                await interaction.editReply({
                    embeds:     [cashOutEmbed(interaction, bet, rawPayout, await settledBalance(userFilter, cashed.balance), newStreak, newMult, payoutNote(cashed))],
                    components: [playAgainRow(replayId)],
                }).catch(() => {});
                attachReplay(riskMsg, replayId, interaction, bet, userFilter, guildSettings, onWager);
                releaseLock?.();
            });

        } catch (collectErr) {
            console.error('[HigherLower] collect error:', collectErr);
            const refunded = settledHere
                ? { credited: true, owed: false, balance: null }
                : await payHand(userFilter, bet,
                    { game: 'higherlower', handId, phase: 'collect-error' });
            await i.update({
                content: settledHere
                    ? `Something went wrong showing the result — your hand was settled.${payoutNote(refunded)}`
                    : `Something went wrong. Your wager was refunded.${payoutNote(refunded)}`,
                embeds: [], components: [],
            }).catch(() => {});
            releaseLock?.();
        }
    });

    collector.on('end', async (collected, _reason) => {
        if (collected.size > 0) return;
        // A lapse pays what the session is worth: the stake before the first
        // win, the cash-out after one. It used to pay the stake either way — so
        // a lapse mid-streak threw the winnings away, and one after a certain
        // call priced below the stake handed back more than the session held.
        const lapsed = await payHand(userFilter, cashValue,
            { game: 'higherlower', handId, phase: 'timeout' });
        await interaction.editReply({
            embeds:     [timeoutEmbed(interaction, current, cashValue, streak, await settledBalance(userFilter, lapsed.balance), payoutNote(lapsed))],
            components: [],
        }).catch(() => {});
        releaseLock?.();
    });
}

function attachReplay(message, replayId, interaction, bet, userFilter, guildSettings, onWager) {
    message.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, ri => ri.customId === replayId, "This isn't your game."),
        max: 1,
        time: 60_000,
    }).on('collect', async ri => {
        try {
            // A new hand answers to the settings as they are now, not as they
            // were when the first one was typed.
            const refused = await replayRefusal(interaction.guild.id, bet);
            if (refused) return refuseReplay(ri, interaction, refused);

            // A replay is a fresh hand paid for with fresh coins, so it reports
            // its own wager rather than riding on the one that opened the
            // original — the jackpot and the season mission both count it.
            const newDebited = await placeWager(userFilter, bet, { onWager });
            if (!newDebited) {
                const fresh = await User.findOne(userFilter);
                return ri.update({
                    content: `❌ Not enough coins! Balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                    embeds: [], components: [],
                });
            }
            // The stake has left the wallet and the hand that would settle or
            // roll it back has not started, so nothing between the two may
            // throw. A failed acknowledgement used to land in the catch below,
            // which reports "something went wrong" and returns nothing.
            await ri.deferUpdate().catch(() => {});
            await playHigherLower(interaction, bet, userFilter, guildSettings, [], 0, null, onWager);
        } catch (replayErr) {
            console.error('[HigherLower] replay error:', replayErr);
            await interaction.editReply({ content: 'Something went wrong on replay.', embeds: [], components: [] }).catch(() => {});
        }
    }).on('end', (_, reason) => {
        if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
    });
}
