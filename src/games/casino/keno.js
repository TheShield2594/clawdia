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

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b1.png';
const MIN_BET = 10;
const MAX_BET = 5000;

const POOL_SIZE  = 40;
const PICK_COUNT = 5;
const DRAW_COUNT = 10;

// Approximate RTP ~78% (hypergeometric: P2≈27.8%, P3≈7.9%, P4≈0.96%, P5≈0.038%)
// EV = 0.278×1 + 0.079×4 + 0.0096×15 + 0.00038×100 ≈ 0.778
const PAYOUTS = { 2: 1, 3: 4, 4: 15, 5: 100 };

function drawNumbers() {
    const pool = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, DRAW_COUNT).sort((a, b) => a - b);
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

function formatNumbers(picked, drawn, revealed) {
    return drawn.slice(0, revealed).map(n => {
        const hit = picked.includes(n);
        return hit ? `**[${n}]**` : `${n}`;
    }).join('  ');
}

async function playKeno(interaction, bet, picked) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let debited = null;
    let settled = false;

    try {
        const [guildSettings] = await Promise.all([
            Guild.findOne({ guildId: interaction.guild.id }),
        ]);

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

        const drawn = drawNumbers();
        const delay = ms => new Promise(r => setTimeout(r, ms));

        const pickedStr = picked.map(n => `**${n}**`).join('  ');

        // Reveal numbers one by one
        for (let i = 1; i <= DRAW_COUNT; i++) {
            const hits = drawn.slice(0, i).filter(n => picked.includes(n)).length;
            const embed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor('#5865F2')
                .setTitle('🎱 Keno — Drawing Numbers')
                .addFields(
                    { name: '🎯 Your Numbers', value: pickedStr, inline: false },
                    { name: `🔵 Drawn (${i}/${DRAW_COUNT})`, value: formatNumbers(picked, drawn, i) || '…', inline: false },
                    { name: '✅ Matches', value: `**${hits}** / ${PICK_COUNT}`, inline: true },
                    { name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true },
                )
                .setFooter({ text: `2 matches = 1× · 3 = 4× · 4 = 15× · 5 = 100×` });
            await interaction.editReply({ embeds: [embed] });
            await delay(800);
        }

        const matches = drawn.filter(n => picked.includes(n)).length;
        const multiplier = PAYOUTS[matches] ?? 0;

        const luckyActive      = hasEffect(debited, 'lucky_charm');
        const luckyStreakBonus = getLuckyStreakBonus(debited);
        const coinMult         = getCoinMultiplier(debited);
        const serverMult       = getServerCoinMultiplier(guildSettings);
        const totalCoinMult    = coinMult * serverMult;

        let grossPayout = multiplier > 0 ? bet * multiplier : 0;

        // Lucky Charm: on loss/no match, 20% chance to give bet back
        let charmTriggered = false;
        if (grossPayout === 0 && luckyActive && Math.random() < 0.20) {
            grossPayout = bet;
            charmTriggered = true;
        }

        // Lucky Streak: convert remaining losses
        let streakTriggered = false;
        if (grossPayout === 0 && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
            grossPayout = bet;
            streakTriggered = true;
        }

        // Apply coin multiplier to net profit only
        let adjustedPayout = grossPayout;
        if (grossPayout > bet && totalCoinMult > 1.0) {
            adjustedPayout = bet + Math.round((grossPayout - bet) * totalCoinMult);
        }

        const credit = adjustedPayout;
        let updated = debited;
        if (credit > 0) {
            updated = await User.findOneAndUpdate(
                userFilter,
                { $inc: { balance: credit } },
                { new: true }
            );
        }
        settled = true;

        const net    = credit - bet;
        const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

        let color, title, desc;
        if (matches === 5) {
            color = '#FF00FF'; title = '🎱 ✨ PERFECT MATCH ✨';
            desc  = '🎯🎯🎯🎯🎯 **All 5 numbers matched! Incredible!**';
        } else if (matches === 4) {
            color = '#00FF00'; title = '🎱 4 Matches — Big Win!';
            desc  = '🎯🎯🎯🎯 **Four matches — massive payout!**';
        } else if (matches === 3) {
            color = '#FFAA00'; title = '🎱 3 Matches — Winner!';
            desc  = '🎯🎯🎯 **Three matches — you won!**';
        } else if (matches === 2) {
            color = '#f39c12'; title = '🎱 2 Matches — Bet Returned!';
            desc  = '🎯🎯 **Two matches — your bet is back!**';
        } else if (charmTriggered || streakTriggered) {
            color = '#f39c12'; title = '🎱 Lucky Save!';
            desc  = charmTriggered ? '🍀 **Lucky Charm** returned your bet!' : '🎯 **Lucky Streak** returned your bet!';
        } else {
            color = '#e74c3c'; title = `🎱 ${matches} Match${matches !== 1 ? 'es' : ''} — No Win`;
            desc  = matches > 0 ? `You matched ${matches} — need 3+ to win.` : '💨 No matches this time.';
        }

        const drawnStr = drawn.map(n => picked.includes(n) ? `**[${n}]**` : `${n}`).join('  ');
        let boostNote = '';
        if (totalCoinMult > 1.0 && adjustedPayout > bet) boostNote = `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied!*`;

        const resultEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor(color)
            .setTitle(title)
            .setDescription(`${desc}${boostNote}`)
            .addFields(
                { name: '🎯 Your Numbers', value: pickedStr, inline: false },
                { name: `🔵 Drawn Numbers`, value: drawnStr, inline: false },
                { name: '✅ Matches', value: `**${matches}** / ${PICK_COUNT}`, inline: true },
                { name: '💰 Bet',     value: `**${bet.toLocaleString()}** coins`, inline: true },
                { name: credit > 0 ? '🏆 Payout' : '💀 Lost', value: credit > 0 ? `${adjustedPayout.toLocaleString()} coins` : `${bet.toLocaleString()} coins`, inline: true },
                { name: '📊 Net',     value: `**${netStr}** coins`, inline: true },
                { name: '💰 Balance', value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`, inline: true },
            )
            .setFooter({ text: '3 matches = 3× · 4 matches = 10× · 5 matches = 50×' })
            .setTimestamp();

        const replayId = `keno_replay_${interaction.id}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('🎱 Play Again').setStyle(ButtonStyle.Primary),
        );

        await interaction.editReply({ embeds: [resultEmbed], components: [row] });

        const msg = await interaction.fetchReply();
        msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        }).on('collect', async i => {
            await i.deferUpdate();
            await playKeno(interaction, bet, picked);
        }).on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Keno] error:', err);
        if (debited && !settled) {
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } })
                .catch(e => console.error('[Keno] rollback failed:', e));
        }
        await interaction.editReply({ content: 'Something went wrong. Your wager was refunded.', components: [] }).catch(() => {});
    }
}

module.exports = {
    name: 'keno',
    description: 'Pick 5 numbers from 1–40 and match the draw for big payouts',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (${MIN_BET}–${MAX_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET))
        .addStringOption(opt =>
            opt.setName('numbers')
                .setDescription('Your 5 numbers from 1–40, space-separated (e.g. 3 12 21 33 39)')
                .setRequired(true)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            return interaction.reply({ content: 'Casino games are disabled on this server.', ephemeral: true });
        }

        const bet        = interaction.options.getInteger('bet');
        const numbersRaw = interaction.options.getString('numbers');

        const parsed = numbersRaw.trim().split(/\s+/).map(Number);
        const valid  = parsed.every(n => Number.isInteger(n) && n >= 1 && n <= POOL_SIZE);

        if (parsed.length !== PICK_COUNT || !valid) {
            return interaction.reply({
                content: `❌ Please provide exactly **5 different numbers** between 1 and ${POOL_SIZE}.\nExample: \`3 12 21 33 39\``,
                ephemeral: true,
            });
        }

        const uniquePicked = [...new Set(parsed)];
        if (uniquePicked.length !== PICK_COUNT) {
            return interaction.reply({ content: '❌ All 5 numbers must be different.', ephemeral: true });
        }

        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if ((user?.balance ?? 0) < bet) {
            const currency = guildSettings?.economy?.currency || '💰';
            return interaction.reply({
                content: `You don't have enough ${currency}. Your balance: **${currency}${(user?.balance ?? 0).toLocaleString()}**`,
                ephemeral: true,
            });
        }

        const { shouldProceed: knProceed, alreadyReplied: knReplied } = await confirmBet(interaction, bet, user.balance, 'Keno', guildSettings);
        if (!knProceed) return;
        if (!knReplied) await interaction.deferReply();
        await playKeno(interaction, bet, uniquePicked.sort((a, b) => a - b));
    },
};
