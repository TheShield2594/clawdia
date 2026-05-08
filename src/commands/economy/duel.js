const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

const DUEL_COOLDOWN_MS = 5 * 60_000;
const ACCEPT_TIMEOUT_MS = 60_000;
const RPS_TIMEOUT_MS = 30_000;

const MINI_GAMES = ['coinflip', 'dice', 'highercard', 'rps'];
const GAME_NAMES = {
    coinflip: '🪙 Coin Flip',
    dice: '🎲 Dice Roll',
    highercard: '🃏 Higher Card',
    rps: '✊ Rock Paper Scissors',
};

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const CARD_RANK = Object.fromEntries(VALUES.map((v, i) => [v, i]));

const RPS_MOVES = ['rock', 'paper', 'scissors'];
const RPS_EMOJI = { rock: '✊', paper: '🖐️', scissors: '✌️' };

function drawCard() {
    return {
        suit: SUITS[Math.floor(Math.random() * SUITS.length)],
        value: VALUES[Math.floor(Math.random() * VALUES.length)],
    };
}

async function saveTwo(userA, userB) {
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await userA.save({ session });
            await userB.save({ session });
        });
    } finally {
        await session.endSession();
    }
}

// customId format: rpsc_{duelId}_{move} or rpso_{duelId}_{move}
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

async function finalizeDuel(interaction, targetUser, challengerId, opponentId, amount, currency, houseCut, challengerWins, tie, game, gameResult) {
    const [challenger, opponent] = await Promise.all([
        User.findOne({ userId: challengerId, guildId: interaction.guild.id }),
        User.findOne({ userId: opponentId, guildId: interaction.guild.id }),
    ]);

    challenger.lastDuel = new Date();
    opponent.lastDuel = new Date();

    let description;
    if (tie) {
        description = `${gameResult}\n\n**It's a tie!** Both bets returned.`;
        await saveTwo(challenger, opponent);
    } else {
        const winner = challengerWins ? challenger : opponent;
        const loser = challengerWins ? opponent : challenger;
        const winnerName = challengerWins ? interaction.user.username : targetUser.username;

        const houseAmount = Math.floor(2 * amount * houseCut);
        const netGain = amount - houseAmount;

        loser.balance = Math.max(0, loser.balance - amount);
        winner.balance += netGain;

        description = `${gameResult}\n\n**${winnerName}** wins **${currency}${netGain.toLocaleString()}** net (after ${Math.round(houseCut * 100)}% house cut)!`;
        await saveTwo(challenger, opponent);
    }

    const embed = new EmbedBuilder()
        .setColor(tie ? '#f39c12' : '#2ecc71')
        .setTitle(`⚔️ Duel Result — ${GAME_NAMES[game]}`)
        .setDescription(description)
        .addFields(
            { name: `${interaction.user.username}'s Balance`, value: `${currency}${challenger.balance.toLocaleString()}`, inline: true },
            { name: `${targetUser.username}'s Balance`, value: `${currency}${opponent.balance.toLocaleString()}`, inline: true },
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}

async function runInstantGame(interaction, targetUser, amount, currency, houseCut, game) {
    let challengerWins = false;
    let tie = false;
    let gameResult = '';

    if (game === 'coinflip') {
        challengerWins = Math.random() < 0.5;
        const face = challengerWins ? 'Heads' : 'Tails';
        gameResult = `🪙 **Coin Flip**: ${face}\n${challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`}`;
    } else if (game === 'dice') {
        const cRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
        const oRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
        if (cRoll > oRoll) challengerWins = true;
        else if (cRoll === oRoll) tie = true;
        gameResult = `🎲 **${interaction.user.username}** rolled **${cRoll}** · **${targetUser.username}** rolled **${oRoll}**\n${tie ? "It's a tie!" : (challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`)}`;
    } else if (game === 'highercard') {
        const cCard = drawCard();
        const oCard = drawCard();
        const cRank = CARD_RANK[cCard.value];
        const oRank = CARD_RANK[oCard.value];
        if (cRank > oRank) challengerWins = true;
        else if (cRank === oRank) tie = true;
        gameResult = `🃏 **${interaction.user.username}** drew **${cCard.value}${cCard.suit}** · **${targetUser.username}** drew **${oCard.value}${oCard.suit}**\n${tie ? "It's a tie!" : (challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`)}`;
    }

    await finalizeDuel(interaction, targetUser, interaction.user.id, targetUser.id, amount, currency, houseCut, challengerWins, tie, game, gameResult);
}

async function runRPS(interaction, msg, targetUser, amount, currency, houseCut, duelId) {
    const challengerPickEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('✊ Rock Paper Scissors')
        .setDescription(`**${interaction.user.username}**, choose your move! (30s)`)
        .setTimestamp();

    await interaction.editReply({ embeds: [challengerPickEmbed], components: [buildRpsRow('c', duelId)] });

    const cPrefix = `rpsc_${duelId}_`;
    const challengerCollector = msg.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && i.customId.startsWith(cPrefix) && RPS_MOVES.includes(i.customId.slice(cPrefix.length)),
        time: RPS_TIMEOUT_MS,
        max: 1,
    });

    challengerCollector.on('collect', async ci => {
        await ci.deferUpdate();
        const challengerMove = ci.customId.slice(cPrefix.length);

        const opponentPickEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('✊ Rock Paper Scissors')
            .setDescription(`**${targetUser.username}**, choose your move! (30s)`)
            .setTimestamp();

        await interaction.editReply({ embeds: [opponentPickEmbed], components: [buildRpsRow('o', duelId)] });

        const oPrefix = `rpso_${duelId}_`;
        const opponentCollector = msg.createMessageComponentCollector({
            filter: i => i.user.id === targetUser.id && i.customId.startsWith(oPrefix) && RPS_MOVES.includes(i.customId.slice(oPrefix.length)),
            time: RPS_TIMEOUT_MS,
            max: 1,
        });

        opponentCollector.on('collect', async oi => {
            await oi.deferUpdate();
            const opponentMove = oi.customId.slice(oPrefix.length);

            let challengerWins = false;
            let tie = false;
            if (challengerMove === opponentMove) {
                tie = true;
            } else if (
                (challengerMove === 'rock' && opponentMove === 'scissors') ||
                (challengerMove === 'paper' && opponentMove === 'rock') ||
                (challengerMove === 'scissors' && opponentMove === 'paper')
            ) {
                challengerWins = true;
            }

            const gameResult = `${RPS_EMOJI[challengerMove]} **${interaction.user.username}**: ${challengerMove}\n${RPS_EMOJI[opponentMove]} **${targetUser.username}**: ${opponentMove}\n${tie ? "It's a tie!" : (challengerWins ? `**${interaction.user.username}** wins!` : `**${targetUser.username}** wins!`)}`;
            await finalizeDuel(interaction, targetUser, interaction.user.id, targetUser.id, amount, currency, houseCut, challengerWins, tie, 'rps', gameResult);
        });

        opponentCollector.on('end', async (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                const embed = new EmbedBuilder()
                    .setColor('#95a5a6')
                    .setTitle('⚔️ Duel Expired')
                    .setDescription(`**${targetUser.username}** didn't pick a move in time. No coins were exchanged.`)
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
            }
        });
    });

    challengerCollector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            const embed = new EmbedBuilder()
                .setColor('#95a5a6')
                .setTitle('⚔️ Duel Expired')
                .setDescription(`**${interaction.user.username}** didn't pick a move in time. No coins were exchanged.`)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
        }
    });
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('duel')
        .setDescription('Challenge another user to a coin-bet duel')
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
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        if (guildSettings?.economy?.duelEnabled === false) {
            return interaction.reply({ content: 'Duels are disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const maxBet = guildSettings?.economy?.duelMaxBet ?? 10000;
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

        const challenger = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            {},
            { upsert: true, new: true }
        );

        if (challenger.lastDuel && Date.now() - new Date(challenger.lastDuel).getTime() < DUEL_COOLDOWN_MS) {
            const remaining = DUEL_COOLDOWN_MS - (Date.now() - new Date(challenger.lastDuel).getTime());
            const mins = Math.ceil(remaining / 60_000);
            return interaction.reply({ content: `You're cooling down from your last duel. Try again in **${mins} min**.`, ephemeral: true });
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
            new ButtonBuilder()
                .setCustomId(`duel_accept_${duelId}`)
                .setLabel('Accept')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`duel_decline_${duelId}`)
                .setLabel('Decline')
                .setStyle(ButtonStyle.Danger),
        );

        await interaction.reply({ embeds: [challengeEmbed], components: [row] });
        const msg = await interaction.fetchReply();

        const acceptCollector = msg.createMessageComponentCollector({
            filter: i => i.user.id === target.id && (i.customId === `duel_accept_${duelId}` || i.customId === `duel_decline_${duelId}`),
            time: ACCEPT_TIMEOUT_MS,
            max: 1,
        });

        acceptCollector.on('collect', async i => {
            await i.deferUpdate();

            if (i.customId === `duel_decline_${duelId}`) {
                const embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('⚔️ Duel Declined')
                    .setDescription(`**${target.username}** declined the challenge.`)
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed], components: [] });
            }

            // Re-verify balances at accept time
            const [freshChallenger, freshOpponent] = await Promise.all([
                User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
                User.findOneAndUpdate({ userId: target.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
            ]);

            if (!freshChallenger || freshChallenger.balance < amount) {
                const embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('⚔️ Duel Cancelled')
                    .setDescription(`**${interaction.user.username}** no longer has enough ${currency}.`)
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed], components: [] });
            }
            if (freshOpponent.balance < amount) {
                const embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('⚔️ Duel Cancelled')
                    .setDescription(`**${target.username}** doesn't have enough ${currency}.`)
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed], components: [] });
            }

            const game = MINI_GAMES[Math.floor(Math.random() * MINI_GAMES.length)];

            if (game === 'rps') {
                await runRPS(interaction, msg, target, amount, currency, houseCut, duelId);
            } else {
                await runInstantGame(interaction, target, amount, currency, houseCut, game);
            }
        });

        acceptCollector.on('end', async (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                const embed = new EmbedBuilder()
                    .setColor('#95a5a6')
                    .setTitle('⚔️ Duel Expired')
                    .setDescription(`The duel challenge to **${target.username}** expired.`)
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
            }
        });
    },
};
