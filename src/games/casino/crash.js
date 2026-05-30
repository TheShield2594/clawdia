const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect } = require('../../services/effectsService');
const {
    LOBBY_JOIN_WINDOW_MS,
    MAX_PLAYERS,
    createLobby,
    getLobby,
    deleteLobby,
    addPlayer,
} = require('../../utils/crashLobby');

const GROWTH  = 1.12;
const TICK_MS = 1200;
const MIN_BET = 10;
const MAX_BET = 5000;

function generateCrashPoint() {
    const r = Math.random();
    if (r < 0.01) return 1.00;
    return Math.min(100.00, parseFloat((0.99 / r).toFixed(2)));
}

function multiplierAt(tick) {
    return parseFloat(Math.pow(GROWTH, tick).toFixed(2));
}

function ticksUntilCrash(crashPoint) {
    return Math.ceil(Math.log(crashPoint) / Math.log(GROWTH));
}

function multLabel(m) {
    return m >= 10 ? m.toFixed(1) + 'x' : m.toFixed(2) + 'x';
}

function crashColor(m) {
    if (m < 1.5)  return '#00ff88';
    if (m < 2.0)  return '#44ff44';
    if (m < 3.0)  return '#aaee00';
    if (m < 5.0)  return '#ffdd00';
    if (m < 8.0)  return '#ffaa00';
    if (m < 15.0) return '#ff6600';
    return '#ff2200';
}

function riskLabel(m) {
    if (m < 1.5)  return '🟢 Safe Zone';
    if (m < 2.0)  return '🟢 Low Risk';
    if (m < 3.0)  return '🟡 Moderate';
    if (m < 5.0)  return '🟡 Risky';
    if (m < 8.0)  return '🟠 High Risk';
    if (m < 15.0) return '🔴 Danger!';
    return '🚨 EXTREME!';
}

function progressBar(m) {
    const total  = 20;
    const filled = Math.min(total, Math.round((Math.log(m) / Math.log(100)) * total));
    const empty  = total - filled;
    const glyph  = m < 5 ? '▰' : m < 15 ? '▮' : '█';
    return `\`${glyph.repeat(filled)}${'▱'.repeat(empty)}\``;
}

// ── Weekly leaderboard helpers ───────────────────────────────────────────────

function getCurrentWeekStart() {
    const now  = new Date();
    const day  = now.getDay(); // 0 = Sun
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // shift to Monday
    const mon  = new Date(now);
    mon.setDate(diff);
    mon.setHours(0, 0, 0, 0);
    return mon;
}

async function updateCrashStats(userId, guildId, multiplier) {
    const weekStart = getCurrentWeekStart();
    const user = await User.findOne({ userId, guildId }).catch(() => null);
    if (!user) return;

    const sameWeek = user.crashStats?.weekStart &&
        new Date(user.crashStats.weekStart).getTime() >= weekStart.getTime();

    const currentWeekBest = sameWeek ? (user.crashStats.weekBest ?? 0) : 0;
    const newWeekBest     = Math.max(currentWeekBest, multiplier);
    const newAllTime      = Math.max(user.crashStats?.allTimeBest ?? 0, multiplier);

    await User.updateOne({ userId, guildId }, {
        $set: {
            'crashStats.weekBest':    newWeekBest,
            'crashStats.weekStart':   weekStart,
            'crashStats.allTimeBest': newAllTime,
        },
    }).catch(() => {});
}

async function buildWeeklyLeaderboard(guildId, client) {
    const weekStart = getCurrentWeekStart();

    const topUsers = await User.find({
        guildId,
        'crashStats.weekStart': { $gte: weekStart },
        'crashStats.weekBest':  { $gt: 0 },
    })
        .sort({ 'crashStats.weekBest': -1 })
        .limit(10)
        .lean()
        .catch(() => []);

    if (topUsers.length === 0) {
        return new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('💥 Crash — Weekly Multiplier Leaderboard')
            .setDescription('No crash cash-outs recorded this week yet. Be the first!')
            .setFooter({ text: 'Resets every Monday at midnight UTC' });
    }

    const lines = [];
    for (let i = 0; i < topUsers.length; i++) {
        const u = topUsers[i];
        const medal = ['🥇','🥈','🥉'][i] ?? `**${i + 1}.**`;
        let username = u.userId;
        if (client) {
            const fetched = await client.users.fetch(u.userId).catch(() => null);
            if (fetched) username = fetched.username;
        }
        lines.push(`${medal} **${username}** — ${multLabel(u.crashStats.weekBest)}`);
    }

    return new EmbedBuilder()
        .setColor('#ffdd00')
        .setTitle('💥 Crash — Weekly Multiplier Leaderboard')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Week of ${weekStart.toDateString()} · Resets every Monday` })
        .setTimestamp();
}

// ── Lobby embed ──────────────────────────────────────────────────────────────

function lobbyEmbed(lobby, playerNames, autoCashout) {
    const secsLeft = Math.max(0, Math.ceil((lobby.joinDeadline - Date.now()) / 1000));
    const lines = playerNames.length
        ? playerNames.map(n => `• ${n}`).join('\n')
        : '*No players yet*';
    const acLine = autoCashout ? `\n🤖 Host auto cash-out: **${multLabel(autoCashout)}**` : '';
    return new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('💥 Crash — Lobby Open')
        .setDescription(
            `**Bet:** ${lobby.bet.toLocaleString()} coins each\n` +
            `**Joining:** ${lobby.players.size}/${MAX_PLAYERS} players\n` +
            acLine + '\n\n' +
            `**Players:**\n${lines}\n\n` +
            `Lobby closes in **${secsLeft}s** or when host starts.`
        )
        .setFooter({ text: 'Click Join to enter · Host can start early' })
        .setTimestamp();
}

function buildLobbyRow(lobbyId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`crash_join_${lobbyId}`)
            .setLabel('Join Lobby')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`crash_start_${lobbyId}`)
            .setLabel('Start Now')
            .setStyle(ButtonStyle.Success),
    );
}

// ── Live game embed ──────────────────────────────────────────────────────────

function liveMultiEmbed(multiplier, bet, playerLines) {
    const bar   = progressBar(multiplier);
    const label = multLabel(multiplier);
    return new EmbedBuilder()
        .setColor(crashColor(multiplier))
        .setTitle('💥 Crash — Live')
        .setDescription(
            `🚀 **Multiplier rising!**\n\n${bar}  **${label}**\n\n` +
            `${riskLabel(multiplier)}\n\n` +
            '**Players:**\n' + (playerLines.join('\n') || '*—*')
        )
        .addFields(
            { name: '📈 Multiplier', value: `**${label}**`,                  inline: true },
            { name: '💰 Bet',        value: `${bet.toLocaleString()} coins`, inline: true },
        )
        .setFooter({ text: 'Hit Cash Out before it crashes! Auto cash-out fires automatically.' });
}

// ── Final result embed ───────────────────────────────────────────────────────

async function buildFinalEmbed(crashPoint, bet, players, client, guildId) {
    const crashLabel = multLabel(crashPoint);
    const lines = [];
    for (const [uid, state] of players.entries()) {
        const user = await client.users.fetch(uid).catch(() => ({ username: uid }));
        if (state.cashedOutAt) {
            const payout = Math.floor(bet * state.cashedOutAt);
            const net    = payout - bet;
            const auto   = state.autoTriggered ? ' *(auto)*' : '';
            lines.push(`✅ **${user.username}** cashed at **${multLabel(state.cashedOutAt)}**${auto} (+${net.toLocaleString()} coins)`);
        } else {
            lines.push(`💀 **${user.username}** didn't cash out (-${bet.toLocaleString()} coins)`);
        }
    }
    return new EmbedBuilder()
        .setColor('#ff3333')
        .setTitle(`💥 Crashed at ${crashLabel}!`)
        .setDescription(lines.join('\n') || '*No players*')
        .setFooter({ text: 'The house always has a 1% edge — play responsibly!' })
        .setTimestamp();
}

module.exports = {
    name: 'crash',
    description: 'Multiplayer crash — bet and cash out before the curve crashes!',
    cooldown: 10,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Coins to bet (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true))
        .addNumberOption(opt =>
            opt.setName('auto_cashout')
                .setDescription('Auto cash out at this multiplier, e.g. 2.00 (optional)')
                .setMinValue(1.10)
                .setMaxValue(99.99)
                .setRequired(false)),

    async execute(interaction) {
        const bet         = interaction.options.getInteger('bet');
        const autoCashout = interaction.options.getNumber('auto_cashout') ?? null;
        const user        = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, user?.balance ?? 0, 'Crash');
        if (!shouldProceed) return;
        if (!alreadyReplied) await interaction.deferReply();
        await openLobby(interaction, bet, autoCashout);
    },
};

async function openLobby(interaction, bet, hostAutoCashout) {
    const channelId = interaction.channel.id;
    const lobbyId   = `${channelId}_${Date.now()}`;

    if (getLobby(channelId)) {
        return interaction.editReply({ content: 'A crash lobby is already open in this channel.', components: [] });
    }

    const lobby = createLobby(channelId, interaction.user.id, bet);
    if (!lobby) {
        return interaction.editReply({ content: 'A crash lobby is already open in this channel.', components: [] });
    }

    const deducted = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: bet } },
        { $inc: { balance: -bet, pendingCrashRefund: bet } },
        { new: true }
    );
    if (!deducted) {
        deleteLobby(channelId);
        return interaction.editReply({ content: `❌ Not enough coins! You need **${bet.toLocaleString()}** coins.`, components: [] });
    }

    // Add host with their auto cash-out preference
    addPlayer(channelId, interaction.user.id, hostAutoCashout);

    const msg = await interaction.editReply({
        embeds:     [lobbyEmbed(lobby, [interaction.user.username], hostAutoCashout)],
        components: [buildLobbyRow(lobbyId)],
    });

    const joinCollector = msg.createMessageComponentCollector({
        filter: i => i.customId === `crash_join_${lobbyId}` || i.customId === `crash_start_${lobbyId}`,
        time:   LOBBY_JOIN_WINDOW_MS + 5_000,
    });

    async function updateLobbyEmbed() {
        const names = [];
        for (const uid of lobby.players.keys()) {
            const u = await interaction.client.users.fetch(uid).catch(() => ({ username: uid }));
            names.push(u.username);
        }
        await interaction.editReply({
            embeds:     [lobbyEmbed(lobby, names, hostAutoCashout)],
            components: [buildLobbyRow(lobbyId)],
        }).catch(() => {});
    }

    joinCollector.on('collect', async i => {
        if (lobby.locked) { await i.deferUpdate().catch(() => {}); return; }

        if (i.customId === `crash_start_${lobbyId}`) {
            if (i.user.id !== lobby.hostId) {
                return i.reply({ content: 'Only the host can start early.', ephemeral: true });
            }
            await i.deferUpdate().catch(() => {});
            joinCollector.stop('started');
            return;
        }

        if (lobby.players.has(i.user.id)) {
            return i.reply({ content: "You're already in this lobby.", ephemeral: true });
        }
        if (lobby.players.size >= MAX_PLAYERS) {
            return i.reply({ content: 'Lobby is full.', ephemeral: true });
        }

        const deducted = await User.findOneAndUpdate(
            { userId: i.user.id, guildId: interaction.guild.id, balance: { $gte: bet } },
            { $inc: { balance: -bet, pendingCrashRefund: bet } },
            { new: true }
        );
        if (!deducted) {
            return i.reply({ content: `You need **${bet.toLocaleString()}** coins to join.`, ephemeral: true });
        }

        const joined = addPlayer(channelId, i.user.id); // no auto cash-out for non-host joiners
        if (!joined) {
            await User.findOneAndUpdate(
                { userId: i.user.id, guildId: interaction.guild.id },
                { $inc: { balance: bet } }
            ).catch(err => console.error('[crash] join refund failed:', err));
            return i.reply({ content: 'Could not join the lobby (it may have just filled up). Your coins have been refunded.', ephemeral: true });
        }
        await i.deferUpdate().catch(() => {});
        await updateLobbyEmbed();
    });

    joinCollector.on('end', async (_, reason) => {
        if (lobby.locked) return;
        lobby.locked = true;

        if (lobby.players.size === 0) {
            deleteLobby(channelId);
            await interaction.editReply({ content: 'Nobody joined — lobby cancelled.', components: [] }).catch(() => {});
            return;
        }

        await startCrashGame(interaction, lobby, lobbyId);
    });

    setTimeout(() => {
        if (!lobby.locked) joinCollector.stop('timeout');
    }, LOBBY_JOIN_WINDOW_MS);
}

async function startCrashGame(interaction, lobby, lobbyId) {
    const channelId = lobby.channelId;
    const bet       = lobby.bet;
    const guildId   = interaction.guild.id;

    const hostDoc     = await User.findOne({ userId: lobby.hostId, guildId });
    const luckyActive = hostDoc ? hasEffect(hostDoc, 'lucky_charm') : false;
    const crash       = luckyActive
        ? Math.min(100.00, parseFloat((generateCrashPoint() * 1.2).toFixed(2)))
        : generateCrashPoint();

    // Instant crash
    if (crash <= 1.00) {
        const loserIds = [...lobby.players.keys()];
        if (loserIds.length > 0) {
            User.updateMany(
                { userId: { $in: loserIds }, guildId },
                { $set: { pendingCrashRefund: 0 } }
            ).catch(err => console.error('[crash] failed to clear pendingCrashRefund on instant crash:', err));
        }
        const finalEmbed = await buildFinalEmbed(crash, bet, lobby.players, interaction.client, guildId);
        deleteLobby(channelId);
        return interaction.editReply({ embeds: [finalEmbed], components: [] }).catch(() => {});
    }

    let tick        = 0;
    let currentMult = multiplierAt(0);
    let gameOver    = false;
    const crashTick   = ticksUntilCrash(crash);
    const collectorMs = (crashTick + 3) * TICK_MS + 8000;

    async function getPlayerLines() {
        const lines = [];
        for (const [uid, state] of lobby.players.entries()) {
            const u = await interaction.client.users.fetch(uid).catch(() => ({ username: uid }));
            if (state.cashedOutAt) {
                const auto = state.autoTriggered ? ' *(auto)*' : '';
                lines.push(`✅ **${u.username}** cashed at **${multLabel(state.cashedOutAt)}**${auto}`);
            } else {
                const acHint = state.autoCashout ? ` *(auto @ ${multLabel(state.autoCashout)})*` : '';
                lines.push(`🎮 **${u.username}** — still in${acHint}`);
            }
        }
        return lines;
    }

    // Shared cash-out function used by both manual and auto triggers
    async function cashOutPlayer(uid, mult, autoTriggered = false) {
        const state = lobby.players.get(uid);
        if (!state || state.cashedOutAt !== null) return false;

        state.cashedOutAt    = mult;
        state.autoTriggered  = autoTriggered;

        const payout = Math.floor(bet * mult);
        await User.findOneAndUpdate(
            { userId: uid, guildId },
            { $inc: { balance: payout }, $set: { pendingCrashRefund: 0 } }
        );

        // Update weekly leaderboard stats
        await updateCrashStats(uid, guildId, mult);
        return true;
    }

    await interaction.editReply({
        embeds:     [liveMultiEmbed(currentMult, bet, await getPlayerLines())],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`crash_co_${lobbyId}`)
                .setLabel(`💰 Cash Out  ${multLabel(currentMult)}`)
                .setStyle(ButtonStyle.Success),
        )],
    }).catch(() => {});

    const message = await interaction.fetchReply().catch(() => null);
    if (!message) { deleteLobby(channelId); return; }

    const collector = message.createMessageComponentCollector({
        filter: i => i.customId === `crash_co_${lobbyId}` && lobby.players.has(i.user.id),
        time:   collectorMs,
    });

    collector.on('collect', async i => {
        if (gameOver) { await i.deferUpdate().catch(() => {}); return; }
        const state = lobby.players.get(i.user.id);
        if (!state || state.cashedOutAt !== null) {
            return i.reply({ content: "You've already cashed out.", ephemeral: true });
        }

        const cashed = await cashOutPlayer(i.user.id, currentMult, false);
        if (!cashed) {
            return i.reply({ content: "You've already cashed out.", ephemeral: true });
        }

        const payout = Math.floor(bet * currentMult);
        await i.reply({
            content: `✅ Cashed out at **${multLabel(currentMult)}** — **+${(payout - bet).toLocaleString()} coins**!`,
            ephemeral: true,
        }).catch(() => {});

        const lines = await getPlayerLines();
        await interaction.editReply({ embeds: [liveMultiEmbed(currentMult, bet, lines)] }).catch(() => {});
    });

    lobby.interval = setInterval(async () => {
        if (gameOver) return;

        tick++;
        currentMult = multiplierAt(tick);

        // Fire auto cash-outs for players whose target has been reached
        for (const [uid, state] of lobby.players.entries()) {
            if (!state.cashedOutAt && state.autoCashout && currentMult >= state.autoCashout) {
                await cashOutPlayer(uid, currentMult, true);
            }
        }

        if (currentMult >= crash) {
            gameOver = true;
            clearInterval(lobby.interval);
            collector.stop('crashed');

            const loserIds = [...lobby.players.entries()]
                .filter(([, s]) => s.cashedOutAt === null)
                .map(([uid]) => uid);
            if (loserIds.length > 0) {
                User.updateMany(
                    { userId: { $in: loserIds }, guildId },
                    { $set: { pendingCrashRefund: 0 } }
                ).catch(err => console.error('[crash] failed to clear pendingCrashRefund:', err));
            }

            const finalEmbed = await buildFinalEmbed(crash, bet, lobby.players, interaction.client, guildId);

            // Leaderboard button on result
            const lbId  = `crash_lb_${lobbyId}`;
            const lbRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(lbId)
                    .setLabel('📊 Weekly Leaderboard')
                    .setStyle(ButtonStyle.Secondary),
            );

            deleteLobby(channelId);
            await interaction.editReply({ embeds: [finalEmbed], components: [lbRow] }).catch(() => {});

            // Collect leaderboard button click
            const finalMsg = await interaction.fetchReply().catch(() => null);
            if (finalMsg) {
                finalMsg.createMessageComponentCollector({
                    filter: i => i.customId === lbId,
                    max:    1,
                    time:   60_000,
                }).on('collect', async i => {
                    const lbEmbed = await buildWeeklyLeaderboard(guildId, interaction.client);
                    await i.reply({ embeds: [lbEmbed], ephemeral: false }).catch(() => {});
                }).on('end', () => {
                    interaction.editReply({ components: [] }).catch(() => {});
                });
            }
            return;
        }

        const lines = await getPlayerLines();
        await interaction.editReply({
            embeds:     [liveMultiEmbed(currentMult, bet, lines)],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`crash_co_${lobbyId}`)
                    .setLabel(`💰 Cash Out  ${multLabel(currentMult)}`)
                    .setStyle(ButtonStyle.Success),
            )],
        }).catch(() => {});
    }, TICK_MS);

    collector.on('end', (_, reason) => {
        if (reason !== 'crashed' && !gameOver) {
            gameOver = true;
            clearInterval(lobby.interval);
            deleteLobby(channelId);
        }
    });
}
