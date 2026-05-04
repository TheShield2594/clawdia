const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

const ROWS = 8;          // Peg rows → 9 landing buckets
const MIN_BET = 10;
const MAX_BET = 5000;
const DELAY_MS = 550;    // ms between animation frames (safe under Discord rate limits)

// Payout multipliers for each of the 9 buckets (index 0 = leftmost, 8 = rightmost).
// Symmetric: edges pay big (rare), centre pays little (common).
// Expected value ≈ 0.916 (~8.4 % house edge).
//   EV = Σ C(8,k)/256 * MULTIPLIERS[k]
//      = (1·10 + 8·3 + 28·1.4 + 56·0.6 + 70·0.3 + …mirrored…) / 256
//      ≈ 234.6 / 256 ≈ 0.916
const MULTIPLIERS = [10, 3, 1.4, 0.6, 0.3, 0.6, 1.4, 3, 10];

// Returns an array of ROWS booleans: true = ball went right, false = left.
function generatePath() {
    return Array.from({ length: ROWS }, () => Math.random() < 0.5);
}

// positions[k] = number of right-moves taken in the first k steps.
// • positions[0] = 0  (top peg; only one peg so always column 0)
// • positions[ROWS] = final bucket index (0 .. ROWS)
function computePositions(path) {
    let col = 0;
    const positions = [0];
    for (const goRight of path) {
        if (goRight) col++;
        positions.push(col);
    }
    return positions;
}

// Renders the triangular peg board as a monospace code block.
// step 0 → ball is at row 0 (top); step ROWS → ball has left the board (in bucket).
//
// Symbols:  o = unvisited peg   . = ball trail   * = ball (current position)
function buildBoard(positions, step) {
    const lines = [];
    for (let row = 0; row < ROWS; row++) {
        const pad = ' '.repeat(ROWS - 1 - row);
        let rowStr;
        if (row < step) {
            // Ball already passed through this row — show the trail.
            rowStr = Array.from({ length: row + 1 }, (_, i) =>
                i === positions[row] ? '.' : 'o',
            ).join(' ');
        } else if (row === step) {
            // Ball is here right now.
            rowStr = Array.from({ length: row + 1 }, (_, i) =>
                i === positions[step] ? '*' : 'o',
            ).join(' ');
        } else {
            // Not yet reached.
            rowStr = Array.from({ length: row + 1 }, () => 'o').join(' ');
        }
        lines.push(pad + rowStr);
    }
    return '```\n' + lines.join('\n') + '\n```';
}

// Nine squares; the active bucket is highlighted with a yellow circle.
function buildBucketBar(bucket) {
    return Array.from({ length: ROWS + 1 }, (_, i) =>
        i === bucket ? '🟡' : '⬜',
    ).join('');
}

// Multiplier label row; the active bucket is bolded.
function buildMultLabels(bucket) {
    return MULTIPLIERS.map((m, i) =>
        i === bucket ? `**${m}x**` : `${m}x`,
    ).join(' · ');
}

// Path arrows revealed one by one during the animation.
function buildArrows(path, revealed) {
    if (revealed === 0) return '⬇️  *dropping…*';
    const arrows = path.slice(0, revealed).map(r => r ? '↘️' : '↙️').join('');
    return revealed < ROWS ? arrows + ' `…`' : arrows;
}

// Embed shown during the drop animation (one per row).
function frameEmbed(path, step, positions, bet, username) {
    return new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(step >= ROWS ? '🎱 Plinko — Landing…' : '🎱 Plinko — Ball Dropping…')
        .setDescription(
            `**${buildArrows(path, step)}**\n\n` +
            buildBoard(positions, step),
        )
        .addFields(
            { name: '💰 Bet', value: `${bet.toLocaleString()} coins`, inline: true },
            { name: '📍 Row', value: `${step} / ${ROWS}`,             inline: true },
        )
        .setFooter({ text: `Player: ${username}` });
}

// Final embed shown after the ball lands.
function resultEmbed(path, positions, bucket, multiplier, bet, payout, newBalance, username) {
    const net    = payout - bet;
    const netStr = net >= 0 ? `+${net.toLocaleString()}` : net.toLocaleString();
    const arrows = path.map(r => r ? '↘️' : '↙️').join('');

    return new EmbedBuilder()
        .setColor(payout >= bet ? '#00ff88' : '#ff4444')
        .setTitle('🎱 Plinko — Result!')
        .setDescription(
            `**Path:** ${arrows}\n\n` +
            buildBoard(positions, ROWS) + '\n' +
            buildBucketBar(bucket) + '\n' +
            buildMultLabels(bucket) + '\n\n' +
            `🎯 **Bucket ${bucket + 1} / 9** → **${multiplier}x multiplier!**`,
        )
        .addFields(
            { name: '💰 Bet',                              value: `${bet.toLocaleString()} coins`,    inline: true },
            { name: payout >= bet ? '🏆 Won' : '💸 Payout', value: `${payout.toLocaleString()} coins`, inline: true },
            { name: '📊 Net',                              value: `${netStr} coins`,                  inline: true },
            { name: '💰 Balance',                          value: `${newBalance.toLocaleString()} coins` },
        )
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('plinko')
        .setDescription('Drop a ball through pegs into multiplier buckets!')
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to bet (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true)),
    cooldown: 5,

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                content: 'This command can only be used in a server.',
                ephemeral: true,
            });
        }

        const bet = interaction.options.getInteger('bet');
        await interaction.deferReply();

        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
        let debited = null;
        let settled = false;

        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
                return interaction.editReply({ content: 'Economy games are disabled in this server.' });
            }

            // Ensure user document exists.
            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );

            // Atomic debit — only proceeds when balance covers the bet.
            debited = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: -bet } },
                { new: true },
            );

            if (!debited) {
                return interaction.editReply({
                    content: `You don't have enough coins to bet **${bet.toLocaleString()}**.`,
                });
            }

            // Determine the full path up front so the result is fixed before
            // any animation frames are sent (balance already updated).
            const path      = generatePath();
            const positions = computePositions(path);
            const bucket    = positions[ROWS];           // 0..8
            const multiplier = MULTIPLIERS[bucket];
            const payout    = Math.floor(bet * multiplier);
            const username  = interaction.user.username;
            const delay     = ms => new Promise(r => setTimeout(r, ms));

            // Frame 0: ball at the top peg.
            await interaction.editReply({
                embeds: [frameEmbed(path, 0, positions, bet, username)],
            });

            // Frames 1..ROWS: ball falls one row per frame.
            for (let step = 1; step <= ROWS; step++) {
                await delay(DELAY_MS);
                await interaction.editReply({
                    embeds: [frameEmbed(path, step, positions, bet, username)],
                }).catch(() => {});
            }

            // Credit the payout atomically.
            let updated = debited;
            if (payout > 0) {
                const credited = await User.findOneAndUpdate(
                    userFilter,
                    { $inc: { balance: payout } },
                    { new: true },
                );
                if (credited) {
                    updated = credited;
                } else {
                    // Document vanished between debit and credit (extremely unlikely).
                    // Attempt a plain read to show the real balance; fall back to 0.
                    console.error(`[Plinko] credit returned null for userId=${interaction.user.id} (${username})`);
                    updated = await User.findOne(userFilter) ?? { balance: 0 };
                }
            }
            settled = true;

            // Safe read: updated is guaranteed non-null at this point.
            const displayBalance = updated.balance ?? 0;

            await delay(400);
            await interaction.editReply({
                embeds: [resultEmbed(path, positions, bucket, multiplier, bet, payout, displayBalance, username)],
            });

        } catch (err) {
            console.error('[Plinko] error:', err);

            // Compensating rollback: if the bet was deducted but the round was
            // never settled, refund the wager so an error doesn't silently eat coins.
            if (debited && !settled) {
                try {
                    await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } });
                } catch (rollbackErr) {
                    console.error('[Plinko] rollback failed:', rollbackErr);
                }
            }

            await interaction.editReply({
                content: 'Something went wrong while playing Plinko. Your bet has been refunded — please try again.',
            }).catch(() => {});
        }
    },
};
