const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const THUMB    = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b1.png';
const ROWS     = 8;
const MIN_BET  = 10;
const MAX_BET  = 5000;
const DELAY_MS = 500;

const MULTIPLIERS = [10, 3, 1.4, 0.6, 0.3, 0.6, 1.4, 3, 10];

// Color-coded bucket emojis based on multiplier tier
const BUCKET_EMOJI = [
    '🟣', // 10x  — jackpot purple
    '🔵', // 3x   — blue
    '🟢', // 1.4x — green
    '🟡', // 0.6x — yellow
    '🔴', // 0.3x — red (loss)
    '🟡', // 0.6x — yellow
    '🟢', // 1.4x — green
    '🔵', // 3x   — blue
    '🟣', // 10x  — jackpot purple
];

function generatePath() {
    return Array.from({ length: ROWS }, () => Math.random() < 0.5);
}

function computePositions(path) {
    let col = 0;
    const positions = [0];
    for (const goRight of path) {
        if (goRight) col++;
        positions.push(col);
    }
    return positions;
}

// Monospace board: o = peg, . = trail, * = ball current position
function buildBoard(positions, step) {
    const lines = [];
    for (let row = 0; row < ROWS; row++) {
        const pad = ' '.repeat(ROWS - 1 - row);
        let rowStr;
        if (row < step) {
            rowStr = Array.from({ length: row + 1 }, (_, i) =>
                i === positions[row] ? '·' : 'o').join(' ');
        } else if (row === step) {
            rowStr = Array.from({ length: row + 1 }, (_, i) =>
                i === positions[step] ? '●' : 'o').join(' ');
        } else {
            rowStr = Array.from({ length: row + 1 }, () => 'o').join(' ');
        }
        lines.push(pad + rowStr);
    }
    return '```\n' + lines.join('\n') + '\n```';
}

// Bottom bucket display with the active bucket highlighted
function buildBucketBar(bucket) {
    return BUCKET_EMOJI.map((e, i) => i === bucket ? `**${e}**` : e).join('');
}

function buildMultLabels(bucket) {
    return MULTIPLIERS.map((m, i) =>
        i === bucket ? `**${m}x**` : `${m}x`).join(' · ');
}

function buildArrows(path, revealed) {
    if (revealed === 0) return '⬇️ *dropping…*';
    const arrows = path.slice(0, revealed).map(r => r ? '↘️' : '↙️').join('');
    return revealed < ROWS ? arrows + ' `…`' : arrows;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function frameEmbed(path, step, positions, bet, interaction) {
    const title = step >= ROWS ? '🎱 Plinko — Landing…' : `🎱 Plinko — Row ${step + 1} of ${ROWS}`;
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#FFD700')
        .setTitle(title)
        .setDescription(
            `**${buildArrows(path, step)}**\n\n` +
            buildBoard(positions, step),
        )
        .addFields(
            { name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true },
            { name: '📍 Progress', value: `Row **${step}** / ${ROWS}`, inline: true },
        )
        .setFooter({ text: '🟣10x  🔵3x  🟢1.4x  🟡0.6x  🔴0.3x' });
}

function resultEmbed(path, positions, bucket, multiplier, bet, payout, newBalance, interaction) {
    const net    = payout - bet;
    const netStr = net >= 0 ? `+${net.toLocaleString()}` : net.toLocaleString();
    const arrows = path.map(r => r ? '↘️' : '↙️').join('');

    const isWin   = payout >= bet;
    const color   = multiplier >= 3 ? '#a855f7' : multiplier >= 1.4 ? '#22cc66' : multiplier >= 0.6 ? '#f1c40f' : '#ff4444';
    const outcome = multiplier >= 10 ? '🎉 **JACKPOT BUCKET!**' : multiplier >= 3 ? '🏆 **Big win!**' : multiplier >= 1 ? '✅ **Profit!**' : multiplier >= 0.6 ? '🟡 **Partial return**' : '💀 **Low bucket**';

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🎱 Plinko — Result!')
        .setDescription(
            `**Path:** ${arrows}\n\n` +
            buildBoard(positions, ROWS) +
            buildBucketBar(bucket) + '\n' +
            buildMultLabels(bucket) + '\n\n' +
            `${BUCKET_EMOJI[bucket]} **Bucket ${bucket + 1}/9** — **${multiplier}x** multiplier!\n${outcome}`,
        )
        .addFields(
            { name: '💰 Bet',                              value: `${bet.toLocaleString()} coins`,    inline: true },
            { name: isWin ? '🏆 Payout' : '💸 Payout',    value: `${payout.toLocaleString()} coins`, inline: true },
            { name: '📊 Net',                              value: `**${netStr}** coins`,              inline: true },
            { name: '💰 Balance',                          value: `**${newBalance.toLocaleString()}** coins` },
        )
        .setFooter({ text: 'Edges pay 10x — centre pays 0.3x  •  Ball path is random' })
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
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }
        const bet = interaction.options.getInteger('bet');
        await interaction.deferReply();
        await playPlinko(interaction, bet);
    },
};

async function playPlinko(interaction, bet) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let debited = null;
    let settled = false;

    try {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            return interaction.editReply({ content: 'Economy games are disabled in this server.' });
        }

        await User.findOneAndUpdate(
            userFilter,
            { $setOnInsert: { ...userFilter, balance: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        debited = await User.findOneAndUpdate(
            { ...userFilter, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true },
        );

        if (!debited) {
            return interaction.editReply({
                content: `❌ Not enough coins to bet **${bet.toLocaleString()}**.`,
            });
        }

        const path       = generatePath();
        const positions  = computePositions(path);
        const bucket     = positions[ROWS];
        const multiplier = MULTIPLIERS[bucket];
        const payout     = Math.floor(bet * multiplier);
        const delay      = ms => new Promise(r => setTimeout(r, ms));

        await interaction.editReply({ embeds: [frameEmbed(path, 0, positions, bet, interaction)] });

        for (let step = 1; step <= ROWS; step++) {
            await delay(DELAY_MS);
            await interaction.editReply({
                embeds: [frameEmbed(path, step, positions, bet, interaction)],
            }).catch(() => {});
        }

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
                console.error(`[Plinko] credit returned null for userId=${interaction.user.id}`);
                updated = await User.findOne(userFilter) ?? { balance: 0 };
            }
        }
        settled = true;

        const replayId = `plinko_replay_${interaction.id}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('🎱 Drop Again').setStyle(ButtonStyle.Primary),
        );

        await delay(400);
        await interaction.editReply({
            embeds: [resultEmbed(path, positions, bucket, multiplier, bet, payout, updated.balance ?? 0, interaction)],
            components: [row],
        });

        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        });
        collector.on('collect', async i => {
            await i.deferUpdate();
            await playPlinko(interaction, bet);
        });
        collector.on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Plinko] error:', err);
        if (debited && !settled) {
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(e =>
                console.error('[Plinko] rollback failed:', e));
        }
        await interaction.editReply({
            content: 'Something went wrong. Your bet has been refunded — please try again.',
            components: [],
        }).catch(() => {});
    }
}
