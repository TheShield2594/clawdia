const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier } = require('../../services/effectsService');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;
const MAX_BET = 5000;
const SUITS   = ['♠', '♥', '♦', '♣'];

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

// Probability of next card being strictly higher/lower, using same-size deck assumption.
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

// Probability-scaled multiplier with 5% house edge. Returns 0 if direction is impossible.
// Cap at 13x for the riskiest single-card guesses.
function winMultiplier(value, direction) {
    const prob = direction === 'higher' ? (13 - value) / 13 : (value - 1) / 13;
    if (prob <= 0) return 0;
    return Math.min(13.0, parseFloat((0.95 / prob).toFixed(2)));
}

// Streak bonus: consecutive correct guesses multiply profit (not the whole payout).
function streakMultiplier(streak) {
    if (streak <= 1) return 1.00;
    if (streak === 2) return 1.15;
    if (streak === 3) return 1.35;
    if (streak === 4) return 1.60;
    return 2.00; // 5+
}

function streakLabel(streak) {
    if (streak <= 0) return '';
    if (streak === 1) return ' 🔥';
    if (streak === 2) return ' 🔥🔥';
    if (streak === 3) return ' 🔥🔥🔥';
    if (streak === 4) return ' 🔥🔥🔥🔥';
    return ` 🔥×${streak}`;
}

// Calculate actual payout: bet + (bet × rawMult - bet) × streakMult
function calcRawPayout(bet, value, direction, streak) {
    const mult  = winMultiplier(value, direction);
    if (mult === 0) return 0;
    const sMult = streakMultiplier(streak);
    return Math.floor(bet + (bet * mult - bet) * sMult);
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function questionEmbed(card, bet, history, interaction, streak) {
    const prob   = probabilities(card.value);
    const multH  = winMultiplier(card.value, 'higher');
    const multL  = winMultiplier(card.value, 'lower');
    const payH   = calcRawPayout(bet, card.value, 'higher', streak);
    const payL   = calcRawPayout(bet, card.value, 'lower',  streak);
    const histStr = history.length ? history.map(c => cardInline(c)).join(' → ') : '*No history yet*';
    const sLabel  = streak >= 2 ? `\n> 🔥 **${streak}-win streak** (${streakMultiplier(streak).toFixed(2)}× profit bonus)` : '';

    const higherField = multH > 0
        ? `${(prob.higher * 100).toFixed(0)}% chance · pays **${payH.toLocaleString()}** (${multH.toFixed(2)}×)`
        : '*Impossible*';
    const lowerField = multL > 0
        ? `${(prob.lower * 100).toFixed(0)}% chance · pays **${payL.toLocaleString()}** (${multL.toFixed(2)}×)`
        : '*Impossible*';

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#5865F2')
        .setTitle('🃏 Higher or Lower')
        .setDescription(`**Current Card**\n\`\`\`\n${cardDisplay(card)}\n\`\`\`${sLabel}`)
        .addFields(
            { name: '⬆️ Higher',    value: higherField,                                       inline: true },
            { name: '⬇️ Lower',     value: lowerField,                                        inline: true },
            { name: '🟰 Tie',       value: `${(prob.equal * 100).toFixed(0)}% → push`,        inline: true },
            { name: '💰 Bet',       value: `**${bet.toLocaleString()}** coins`,               inline: true },
            { name: '📜 History',   value: histStr,                                           inline: false },
        )
        .setFooter({ text: 'Equal value = push (bet returned)  •  15 seconds to choose' });
}

function resultEmbed(interaction, current, next, pickedHigher, outcome, bet, payout, newBalance, history, streak) {
    const histStr = history.map(c => cardInline(c)).join(' → ');
    const sLabel  = streak > 0 ? streakLabel(streak) : '';

    const configs = {
        win:  { color: '#2ecc71', title: `🃏 Correct!${sLabel}`,  desc: `✅ Next card was ${cardInline(next)} — **${pickedHigher ? 'Higher' : 'Lower'}** was right!` },
        loss: { color: '#e74c3c', title: '🃏 Wrong!',              desc: `❌ Next card was ${cardInline(next)} — you guessed **${pickedHigher ? 'Higher' : 'Lower'}** incorrectly.` },
        push: { color: '#f1c40f', title: '🃏 Push — Tie!',         desc: `🟰 Next card was also ${cardInline(next)} — same value! Bet returned.` },
    };
    const { color, title, desc } = configs[outcome];

    const netRaw = payout - bet;
    const netStr = netRaw >= 0 ? `+${netRaw.toLocaleString()}` : `${netRaw.toLocaleString()}`;

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(title)
        .setDescription(`${desc}\n\n\`\`\`\n${cardDisplay(next)}\n\`\`\``)
        .addFields(
            { name: '🃏 Was',     value: cardInline(current),                       inline: true },
            { name: '🃏 Next',    value: cardInline(next),                          inline: true },
            { name: '📊 Net',     value: `**${netStr}** coins`,                     inline: true },
            { name: '💰 Balance', value: `**${newBalance.toLocaleString()}** coins`, inline: true },
            { name: '📜 History', value: histStr || '*none*',                        inline: false },
        )
        .setTimestamp();
}

function timeoutEmbed(interaction, card, bet, newBalance) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#95a5a6')
        .setTitle('🃏 Higher or Lower — Timed Out')
        .setDescription(`⏱️ You didn't pick in time. Your bet of **${bet.toLocaleString()}** coins has been refunded.`)
        .addFields(
            { name: '🃏 Card Was',  value: cardInline(card),                          inline: true },
            { name: '💰 Balance',   value: `**${newBalance.toLocaleString()}** coins`, inline: true },
        )
        .setTimestamp();
}

module.exports = {
    name: 'higherlower',
    description: 'Bet on whether the next card will be higher or lower — payouts scale with probability',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to wager (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true)),

    async execute(interaction) {
        const bet = interaction.options.getInteger('bet');
        const [user, guildSettings] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id }),
        ]);
        const wallet = user?.balance ?? 0;

        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            return interaction.reply({ content: 'Economy games are disabled in this server.', ephemeral: true });
        }

        const { shouldProceed: hlProceed, alreadyReplied: hlReplied } = await confirmBet(interaction, bet, wallet, 'Higher or Lower', guildSettings);
        if (!hlProceed) return;
        if (!hlReplied) await interaction.deferReply();

        try {
            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            const debited = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true }
            );

            if (!debited) {
                return interaction.editReply({
                    content: `❌ Insufficient funds. You need **${bet.toLocaleString()}** coins.`,
                });
            }

            await playHigherLower(interaction, bet, userFilter, guildSettings, [], 0);

        } catch (err) {
            console.error('[HigherLower] error:', err);
            await interaction.editReply({ content: 'Failed to run Higher or Lower.' }).catch(() => {});
        }
    },
};

async function playHigherLower(interaction, bet, userFilter, guildSettings, history, streak) {
    const current = rollCard();
    const canHigh = winMultiplier(current.value, 'higher') > 0;
    const canLow  = winMultiplier(current.value, 'lower')  > 0;

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
        filter: i => i.user.id === interaction.user.id && [upId, downId].includes(i.customId),
        max:    1,
        time:   15_000,
    });

    collector.on('collect', async i => {
        try {
            const next         = rollCard();
            const pickedHigher = i.customId === upId;

            // Fetch user once per resolution for all effect checks
            const userDoc    = await User.findOne(userFilter);
            const luckyActive = hasEffect(userDoc, 'lucky_charm');
            const coinMult   = getCoinMultiplier(userDoc);
            const serverMult = getServerCoinMultiplier(guildSettings);
            const lsBonus  = getLuckyStreakBonus(userDoc);

            let outcome, rawPayout, newStreak;

            if (next.value === current.value) {
                // Tie: push regardless of direction picked
                outcome    = 'push';
                rawPayout  = bet;
                newStreak  = streak; // ties don't break streak
            } else {
                const won = pickedHigher ? next.value > current.value : next.value < current.value;

                if (!won && luckyActive && Math.random() < 0.20) {
                    // Lucky Charm: return bet on loss
                    outcome   = 'push';
                    rawPayout = bet;
                    newStreak = 0;
                } else if (won) {
                    newStreak = streak + 1;
                    rawPayout = calcRawPayout(bet, current.value, pickedHigher ? 'higher' : 'lower', newStreak);

                    // Apply coin / server multiplier to profits only
                    const totalMult = coinMult * serverMult;
                    if (totalMult > 1.0) {
                        rawPayout = bet + Math.round((rawPayout - bet) * totalMult);
                    }

                    outcome = 'win';
                } else {
                    if (lsBonus > 0 && Math.random() < lsBonus) {
                        outcome   = 'push';
                        rawPayout = bet;
                    } else {
                        outcome   = 'loss';
                        rawPayout = 0;
                    }
                    newStreak = 0;
                }
            }

            const updated = await User.findOneAndUpdate(
                userFilter,
                { $inc: { balance: rawPayout } },
                { new: true }
            );

            const newHistory = [...history, current];
            const replayId   = `hl_replay_${interaction.id}_${Date.now()}`;
            const replayRow  = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(replayId).setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary),
            );

            await i.update({
                embeds:     [resultEmbed(interaction, current, next, pickedHigher, outcome, bet, rawPayout, updated?.balance ?? 0, newHistory, newStreak)],
                components: [replayRow],
            });

            message.createMessageComponentCollector({
                filter: ri => ri.user.id === interaction.user.id && ri.customId === replayId,
                max: 1,
                time: 60_000,
            }).on('collect', async ri => {
                try {
                    const newDebited = await User.findOneAndUpdate(
                        { ...userFilter, balance: { $gte: bet } },
                        { $inc: { balance: -bet } },
                        { new: true }
                    );
                    if (!newDebited) {
                        const fresh = await User.findOne(userFilter);
                        return ri.update({
                            content: `❌ Not enough coins! Balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                            embeds: [], components: [],
                        });
                    }
                    await ri.deferUpdate();
                    // Carry the streak into the next round (newStreak already encodes win/tie/loss)
                    await playHigherLower(interaction, bet, userFilter, guildSettings, newHistory.slice(-5), newStreak);
                } catch (replayErr) {
                    console.error('[HigherLower] replay error:', replayErr);
                    await interaction.editReply({ content: 'Something went wrong on replay.', embeds: [], components: [] }).catch(() => {});
                }
            }).on('end', (_, reason) => {
                if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
            });

        } catch (collectErr) {
            console.error('[HigherLower] collect error:', collectErr);
            await i.update({ content: 'Something went wrong. Your wager was refunded.', embeds: [], components: [] }).catch(() => {});
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
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
    });
}
