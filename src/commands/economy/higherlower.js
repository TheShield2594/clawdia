const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

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

// Render a card as a visual block using code block formatting
function cardDisplay(card) {
    const lbl  = cardLabel(card.value);
    const suit = card.suit;
    const pad  = lbl.length === 2 ? '' : ' '; // align single-char labels
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

// Small inline card label: A♠ or 10♥
function cardInline(card) {
    return `**${cardLabel(card.value)}${card.suit}**`;
}

// Probability next card is higher / lower / equal, given current value
function probabilities(value) {
    const higher = 13 - value;   // cards strictly above
    const lower  = value - 1;    // cards strictly below
    const equal  = 1;
    const total  = 13;
    return {
        higher: Math.round((higher / total) * 100),
        lower:  Math.round((lower  / total) * 100),
        equal:  Math.round((equal  / total) * 100),
    };
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function questionEmbed(card, bet, history, interaction) {
    const prob = probabilities(card.value);
    const histStr = history.length
        ? history.map(c => cardInline(c)).join('  →  ')
        : '*No history yet*';

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#5865F2')
        .setTitle('🃏 Higher or Lower')
        .setDescription(
            `**Current Card**\n\`\`\`\n${cardDisplay(card)}\n\`\`\``,
        )
        .addFields(
            { name: '⬆️ Higher',   value: `${prob.higher}% chance`, inline: true },
            { name: '🟰 Equal',    value: `${prob.equal}% (push)`,  inline: true },
            { name: '⬇️ Lower',    value: `${prob.lower}% chance`,  inline: true },
            { name: '💰 Bet',      value: `**${bet.toLocaleString()}** coins`, inline: true },
            { name: '🏆 Win Pays', value: `**${(bet * 2).toLocaleString()}** coins`, inline: true },
            { name: '📜 History',  value: histStr, inline: false },
        )
        .setFooter({ text: 'Equal value = push (bet returned)  •  You have 15 seconds to choose' });
}

function resultEmbed(interaction, current, next, pickedHigher, outcome, bet, newBalance, history) {
    const histStr = history.map(c => cardInline(c)).join('  →  ');

    const configs = {
        win:  { color: '#2ecc71', title: '🃏 Correct!',     desc: `✅ The next card was **${cardInline(next)}** — you guessed **${pickedHigher ? 'Higher' : 'Lower'}** correctly!` },
        loss: { color: '#e74c3c', title: '🃏 Wrong!',       desc: `❌ The next card was **${cardInline(next)}** — you guessed **${pickedHigher ? 'Higher' : 'Lower'}** but it was ${next.value > current.value ? 'higher' : 'lower'}.` },
        push: { color: '#f1c40f', title: '🃏 Push — Tie!',  desc: `🟰 The next card was also **${cardInline(next)}** — same value! Your bet is returned.` },
    };
    const { color, title, desc } = configs[outcome];

    const net    = outcome === 'win' ? bet : outcome === 'push' ? 0 : -bet;
    const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `${desc}\n\n` +
            `\`\`\`\n${cardDisplay(next)}\n\`\`\``,
        )
        .addFields(
            { name: '🃏 Was',        value: cardInline(current),                    inline: true },
            { name: '🃏 Next',       value: cardInline(next),                       inline: true },
            { name: '📊 Net',        value: `**${netStr}** coins`,                  inline: true },
            { name: '💰 Balance',    value: `**${newBalance.toLocaleString()}** coins`, inline: true },
            { name: '📜 History',    value: histStr || '*none*',                    inline: false },
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
            { name: '🃏 Card Was',    value: cardInline(card),                        inline: true },
            { name: '💰 Balance',     value: `**${newBalance.toLocaleString()}** coins`, inline: true },
        )
        .setTimestamp();
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('higherlower')
        .setDescription('Bet on whether the next card will be higher or lower')
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to wager (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true)),

    async execute(interaction) {
        const bet = interaction.options.getInteger('bet');
        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
                return interaction.reply({ content: 'Economy games are disabled in this server.', ephemeral: true });
            }

            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            let user = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true }
            );

            if (!user) {
                return interaction.reply({
                    content: `❌ Insufficient funds. You need **${bet.toLocaleString()}** coins to place this bet.`,
                    ephemeral: true,
                });
            }

            await playHigherLower(interaction, bet, userFilter, []);

        } catch (err) {
            console.error('[HigherLower] error:', err);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'Failed to run Higher or Lower.', ephemeral: true });
            } else {
                await interaction.reply({ content: 'Failed to run Higher or Lower.', ephemeral: true });
            }
        }
    },
};

async function playHigherLower(interaction, bet, userFilter, history) {
    const current = rollCard();
    const upId    = `hl_up_${interaction.id}_${Date.now()}`;
    const downId  = `hl_down_${interaction.id}_${Date.now()}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(upId).setLabel('⬆️ Higher').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(downId).setLabel('⬇️ Lower').setStyle(ButtonStyle.Danger),
    );

    // First play uses reply; replays use editReply
    const isFirstPlay = !interaction.replied && !interaction.deferred;
    if (isFirstPlay) {
        await interaction.reply({
            embeds:     [questionEmbed(current, bet, history, interaction)],
            components: [row],
        });
    } else {
        await interaction.editReply({
            embeds:     [questionEmbed(current, bet, history, interaction)],
            components: [row],
        });
    }

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

            let outcome, delta;
            if (next.value === current.value) {
                outcome = 'push';
                delta   = bet; // refund
            } else {
                const won = pickedHigher ? next.value > current.value : next.value < current.value;
                outcome   = won ? 'win' : 'loss';
                delta     = won ? bet * 2 : 0;
            }

            const updated = await User.findOneAndUpdate(
                userFilter,
                { $inc: { balance: delta } },
                { new: true }
            );

            const newHistory = [...history, current];

            const replayId = `hl_replay_${interaction.id}_${Date.now()}`;
            const replayRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(replayId).setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary),
            );

            await i.update({
                embeds:     [resultEmbed(interaction, current, next, pickedHigher, outcome, bet, updated?.balance ?? 0, newHistory)],
                components: [replayRow],
            });

            // Replay: deduct bet again and restart
            message.createMessageComponentCollector({
                filter: ri => ri.user.id === interaction.user.id && ri.customId === replayId,
                max: 1,
                time: 60_000,
            }).on('collect', async ri => {
                const newDebited = await User.findOneAndUpdate(
                    { ...userFilter, balance: { $gte: bet } },
                    { $inc: { balance: -bet } },
                    { new: true }
                );
                if (!newDebited) {
                    const fresh = await User.findOne(userFilter);
                    await ri.update({
                        content: `❌ Not enough coins! Balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                        embeds: [], components: [],
                    });
                    return;
                }
                await ri.deferUpdate();
                await playHigherLower(interaction, bet, userFilter, newHistory.slice(-5));
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
        // Timeout — refund
        await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(() => {});
        const fresh = await User.findOne(userFilter);
        await interaction.editReply({
            embeds:     [timeoutEmbed(interaction, current, bet, fresh?.balance ?? 0)],
            components: [],
        }).catch(() => {});
    });
}
