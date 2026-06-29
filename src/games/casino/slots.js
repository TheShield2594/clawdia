const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const User = require('../../models/User');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');
const Guild = require('../../models/Guild');
const { randomFrom, SLOTS_LOSE_LINES, SLOTS_WIN_LINES } = require('../../utils/copyLines');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b0.png';

const SYMBOLS = [
    { emoji: '🍒', name: 'Cherry',   type: 'regular',    weight: 28, payout: 2  },
    { emoji: '🍋', name: 'Lemon',    type: 'regular',    weight: 22, payout: 3  },
    { emoji: '🍇', name: 'Grape',    type: 'regular',    weight: 18, payout: 5  },
    { emoji: '🔔', name: 'Bell',     type: 'regular',    weight: 12, payout: 8  },
    { emoji: '💎', name: 'Diamond',  type: 'regular',    weight: 8,  payout: 15 },
    { emoji: '🌟', name: 'Star',     type: 'regular',    weight: 5,  payout: 25 },
    { emoji: '🃏', name: 'Wild',     type: 'wild',       weight: 4              },
    { emoji: '⚡', name: '2x Boost', type: 'multiplier', weight: 3, multiplier: 2 },
    { emoji: '🌸', name: 'Scatter',  type: 'scatter',    weight: 2              },
];

const HIGH_VALUE_SYMBOLS = ['Bell', 'Diamond', 'Star'];
const WIN_ANNOUNCE_MULT  = 50;

const TOTAL_WEIGHT      = SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
const SPIN_POOL         = SYMBOLS.filter(s => s.type === 'regular' || s.type === 'wild');
const JACKPOT_SEED      = 5000;
const JACKPOT_CONTRIB   = 10;

function spinReel() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (const s of SYMBOLS) {
        r -= s.weight;
        if (r <= 0) return s;
    }
    return SYMBOLS[0];
}

function randomEmoji() {
    return SPIN_POOL[Math.floor(Math.random() * SPIN_POOL.length)].emoji;
}

function reelDisplay(reels, revealed) {
    return reels.map((s, i) => i < revealed ? s.emoji : randomEmoji()).join('  ┃  ');
}

function evaluate(reels, bet) {
    const regulars   = reels.filter(s => s.type === 'regular');
    const wilds      = reels.filter(s => s.type === 'wild');
    const mults      = reels.filter(s => s.type === 'multiplier');
    const scatters   = reels.filter(s => s.type === 'scatter');
    const wildCount  = wilds.length;
    const multFactor = mults.reduce((acc, m) => acc * m.multiplier, 1);

    if (wildCount === 3)
        return { payout: 0, outcome: 'jackpot', symbol: null, wildCount, multFactor, scatterCount: 0 }; // payout filled in by caller
    if (mults.length === 3)
        return { payout: bet * 4, outcome: 'mult3', symbol: null, wildCount, multFactor, scatterCount: 0 };

    // Scatter: 2+ triggers free spins (resolved in caller)
    if (scatters.length >= 2)
        return { payout: 0, outcome: 'scatter', symbol: null, wildCount, multFactor, scatterCount: scatters.length };

    if (regulars.length > 0) {
        const freq = {};
        for (const s of regulars) freq[s.name] = (freq[s.name] || 0) + 1;
        const [topName, topCount] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
        const effective = topCount + wildCount;
        const sym = SYMBOLS.find(s => s.name === topName);

        if (effective >= 3)
            return { payout: bet * sym.payout * multFactor, outcome: 'three', symbol: sym, wildCount, multFactor, scatterCount: 0 };
        if (effective === 2)
            return { payout: Math.floor(bet * sym.payout * 0.5 * multFactor), outcome: 'two', symbol: sym, wildCount, multFactor, scatterCount: 0 };
    }

    return { payout: 0, outcome: 'lose', symbol: null, wildCount, multFactor, scatterCount: 0 };
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function spinEmbed(display, bet, stage, interaction, jackpotPool) {
    const statuses = [
        '🎰 **Spinning all reels…**',
        '🔒 **First reel locked!** Spinning remaining…',
        '🔒🔒 **Two reels locked!** Last one spinning…',
    ];
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#FFD700')
        .setTitle('🎰 Slot Machine')
        .setDescription(`${statuses[stage]}\n\n> **[ ${display} ]**`)
        .addFields(
            { name: '💰 Bet',            value: `**${bet.toLocaleString()}** coins`,          inline: true },
            { name: '🎲 Status',         value: `Reel ${stage}/3 locked`,                     inline: true },
            { name: '🏆 Current Jackpot', value: `**${jackpotPool.toLocaleString()}** coins`, inline: true },
        );
}

function resultEmbed(reels, result, bet, balance, interaction, jackpotPool) {
    const { payout, outcome, symbol, wildCount, multFactor } = result;
    const display = reels.map(s => s.emoji).join('  ┃  ');
    const net     = payout - bet;
    const netStr  = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

    const cfg = {
        jackpot: { color: '#FF00FF', title: '🎰 ✨ J A C K P O T ✨ 🎰', line: '🃏🃏🃏 **TRIPLE WILD — JACKPOT!** 🎉🎊🎉\n*The reels went absolutely wild!*' },
        mult3:   { color: '#00FFFF', title: '🎰 ⚡ Triple Boost! ⚡',     line: `⚡⚡⚡ **TRIPLE MULTIPLIER BONUS!**\n*${randomFrom(SLOTS_WIN_LINES)}*` },
        three:   { color: '#00FF00', title: `🎰 🏆 Three ${symbol?.name ?? ''}s!`, line: `${symbol?.emoji.repeat(3)} **THREE OF A KIND!**\n*${randomFrom(SLOTS_WIN_LINES)}*` },
        two:     { color: '#FFAA00', title: '🎰 Two of a Kind',           line: `${symbol?.emoji.repeat(2)} **Two ${symbol?.name ?? ''}s** — partial win!\n*${randomFrom(SLOTS_WIN_LINES)}*` },
        push:    { color: '#f39c12', title: '🎰 🎯 Lucky Streak Fired!',   line: '🎯 **Your Lucky Streak fired!** Bet returned — spin again!' },
        scatter: { color: '#ff69b4', title: '🌸 Scatter — Free Spins!',   line: '🌸 **Scatter symbols triggered!** Free spins incoming…' },
        lose:    { color: '#FF4444', title: '🎰 No Match',                line: `💨 *${randomFrom(SLOTS_LOSE_LINES)}*` },
    };
    const { color, title, line } = cfg[outcome] ?? cfg.lose;

    let extras = '';
    if (wildCount > 0 && outcome !== 'jackpot') extras += '\n> 🃏 *Wild card assisted!*';
    if (multFactor > 1 && outcome !== 'mult3')  extras += `\n> ⚡ *${multFactor}x Boost applied!*`;

    const payoutVal = payout > 0 ? payout : bet;
    const payoutLabel = payout > 0 ? '🏆 Payout' : '💀 Lost';
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `> **[ ${display} ]**\n\n${line}${extras}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `  💸 Bet: ${bet.toLocaleString()}  ·  ${payoutLabel}: ${payoutVal.toLocaleString()}  ·  📊 Net: **${netStr}**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━`
        )
        .addFields(
            { name: '💰 Balance',      value: `**${balance.toLocaleString()}** coins`,      inline: true },
            { name: '🏆 Jackpot Pool', value: `**${jackpotPool.toLocaleString()}** coins`, inline: true },
        )
        .setFooter({ text: '🃏 Wild substitutes for any symbol  •  ⚡ Boost multiplies your win' })
        .setTimestamp();
}

function jackpotBroadcastEmbed(interaction, wonAmount, newPool) {
    return new EmbedBuilder()
        .setColor('#FF00FF')
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .setDescription(
            `🎰 ━━━━━━━━━━━━━━━━━━━━━━━ 🎰\n` +
            `　　　**J A C K P O T**\n` +
            `🎰 ━━━━━━━━━━━━━━━━━━━━━━━ 🎰\n\n` +
            `${interaction.user} just hit **TRIPLE WILD** 🃏🃏🃏\n` +
            `and walked away with the entire pool.\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `  💰 Won: **${wonAmount.toLocaleString()}** coins\n` +
            `  🔄 New pool: **${newPool.toLocaleString()}** coins\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `> Think you can be next?`
        )
        .setTimestamp();
}

function paytableEmbed() {
    return new EmbedBuilder()
        .setColor('#FFD700')
        .setThumbnail(THUMB)
        .setTitle('🎰 Slot Machine — Paytable')
        .setDescription('Match **3 symbols** (or **2 + a Wild 🃏**) to win!\n⚡ Boost on any reel multiplies your payout.\n​')
        .addFields(
            { name: '🍒 Cherry',   value: '**2×** your bet',   inline: true },
            { name: '🍋 Lemon',    value: '**3×** your bet',   inline: true },
            { name: '🍇 Grape',    value: '**5×** your bet',   inline: true },
            { name: '🔔 Bell',     value: '**8×** your bet',   inline: true },
            { name: '💎 Diamond',  value: '**15×** your bet',  inline: true },
            { name: '🌟 Star',     value: '**25×** your bet',  inline: true },
            { name: '​', value: '​', inline: false },
            { name: '🃏🃏🃏 Triple Wild', value: '🏆 **JACKPOT — wins the pool** (seeds at 5,000)', inline: true },
            { name: '⚡⚡⚡ Triple Boost', value: '**4× bet**', inline: true },
            { name: 'Two of a Kind', value: 'Half of the 3-of-a-kind payout', inline: false },
            { name: '🌸🌸 Two Scatters', value: '**3 free spins** (no bet deducted)', inline: true },
            { name: '🌸🌸🌸 Three Scatters', value: '**5 free spins** with **1.5× multiplier**', inline: true },
            { name: '🔥 Hot Reel', value: 'After 3 losses in a row, reel 1 locks to a high-value symbol', inline: false },
        )
        .setFooter({ text: 'Two-of-a-kind pays 50% of the three-of-a-kind rate for that symbol' });
}

module.exports = {
    name: 'slots',
    description: 'Spin the slot machine and try your luck!',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription('Amount of coins to bet (min 10)')
                .setMinValue(10)
                .setMaxValue(1_000_000_000)
                .setRequired(true)),
    async execute(interaction, { releaseLock } = {}) {
        const bet           = interaction.options.getInteger('bet');
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const casinoMaxBet  = guildSettings?.economy?.casinoMaxBet ?? 0;
        if (casinoMaxBet > 0 && bet > casinoMaxBet) {
            releaseLock?.();
            return interaction.reply({ content: `❌ The casino bet limit on this server is **${casinoMaxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const wallet = user?.balance ?? 0;
        const { shouldProceed: slProceed, alreadyReplied: slReplied } = await confirmBet(interaction, bet, wallet, 'Slots');
        if (!slProceed) { releaseLock?.(); return; }
        if (!slReplied) await interaction.deferReply();
        await playSlots(interaction, bet, releaseLock);
    },
};

// releaseLock is called once the spin settles into a result — "Spin Again"
// starts a brand-new hand with its own atomic debit, so it doesn't need the
// lock re-held.
async function playSlots(interaction, bet, releaseLock) {
    const userFilter  = { userId: interaction.user.id, guildId: interaction.guild.id };
    const guildFilter = { guildId: interaction.guild.id };
    try {
        const [userDoc, guildSettings] = await Promise.all([
            User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ),
            // Ensure slots.jackpotPool exists on the document before we try to match it
            Guild.findOneAndUpdate(
                { ...guildFilter, 'slots.jackpotPool': { $exists: false } },
                { $set: { 'slots.jackpotPool': JACKPOT_SEED } },
                { new: false }
            ).then(() => Guild.findOne(guildFilter)),
        ]);

        const luckyActive      = hasEffect(userDoc, 'lucky_charm');
        const luckyStreakBonus = getLuckyStreakBonus(userDoc);
        const coinMult         = getCoinMultiplier(userDoc);
        const serverMult       = getServerCoinMultiplier(guildSettings);
        const totalCoinMult    = coinMult * serverMult;

        // ── Debit the bet FIRST, before any pool mutations ─────────────────
        const debited = await User.findOneAndUpdate(
            { ...userFilter, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true }
        );
        if (!debited) {
            releaseLock?.();
            const fresh = await User.findOne(userFilter);
            return interaction.editReply({
                content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                embeds: [], components: [],
            });
        }

        // Read current jackpot pool snapshot (after guaranteed initialization above)
        const jackpotPool = guildSettings?.slots?.jackpotPool ?? JACKPOT_SEED;

        // ── Hot Reel mechanic: after 3 consecutive losses, lock reel 1 ────────
        const lossStreak = userDoc.casinoStats?.slotsLossStreak ?? 0;
        const hotReelTriggered = lossStreak >= 3;

        let reels = [spinReel(), spinReel(), spinReel()];
        if (hotReelTriggered) {
            const hotPool = SYMBOLS.filter(s => HIGH_VALUE_SYMBOLS.includes(s.name));
            reels[0] = hotPool[Math.floor(Math.random() * hotPool.length)];
        }

        let result = evaluate(reels, bet);
        let charmTriggered = false;

        // Lucky Charm: on loss, 20% chance to re-spin (low-stakes bets only)
        const luckySavable = luckySaveEligible(bet);
        if (result.outcome === 'lose' && luckySavable && luckyActive && Math.random() < 0.20) {
            reels  = [spinReel(), spinReel(), spinReel()];
            result = evaluate(reels, bet);
            charmTriggered = true;
        }
        // Lucky Streak: on remaining loss, convert to a push (bet returned)
        if (result.outcome === 'lose' && luckySavable && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
            result = { ...result, outcome: 'push', payout: bet };
        }

        // ── Jackpot / pool update (bet already charged) ────────────────────
        let finalJackpotPool = jackpotPool;
        let jackpotWon = false;

        if (result.outcome === 'jackpot') {
            // Atomically swap the pool for the seed and pay out whatever was in it.
            // findOneAndUpdate returns the pre-update document, so two concurrent
            // winners settle cleanly: the first takes the accumulated pool, the
            // second takes the fresh seed — nothing is minted, nobody gets zero.
            const claimed = await Guild.findOneAndUpdate(
                guildFilter,
                {
                    $set: {
                        'slots.jackpotPool':       JACKPOT_SEED,
                        'slots.lastJackpotWinner': interaction.user.id,
                        'slots.lastJackpotAt':     new Date(),
                    }
                },
                { new: false }
            );
            const claimedAmount = claimed?.slots?.jackpotPool ?? JACKPOT_SEED;
            Guild.updateOne(guildFilter, { $set: { 'slots.lastJackpotAmount': claimedAmount } }).catch(() => {});
            result = { ...result, payout: claimedAmount };
            finalJackpotPool = JACKPOT_SEED;
            jackpotWon = true;
        } else {
            await Guild.updateOne(guildFilter, { $inc: { 'slots.jackpotPool': JACKPOT_CONTRIB } });
            finalJackpotPool = jackpotPool + JACKPOT_CONTRIB;
        }

        // ── Handle scatter free spins ───────────────────────────────────────────
        let freeSpinCount = 0;
        let freeSpinMult  = 1;
        if (result.outcome === 'scatter') {
            freeSpinCount = result.scatterCount >= 3 ? 5 : 3;
            freeSpinMult  = result.scatterCount >= 3 ? 1.5 : 1;
        }

        // ── Update loss streak ──────────────────────────────────────────────────
        const isWin = result.outcome !== 'lose';
        const newStreak = isWin || hotReelTriggered ? 0 : lossStreak + 1;
        await User.updateOne(userFilter, { $set: { 'casinoStats.slotsLossStreak': newStreak } }).catch(() => {});

        // Apply coin booster to payout (net profit portion only)
        let adjustedPayout = result.payout;
        if (result.payout > 0 && totalCoinMult > 1.0) {
            adjustedPayout = bet + Math.round((result.payout - bet) * totalCoinMult);
        }

        // Credit the payout (bet already debited above)
        let user = await User.findOneAndUpdate(
            userFilter,
            { $inc: { balance: adjustedPayout } },
            { new: true }
        );
        releaseLock?.();

        const delay = ms => new Promise(r => setTimeout(r, ms));

        await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 0), bet, 0, interaction, jackpotPool)], components: [] });
        await delay(800);
        await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 1), bet, 1, interaction, jackpotPool)] });
        await delay(800);
        await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 2), bet, 2, interaction, jackpotPool)] });
        await delay(800);

        // If jackpot won, post the broadcast embed before the winner sees their result
        if (jackpotWon && (guildSettings?.slots?.announceJackpot ?? true)) {
            const pingHere       = guildSettings?.slots?.jackpotPingHere ?? false;
            const jackpotChanId  = guildSettings?.slots?.jackpotChannelId ?? null;
            const targetChannel  = jackpotChanId
                ? (interaction.guild?.channels?.cache?.get(jackpotChanId) ?? interaction.channel)
                : interaction.channel;
            await targetChannel?.send({
                content: pingHere ? '@here' : undefined,
                embeds: [jackpotBroadcastEmbed(interaction, jackpotPool, JACKPOT_SEED)],
            }).catch(err => console.error(`[Slots] jackpot broadcast failed — channel:${targetChannel?.id} interaction:${interaction.id}`, err));
        }

        // ── Scatter: play free spins automatically ──────────────────────────────
        if (freeSpinCount > 0) {
            let freeTotalPayout = 0;
            const freeResults = [];
            for (let fs = 0; fs < freeSpinCount; fs++) {
                const freeReels = [spinReel(), spinReel(), spinReel()];
                const freeResult = evaluate(freeReels, bet);
                // Triple wilds in a free spin pay a flat mega-win — the progressive
                // pool is only claimable on paid spins (evaluate leaves payout at 0).
                if (freeResult.outcome === 'jackpot') freeResult.payout = bet * 25;
                const freePayout = Math.round(freeResult.payout * freeSpinMult);
                freeTotalPayout += freePayout;
                freeResults.push({ reels: freeReels, payout: freePayout, outcome: freeResult.outcome });
            }
            if (freeTotalPayout > 0) {
                user = await User.findOneAndUpdate(
                    userFilter,
                    { $inc: { balance: freeTotalPayout } },
                    { new: true }
                );
            }
            const freeResultLines = freeResults.map((fr, i) =>
                `Spin ${i + 1}: ${fr.reels.map(r => r.emoji).join(' ')} → **+${fr.payout.toLocaleString()}**`
            ).join('\n');
            const scatterEmbed = new EmbedBuilder()
                .setColor('#ff69b4')
                .setTitle(`🌸 Free Spins Complete! (${freeSpinCount} spins${freeSpinMult > 1 ? ` · ${freeSpinMult}×` : ''})`)
                .setDescription(freeResultLines)
                .addFields(
                    { name: '🎁 Free Spin Total', value: `**+${freeTotalPayout.toLocaleString()}** coins`, inline: true },
                    { name: '💰 Balance',          value: `**${(user?.balance ?? 0).toLocaleString()}** coins`, inline: true },
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [scatterEmbed], components: [] });
            await delay(2000);
        }

        // ── Big win announcement ────────────────────────────────────────────────
        const winMult = adjustedPayout > 0 ? adjustedPayout / bet : 0;
        if (winMult >= WIN_ANNOUNCE_MULT && !jackpotWon) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId ?? null;
            if (announceChannelId) {
                const bigWinEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setDescription(
                        `🎰 ${interaction.user} just hit a **${winMult.toFixed(0)}× ${result.symbol?.name ?? 'win'}** on slots for **${adjustedPayout.toLocaleString()} coins**!`
                    )
                    .setTimestamp();
                const ch = interaction.guild?.channels?.cache?.get(announceChannelId);
                if (ch?.isTextBased?.()) ch.send({ embeds: [bigWinEmbed] }).catch(() => {});
            }
        }

        const replayId   = `slots_replay_${interaction.id}_${Date.now()}`;
        const paytableId = `slots_pay_${interaction.id}_${Date.now()}`;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('🎰 Spin Again').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(paytableId).setLabel('📊 Paytable').setStyle(ButtonStyle.Secondary),
        );

        const finalEmbed = resultEmbed(reels, { ...result, payout: adjustedPayout }, bet, user?.balance ?? 0, interaction, finalJackpotPool);
        if (hotReelTriggered) {
            const desc = finalEmbed.data.description ?? '';
            finalEmbed.setDescription(desc + '\n> 🔥 *Hot Reel activated — first reel was locked to a high-value symbol!*');
        }
        if (charmTriggered) {
            const desc = finalEmbed.data.description ?? '';
            finalEmbed.setDescription(desc + '\n> 🍀 *Lucky Charm gave you a second chance!*');
        }
        if (totalCoinMult > 1.0 && adjustedPayout > bet) {
            const desc = finalEmbed.data.description ?? '';
            finalEmbed.setDescription(desc + `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied to winnings!*`);
        }
        await interaction.editReply({
            embeds: [finalEmbed],
            components: [row],
        });

        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && [replayId, paytableId].includes(i.customId),
            time: 60_000,
        });

        collector.on('collect', async i => {
            if (i.customId === paytableId) {
                await i.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
                return;
            }
            collector.stop('replay');
            await i.deferUpdate();
            await playSlots(interaction, bet, null);
        });

        collector.on('end', (_, reason) => {
            if (reason !== 'replay') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Slots] error:', err);
        releaseLock?.();
        await interaction.editReply({ content: 'An error occurred while playing slots. Please try again.', components: [] }).catch(() => {});
    }
}
