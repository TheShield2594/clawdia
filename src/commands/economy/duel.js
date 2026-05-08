const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const { randomInt } = require('crypto');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

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

async function finalizeDuel({ interaction, targetUser, challengerId, opponentId, amount, currency, houseCut, challengerWins, tie, game, gameResult }) {
    const guildId = interaction.guild.id;
    // Escrow already deducted both stakes; compute payout from pot
    const pot         = 2 * amount;
    const houseAmount = Math.floor(pot * houseCut);
    const winnerPayout = pot - houseAmount; // escrowed funds returned to winner
    const netGain      = winnerPayout - amount; // winner's profit above their own stake

    let description;
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
        // Winner receives the full pot minus house cut; loser's stake was already taken by escrow
        await Promise.all([
            User.updateOne({ userId: winnerId, guildId }, { $inc: { balance: winnerPayout }, $set: { lastDuel: new Date() } }),
            User.updateOne({ userId: loserId,  guildId }, { $set: { lastDuel: new Date() } }),
        ]);
        description = `${gameResult}\n\n**${winnerName}** wins **${currency}${netGain.toLocaleString()}** net (after ${Math.round(houseCut * 100)}% house cut)!`;
    }

    const [challenger, opponent] = await Promise.all([
        User.findOne({ userId: challengerId, guildId }),
        User.findOne({ userId: opponentId,   guildId }),
    ]);

    const embed = new EmbedBuilder()
        .setColor(tie ? '#f39c12' : '#2ecc71')
        .setTitle(`⚔️ Duel Result — ${GAME_NAMES[game]}`)
        .setDescription(description)
        .addFields(
            { name: `${interaction.user.username}'s Balance`, value: `${currency}${(challenger?.balance ?? 0).toLocaleString()}`, inline: true },
            { name: `${targetUser.username}'s Balance`,       value: `${currency}${(opponent?.balance  ?? 0).toLocaleString()}`, inline: true },
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}

function errorEmbed(title, description) {
    return new EmbedBuilder().setColor('#e74c3c').setTitle(title).setDescription(description).setTimestamp();
}

async function runInstantGame(interaction, targetUser, amount, currency, houseCut, game) {
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
        await finalizeDuel({ interaction, targetUser, challengerId: interaction.user.id, opponentId: targetUser.id, amount, currency, houseCut, challengerWins, tie, game, gameResult });
    } catch (err) {
        console.error('Duel finalizeDuel error:', err);
        await refundEscrow(interaction.user.id, targetUser.id, interaction.guild.id, amount).catch(console.error);
        await interaction.editReply({ embeds: [errorEmbed('⚔️ Duel Error', 'Something went wrong settling the duel. Both bets have been refunded.')], components: [] }).catch(() => {});
    }
}

async function runRPS(interaction, msg, targetUser, amount, currency, houseCut, duelId) {
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
            embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors').setDescription(`**${interaction.user.username}**, choose your move! (30s)`).setTimestamp()],
            components: [buildRpsRow('c', duelId)],
        });
    } catch (err) {
        console.error('Duel RPS editReply error:', err);
        await refundEscrow(interaction.user.id, targetUser.id, guildId, amount).catch(console.error);
        return;
    }

    const cPrefix = `rpsc_${duelId}_`;
    const challengerCollector = msg.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && i.customId.startsWith(cPrefix) && RPS_MOVES.includes(i.customId.slice(cPrefix.length)),
        time: RPS_TIMEOUT_MS,
        max: 1,
    });

    challengerCollector.on('collect', async ci => {
        try {
            await ci.deferUpdate();
            const challengerMove = ci.customId.slice(cPrefix.length);

            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors').setDescription(`**${targetUser.username}**, choose your move! (30s)`).setTimestamp()],
                components: [buildRpsRow('o', duelId)],
            });

            const oPrefix = `rpso_${duelId}_`;
            const opponentCollector = msg.createMessageComponentCollector({
                filter: i => i.user.id === targetUser.id && i.customId.startsWith(oPrefix) && RPS_MOVES.includes(i.customId.slice(oPrefix.length)),
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
                            await finalizeDuel({ interaction, targetUser, challengerId: interaction.user.id, opponentId: targetUser.id, amount, currency, houseCut, challengerWins, tie, game: 'rps', gameResult });
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
                            embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('⚔️ Duel Expired').setDescription(`**${targetUser.username}** didn't pick a move in time. Both bets refunded.`).setTimestamp()],
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
                    embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('⚔️ Duel Expired').setDescription(`**${interaction.user.username}** didn't pick a move in time. Both bets refunded.`).setTimestamp()],
                    components: [],
                }).catch(() => {});
            });
        }
    });
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('duel')
        .setDescription('Challenge another user to a coin-bet duel')
        .setDMPermission(false)
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('The user to challenge')
                .setRequired(true))
        .addIntegerOption(opt =>
            opt.setName('amount')
                .setDescription('Amount to bet from your wallet')
                .setRequired(true)
                .setMinValue(1)),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        if (guildSettings?.economy?.duelEnabled === false) {
            return interaction.reply({ content: 'Duels are disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency    || '💰';
        const maxBet   = guildSettings?.economy?.duelMaxBet  ?? 10000;
        const houseCut = guildSettings?.economy?.duelHouseCut ?? 0.05;

        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "You can't duel yourself.", ephemeral: true });
        }
        if (target.bot) {
            return interaction.reply({ content: "You can't duel a bot.", ephemeral: true });
        }
        if (amount > maxBet) {
            return interaction.reply({ content: `The maximum bet on this server is **${currency}${maxBet.toLocaleString()}**.`, ephemeral: true });
        }

        const [challenger, opponent] = await Promise.all([
            User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
            User.findOneAndUpdate({ userId: target.id,           guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
        ]);

        if (challenger.lastDuel && Date.now() - new Date(challenger.lastDuel).getTime() < DUEL_COOLDOWN_MS) {
            const mins = Math.ceil((DUEL_COOLDOWN_MS - (Date.now() - new Date(challenger.lastDuel).getTime())) / 60_000);
            return interaction.reply({ content: `You're cooling down from your last duel. Try again in **${mins} min**.`, ephemeral: true });
        }
        if (opponent.lastDuel && Date.now() - new Date(opponent.lastDuel).getTime() < DUEL_COOLDOWN_MS) {
            const mins = Math.ceil((DUEL_COOLDOWN_MS - (Date.now() - new Date(opponent.lastDuel).getTime())) / 60_000);
            return interaction.reply({ content: `**${target.username}** is still on duel cooldown. Try again in **${mins} min**.`, ephemeral: true });
        }

        if (challenger.balance < amount) {
            return interaction.reply({ content: `You don't have enough ${currency}. Wallet: **${currency}${challenger.balance.toLocaleString()}**`, ephemeral: true });
        }

        const duelId = `${interaction.user.id}_${Date.now()}`;

        const challengeEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle('⚔️ Duel Challenge!')
            .setDescription(
                `**${interaction.user.username}** challenges <@${target.id}> to a duel!\n\n` +
                `Bet: **${currency}${amount.toLocaleString()}** each\n` +
                `House cut: **${Math.round(houseCut * 100)}%**\n\n` +
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
            filter: i => i.user.id === target.id && (i.customId === `duel_accept_${duelId}` || i.customId === `duel_decline_${duelId}`),
            time: ACCEPT_TIMEOUT_MS,
            max: 1,
        });

        acceptCollector.on('collect', async i => {
            let escrowTaken = false;
            try {
                await i.deferUpdate();

                if (i.customId === `duel_decline_${duelId}`) {
                    return interaction.editReply({
                        embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('⚔️ Duel Declined').setDescription(`**${target.username}** declined the challenge.`).setTimestamp()],
                        components: [],
                    });
                }

                // Atomically escrow wagers; re-validates live balances at deduction time
                const escrow = await takeEscrow(interaction.user.id, target.id, interaction.guild.id, amount);
                if (!escrow.success) {
                    const who = escrow.reason === 'challenger' ? interaction.user.username : target.username;
                    return interaction.editReply({
                        embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('⚔️ Duel Cancelled').setDescription(`**${who}** no longer has enough ${currency}.`).setTimestamp()],
                        components: [],
                    });
                }
                escrowTaken = true;

                const game = MINI_GAMES[randomInt(MINI_GAMES.length)];
                if (game === 'rps') {
                    await runRPS(interaction, msg, target, amount, currency, houseCut, duelId);
                } else {
                    await runInstantGame(interaction, target, amount, currency, houseCut, game);
                }
            } catch (err) {
                console.error('Duel accept collect error:', err);
                if (escrowTaken) {
                    await refundEscrow(interaction.user.id, target.id, interaction.guild.id, amount).catch(console.error);
                }
                await interaction.editReply({ embeds: [errorEmbed('⚔️ Duel Error', 'Something went wrong. Any escrowed bets have been refunded.')], components: [] }).catch(() => {});
            }
        });

        acceptCollector.on('end', async (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('⚔️ Duel Expired').setDescription(`The duel challenge to **${target.username}** expired.`).setTimestamp()],
                    components: [],
                }).catch(() => {});
            }
        });
    },
};
