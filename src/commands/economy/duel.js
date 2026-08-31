const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const { randomInt } = require('crypto');
const User = require('../../models/User');
const { advanceMissions } = require('../../services/seasonMissionService');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { isDistrictActive } = require('../../services/districtService');
const { START_ELO, tierFor, applyElo, makeSeasonId } = require('../../utils/duelElo');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');

const DUEL_COOLDOWN_MS = 5 * 60_000;
const ACCEPT_TIMEOUT_MS = 60_000;
const RPS_TIMEOUT_MS = 30_000;

const MINI_GAMES = ['coinflip', 'dice', 'highercard', 'rps'];
const GAME_NAMES = {
    coinflip:   '🪙 Coin Flip',
    dice:       '🎲 Dice Roll',
    highercard: '🃏 Higher Card',
    rps:        '✊ Rock Paper Scissors',
};

const VICTORY_FLAVOR = {
    coinflip:   'Called it. Every time.',
    dice:       "The dice don't lie.",
    highercard: 'Higher card. Lower ego.',
    rps:        'Reads people well.',
};

const DUEL_LOSS_LINES = [
    'Better luck next time.',
    'The gap is clear. Train harder.',
    'It happens to everyone. Once.',
    'They were just better. Today.',
];

const SUITS  = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const CARD_RANK = Object.fromEntries(VALUES.map((v, i) => [v, i]));

const RPS_MOVES = ['rock', 'paper', 'scissors'];
const RPS_EMOJI = { rock: '✊', paper: '🖐️', scissors: '✌️' };

function drawCard() {
    return { suit: SUITS[randomInt(SUITS.length)], value: VALUES[randomInt(VALUES.length)] };
}

// Atomically deduct wagers from both players. Returns { success, reason }.
// If opponent deduction fails after challenger succeeded, challenger is refunded.
async function takeEscrow(challengerId, opponentId, guildId, amount) {
    const challenger = await User.findOneAndUpdate(
        { userId: challengerId, guildId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true }
    );
    if (!challenger) return { success: false, reason: 'challenger' };

    const opponent = await User.findOneAndUpdate(
        { userId: opponentId, guildId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true }
    );
    if (!opponent) {
        await User.updateOne({ userId: challengerId, guildId }, { $inc: { balance: amount } });
        return { success: false, reason: 'opponent' };
    }
    return { success: true };
}

async function refundEscrow(challengerId, opponentId, guildId, amount) {
    await Promise.all([
        User.updateOne({ userId: challengerId, guildId }, { $inc: { balance: amount } }),
        User.updateOne({ userId: opponentId,   guildId }, { $inc: { balance: amount } }),
    ]);
}

// customId: rpsc_{duelId}_{move}  or  rpso_{duelId}_{move}
function buildRpsRow(role, duelId) {
    return new ActionRowBuilder().addComponents(
        RPS_MOVES.map(move =>
            new ButtonBuilder()
                .setCustomId(`rps${role}_${duelId}_${move}`)
                .setLabel(`${RPS_EMOJI[move]} ${move.charAt(0).toUpperCase() + move.slice(1)}`)
                .setStyle(ButtonStyle.Primary)
        )
    );
}

// Atomically re-check and claim cooldown for both players at duel-accept time.
// Returns { ok, reason } — reason ∈ { 'challenger' | 'opponent' } on failure.
// Both player updates are performed only if both pass the cooldown check; if
// the second claim fails the first is reverted.
async function claimDuelCooldown(challengerId, opponentId, guildId, lastDuelBefore) {
    const claimedChallenger = await User.findOneAndUpdate(
        {
            userId: challengerId,
            guildId,
            $or: [
                { lastDuel: null },
                { lastDuel: { $lt: lastDuelBefore } },
            ],
        },
        { $set: { lastDuel: new Date() } },
        { new: false }
    );
    if (!claimedChallenger) return { ok: false, reason: 'challenger' };

    const claimedOpponent = await User.findOneAndUpdate(
        {
            userId: opponentId,
            guildId,
            $or: [
                { lastDuel: null },
                { lastDuel: { $lt: lastDuelBefore } },
            ],
        },
        { $set: { lastDuel: new Date() } },
        { new: false }
    );
    if (!claimedOpponent) {
        // Revert challenger's claim to its previous value
        await User.updateOne(
            { userId: challengerId, guildId },
            { $set: { lastDuel: claimedChallenger.lastDuel } }
        ).catch(console.error);
        return { ok: false, reason: 'opponent' };
    }
    return { ok: true, prevChallengerLastDuel: claimedChallenger.lastDuel, prevOpponentLastDuel: claimedOpponent.lastDuel };
}

async function revertDuelCooldown(challengerId, opponentId, guildId, prevChallenger, prevOpponent) {
    await Promise.all([
        User.updateOne({ userId: challengerId, guildId }, { $set: { lastDuel: prevChallenger ?? null } }),
        User.updateOne({ userId: opponentId,   guildId }, { $set: { lastDuel: prevOpponent   ?? null } }),
    ]).catch(console.error);
}

async function finalizeDuel({ interaction, targetUser, challengerId, opponentId, amount, currency, houseCut, challengerWins, tie, game, gameResult, isRanked = false }) {
    const guildId = interaction.guild.id;
    // Escrow already deducted both stakes; compute payout from pot
    const guildDoc = await getGuildSettings(guildId);
    const arenaActive = isDistrictActive(guildDoc, 'arena');
    const pot         = 2 * amount;
    const houseAmount = Math.floor(pot * houseCut);
    // Arena district adds +15% of the pot on top of the normal payout; house cut still applies.
    const arenaBonus   = arenaActive ? Math.floor(pot * 0.15) : 0;
    const winnerPayout = pot - houseAmount + arenaBonus; // escrowed funds returned to winner
    const netGain      = winnerPayout - amount; // winner's profit above their own stake

    let description;
    let eloLine = '';
    if (tie) {
        // Refund both stakes and record cooldown
        await Promise.all([
            User.updateOne({ userId: challengerId, guildId }, { $inc: { balance: amount }, $set: { lastDuel: new Date() } }),
            User.updateOne({ userId: opponentId,   guildId }, { $inc: { balance: amount }, $set: { lastDuel: new Date() } }),
        ]);
        description = `${gameResult}\n\n**It's a tie!** Both bets returned.`;
    } else {
        const winnerId   = challengerWins ? challengerId : opponentId;
        const loserId    = challengerWins ? opponentId   : challengerId;
        const winnerName = challengerWins ? interaction.user.username : targetUser.username;

        const baseWinnerInc = { $inc: { balance: winnerPayout, duelWins: 1 }, $set: { lastDuel: new Date() } };
        const baseLoserInc  = { $inc: { duelLosses: 1 }, $set: { lastDuel: new Date() } };

        if (isRanked) {
            // Apply ELO changes — read current ratings, compute deltas, persist atomically.
            const [winnerDoc, loserDoc] = await Promise.all([
                User.findOne({ userId: winnerId, guildId }).select('ranked').lean(),
                User.findOne({ userId: loserId,  guildId }).select('ranked').lean(),
            ]);
            const kFactor = guildDoc?.rankedDuels?.kFactor ?? 32;
            // Detect if the stored season is already past its end date. When that
            // happens (the scheduler hasn't yet rolled the season over) we tag this
            // match against the *next* season id and initialize the season-scoped
            // counters with $set rather than $inc, so an in-flight match never
            // bumps a counter from the prior season.
            const storedSeasonId = guildDoc?.rankedDuels?.currentSeasonId
                ?? makeSeasonId(guildDoc?.rankedDuels?.seasonNumber ?? 1);
            const seasonExpired  = guildDoc?.rankedDuels?.seasonEndsAt
                && new Date(guildDoc.rankedDuels.seasonEndsAt).getTime() <= Date.now();
            const seasonId       = seasonExpired
                ? makeSeasonId((guildDoc?.rankedDuels?.seasonNumber ?? 1) + 1)
                : storedSeasonId;
            const wElo = winnerDoc?.ranked?.elo ?? START_ELO;
            const lElo = loserDoc?.ranked?.elo  ?? START_ELO;
            const { winnerNewElo, loserNewElo, winnerDelta, loserDelta } = applyElo(wElo, lElo, kFactor);

            baseWinnerInc.$inc['ranked.rankedWins']  = 1;
            baseWinnerInc.$set['ranked.elo']         = winnerNewElo;
            baseWinnerInc.$set['ranked.peakElo']     = Math.max(winnerDoc?.ranked?.peakElo ?? START_ELO, winnerNewElo);
            baseWinnerInc.$set['ranked.currentSeasonId'] = seasonId;

            baseLoserInc.$inc['ranked.rankedLosses'] = 1;
            baseLoserInc.$set['ranked.elo']          = loserNewElo;
            baseLoserInc.$set['ranked.currentSeasonId'] = seasonId;

            if (seasonExpired) {
                // First match of a new season — initialize seasonal counters rather
                // than carrying over the prior season's totals via $inc.
                baseWinnerInc.$set['ranked.seasonRankedWins']   = 1;
                baseWinnerInc.$set['ranked.seasonRankedLosses'] = 0;
                baseWinnerInc.$set['ranked.seasonPeakElo']      = winnerNewElo;

                baseLoserInc.$set['ranked.seasonRankedWins']    = 0;
                baseLoserInc.$set['ranked.seasonRankedLosses']  = 1;
                baseLoserInc.$set['ranked.seasonPeakElo']       = loserNewElo;
            } else {
                baseWinnerInc.$inc['ranked.seasonRankedWins']   = 1;
                baseWinnerInc.$set['ranked.seasonPeakElo']      = Math.max(winnerDoc?.ranked?.seasonPeakElo ?? START_ELO, winnerNewElo);

                baseLoserInc.$inc['ranked.seasonRankedLosses']  = 1;
            }

            const winnerTier = tierFor(winnerNewElo);
            const loserTier  = tierFor(loserNewElo);
            eloLine = `\n\n📊 **Ranked update** · ${seasonId}\n` +
                `Winner: ${winnerTier.icon} ${winnerNewElo} (+${winnerDelta})\n` +
                `Loser:  ${loserTier.icon} ${loserNewElo} (${loserDelta})`;
        }

        await Promise.all([
            User.updateOne({ userId: winnerId, guildId }, baseWinnerInc),
            User.updateOne({ userId: loserId,  guildId }, baseLoserInc),
        ]);

        // Season pass: "Win a duel" — the winner only, and only once the payout
        // has actually settled. Fire-and-forget; a mission that fails to tick
        // must not take the duel result down with it.
        advanceMissions(User, { userId: winnerId, guildId }, 'duel_win', 1, guildDoc)
            .catch(err => console.error('[duel] season mission error:', err));
        const arenaStr = arenaActive ? ` + ⚔️ Arena bonus: ${currency}${arenaBonus.toLocaleString()}` : '';
        description = `${gameResult}\n\n**${winnerName}** wins **${currency}${netGain.toLocaleString()}** net (${Math.round(houseCut * 100)}% house cut${arenaStr})!${eloLine}`;
    }

    const [challenger, opponent] = await Promise.all([
        User.findOne({ userId: challengerId, guildId }),
        User.findOne({ userId: opponentId,   guildId }),
    ]);

    const cWins   = challenger?.duelWins   ?? 0;
    const cLosses = challenger?.duelLosses ?? 0;
    const oWins   = opponent?.duelWins     ?? 0;
    const oLosses = opponent?.duelLosses   ?? 0;

    const embed = new EmbedBuilder()
        .setColor(tie ? '#f39c12' : '#2ecc71')
        .setTitle(`⚔️ Duel Result — ${GAME_NAMES[game]}`)
        .setDescription(description)
        .addFields(
            { name: `${interaction.user.username}'s Balance`, value: `${currency}${(challenger?.balance ?? 0).toLocaleString()}`, inline: true },
            { name: `${targetUser.username}'s Balance`,       value: `${currency}${(opponent?.balance  ?? 0).toLocaleString()}`, inline: true },
            { name: `${interaction.user.username}'s Record`,  value: `${cWins}W / ${cLosses}L`, inline: true },
            { name: `${targetUser.username}'s Record`,        value: `${oWins}W / ${oLosses}L`, inline: true },
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});

    // Post the victory card as a separate channel follow-up (non-ephemeral)
    if (!tie) {
        const winnerUser = challengerWins ? interaction.user : targetUser;
        const loserUser  = challengerWins ? targetUser       : interaction.user;
        const flavor     = VICTORY_FLAVOR[game] ?? 'A clean win.';
        const lossLine   = DUEL_LOSS_LINES[Math.floor(Math.random() * DUEL_LOSS_LINES.length)];
        const divider    = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
        const winLine    = winnerPayout.toLocaleString();

        const victoryCard = new EmbedBuilder()
            .setColor(COLORS.PRIZE)
            .setTitle('🏆 Duel Victory')
            .setDescription(
                `<@${winnerUser.id}> defeated <@${loserUser.id}> in a ${GAME_NAMES[game]}\n\n` +
                `${divider}\n` +
                `  💰 Won: **${currency}${winLine}**\n` +
                `  ⚔️ Method: **${GAME_NAMES[game]}**\n` +
                `${divider}\n\n` +
                `> *${flavor}*\n` +
                `> ${lossLine}`
            )
            .setThumbnail(winnerUser.displayAvatarURL({ dynamic: true }))
            .setFooter({ text: `Challenged by ${loserUser.username}` })
            .setTimestamp();

        await interaction.followUp({ embeds: [victoryCard] }).catch(() => {});
    }
}

function errorEmbed(title, description) {
    return new EmbedBuilder().setColor(COLORS.ERROR).setTitle(title).setDescription(description).setTimestamp();
}

async function runInstantGame(interaction, targetUser, amount, currency, houseCut, game, isRanked = false) {
    let challengerWins = false;
    let tie = false;
    let gameResult = '';

    if (game === 'coinflip') {
        challengerWins = randomInt(2) === 0;
        const face = challengerWins ? 'Heads' : 'Tails';
        gameResult = `🪙 **Coin Flip**: ${face}\n${challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`}`;
    } else if (game === 'dice') {
        const cRoll = randomInt(1, 7) + randomInt(1, 7);
        const oRoll = randomInt(1, 7) + randomInt(1, 7);
        if (cRoll > oRoll) challengerWins = true;
        else if (cRoll === oRoll) tie = true;
        gameResult = `🎲 **${interaction.user.username}** rolled **${cRoll}** · **${targetUser.username}** rolled **${oRoll}**\n${tie ? "It's a tie!" : (challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`)}`;
    } else if (game === 'highercard') {
        const cCard = drawCard();
        const oCard = drawCard();
        if (CARD_RANK[cCard.value] > CARD_RANK[oCard.value]) challengerWins = true;
        else if (CARD_RANK[cCard.value] === CARD_RANK[oCard.value]) tie = true;
        gameResult = `🃏 **${interaction.user.username}** drew **${cCard.value}${cCard.suit}** · **${targetUser.username}** drew **${oCard.value}${oCard.suit}**\n${tie ? "It's a tie!" : (challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`)}`;
    }

    try {
        await finalizeDuel({ interaction, targetUser, challengerId: interaction.user.id, opponentId: targetUser.id, amount, currency, houseCut, challengerWins, tie, game, gameResult, isRanked });
    } catch (err) {
        console.error('Duel finalizeDuel error:', err);
        await refundEscrow(interaction.user.id, targetUser.id, interaction.guild.id, amount).catch(console.error);
        await interaction.editReply({ embeds: [errorEmbed('⚔️ Duel Error', 'Something went wrong settling the duel. Both bets have been refunded.')], components: [] }).catch(() => {});
    }
}

async function runRPS(interaction, msg, targetUser, amount, currency, houseCut, duelId, isRanked = false) {
    // settled prevents double-refund if both a collect error and a timeout fire
    let settled = false;
    const guildId = interaction.guild.id;

    async function settle(fn) {
        if (settled) return;
        settled = true;
        await fn();
    }

    try {
        await interaction.editReply({
            embeds: [new EmbedBuilder().setColor(COLORS.INFO).setTitle('✊ Rock Paper Scissors').setDescription(`**${interaction.user.username}**, choose your move! (30s)`).setTimestamp()],
            components: [buildRpsRow('c', duelId)],
        });
    } catch (err) {
        console.error('Duel RPS editReply error:', err);
        await refundEscrow(interaction.user.id, targetUser.id, guildId, amount).catch(console.error);
        return;
    }

    const cPrefix = `rpsc_${duelId}_`;
    const challengerCollector = msg.createMessageComponentCollector({
        filter: ownedBy(
            interaction.user.id,
            i => i.customId.startsWith(cPrefix) && RPS_MOVES.includes(i.customId.slice(cPrefix.length)),
            "This isn't your duel.",
        ),
        time: RPS_TIMEOUT_MS,
        max: 1,
    });

    challengerCollector.on('collect', async ci => {
        try {
            await ci.deferUpdate();
            const challengerMove = ci.customId.slice(cPrefix.length);

            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor(COLORS.INFO).setTitle('✊ Rock Paper Scissors').setDescription(`**${targetUser.username}**, choose your move! (30s)`).setTimestamp()],
                components: [buildRpsRow('o', duelId)],
            });

            const oPrefix = `rpso_${duelId}_`;
            const opponentCollector = msg.createMessageComponentCollector({
                filter: ownedBy(
                    targetUser.id,
                    i => i.customId.startsWith(oPrefix) && RPS_MOVES.includes(i.customId.slice(oPrefix.length)),
                    "This isn't your duel.",
                ),
                time: RPS_TIMEOUT_MS,
                max: 1,
            });

            opponentCollector.on('collect', async oi => {
                try {
                    await oi.deferUpdate();
                    const opponentMove = oi.customId.slice(oPrefix.length);

                    let challengerWins = false;
                    let tie = false;
                    if (challengerMove === opponentMove) {
                        tie = true;
                    } else if (
                        (challengerMove === 'rock'     && opponentMove === 'scissors') ||
                        (challengerMove === 'paper'    && opponentMove === 'rock')     ||
                        (challengerMove === 'scissors' && opponentMove === 'paper')
                    ) {
                        challengerWins = true;
                    }

                    const gameResult = `${RPS_EMOJI[challengerMove]} **${interaction.user.username}**: ${challengerMove}\n${RPS_EMOJI[opponentMove]} **${targetUser.username}**: ${opponentMove}\n${tie ? "It's a tie!" : (challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`)}`;

                    await settle(async () => {
                        try {
                            await finalizeDuel({ interaction, targetUser, challengerId: interaction.user.id, opponentId: targetUser.id, amount, currency, houseCut, challengerWins, tie, game: 'rps', gameResult, isRanked });
                        } catch (err) {
                            console.error('Duel RPS finalizeDuel error:', err);
                            await refundEscrow(interaction.user.id, targetUser.id, guildId, amount).catch(console.error);
                            await interaction.editReply({ embeds: [errorEmbed('⚔️ Duel Error', 'Something went wrong settling the duel. Both bets have been refunded.')], components: [] }).catch(() => {});
                        }
                    });
                } catch (err) {
                    console.error('Duel RPS opponent collect error:', err);
                    await settle(async () => {
                        await refundEscrow(interaction.user.id, targetUser.id, guildId, amount).catch(console.error);
                        await interaction.editReply({ embeds: [errorEmbed('⚔️ Duel Error', 'Something went wrong. Both bets have been refunded.')], components: [] }).catch(() => {});
                    });
                }
            });

            opponentCollector.on('end', async (collected, reason) => {
                if (reason === 'time' && collected.size === 0) {
                    await settle(async () => {
                        await refundEscrow(interaction.user.id, targetUser.id, guildId, amount).catch(console.error);
                        await interaction.editReply({
                            embeds: [new EmbedBuilder().setColor(COLORS.NEUTRAL).setTitle('⚔️ Duel Expired').setDescription(`**${targetUser.username}** didn't pick a move in time. Both bets refunded.`).setTimestamp()],
                            components: [],
                        }).catch(() => {});
                    });
                }
            });
        } catch (err) {
            console.error('Duel RPS challenger collect error:', err);
            await settle(async () => {
                await refundEscrow(interaction.user.id, targetUser.id, guildId, amount).catch(console.error);
                await interaction.editReply({ embeds: [errorEmbed('⚔️ Duel Error', 'Something went wrong. Both bets have been refunded.')], components: [] }).catch(() => {});
            });
        }
    });

    challengerCollector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            await settle(async () => {
                await refundEscrow(interaction.user.id, targetUser.id, guildId, amount).catch(console.error);
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(COLORS.NEUTRAL).setTitle('⚔️ Duel Expired').setDescription(`**${interaction.user.username}** didn't pick a move in time. Both bets refunded.`).setTimestamp()],
                    components: [],
                }).catch(() => {});
            });
        }
    });
}

async function runChallenge(interaction, isRanked) {
    const guildSettings = await getGuildSettings(interaction.guild.id);

    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    if (guildSettings?.economy?.duelEnabled === false) {
        return interaction.reply({ content: 'Duels are disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    if (isRanked && guildSettings?.rankedDuels?.enabled === false) {
        return interaction.reply({ content: 'Ranked duels are disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const currency = guildSettings?.economy?.currency    || '💰';
    const maxBet   = guildSettings?.economy?.duelMaxBet  ?? 10000;
    const houseCut = guildSettings?.economy?.duelHouseCut ?? 0.05;
    const minBet   = isRanked ? (guildSettings?.rankedDuels?.minBet ?? 100) : 1;

    const target    = interaction.options.getUser('user');
    const amount    = interaction.options.getInteger('amount');
    const gameChoice = interaction.options.getString('game') ?? 'random';

    if (target.id === interaction.user.id) {
        return interaction.reply({ content: "You can't duel yourself.", flags: MessageFlags.Ephemeral });
    }
    if (target.bot) {
        return interaction.reply({ content: "You can't duel a bot.", flags: MessageFlags.Ephemeral });
    }
    if (amount > maxBet) {
        return interaction.reply({ content: `The maximum bet on this server is **${currency}${maxBet.toLocaleString()}**.`, flags: MessageFlags.Ephemeral });
    }
    if (amount < minBet) {
        return interaction.reply({ content: `Ranked duels require a minimum bet of **${currency}${minBet.toLocaleString()}**.`, flags: MessageFlags.Ephemeral });
    }

    const [challenger, opponent] = await Promise.all([
        User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
        User.findOneAndUpdate({ userId: target.id,           guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
    ]);

    if (challenger.lastDuel && Date.now() - new Date(challenger.lastDuel).getTime() < DUEL_COOLDOWN_MS) {
        const mins = Math.ceil((DUEL_COOLDOWN_MS - (Date.now() - new Date(challenger.lastDuel).getTime())) / 60_000);
        return interaction.reply({ content: `You're cooling down from your last duel. Try again in **${mins} min**.`, flags: MessageFlags.Ephemeral });
    }
    if (opponent.lastDuel && Date.now() - new Date(opponent.lastDuel).getTime() < DUEL_COOLDOWN_MS) {
        const mins = Math.ceil((DUEL_COOLDOWN_MS - (Date.now() - new Date(opponent.lastDuel).getTime())) / 60_000);
        return interaction.reply({ content: `**${target.username}** is still on duel cooldown. Try again in **${mins} min**.`, flags: MessageFlags.Ephemeral });
    }

    if (challenger.balance < amount) {
        return interaction.reply({ content: `You don't have enough ${currency}. Wallet: **${currency}${challenger.balance.toLocaleString()}**`, flags: MessageFlags.Ephemeral });
    }

    const duelId = `${interaction.user.id}_${Date.now()}`;
    const modeLabel = isRanked ? '🏆 Ranked Duel' : '⚔️ Duel Challenge!';
    let rankedFooter = '';
    if (isRanked) {
        const cTier = tierFor(challenger.ranked?.elo ?? START_ELO);
        const oTier = tierFor(opponent.ranked?.elo  ?? START_ELO);
        rankedFooter = `\n\nELO: ${cTier.icon} ${challenger.ranked?.elo ?? START_ELO}  vs  ${oTier.icon} ${opponent.ranked?.elo ?? START_ELO}`;
    }

    const challengeEmbed = new EmbedBuilder()
        .setColor(isRanked ? '#9b59b6' : '#f39c12')
        .setTitle(modeLabel)
        .setDescription(
            `**${interaction.user.username}** challenges <@${target.id}> to a${isRanked ? ' **ranked**' : ''} duel!\n\n` +
            `Bet: **${currency}${amount.toLocaleString()}** each\n` +
            `House cut: **${Math.round(houseCut * 100)}%**\n` +
            `Game: **${gameChoice === 'random' ? '🎲 Random' : GAME_NAMES[gameChoice]}**${rankedFooter}\n\n` +
            `<@${target.id}>, do you accept?`
        )
        .setFooter({ text: 'Challenge expires in 60 seconds' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`duel_accept_${duelId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`duel_decline_${duelId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ embeds: [challengeEmbed], components: [row] });
    const msg = await interaction.fetchReply();

    const acceptCollector = msg.createMessageComponentCollector({
        filter: ownedBy(
            target.id,
            i => i.customId === `duel_accept_${duelId}` || i.customId === `duel_decline_${duelId}`,
            "This isn't your duel.",
        ),
        time: ACCEPT_TIMEOUT_MS,
        max: 1,
    });

    acceptCollector.on('collect', async i => {
        let escrowTaken = false;
        let cooldownClaim = null;
        try {
            await i.deferUpdate();

            if (i.customId === `duel_decline_${duelId}`) {
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setTitle('⚔️ Duel Declined').setDescription(`**${target.username}** declined the challenge.`).setTimestamp()],
                    components: [],
                });
            }

            // Re-check + atomically claim the cooldown for both players at accept time.
            // Each player must either have no recorded lastDuel or one older than
            // (now - DUEL_COOLDOWN_MS). Both claims must succeed or both are reverted.
            const cooldownBefore = new Date(Date.now() - DUEL_COOLDOWN_MS);
            cooldownClaim = await claimDuelCooldown(interaction.user.id, target.id, interaction.guild.id, cooldownBefore);
            if (!cooldownClaim.ok) {
                const who = cooldownClaim.reason === 'challenger' ? interaction.user.username : target.username;
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setTitle('⚔️ Duel Cancelled').setDescription(`**${who}** is on duel cooldown.`).setTimestamp()],
                    components: [],
                });
            }

            const escrow = await takeEscrow(interaction.user.id, target.id, interaction.guild.id, amount);
            if (!escrow.success) {
                // Cooldown was claimed but escrow failed — revert the claim
                await revertDuelCooldown(interaction.user.id, target.id, interaction.guild.id, cooldownClaim.prevChallengerLastDuel, cooldownClaim.prevOpponentLastDuel);
                cooldownClaim = null;
                const who = escrow.reason === 'challenger' ? interaction.user.username : target.username;
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setTitle('⚔️ Duel Cancelled').setDescription(`**${who}** no longer has enough ${currency}.`).setTimestamp()],
                    components: [],
                });
            }
            escrowTaken = true;

            const game = (gameChoice === 'random')
                ? MINI_GAMES[randomInt(MINI_GAMES.length)]
                : gameChoice;
            if (game === 'rps') {
                await runRPS(interaction, msg, target, amount, currency, houseCut, duelId, isRanked);
            } else {
                await runInstantGame(interaction, target, amount, currency, houseCut, game, isRanked);
            }
        } catch (err) {
            console.error('Duel accept collect error:', err);
            if (escrowTaken) {
                await refundEscrow(interaction.user.id, target.id, interaction.guild.id, amount).catch(console.error);
            }
            if (cooldownClaim?.ok) {
                await revertDuelCooldown(interaction.user.id, target.id, interaction.guild.id, cooldownClaim.prevChallengerLastDuel, cooldownClaim.prevOpponentLastDuel);
            }
            await interaction.editReply({ embeds: [errorEmbed('⚔️ Duel Error', 'Something went wrong. Any escrowed bets have been refunded.')], components: [] }).catch(() => {});
        }
    });

    acceptCollector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor(COLORS.NEUTRAL).setTitle('⚔️ Duel Expired').setDescription(`The duel challenge to **${target.username}** expired.`).setTimestamp()],
                components: [],
            }).catch(() => {});
        }
    });
}

async function runRankView(interaction) {
    const target  = interaction.options.getUser('user') ?? interaction.user;
    const guildId = interaction.guild.id;
    const userDoc = await User.findOne({ userId: target.id, guildId }).select('ranked duelWins duelLosses').lean();
    const elo     = userDoc?.ranked?.elo ?? START_ELO;
    const tier    = tierFor(elo);
    const peak    = userDoc?.ranked?.peakElo ?? elo;
    const peakTier= tierFor(peak);
    const rW = userDoc?.ranked?.rankedWins ?? 0;
    const rL = userDoc?.ranked?.rankedLosses ?? 0;
    const sW = userDoc?.ranked?.seasonRankedWins ?? 0;
    const sL = userDoc?.ranked?.seasonRankedLosses ?? 0;
    const titles = userDoc?.ranked?.seasonalTitles ?? [];

    // Server rank (1-indexed) based on current ELO
    const higher = await User.countDocuments({ guildId, 'ranked.elo': { $gt: elo } });
    const rankPosition = higher + 1;

    const guildSettings = await getGuildSettings(guildId);
    const seasonId = guildSettings?.rankedDuels?.currentSeasonId
        ?? makeSeasonId(guildSettings?.rankedDuels?.seasonNumber ?? 1);

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(`${tier.icon} ${target.username} — ${tier.label}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setDescription(`Current **${elo}** ELO · Server rank **#${rankPosition}**`)
        .addFields(
            { name: 'Peak Rating',  value: `${peakTier.icon} ${peak} (${peakTier.label})`, inline: true },
            { name: 'Season',       value: `${seasonId} · ${sW}W / ${sL}L`,                inline: true },
            { name: 'All-Time',     value: `${rW}W / ${rL}L (Ranked)`,                     inline: true },
        );
    if (titles.length) {
        embed.addFields({ name: 'Earned Titles', value: titles.map(t => `🏷️ ${t}`).join('\n'), inline: false });
    }
    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

async function runLeaderboard(interaction) {
    const guildId = interaction.guild.id;
    // Include anyone who has touched the ladder (wins OR losses), not just winners.
    const top = await User.find({
        guildId,
        $or: [
            { 'ranked.rankedWins':   { $gt: 0 } },
            { 'ranked.rankedLosses': { $gt: 0 } },
        ],
    })
        .sort({ 'ranked.elo': -1 })
        .limit(10)
        .select('userId ranked')
        .lean();

    if (!top.length) {
        return interaction.reply({ content: 'No one has played a ranked duel yet on this server.', flags: MessageFlags.Ephemeral });
    }

    const lines = await Promise.all(top.map(async (row, idx) => {
        const elo = row.ranked?.elo ?? START_ELO;
        const tier = tierFor(elo);
        const u = await interaction.client.users.fetch(row.userId).catch(() => null);
        const name = u?.username ?? row.userId;
        const wl = `${row.ranked?.rankedWins ?? 0}W/${row.ranked?.rankedLosses ?? 0}L`;
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `\`#${String(idx + 1).padStart(2, ' ')}\``;
        return `${medal}  ${tier.icon} **${name}** — ${elo} ELO · ${wl}`;
    }));

    const guildSettings = await getGuildSettings(guildId);
    const seasonId = guildSettings?.rankedDuels?.currentSeasonId
        ?? makeSeasonId(guildSettings?.rankedDuels?.seasonNumber ?? 1);
    const seasonEnds = guildSettings?.rankedDuels?.seasonEndsAt
        ? `\n\nSeason ends <t:${Math.floor(new Date(guildSettings.rankedDuels.seasonEndsAt).getTime() / 1000)}:R>`
        : '';

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(`🏆 Ranked Duel Ladder — ${seasonId}`)
        .setDescription(lines.join('\n') + seasonEnds)
        .setFooter({ text: 'Top 3 at season end earn coins, a title, and bragging rights.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('duel')
        .setDescription('Challenge another user to a coin-bet duel')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('casual')
                .setDescription('Unranked duel — wager coins without affecting your ELO.')
                .addUserOption(o => o.setName('user').setDescription('The user to challenge').setRequired(true))
                .addIntegerOption(o => o.setName('amount').setDescription('Amount to bet from your wallet').setRequired(true).setMinValue(1))
                .addStringOption(o => o.setName('game').setDescription('Minigame to play (default: random)').setRequired(false)
                    .addChoices(
                        { name: '🪙 Coin Flip',           value: 'coinflip'   },
                        { name: '🎲 Dice Roll',            value: 'dice'       },
                        { name: '🃏 Higher Card',          value: 'highercard' },
                        { name: '✊ Rock Paper Scissors',  value: 'rps'        },
                        { name: '🎲 Random',               value: 'random'     }
                    )))
        .addSubcommand(sub =>
            sub.setName('ranked')
                .setDescription('Rated duel — updates your ELO and seasonal record.')
                .addUserOption(o => o.setName('user').setDescription('The user to challenge').setRequired(true))
                .addIntegerOption(o => o.setName('amount').setDescription('Amount to bet (server-configured minimum)').setRequired(true).setMinValue(1))
                .addStringOption(o => o.setName('game').setDescription('Minigame to play (default: random)').setRequired(false)
                    .addChoices(
                        { name: '🪙 Coin Flip',           value: 'coinflip'   },
                        { name: '🎲 Dice Roll',            value: 'dice'       },
                        { name: '🃏 Higher Card',          value: 'highercard' },
                        { name: '✊ Rock Paper Scissors',  value: 'rps'        },
                        { name: '🎲 Random',               value: 'random'     }
                    )))
        .addSubcommand(sub =>
            sub.setName('rank')
                .setDescription('Show your (or another user\'s) ranked duel rating and tier.')
                .addUserOption(o => o.setName('user').setDescription('User to inspect (defaults to yourself).').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('Show the top 10 ranked duelists on this server.')),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'casual')      return runChallenge(interaction, false);
        if (sub === 'ranked')      return runChallenge(interaction, true);
        if (sub === 'rank')        return runRankView(interaction);
        if (sub === 'leaderboard') return runLeaderboard(interaction);
    },
};
