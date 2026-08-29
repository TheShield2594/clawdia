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
    POOL_SIZE,
    PICK_COUNT,
    DRAW_COUNT,
    PAYOUTS,
    PAYTABLE_FOOTER,
    drawNumbers,
    nearMissCount,
} = require('./kenoPaytable');
const { ownedBy } = require('../../utils/collectorOwner');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b1.png';
const MIN_BET = 10;

const delay = ms => new Promise(r => setTimeout(r, ms));

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
    };
}

// 4-row × 10-col emoji grid
// ⬛ = unselected  🟦 = your pick (not drawn)  🟥 = drawn (not your pick)  🟨 = match!
function formatKenoGrid(picked, drawn, revealedCount = DRAW_COUNT) {
    const revealedDrawn = drawn.slice(0, revealedCount);
    const rows = [];
    for (let row = 0; row < 4; row++) {
        const cells = [];
        for (let col = 1; col <= 10; col++) {
            const n = row * 10 + col;
            const isPicked = picked.includes(n);
            const isDrawn  = revealedDrawn.includes(n);
            if (isPicked && isDrawn) cells.push('🟨');
            else if (isPicked)       cells.push('🟦');
            else if (isDrawn)        cells.push('🟥');
            else                     cells.push('⬛');
        }
        rows.push(cells.join(''));
    }
    return rows.join('\n') + '\n-# ⬛ blank  🟦 your pick  🟥 drawn  🟨 match';
}

function hitBar(hits) {
    const filled = '🟨'.repeat(hits);
    const empty  = '⬛'.repeat(PICK_COUNT - hits);
    return filled + empty;
}

function phaseTitle(hits, _total) {
    if (hits === 0) return '🎱 Drawing… no hits yet';
    if (hits === 1) return '🎱 One match!';
    if (hits === 2) return '🎱 Two matches!';
    if (hits >= 3)  return `🎱 ${hits} matches — keep going!`;
    return '🎱 Drawing…';
}

// releaseLock is called once the draw settles into a result — replays/
// rerolls don't need it re-held since they re-debit atomically like any
// fresh bet.
async function playKeno(interaction, bet, picked, alreadyDebited = false, releaseLock, onWager) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let debited = null;
    let settled = false;

    try {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (alreadyDebited) {
            debited = await User.findOne(userFilter);
        } else {
            debited = await placeWager(userFilter, bet, { onWager });

            if (!debited) {
                releaseLock?.();
                const fresh = await User.findOne(userFilter);
                return interaction.editReply({
                    content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                });
            }
        }

        const drawn   = drawNumbers();
        const pickedStr = picked.map(n => `**${n}**`).join('  ');

        // ── Skip-animation control — lets repeat players jump straight to the
        // result instead of sitting through the full reveal each time ────────
        const skipId   = `keno_skip_${interaction.id}_${Date.now()}`;
        const skipRow  = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(skipId).setLabel('⏩ Skip Animation').setStyle(ButtonStyle.Secondary),
        );
        const animState = { skipped: false };
        let skipCollector = null;
        const armSkipCollector = async () => {
            if (skipCollector) return;
            const msg = await interaction.fetchReply().catch(() => null);
            if (!msg) return;
            skipCollector = msg.createMessageComponentCollector({
                filter: ownedBy(interaction.user.id, i => i.customId === skipId, "This isn't your card."),
                time: 8_000,
            });
            skipCollector.on('collect', async i => {
                animState.skipped = true;
                await i.deferUpdate().catch(() => {});
            });
        };

        // ── Phase 1: Draw numbers 1-5 one at a time ──────────────────────────
        for (let i = 1; i <= 5 && !animState.skipped; i++) {
            const hits = drawn.slice(0, i).filter(n => picked.includes(n)).length;
            const embed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(COLORS.INFO)
                .setTitle(phaseTitle(hits, i))
                .setDescription(formatKenoGrid(picked, drawn, i))
                .addFields(
                    { name: '🎯 Your Picks', value: pickedStr, inline: true },
                    { name: `🔵 Drawing (${i}/10)`, value: `${hitBar(hits)}  **${hits}** hit`, inline: true },
                )
                .setFooter({ text: PAYTABLE_FOOTER });
            await interaction.editReply({ embeds: [embed], components: [skipRow] });
            if (i === 1) await armSkipCollector();
            await delay(650);
        }

        // ── Midpoint suspense break ───────────────────────────────────────────
        if (!animState.skipped) {
            const midHits = drawn.slice(0, 5).filter(n => picked.includes(n)).length;
            const remaining = PICK_COUNT - midHits;
            let suspenseText;
            if (midHits === 5)     suspenseText = '🔥 **All 5 matched in the first draw!** Last 5 are gravy…';
            else if (midHits >= 3) suspenseText = `✅ **${midHits} matched** so far — ${remaining} more to go for the jackpot!`;
            else if (midHits === 2) suspenseText = `🎯 **2 matched** — one more for a profit…`;
            else if (midHits === 1) suspenseText = `😬 **1 matched** — need ${remaining} of the next 5…`;
            else                   suspenseText  = `💨 **Nothing yet** — all ${PICK_COUNT} need to come from the last 5…`;

            const midEmbed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(COLORS.INFO)
                .setTitle('🎱 Halfway — Drawing 6 of 10…')
                .setDescription(formatKenoGrid(picked, drawn, 5))
                .addFields(
                    { name: '🎯 Your Picks', value: pickedStr, inline: true },
                    { name: '📊 Midpoint', value: suspenseText, inline: false },
                )
                .setFooter({ text: PAYTABLE_FOOTER });
            await interaction.editReply({ embeds: [midEmbed], components: [skipRow] });
            await delay(1200);
        }

        // ── Phase 2: Draw numbers 6-10 one at a time ─────────────────────────
        for (let i = 6; i <= 10 && !animState.skipped; i++) {
            const hits = drawn.slice(0, i).filter(n => picked.includes(n)).length;
            const embed = new EmbedBuilder()
                .setAuthor(embedAuthor(interaction))
                .setThumbnail(THUMB)
                .setColor(COLORS.INFO)
                .setTitle(phaseTitle(hits, i))
                .setDescription(formatKenoGrid(picked, drawn, i))
                .addFields(
                    { name: '🎯 Your Picks', value: pickedStr, inline: true },
                    { name: `🔵 Drawing (${i}/10)`, value: `${hitBar(hits)}  **${hits}** hit`, inline: true },
                )
                .setFooter({ text: PAYTABLE_FOOTER });
            await interaction.editReply({ embeds: [embed], components: [skipRow] });
            await delay(650);
        }

        skipCollector?.stop();

        // ── Calculate result ──────────────────────────────────────────────────
        const matches    = drawn.filter(n => picked.includes(n)).length;
        const multiplier = PAYOUTS[matches] ?? 0;

        const luckyActive      = hasEffect(debited, 'lucky_charm');
        const luckyStreakBonus = getLuckyStreakBonus(debited);
        const coinMult         = getCoinMultiplier(debited);
        const serverMult       = getServerCoinMultiplier(guildSettings);
        const totalCoinMult    = coinMult * serverMult;

        let grossPayout = multiplier > 0 ? bet * multiplier : 0;

        const luckySavable = luckySaveEligible(bet);

        let charmTriggered = false;
        if (grossPayout === 0 && luckySavable && luckyActive && Math.random() < 0.20) {
            grossPayout = bet;
            charmTriggered = true;
        }

        let streakTriggered = false;
        if (grossPayout === 0 && luckySavable && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
            grossPayout = bet;
            streakTriggered = true;
        }

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
        releaseLock?.();

        const net    = credit - bet;
        const netStr = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;
        let boostNote = '';
        if (totalCoinMult > 1.0 && adjustedPayout > bet) boostNote = `\n> 🚀 *${totalCoinMult.toFixed(1)}x Coin Booster applied!*`;

        // ── Special celebration for big wins (skipped if animation was skipped) ─
        if (matches === 5 && !animState.skipped) {
            await delay(400);
            const stage1 = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('🎱 Wait…')
                .setDescription('> Counting your matches…')
                .setAuthor(embedAuthor(interaction));
            await interaction.editReply({ embeds: [stage1] });
            await delay(900);

            const stage2 = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('🎱 1… 2… 3… 4…')
                .setDescription('> 🟨🟨🟨🟨 — one more…')
                .setAuthor(embedAuthor(interaction));
            await interaction.editReply({ embeds: [stage2] });
            await delay(1100);
        } else if (matches === 4 && !animState.skipped) {
            await delay(400);
            const stage1 = new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('🎱 4 Matches…')
                .setDescription('> 🟨🟨🟨🟨 — **That\'s a massive hit!**')
                .setAuthor(embedAuthor(interaction));
            await interaction.editReply({ embeds: [stage1] });
            await delay(900);
        }

        // ── Build final result embed ──────────────────────────────────────────
        let color, title, desc;
        if (matches === 5) {
            color = '#FFD700';
            title = '🎱 ★ PERFECT KENO ★  ALL FIVE MATCHED!';
            desc  = `🟨🟨🟨🟨🟨\n# 💥 ${PAYOUTS[5]}× JACKPOT! 💥\nEvery single pick hit. This almost never happens.`;
        } else if (matches === 4) {
            color = '#00FF88';
            title = `🎱 Four Matches — ${PAYOUTS[4]}× Win!`;
            desc  = '🟨🟨🟨🟨⬛\n**Four picks landed — huge payout!**';
        } else if (matches === 3) {
            color = '#FFAA00';
            title = `🎱 Three Matches — ${PAYOUTS[3]}× Win!`;
            desc  = '🟨🟨🟨⬛⬛\n**Three picks hit — you\'re up!**';
        } else if (matches === 2) {
            color = '#f39c12';
            title = '🎱 Two Matches — Bet Returned';
            desc  = '🟨🟨⬛⬛⬛\nBreak-even — your bet comes back.';
        } else if (charmTriggered || streakTriggered) {
            color = '#f39c12';
            title = '🎱 Lucky Save!';
            desc  = charmTriggered ? '🍀 **Lucky Charm** returned your bet!' : '🎯 **Lucky Streak** returned your bet!';
        } else {
            const nm = nearMissCount(picked, drawn);
            color = '#e74c3c';
            if (matches === 1) {
                title = '🎱 One Match — So Close';
                desc  = '🟨⬛⬛⬛⬛\nJust one away from breaking even. The next one could be it.';
            } else if (nm >= 3) {
                title = '🎱 No Matches — Near Miss';
                desc  = `💨 Not this time — but **${nm} of your picks** were within 2 of a drawn number. The board was close.`;
            } else {
                title = '🎱 No Matches';
                desc  = '💨 Cold board this round. The 🟦 and 🟥 didn\'t meet.';
            }
        }

        const payoutLabel = credit > 0 ? '🏆 Payout' : '💀 Lost';
        const payoutAmt   = credit > 0 ? adjustedPayout : bet;

        // Surface near-miss data
        const nearMisses = nearMissCount(picked, drawn);
        const showNearMiss = nearMisses > 0 && matches < 2;

        const resultEmbed = new EmbedBuilder()
            .setAuthor(embedAuthor(interaction))
            .setThumbnail(THUMB)
            .setColor(color)
            .setTitle(title)
            .setDescription(
                `${desc}${boostNote}\n\n` +
                `> 💸 Bet **${bet.toLocaleString()}**  ·  ${payoutLabel} **${payoutAmt.toLocaleString()}**  ·  Net **${netStr}**`
            )
            .addFields(
                { name: '🎯 Your Picks', value: pickedStr,                                                 inline: false },
                { name: '🗺️ Board',      value: formatKenoGrid(picked, drawn),                             inline: false },
                { name: '✅ Matches',    value: `${hitBar(matches)}  **${matches} / ${PICK_COUNT}**`,      inline: true  },
                { name: '💰 Balance',    value: `**${(updated?.balance ?? 0).toLocaleString()}** coins`,   inline: true  },
            )
            .setFooter({ text: PAYTABLE_FOOTER })
            .setTimestamp();

        if (showNearMiss) {
            resultEmbed.addFields({
                name: '😬 So Close!',
                value: `**${nearMisses}** of your numbers were within 2 of a drawn number.\n*Just off from a bigger win...*`,
                inline: false,
            });
        }

        const replayId  = `keno_replay_${interaction.id}_${Date.now()}`;
        const rerollId  = `keno_reroll_${interaction.id}_${Date.now()}`;
        const rerollCost = Math.ceil(bet / 2);
        const canReroll  = nearMisses >= 3 && matches <= 1 && (updated?.balance ?? 0) >= rerollCost;

        const buttons = [
            new ButtonBuilder().setCustomId(replayId).setLabel('🎱 Play Again').setStyle(ButtonStyle.Primary),
        ];
        if (canReroll) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(rerollId)
                    .setLabel(`🎰 Quick Reroll — ${rerollCost.toLocaleString()} coins (same picks)`)
                    .setStyle(ButtonStyle.Secondary),
            );
        }

        const row = new ActionRowBuilder().addComponents(...buttons);

        await interaction.editReply({ embeds: [resultEmbed], components: [row] });

        const msg = await interaction.fetchReply();
        msg.createMessageComponentCollector({
            filter: ownedBy(interaction.user.id, i => [replayId, rerollId].includes(i.customId), "This isn't your card."),
            max: 1,
            time: 60_000,
        }).on('collect', async i => {
            if (i.customId === rerollId) {
                // Quick reroll at 50% cost with same picks. A discounted draw is
                // still a fresh draw paid for with fresh coins, so it reports its
                // own wager — at the reroll price, not the original bet.
                const rerollDebited = await placeWager(userFilter, rerollCost, { onWager });
                if (!rerollDebited) {
                    return i.update({ content: `❌ Not enough coins for the quick reroll (need **${rerollCost.toLocaleString()}** coins).`, embeds: [], components: [] });
                }
                await i.deferUpdate();
                await playKeno(interaction, rerollCost, picked, true, null, onWager);
            } else {
                await i.deferUpdate();
                await playKeno(interaction, bet, picked, false, null, onWager);
            }
        }).on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Keno] error:', err);
        releaseLock?.();
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
                .setDescription(`Amount to bet (min ${MIN_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(1_000_000_000))
        .addStringOption(opt =>
            opt.setName('numbers')
                .setDescription('Your 5 numbers from 1–40, space-separated (e.g. 3 12 21 33 39)')
                .setRequired(true)),

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
        const numbersRaw = interaction.options.getString('numbers');

        const parsed = numbersRaw.trim().split(/\s+/).map(Number);
        const valid  = parsed.every(n => Number.isInteger(n) && n >= 1 && n <= POOL_SIZE);

        if (parsed.length !== PICK_COUNT || !valid) {
            releaseLock?.();
            return interaction.reply({
                content: `❌ Please provide exactly **5 different numbers** between 1 and ${POOL_SIZE}.\nExample: \`3 12 21 33 39\``,
                flags: MessageFlags.Ephemeral,
            });
        }

        const uniquePicked = [...new Set(parsed)];
        if (uniquePicked.length !== PICK_COUNT) {
            releaseLock?.();
            return interaction.reply({ content: '❌ All 5 numbers must be different.', flags: MessageFlags.Ephemeral });
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

        const { shouldProceed: knProceed, alreadyReplied: knReplied } = await confirmBet(interaction, bet, user.balance, 'Keno', guildSettings);
        if (!knProceed) { releaseLock?.(); return; }
        if (!knReplied) await interaction.deferReply();
        await playKeno(interaction, bet, uniquePicked.sort((a, b) => a - b), false, releaseLock, onWager);
    },
};
