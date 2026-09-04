const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const User = require('../../models/User');
const { placeWager } = require('../../utils/placeWager');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');
const Guild = require('../../models/Guild');
const { randomFrom, SLOTS_LOSE_LINES, SLOTS_WIN_LINES } = require('../../utils/copyLines');
const { claimJackpot, DEFAULT_SEED: JACKPOT_SEED } = require('../../services/casinoJackpotService');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
const {
    SYMBOLS,
    HIGH_VALUE_SYMBOLS,
    FREE_SPIN_JACKPOT_MULT,
    spinReel,
    randomEmoji,
    evaluate,
} = require('./slotsReels');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b0.png';

const WIN_ANNOUNCE_MULT = 50;

// The jackpot slots plays for is the shared progressive pool
// (services/casinoJackpotService) — the same one `/casino jackpot` reports and
// every casino bet feeds at 0.5%. Slots keeps no pool of its own; a Triple Wild is
// simply a second, rarer way to claim this one. FREE_SPIN_JACKPOT_MULT is what a
// Triple Wild pays when there is no pool to claim: on a free spin (which staked
// nothing), or in a guild with no document and so no accumulated pot. A claim
// that succeeded and has not been credited yet is *not* one of those — the pot
// is the player's and is being recovered under its payout key, so paying this
// on top would pay the same Triple Wild twice (#873).

function reelDisplay(reels, revealed) {
    return reels.map((s, i) => i < revealed ? s.emoji : randomEmoji()).join('  ┃  ');
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
        .setColor(COLORS.PRIZE)
        .setTitle('🎰 Slot Machine')
        .setDescription(`${statuses[stage]}\n\n> **[ ${display} ]**`)
        .addFields(
            { name: '💰 Bet',            value: `**${bet.toLocaleString()}** coins`,          inline: true },
            { name: '🎲 Status',         value: `Reel ${stage}/3 locked`,                     inline: true },
            { name: '🏆 Progressive Jackpot', value: `**${jackpotPool.toLocaleString()}** coins`, inline: true },
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
            { name: '🏆 Progressive Jackpot', value: `**${jackpotPool.toLocaleString()}** coins`, inline: true },
        )
        .setFooter({ text: '🃏 Wild substitutes for any symbol  •  ⚡ Boost multiplies your win' })
        .setTimestamp();
}

/**
 * The channel-wide announcement of a Triple Wild.
 *
 * `delivery` is the claim's outcome, and it is what makes the channel hear the
 * same thing the winner does: this embed used to say the player "walked away
 * with the entire pool" whatever became of the credit, so a pot that had not
 * arrived was announced as paid to everyone while the winner's own result embed
 * said otherwise (#873).
 *
 * @param {object} interaction  the spin, for the winner's name and avatar
 * @param {number} wonAmount    the pot that was claimed
 * @param {number} newPool      what the pool was reseeded to
 * @param {object} [delivery]   `{ credited, owed }` from the claim; defaults to
 *                              a delivered pot, which is what every caller
 *                              before the claim could fail to land meant
 */
function jackpotBroadcastEmbed(interaction, wonAmount, newPool, delivery = {}) {
    const { credited = true, owed = false } = delivery;
    const wonLine = credited
        ? `  💰 Won: **${wonAmount.toLocaleString()}** coins\n`
        : `  💰 Won: **${wonAmount.toLocaleString()}** coins — not delivered yet\n` +
          (owed
              ? `  📝 Recorded for an admin to settle\n`
              : `  ⚠️ Could not be recorded — tell an admin\n`);

    return new EmbedBuilder()
        .setColor('#FF00FF')
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .setDescription(
            `🎰 ━━━━━━━━━━━━━━━━━━━━━━━ 🎰\n` +
            `　　　**J A C K P O T**\n` +
            `🎰 ━━━━━━━━━━━━━━━━━━━━━━━ 🎰\n\n` +
            `${interaction.user} just hit **TRIPLE WILD** 🃏🃏🃏\n` +
            (credited ? `and walked away with the entire pool.\n\n` : `and claimed the entire pool.\n\n`) +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            wonLine +
            `  🔄 New pool: **${newPool.toLocaleString()}** coins\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `> Think you can be next?`
        )
        .setTimestamp();
}

function paytableEmbed() {
    return new EmbedBuilder()
        .setColor(COLORS.PRIZE)
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
            { name: '🃏🃏🃏 Triple Wild', value: '🏆 **JACKPOT — wins the whole progressive pool** (`/casino jackpot`)', inline: true },
            { name: '⚡⚡⚡ Triple Boost', value: '**4× bet**', inline: true },
            { name: 'Two of a Kind', value: 'Half of the 3-of-a-kind payout', inline: false },
            { name: '🌸🌸 Two Scatters', value: '**3 free spins** (no bet deducted)', inline: true },
            { name: '🌸🌸🌸 Three Scatters', value: '**5 free spins** with **1.5× multiplier**', inline: true },
            { name: '🔥 Hot Reel', value: 'After 3 losses in a row, reel 1 locks to a high-value symbol', inline: false },
        )
        .setFooter({ text: 'Two-of-a-kind pays 50% of the three-of-a-kind rate for that symbol • a Wild beside two different symbols completes the better-paying one' });
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
    async execute(interaction, { releaseLock, onWager } = {}) {
        const bet           = interaction.options.getInteger('bet');
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const casinoMaxBet  = guildSettings?.economy?.casinoMaxBet ?? 0;
        if (casinoMaxBet > 0 && bet > casinoMaxBet) {
            releaseLock?.();
            return interaction.reply({ content: `❌ The casino bet limit on this server is **${casinoMaxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const wallet = user?.balance ?? 0;
        const { shouldProceed: slProceed, alreadyReplied: slReplied } = await confirmBet(interaction, bet, wallet, 'Slots', guildSettings);
        if (!slProceed) { releaseLock?.(); return; }
        if (!slReplied) await interaction.deferReply();
        await playSlots(interaction, bet, releaseLock, onWager);
    },
};

// releaseLock is called once the spin settles into a result — "Spin Again"
// starts a brand-new hand with its own atomic debit, so it doesn't need the
// lock re-held.
async function playSlots(interaction, bet, releaseLock, onWager) {
    const userFilter  = { userId: interaction.user.id, guildId: interaction.guild.id };
    const guildFilter = { guildId: interaction.guild.id };
    try {
        const [userDoc, guildSettings] = await Promise.all([
            User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ),
            Guild.findOne(guildFilter),
        ]);

        const luckyActive      = hasEffect(userDoc, 'lucky_charm');
        const luckyStreakBonus = getLuckyStreakBonus(userDoc);
        const coinMult         = getCoinMultiplier(userDoc);
        const serverMult       = getServerCoinMultiplier(guildSettings);
        const totalCoinMult    = coinMult * serverMult;

        // ── Debit the bet FIRST, before any pool mutations ─────────────────
        const debited = await placeWager(userFilter, bet, { onWager });
        if (!debited) {
            releaseLock?.();
            const fresh = await User.findOne(userFilter);
            return interaction.editReply({
                content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                embeds: [], components: [],
            });
        }

        // Snapshot of the shared progressive pool, for the reels-spinning embeds. The
        // pool moves under us while they animate (every casino bet in the guild feeds
        // it), so the result embed reports a fresh figure rather than this one.
        const jackpotPool = guildSettings?.casinoJackpot?.pool ?? JACKPOT_SEED;

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

        // ── Jackpot claim (bet already charged) ────────────────────────────
        //
        // A losing spin needs no pool write of its own: placeWager above already
        // reported the wager, and that is what feeds the progressive pool its 0.5%.
        // Slots writing a second contribution here is exactly how it ended up with a
        // pool of its own.
        let finalJackpotPool = jackpotPool;
        let jackpotWon = false;
        let jackpotNote = null;
        let jackpotDelivery = {};

        if (result.outcome === 'jackpot') {
            const claim = await claimJackpot({
                guildId:  interaction.guild.id,
                userId:   interaction.user.id,
                username: interaction.user.username,
                note:     'Progressive jackpot win — slots Triple Wild',
            });
            finalJackpotPool = claim.newPool;
            if (claim.claimed) {
                // The pot came out of the pool, so it is this player's whether or
                // not the credit has landed yet — and either way the spin's own
                // credit below must skip the amount. A claim that has not been
                // paid is being recovered under its own payout key (the restart
                // reconciler, `payouts:replay`), and paying the flat mega-win in
                // its place would pay the same Triple Wild twice: the fallback
                // used to run on top of a pool the service had put back, over a
                // credit that may well have committed and only lost its response.
                //
                // result.payout carries the pot for the embeds' arithmetic only.
                jackpotWon = true;
                result = { ...result, payout: claim.wonAmount };
                jackpotDelivery = { credited: claim.credited, owed: claim.owed };
                if (!claim.credited) {
                    jackpotNote = claim.owed
                        ? '\n> ⚠️ *The pot could not be paid out just now — it has been recorded and an admin can settle it.*'
                        : '\n> ⚠️ *The pot could not be paid out just now, and could not be recorded either — please tell an admin.*';
                }
            } else {
                // Nothing was claimed — there is no guild document and so no pool
                // to win. Pay the flat mega-win through the normal payout path
                // instead; a Triple Wild is never a dead spin.
                console.error(`[Slots] no jackpot pool to claim for ${interaction.user.id} — paying the ${FREE_SPIN_JACKPOT_MULT}x fallback`);
                result = { ...result, payout: bet * FREE_SPIN_JACKPOT_MULT };
            }
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

        // Apply coin booster to payout (net profit portion only). A claimed jackpot
        // is exempt: the pool is a fixed pot of coins other players paid in, not a
        // multiple of this bet, and running a booster over it mints the difference.
        let adjustedPayout = result.payout;
        if (result.payout > 0 && totalCoinMult > 1.0 && !jackpotWon) {
            adjustedPayout = bet + Math.round((result.payout - bet) * totalCoinMult);
        }

        // Credit the payout (bet already debited above). casinoJackpotService credits
        // a claimed jackpot itself — including it here would pay the pool out twice.
        let user = await User.findOneAndUpdate(
            userFilter,
            { $inc: { balance: jackpotWon ? 0 : adjustedPayout } },
            { new: true }
        );

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
                embeds: [jackpotBroadcastEmbed(interaction, result.payout, finalJackpotPool, jackpotDelivery)],
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
                if (freeResult.outcome === 'jackpot') freeResult.payout = bet * FREE_SPIN_JACKPOT_MULT;
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

        // Lock is released only after the spin's payout (including any free-spin
        // payouts) has fully settled, so "Spin Again" can't start a new hand for
        // this player while a free-spin credit is still being written.
        releaseLock?.();

        // ── Big win announcement ────────────────────────────────────────────────
        const winMult = adjustedPayout > 0 ? adjustedPayout / bet : 0;
        if (winMult >= WIN_ANNOUNCE_MULT && !jackpotWon) {
            const announceChannelId = guildSettings?.economy?.announcementChannelId ?? null;
            if (announceChannelId) {
                const bigWinEmbed = new EmbedBuilder()
                    .setColor(COLORS.PRIZE)
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

        // Refresh the pool for the result embed rather than reusing the pre-spin
        // snapshot. This spin's own 0.5% contribution is fired and forgotten from
        // placeWager, and the reels animated for ~2.4 seconds on top of that, so the
        // snapshot is stale by the time anyone reads it — and this is the figure a
        // player checks against `/casino jackpot`.
        if (!jackpotWon) {
            const fresh = await Guild.findOne(guildFilter, 'casinoJackpot').lean().catch(() => null);
            finalJackpotPool = fresh?.casinoJackpot?.pool ?? finalJackpotPool;
        }

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
        // A pot that was claimed but has not reached the balance yet says so
        // here. The embed reports the win and the new balance from the same
        // document, and without this it would show the pot as paid.
        if (jackpotNote) {
            const desc = finalEmbed.data.description ?? '';
            finalEmbed.setDescription(desc + jackpotNote);
        }
        await interaction.editReply({
            embeds: [finalEmbed],
            components: [row],
        });

        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: ownedBy(
                interaction.user.id,
                i => [replayId, paytableId].includes(i.customId),
                "This isn't your spin — run `/slots` for your own.",
            ),
            time: 60_000,
        });

        collector.on('collect', async i => {
            if (i.customId === paytableId) {
                await i.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
                return;
            }
            collector.stop('replay');
            await i.deferUpdate();
            await playSlots(interaction, bet, null, onWager);
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
