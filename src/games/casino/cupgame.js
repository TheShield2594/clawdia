const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier } = require('../../services/effectsService');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3a9.png';
const MIN_BET = 10;
const MAX_BET = 5000;

// Number of shuffle steps scales with bet size
function shuffleCount(bet) {
    if (bet >= 2500) return 8;
    if (bet >= 1000) return 6;
    if (bet >= 500)  return 5;
    return 4;
}

const CUPS = ['🥤', '🥤', '🥤'];
const BALL = '🔴';
const BASE_WIN_MULT = 2.8; // 1/3 chance × 2.8 = ~93% RTP before lucky effects

function cupsDisplay(ballPos, showBall = false) {
    return CUPS.map((cup, i) => (showBall && i === ballPos) ? BALL : cup).join('  ');
}

function swapTwo(arr, a, b) {
    const copy = [...arr];
    [copy[a], copy[b]] = [copy[b], copy[a]];
    return copy;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

async function playCupGame(interaction, bet) {
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

        // Initial state — show the ball under cup 0
        let ballPos = Math.floor(Math.random() * 3);

        const revealEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor('#f1c40f')
            .setTitle('🎩 Cup Game — Watch Closely!')
            .setDescription(`The ball is under cup **${ballPos + 1}**!\n\n> ${cupsDisplay(ballPos, true)}\n> 1️⃣  ·  2️⃣  ·  3️⃣`)
            .addFields({ name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true })
            .setFooter({ text: 'Watch the ball — shuffling begins soon…' });

        await interaction.editReply({ embeds: [revealEmbed] });
        await delay(1500);

        // Shuffle phase — track ball position through swaps
        const steps = shuffleCount(bet);
        let positions = [0, 1, 2];

        for (let step = 0; step < steps; step++) {
            let a, b;
            do {
                a = Math.floor(Math.random() * 3);
                b = Math.floor(Math.random() * 3);
            } while (a === b);

            // Move the ball if it's in one of the swapped cups
            if (ballPos === a) ballPos = b;
            else if (ballPos === b) ballPos = a;

            positions = swapTwo(positions, a, b);

            const shuffleDisplay = positions.map(pos => CUPS[pos]).join('  ');
            const shuffleEmbed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('🎩 Cup Game — Shuffling…')
                .setDescription(`Swap ${step + 1}/${steps}\n\n> ${shuffleDisplay}\n> 1️⃣  ·  2️⃣  ·  3️⃣`)
                .addFields({ name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true })
                .setFooter({ text: 'Follow the ball!' });

            await interaction.editReply({ embeds: [shuffleEmbed] });
            await delay(600);
        }

        // Prompt the player to pick
        const gameId = `cup_${interaction.id}_${Date.now()}`;
        const pickEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor('#f1c40f')
            .setTitle('🎩 Cup Game — Pick a Cup!')
            .setDescription(`Shuffling done! Where's the ball?\n\n> 🥤  🥤  🥤\n> 1️⃣  ·  2️⃣  ·  3️⃣`)
            .addFields({ name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true })
            .setFooter({ text: 'You have 30 seconds to choose.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cup_1_${gameId}`).setLabel('Cup 1').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`cup_2_${gameId}`).setLabel('Cup 2').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`cup_3_${gameId}`).setLabel('Cup 3').setStyle(ButtonStyle.Primary),
        );

        await interaction.editReply({ embeds: [pickEmbed], components: [row] });

        const msg = await interaction.fetchReply();
        let guess;
        try {
            const response = await msg.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id && i.customId.startsWith('cup_') && i.customId.endsWith(gameId),
                time: 30_000,
            });
            await response.deferUpdate();
            guess = parseInt(response.customId.split('_')[1], 10) - 1; // 0-indexed
        } catch {
            // Timeout — refund and exit
            settled = true;
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } });
            await interaction.editReply({
                content: '⏱️ Time\'s up! Your bet was refunded.',
                embeds: [],
                components: [],
            }).catch(() => {});
            return;
        }

        const won = guess === ballPos;

        const luckyActive      = hasEffect(debited, 'lucky_charm');
        const luckyStreakBonus = getLuckyStreakBonus(debited);
        const coinMult         = getCoinMultiplier(debited);
        const serverMult       = getServerCoinMultiplier(guildSettings);
        const totalCoinMult    = coinMult * serverMult;

        let grossPayout = won ? Math.floor(bet * BASE_WIN_MULT) : 0;
        let charmTriggered = false;
        let streakTriggered = false;

        // Lucky Charm: on loss, 20% chance to return bet
        if (!won && luckyActive && Math.random() < 0.20) {
            grossPayout = bet;
            charmTriggered = true;
        }
        if (!won && !charmTriggered && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
            grossPayout = bet;
            streakTriggered = true;
        }

        let adjustedPayout = grossPayout;
        if (grossPayout > bet && totalCoinMult > 1.0) {
            adjustedPayout = bet + Math.round((grossPayout - bet) * totalCoinMult);
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

        const net    = adjustedPayout - bet;
        const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

        // Reveal all cups
        const revealAll = CUPS.map((cup, i) => i === ballPos ? BALL : cup).join('  ');
        const guessLabel = `Cup ${guess + 1}`;
        const ballLabel  = `Cup ${ballPos + 1}`;

        let color, title, desc;
        if (won) {
            color = '#2ecc71';
            title = '🎩 Correct! You found the ball!';
            desc  = `> ${revealAll}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\n🎉 You picked **${guessLabel}** — the ball was there! **${BASE_WIN_MULT}×** payout!`;
        } else if (charmTriggered || streakTriggered) {
            color = '#f39c12';
            title = '🎩 Wrong Cup — Lucky Save!';
            desc  = `> ${revealAll}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\nYou picked **${guessLabel}** but the ball was under **${ballLabel}**.\n${charmTriggered ? '🍀 **Lucky Charm** returned your bet!' : '🎯 **Lucky Streak** returned your bet!'}`;
        } else {
            color = '#e74c3c';
            title = '🎩 Wrong Cup!';
            desc  = `> ${revealAll}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\nYou picked **${guessLabel}** but the ball was under **${ballLabel}**.`;
        }

        let boostNote = '';
        if (totalCoinMult > 1.0 && adjustedPayout > bet) boostNote = `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied!*`;

        const resultEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor(color)
            .setTitle(title)
            .setDescription(`${desc}${boostNote}`)
            .addFields(
                { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`, inline: true },
                { name: adjustedPayout > 0 ? '🏆 Payout' : '💀 Lost', value: adjustedPayout > 0 ? `${adjustedPayout.toLocaleString()} coins` : `${bet.toLocaleString()} coins`, inline: true },
                { name: '📊 Net',     value: `**${netStr}** coins`, inline: true },
                { name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true },
            )
            .setFooter({ text: `Difficulty: ${steps} shuffles · Win = ${BASE_WIN_MULT}×` })
            .setTimestamp();

        const replayId = `cup_replay_${interaction.id}_${Date.now()}`;
        const replayRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('🎩 Play Again').setStyle(ButtonStyle.Primary),
        );

        await interaction.editReply({ embeds: [resultEmbed], components: [replayRow] });

        const replyMsg = await interaction.fetchReply();
        replyMsg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        }).on('collect', async i => {
            await i.deferUpdate();
            await playCupGame(interaction, bet);
        }).on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[CupGame] error:', err);
        if (debited && !settled) {
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } })
                .catch(e => console.error('[CupGame] rollback failed:', e));
        }
        await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', components: [] }).catch(() => {});
    }
}

module.exports = {
    name: 'cupgame',
    description: 'Shell game — watch the shuffle, pick the cup hiding the ball',
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

        const { shouldProceed: cgProceed, alreadyReplied: cgReplied } = await confirmBet(interaction, bet, user.balance, 'Cup Game', guildSettings);
        if (!cgProceed) return;
        if (!cgReplied) await interaction.deferReply();
        await playCupGame(interaction, bet);
    },
};
