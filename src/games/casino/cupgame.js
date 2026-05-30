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

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0db.png';
const MIN_BET = 10;
const MAX_BET = 5000;

const QUEEN  = '🂽';  // Queen of hearts (face up)
const DECOYS = ['🂡', '🂱']; // Ace of spades, Ace of hearts (decoys)
const HIDDEN = '🂠';  // Card back

// Win multiplier: 1/3 chance × 2.8 ≈ 93% RTP
const BASE_WIN_MULT = 2.8;

// Shuffle steps scale with bet size
function shuffleCount(bet) {
    if (bet >= 2500) return 8;
    if (bet >= 1000) return 6;
    if (bet >= 500)  return 5;
    return 4;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

// Build a face-up display from final queen position
function buildReveal(queenPos) {
    let di = 0;
    return [0, 1, 2].map(i => i === queenPos ? QUEEN : DECOYS[di++]);
}

async function playMonte(interaction, bet) {
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

        // Place the Queen at a random starting position
        let queenPos = Math.floor(Math.random() * 3);
        const initialCards = buildReveal(queenPos);

        // Show cards face-up so player can see the Queen
        const revealEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor('#f1c40f')
            .setTitle('🃏 Three Card Monte — Watch the Queen!')
            .setDescription(
                `The **Queen** is at position **${queenPos + 1}**!\n\n` +
                `> ${initialCards.join('   ')}\n` +
                `> 1️⃣  ·  2️⃣  ·  3️⃣`,
            )
            .addFields({ name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true })
            .setFooter({ text: 'Watch the Queen — shuffling begins soon…' });

        await interaction.editReply({ embeds: [revealEmbed] });
        await delay(1800);

        // Flip all cards face-down
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('🃏 Three Card Monte — Cards Flipped!')
                .setDescription(
                    `Cards are now face down — follow the Queen!\n\n` +
                    `> ${HIDDEN}   ${HIDDEN}   ${HIDDEN}\n` +
                    `> 1️⃣  ·  2️⃣  ·  3️⃣`,
                )
                .addFields({ name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true })
                .setFooter({ text: 'Shuffling begins…' })],
        });
        await delay(700);

        // Shuffle phase — show each swap
        const steps = shuffleCount(bet);

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
                    .setColor('#5865F2')
                    .setTitle('🃏 Three Card Monte — Shuffling…')
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

        // Tell mechanic: 40% chance a subtle cosmetic hint appears.
        // The hint card is chosen randomly (1/3 chance it's the actual queen).
        // This creates psychological tension without mechanically skewing the odds.
        const tellCard = Math.floor(Math.random() * 3);
        const tellText = Math.random() < 0.40
            ? `\n\n👁️ *You notice card **${tellCard + 1}** seems slightly warped…*`
            : '';

        // Prompt the player to pick
        const gameId = `monte_${interaction.id}_${Date.now()}`;

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#f1c40f')
                .setTitle('🃏 Three Card Monte — Find the Queen!')
                .setDescription(
                    `Shuffling done! Where's the Queen?${tellText}\n\n` +
                    `> ${HIDDEN}   ${HIDDEN}   ${HIDDEN}\n` +
                    `> 1️⃣  ·  2️⃣  ·  3️⃣`,
                )
                .addFields(
                    { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`,                    inline: true },
                    { name: '🏆 Win Pays', value: `**${Math.floor(bet * BASE_WIN_MULT).toLocaleString()}** coins`, inline: true },
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
                filter: i => i.user.id === interaction.user.id && i.customId.startsWith('monte_') && i.customId.endsWith(gameId),
                time: 30_000,
            });
            await resp.deferUpdate();
            guess = parseInt(resp.customId.split('_')[1], 10) - 1; // 0-indexed
        } catch {
            settled = true;
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } });
            return interaction.editReply({ content: '⏱️ Time\'s up! Your bet was refunded.', embeds: [], components: [] }).catch(() => {});
        }

        const won = guess === queenPos;

        const luckyActive      = hasEffect(debited, 'lucky_charm');
        const luckyStreakBonus = getLuckyStreakBonus(debited);
        const coinMult         = getCoinMultiplier(debited);
        const serverMult       = getServerCoinMultiplier(guildSettings);
        const totalCoinMult    = coinMult * serverMult;

        let grossPayout     = won ? Math.floor(bet * BASE_WIN_MULT) : 0;
        let charmTriggered  = false;
        let streakTriggered = false;

        if (!won && luckyActive && Math.random() < 0.20) {
            grossPayout    = bet;
            charmTriggered = true;
        }
        if (!won && !charmTriggered && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
            grossPayout     = bet;
            streakTriggered = true;
        }

        let adjustedPayout = grossPayout;
        if (grossPayout > bet && totalCoinMult > 1.0) {
            adjustedPayout = bet + Math.round((grossPayout - bet) * totalCoinMult);
        }

        let updated = debited;
        if (adjustedPayout > 0) {
            updated = await User.findOneAndUpdate(userFilter, { $inc: { balance: adjustedPayout } }, { new: true });
        }
        settled = true;

        const net    = adjustedPayout - bet;
        const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;
        const reveal = buildReveal(queenPos);

        let color, title, desc;
        if (won) {
            color = '#2ecc71';
            title = '🃏 Correct! You found the Queen!';
            desc  = `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\n🎉 You picked **Card ${guess + 1}** — the Queen was there! **${BASE_WIN_MULT}×** payout!`;
        } else if (charmTriggered || streakTriggered) {
            color = '#f39c12';
            title = '🃏 Wrong Card — Lucky Save!';
            desc  = `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\nYou picked **Card ${guess + 1}** but the Queen was at **Card ${queenPos + 1}**.\n${charmTriggered ? '🍀 **Lucky Charm** returned your bet!' : '🎯 **Lucky Streak** returned your bet!'}`;
        } else {
            color = '#e74c3c';
            title = '🃏 Wrong Card!';
            desc  = `> ${reveal.join('   ')}\n> 1️⃣  ·  2️⃣  ·  3️⃣\n\nYou picked **Card ${guess + 1}** but the Queen was at **Card ${queenPos + 1}**.`;
        }

        if (totalCoinMult > 1.0 && adjustedPayout > bet) desc += `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied!*`;

        const replayId = `monte_replay_${interaction.id}_${Date.now()}`;

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(color)
                .setTitle(title)
                .setDescription(desc)
                .addFields(
                    { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`, inline: true },
                    { name: adjustedPayout > 0 ? '🏆 Payout' : '💀 Lost', value: adjustedPayout > 0 ? `${adjustedPayout.toLocaleString()} coins` : `${bet.toLocaleString()} coins`, inline: true },
                    { name: '📊 Net',     value: `**${netStr}** coins`,                inline: true },
                    { name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true },
                )
                .setFooter({ text: `${steps} shuffles · Queen odds 1-in-3 · ${BASE_WIN_MULT}× payout` })
                .setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(replayId).setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary),
            )],
        });

        const replyMsg = await interaction.fetchReply();
        replyMsg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        }).on('collect', async i => {
            await i.deferUpdate();
            await playMonte(interaction, bet);
        }).on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Monte] error:', err);
        if (debited && !settled) {
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } })
                .catch(e => console.error('[Monte] rollback failed:', e));
        }
        await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', components: [] }).catch(() => {});
    }
}

module.exports = {
    name: 'cupgame',
    description: 'Three Card Monte — follow the Queen through the shuffle and find her!',
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

        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, user.balance, 'Three Card Monte', guildSettings);
        if (!shouldProceed) return;
        if (!alreadyReplied) await interaction.deferReply();
        await playMonte(interaction, bet);
    },
};
