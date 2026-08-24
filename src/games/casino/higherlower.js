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
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;
const SUITS   = ['♠', '♥', '♦', '♣'];

// Session multiplier: starts at 1.0, gains +0.5 per correct guess, capped at 6.0.
const STREAK_BONUS = 0.5;
const MAX_SESSION_MULT = 6.0;

function sessionMult(streak) {
    return Math.min(MAX_SESSION_MULT, 1.0 + streak * STREAK_BONUS);
}

function rollCard() {
    return {
        value: Math.floor(Math.random() * 13) + 1,
        suit:  SUITS[Math.floor(Math.random() * SUITS.length)],
    };
}

function cardLabel(value) {
    const face = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    return face[value] ?? String(value);
}

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

function probabilities(value) {
    const higher = 13 - value;
    const lower  = value - 1;
    const total  = 13;
    return {
        higher: higher / total,
        lower:  lower  / total,
        equal:  1      / total,
    };
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function questionEmbed(card, bet, history, interaction, streak) {
    const prob      = probabilities(card.value);
    const mult      = sessionMult(streak);
    const nextMult  = sessionMult(streak + 1);
    const cashNow   = Math.floor(bet * mult);
    const cashNext  = Math.floor(bet * nextMult);
    const histStr   = history.length ? history.map(c => cardInline(c)).join(' → ') : '*No history yet*';

    const streakLine = streak > 0
        ? `\n> 🔥 **${streak}-win streak** · ${mult.toFixed(1)}× · Cash out: **${cashNow.toLocaleString()}** or go for **${cashNext.toLocaleString()}** (${nextMult.toFixed(1)}×)`
        : '';

    const higherField = prob.higher > 0
        ? `${(prob.higher * 100).toFixed(0)}% chance`
        : '*Impossible*';
    const lowerField = prob.lower > 0
        ? `${(prob.lower * 100).toFixed(0)}% chance`
        : '*Impossible*';

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.INFO)
        .setTitle('🃏 Higher or Lower')
        .setDescription(`**Current Card**\n\`\`\`\n${cardDisplay(card)}\n\`\`\`${streakLine}`)
        .addFields(
            { name: '⬆️ Higher',  value: higherField,                                    inline: true },
            { name: '⬇️ Lower',   value: lowerField,                                     inline: true },
            { name: '🟰 Tie',     value: `${(prob.equal * 100).toFixed(0)}% → push`,     inline: true },
            { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,             inline: true },
            { name: '🎯 Win →',   value: `**${cashNext.toLocaleString()}** (${nextMult.toFixed(1)}×)`, inline: true },
            { name: '📜 History', value: histStr,                                        inline: false },
        )
        .setFooter({ text: 'Equal value = push  •  15s to choose  •  Cash out any time after a win' });
}

function riskEmbed(interaction, current, next, pickedHigher, bet, streak, payout) {
    const mult = sessionMult(streak);
    const nextMult = sessionMult(streak + 1);
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#f1c40f')
        .setTitle(`🃏 Correct! 🔥×${streak}`)
        .setDescription(
            `✅ ${cardInline(current)} → ${cardInline(next)} — **${pickedHigher ? 'Higher' : 'Lower'}** was right!\n\n` +
            `> 💰 **Cash out: ${payout.toLocaleString()} coins** (${mult.toFixed(1)}× your bet)\n` +
            `> 🎴 Or risk it for **${Math.floor(bet * nextMult).toLocaleString()}** coins (${nextMult.toFixed(1)}×)\n` +
            (streak >= Math.floor((MAX_SESSION_MULT - 1.0) / STREAK_BONUS)
                ? '\n> ⚠️ *Max multiplier reached — cash out is the same regardless.*'
                : '')
        )
        .addFields(
            { name: '💰 Bet',        value: `**${bet.toLocaleString()}** coins`,     inline: true },
            { name: '🏆 Cash Out',   value: `**${payout.toLocaleString()}** coins`,  inline: true },
            { name: '🎲 If You Win', value: `**${Math.floor(bet * nextMult).toLocaleString()}** coins (${nextMult.toFixed(1)}×)`, inline: true },
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

function cashOutEmbed(interaction, bet, payout, newBalance, streak) {
    const mult   = sessionMult(streak);
    const net    = payout - bet;
    const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.SUCCESS)
        .setTitle(`🃏 Cashed Out! 🔥×${streak}`)
        .setDescription(`💰 You locked in **${payout.toLocaleString()}** coins at **${mult.toFixed(1)}×**!`)
        .addFields(
            { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,          inline: true },
            { name: '🏆 Payout',  value: `**${payout.toLocaleString()}** coins`,       inline: true },
            { name: '📊 Net',     value: `**${netStr}** coins`,                        inline: true },
            { name: '💰 Balance', value: `**${newBalance.toLocaleString()}** coins`,   inline: true },
        )
        .setTimestamp();
}

function timeoutEmbed(interaction, card, bet, newBalance) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.NEUTRAL)
        .setTitle('🃏 Higher or Lower — Timed Out')
        .setDescription(`⏱️ You didn't pick in time. Your bet of **${bet.toLocaleString()}** coins has been refunded.`)
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

        const casinoMaxBet = guildSettings?.economy?.casinoMaxBet ?? 0;
        if (casinoMaxBet > 0 && bet > casinoMaxBet) {
            releaseLock?.();
            return interaction.reply({ content: `❌ The casino bet limit on this server is **${casinoMaxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
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
// A session ends when the player cashes out, loses, or starts a new game.
// releaseLock is called as soon as the hand resolves to a final state (win/
// loss/cash-out/timeout) — NOT held through "Play Again", since a replay
// re-runs the same atomic debit as any fresh bet and can't double-spend even
// if another casino game starts in parallel once this hand has settled.
async function playHigherLower(interaction, bet, userFilter, guildSettings, history, streak, releaseLock, onWager) {
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
        embeds:     [questionEmbed(current, bet, history, interaction, streak)],
        components: [row],
    });

    const message   = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, i => [upId, downId].includes(i.customId), "This isn't your game."),
        max:    1,
        time:   15_000,
    });

    collector.on('collect', async i => {
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
                await playHigherLower(interaction, bet, userFilter, guildSettings, newHistory.slice(-5), streak, releaseLock, onWager);
                return;
            }

            const won = pickedHigher ? next.value > current.value : next.value < current.value;

            // Lucky Charm on loss: return bet silently and end session (low-stakes bets only)
            if (!won && luckySaveEligible(bet) && luckyActive && Math.random() < 0.20) {
                const updated = await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }, { new: true });
                const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                await i.update({
                    embeds: [new EmbedBuilder()
                        .setAuthor(embedAuthor(interaction))
                        .setThumbnail(THUMB)
                        .setColor(COLORS.WARN)
                        .setTitle('🃏 Wrong — Lucky Save!')
                        .setDescription(`${cardInline(current)} → ${cardInline(next)}\n🍀 **Lucky Charm** returned your bet!`)
                        .addFields({ name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true })
                        .setTimestamp()],
                    components: [playAgainRow(replayId)],
                });
                attachReplay(message, replayId, interaction, bet, userFilter, guildSettings, onWager);
                releaseLock?.();
                return;
            }

            // Lucky Streak on loss: return bet silently and end session (low-stakes bets only)
            if (!won && luckySaveEligible(bet) && lsBonus > 0 && Math.random() < lsBonus) {
                const updated = await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }, { new: true });
                const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                await i.update({
                    embeds: [new EmbedBuilder()
                        .setAuthor(embedAuthor(interaction))
                        .setThumbnail(THUMB)
                        .setColor(COLORS.WARN)
                        .setTitle('🃏 Wrong — Lucky Streak Save!')
                        .setDescription(`${cardInline(current)} → ${cardInline(next)}\n🎯 **Lucky Streak** returned your bet!`)
                        .addFields({ name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true })
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
            const mult      = sessionMult(newStreak);
            let rawPayout   = Math.floor(bet * mult);

            // Apply coin/server multiplier to profit only
            if (totalMult > 1.0) {
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
                    .setLabel(`🎴 Risk It (${sessionMult(newStreak + 1).toFixed(1)}× next)`)
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(mult >= MAX_SESSION_MULT),
            );

            await i.update({
                embeds:     [riskEmbed(interaction, current, next, pickedHigher, bet, newStreak, rawPayout)],
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
                        const updated  = await User.findOneAndUpdate(userFilter, { $inc: { balance: rawPayout } }, { new: true });
                        payoutCredited = true;
                        const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                        await r.update({
                            embeds:     [cashOutEmbed(interaction, bet, rawPayout, updated?.balance ?? 0, newStreak)],
                            components: [playAgainRow(replayId)],
                        });
                        attachReplay(riskMsg, replayId, interaction, bet, userFilter, guildSettings, onWager);
                        releaseLock?.();
                    } else {
                        // Risk another card — recurse without paying out
                        await r.deferUpdate();
                        await playHigherLower(interaction, bet, userFilter, guildSettings, newHistory.slice(-5), newStreak, releaseLock, onWager);
                    }
                } catch (riskErr) {
                    console.error('[HigherLower] risk collect error:', riskErr);
                    await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', embeds: [], components: [] }).catch(() => {});
                    if (!payoutCredited) {
                        await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
                    }
                    releaseLock?.();
                }
            });

            riskCollector.on('end', async (collected, _reason) => {
                if (collected.size > 0) return;
                // Timeout on risk screen — auto cash out
                const updated  = await User.findOneAndUpdate(userFilter, { $inc: { balance: rawPayout } }, { new: true });
                const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
                await interaction.editReply({
                    embeds:     [cashOutEmbed(interaction, bet, rawPayout, updated?.balance ?? 0, newStreak)],
                    components: [playAgainRow(replayId)],
                }).catch(() => {});
                attachReplay(riskMsg, replayId, interaction, bet, userFilter, guildSettings, onWager);
                releaseLock?.();
            });

        } catch (collectErr) {
            console.error('[HigherLower] collect error:', collectErr);
            await i.update({ content: 'Something went wrong. Your wager was refunded.', embeds: [], components: [] }).catch(() => {});
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
            releaseLock?.();
        }
    });

    collector.on('end', async (collected, _reason) => {
        if (collected.size > 0) return;
        await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
        const fresh = await User.findOne(userFilter);
        await interaction.editReply({
            embeds:     [timeoutEmbed(interaction, current, bet, fresh?.balance ?? 0)],
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
            await ri.deferUpdate();
            await playHigherLower(interaction, bet, userFilter, guildSettings, [], 0, null, onWager);
        } catch (replayErr) {
            console.error('[HigherLower] replay error:', replayErr);
            await interaction.editReply({ content: 'Something went wrong on replay.', embeds: [], components: [] }).catch(() => {});
        }
    }).on('end', (_, reason) => {
        if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
    });
}
