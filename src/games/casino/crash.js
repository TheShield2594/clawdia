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
const { hasEffect, luckySaveEligible } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');
const { ownedByMembers } = require('../../utils/collectorOwner');
const {
    LOBBY_JOIN_WINDOW_MS,
    MAX_PLAYERS,
    createLobby,
    getLobby,
    deleteLobby,
    addPlayer,
} = require('../../utils/crashLobby');
const {
    generateCrashPoint,
    multiplierAt,
    ticksUntilCrash,
    multLabel,
} = require('./crashCurve');
const { creditCoinsOnce, casinoPayoutKey } = require('../../utils/payoutKey');
const { counterSetExpr } = require('../../utils/balanceDebit');
const { creditCoinsOrOwe } = require('../../utils/creditOrOwe');

const TICK_MS = 1200;
const MIN_BET = 10;

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
    const day  = now.getUTCDay(); // 0 = Sun
    const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1); // shift to Monday
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), diff));
}

async function updateCrashStats(userId, guildId, multiplier, username) {
    const weekStart = getCurrentWeekStart();

    // Same-week path: atomically raise weekBest and allTimeBest without reading first.
    const sameWeek = await User.updateOne(
        { userId, guildId, 'crashStats.weekStart': { $gte: weekStart } },
        {
            $max: { 'crashStats.weekBest': multiplier, 'crashStats.allTimeBest': multiplier },
            ...(username && { $set: { 'crashStats.username': username } }),
        }
    ).catch(() => null);

    if (sameWeek?.matchedCount === 0) {
        // Week rollover or first record: reset weekBest/weekStart, still $max allTimeBest.
        await User.updateOne(
            {
                userId, guildId,
                $or: [
                    { 'crashStats.weekStart': { $lt: weekStart } },
                    { 'crashStats.weekStart': null },
                ],
            },
            {
                $set: {
                    'crashStats.weekBest':  multiplier,
                    'crashStats.weekStart': weekStart,
                    ...(username && { 'crashStats.username': username }),
                },
                $max: { 'crashStats.allTimeBest': multiplier },
            }
        ).catch(err => console.error('[crash] weekRollover update failed:', err));

        // A concurrent request that also hit the rollover path may have won the
        // conditional $or race and set weekStart already, causing the update above
        // to match nothing. Run an unconditional $max so allTimeBest is never missed.
        await User.updateOne(
            { userId, guildId },
            { $max: { 'crashStats.allTimeBest': multiplier } }
        ).catch(err => console.error('[crash] allTimeBest fallback failed:', err));
    }
}

async function buildWeeklyLeaderboard(guildId, _client) {
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
            .setColor(COLORS.INFO)
            .setTitle('💥 Crash — Weekly Multiplier Leaderboard')
            .setDescription('No crash cash-outs recorded this week yet. Be the first!')
            .setFooter({ text: 'Resets every Monday at midnight UTC' });
    }

    const lines = [];
    for (let i = 0; i < topUsers.length; i++) {
        const u        = topUsers[i];
        const medal    = ['🥇','🥈','🥉'][i] ?? `**${i + 1}.**`;
        const username = u.crashStats.username ?? u.userId;
        lines.push(`${medal} **${username}** — ${multLabel(u.crashStats.weekBest)}`);
    }

    return new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle('💥 Crash — Weekly Multiplier Leaderboard')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Week of ${weekStart.toDateString()} · Resets every Monday` })
        .setTimestamp();
}

// ── Lobby embed ──────────────────────────────────────────────────────────────

function lobbyEmbed(lobby, playerNames, autoCashout, crashHistory) {
    const secsLeft = Math.max(0, Math.ceil((lobby.joinDeadline - Date.now()) / 1000));
    const lines = playerNames.length
        ? playerNames.map(n => `• ${n}`).join('\n')
        : '*No players yet*';
    const acLine = autoCashout ? `\n🤖 Host auto cash-out: **${multLabel(autoCashout)}**` : '';
    const historyLine = crashHistory?.length
        ? `\n💥 Recent Crashes: ${crashHistory.slice(-5).map(c => `**${multLabel(c)}**`).join(' · ')}\n*Is a big one coming?* 🤔`
        : '';
    return new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('💥 Crash — Lobby Open')
        .setDescription(
            `**Bet:** ${lobby.bet.toLocaleString()} coins each\n` +
            `**Joining:** ${lobby.players.size}/${MAX_PLAYERS} players\n` +
            acLine +
            historyLine + '\n\n' +
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

async function buildFinalEmbed(crashPoint, bet, players, client, _guildId) {
    const crashLabel = multLabel(crashPoint);
    const lines = [];
    for (const [uid, state] of players.entries()) {
        const user = await client.users.fetch(uid).catch(() => null) ?? { username: uid };
        if (state.cashedOutAt) {
            const payout = Math.floor(bet * state.cashedOutAt);
            const net    = payout - bet;
            const auto   = state.autoTriggered ? ' *(auto)*' : '';
            lines.push(`✅ **${user.username}** cashed at **${multLabel(state.cashedOutAt)}**${auto} (+${net.toLocaleString()} coins)`);
        } else if (state.cashFailed) {
            const net = Math.floor(bet * state.cashFailedAt) - bet;
            lines.push(state.cashOutcome === 'owed'
                ? `⏳ **${user.username}** cashed at **${multLabel(state.cashFailedAt)}** (+${net.toLocaleString()} coins) — recorded, not yet paid`
                : `⚠️ **${user.username}** cashed at **${multLabel(state.cashFailedAt)}** — payout could not be credited or recorded`);
        } else {
            lines.push(`💀 **${user.username}** didn't cash out (-${bet.toLocaleString()} coins)`);
        }
    }
    return new EmbedBuilder()
        .setColor(COLORS.ERROR)
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
                .setDescription(`Coins to bet (min ${MIN_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(1_000_000_000)
                .setRequired(true))
        .addNumberOption(opt =>
            opt.setName('auto_cashout')
                .setDescription('Auto cash out at this multiplier, e.g. 2.00 (optional)')
                .setMinValue(1.10)
                .setMaxValue(99.99)
                .setRequired(false)),

    async execute(interaction, { releaseLock, onWager } = {}) {
        const bet         = interaction.options.getInteger('bet');
        const autoCashout = interaction.options.getNumber('auto_cashout') ?? null;
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const casinoMaxBet  = guildSettings?.economy?.casinoMaxBet ?? 0;
        if (casinoMaxBet > 0 && bet > casinoMaxBet) {
            releaseLock?.();
            return interaction.reply({ content: `❌ The casino bet limit on this server is **${casinoMaxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }
        const user        = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, user?.balance ?? 0, 'Crash', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }
        if (!alreadyReplied) await interaction.deferReply();
        await openLobby(interaction, bet, autoCashout, releaseLock, onWager);
    },
};

// releaseLock is called as soon as the host's bet is committed (the lobby
// is created and the host's debit succeeds) — the host's casino lock isn't
// held through the lobby wait + the multiplayer game itself, since their
// stake is already atomically deducted and can't be double-spent.
async function openLobby(interaction, bet, hostAutoCashout, releaseLock, onWager) {
    const channelId = interaction.channel.id;
    const lobbyId   = `${channelId}_${Date.now()}`;

    if (getLobby(channelId)) {
        releaseLock?.();
        return interaction.editReply({ content: 'A crash lobby is already open in this channel.', components: [] });
    }

    const lobby = createLobby(channelId, interaction.user.id, bet, interaction.guild.id);
    if (!lobby) {
        releaseLock?.();
        return interaction.editReply({ content: 'A crash lobby is already open in this channel.', components: [] });
    }

    const deducted = await placeWager(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        bet,
        { extraInc: { pendingCrashRefund: bet }, onWager },
    );
    if (!deducted) {
        deleteLobby(channelId);
        releaseLock?.();
        return interaction.editReply({ content: `❌ Not enough coins! You need **${bet.toLocaleString()}** coins.`, components: [] });
    }

    // Add host with their auto cash-out preference
    addPlayer(channelId, interaction.user.id, hostAutoCashout, interaction.user.username);
    releaseLock?.();

    const guildDoc     = await Guild.findOne({ guildId: interaction.guild.id }, 'casinoStats').lean().catch(() => null);
    const crashHistory = guildDoc?.casinoStats?.crashHistory ?? [];

    const msg = await interaction.editReply({
        embeds:     [lobbyEmbed(lobby, [interaction.user.username], hostAutoCashout, crashHistory)],
        components: [buildLobbyRow(lobbyId)],
    });

    const joinCollector = msg.createMessageComponentCollector({
        filter: i => i.customId === `crash_join_${lobbyId}` || i.customId === `crash_start_${lobbyId}`,
        time:   LOBBY_JOIN_WINDOW_MS + 5_000,
    });

    async function updateLobbyEmbed() {
        const names = [];
        for (const uid of lobby.players.keys()) {
            const u = await interaction.client.users.fetch(uid).catch(() => null) ?? { username: uid };
            names.push(u.username);
        }
        await interaction.editReply({
            embeds:     [lobbyEmbed(lobby, names, hostAutoCashout, crashHistory)],
            components: [buildLobbyRow(lobbyId)],
        }).catch(() => {});
    }

    joinCollector.on('collect', async i => {
        if (lobby.locked) { await i.deferUpdate().catch(() => {}); return; }

        if (i.customId === `crash_start_${lobbyId}`) {
            if (i.user.id !== lobby.hostId) {
                return i.reply({ content: 'Only the host can start early.', flags: MessageFlags.Ephemeral });
            }
            await i.deferUpdate().catch(() => {});
            joinCollector.stop('started');
            return;
        }

        if (lobby.players.has(i.user.id)) {
            return i.reply({ content: "You're already in this lobby.", flags: MessageFlags.Ephemeral });
        }
        if (lobby.players.size >= MAX_PLAYERS) {
            return i.reply({ content: 'Lobby is full.', flags: MessageFlags.Ephemeral });
        }

        // A joiner stakes their own coins on somebody else's command, so the
        // wager is reported against them — the jackpot is credited to whoever
        // wins it and the mission ticks for the player who actually bet.
        //
        // The debit is not the last thing that can go wrong here, though: the
        // seat is claimed after it, and a lobby that filled in between refunds
        // the stake. Reporting from inside placeWager would contribute to the
        // jackpot and tick the mission for a bet that was then handed straight
        // back — the same "counted a hand that never happened" this signal
        // exists to stop. So the debit stays silent and the wager is reported
        // once the seat is actually theirs.
        const deducted = await placeWager(
            { userId: i.user.id, guildId: interaction.guild.id },
            bet,
            { extraInc: { pendingCrashRefund: bet } },
        );
        if (!deducted) {
            return i.reply({ content: `You need **${bet.toLocaleString()}** coins to join.`, flags: MessageFlags.Ephemeral });
        }

        const joined = addPlayer(channelId, i.user.id, null, i.user.username); // no auto cash-out for non-host joiners
        if (!joined) {
            // The stake goes back, and so does the `lifetimeGambled` placeWager
            // counted with the debit: coins handed straight back were never
            // risked, and the wagering achievements must not count them.
            await User.findOneAndUpdate(
                { userId: i.user.id, guildId: interaction.guild.id },
                { $inc: { balance: bet, pendingCrashRefund: -bet, lifetimeGambled: -bet } }
            ).catch(err => console.error('[crash] join refund failed:', err));
            return i.reply({ content: 'Could not join the lobby (it may have just filled up). Your coins have been refunded.', flags: MessageFlags.Ephemeral });
        }

        // Their button interaction carries the channel a jackpot would announce in.
        onWager?.({ amount: bet, user: i.user, source: i });
        await i.deferUpdate().catch(() => {});
        await updateLobbyEmbed();
    });

    joinCollector.on('end', async (_, _reason) => {
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
    // Charm boost only applies to low-stakes lobbies — a +20% crash-point shift on an
    // unbounded bet would flip the game's expected value player-positive.
    const luckyActive = hostDoc ? hasEffect(hostDoc, 'lucky_charm') && luckySaveEligible(lobby.bet) : false;
    const crash       = luckyActive
        ? Math.min(100.00, parseFloat((generateCrashPoint() * 1.2).toFixed(2)))
        : generateCrashPoint();

    // Instant crash
    if (crash <= 1.00) {
        // Nobody can have cashed out yet — the game ends before the first tick —
        // so every player is a loser here and none has a marker worth keeping.
        const loserIds = [...lobby.players.keys()];
        if (loserIds.length > 0) {
            User.updateMany(
                { userId: { $in: loserIds }, guildId, pendingCrashRefund: { $gte: bet } },
                { $inc: { pendingCrashRefund: -bet } }
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
            const u = await interaction.client.users.fetch(uid).catch(() => null) ?? { username: uid };
            if (state.cashedOutAt) {
                const auto = state.autoTriggered ? ' *(auto)*' : '';
                lines.push(`✅ **${u.username}** cashed at **${multLabel(state.cashedOutAt)}**${auto}`);
            } else if (state.cashFailed) {
                lines.push(`⏳ **${u.username}** cashed at **${multLabel(state.cashFailedAt)}** — payout pending`);
            } else {
                const acHint = state.autoCashout ? ` *(auto @ ${multLabel(state.autoCashout)})*` : '';
                lines.push(`🎮 **${u.username}** — still in${acHint}`);
            }
        }
        return lines;
    }

    /**
     * Shared cash-out, for both the button and the auto-cash-out trigger.
     *
     * The payout and the clearing of `pendingCrashRefund` are one keyed write,
     * because they are two halves of one fact. `pendingCrashRefund` is the
     * marker `src/events/ready.js` reconciles on restart: while it is set, the
     * stake is considered still owed back. Crediting the payout without
     * clearing it would have the reconciler return the stake *as well as* the
     * winnings the moment the bot next restarted.
     *
     * It is decremented by the stake rather than set to zero. A player sitting
     * in two channels' lobbies has both stakes counted in the one field, and
     * zeroing it for one hand discarded the other hand's marker — losing that
     * stake if the second lobby then errored.
     *
     * On failure the state is deliberately left unresolved (`cashedOutAt` stays
     * null) so the tick-error path still sees a player to refund. What the
     * state must *also* record is that this was a failure rather than a player
     * still riding the multiplier, which `cashFailed` does: the crash
     * resolution below clears the marker for everyone who did not cash out, and
     * without the distinction it cleared it for these players too — destroying
     * the one record that could have paid them, on top of the payout that had
     * already been lost.
     *
     * @returns {Promise<'paid'|'owed'|'lost'|'already'>}
     */
    async function cashOutPlayer(uid, mult, autoTriggered = false) {
        const state = lobby.players.get(uid);
        if (!state || state.cashedOutAt !== null || state.cashFailed) return 'already';

        const payout = Math.floor(bet * mult);
        const { status } = await creditCoinsOnce(
            { userId: uid, guildId },
            payout,
            casinoPayoutKey('crash', lobbyId, `cashout:${uid}`),
            { extraSet: counterSetExpr({ pendingCrashRefund: -bet }) },
        ).catch(err => {
            console.error('[crash] cashOut DB write failed:', err);
            return { status: 'unknown' };
        });

        if (status !== 'paid' && status !== 'duplicate') {
            // The multiplier and the outcome are recorded beside the flag: this
            // player *did* cash out, and both the live lines and the final embed
            // read `cashedOutAt` to decide what to say. Left null with nothing
            // beside it, the round reported them as still in and then as never
            // having cashed out — contradicting the reply they had just been
            // given, and telling the channel they lost a hand they had won.
            state.cashFailed   = true;
            state.cashFailedAt = mult;
            // The stake is still covered by the untouched `pendingCrashRefund`,
            // so what is owed here is the winnings on top of it and not the
            // whole payout — recording the payout would pay the stake twice
            // once the reconciler returns it. At a 1.00x cash-out the net is
            // zero and this is a no-op, which is correct: the marker alone
            // makes the player whole.
            const { owed } = await creditCoinsOrOwe({ userId: uid, guildId }, payout - bet, {
                payoutKey: casinoPayoutKey('crash', lobbyId, `cashout-net:${uid}`),
                service:   'casino',
                jobName:   'crash:cashout',
            });
            state.cashOutcome = owed ? 'owed' : 'lost';
            return state.cashOutcome;
        }

        state.cashedOutAt   = mult;
        state.autoTriggered = autoTriggered;

        // Update weekly leaderboard stats (store username to avoid N+1 fetches in leaderboard)
        await updateCrashStats(uid, guildId, mult, state.username);
        return 'paid';
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
        filter: ownedByMembers(
            userId => lobby.players.has(userId),
            i => i.customId === `crash_co_${lobbyId}`,
            "You're not in this round — join the next lobby to play.",
        ),
        time:   collectorMs,
    });

    collector.on('collect', async i => {
        if (gameOver) { await i.deferUpdate().catch(() => {}); return; }
        const state = lobby.players.get(i.user.id);
        if (!state || state.cashedOutAt !== null) {
            return i.reply({ content: "You've already cashed out.", flags: MessageFlags.Ephemeral });
        }

        const outcome = await cashOutPlayer(i.user.id, currentMult, false);
        if (outcome === 'already') {
            return i.reply({ content: "You've already cashed out.", flags: MessageFlags.Ephemeral });
        }

        const payout = Math.floor(bet * currentMult);
        // A failed cash-out used to answer "You've already cashed out" as well,
        // which is the one case where that sentence costs the player money: they
        // read it as being safely out, stopped watching, and lost the hand at
        // the crash. Their stake is covered by the untouched marker either way,
        // so the wording only has to be honest about the winnings.
        if (outcome !== 'paid') {
            return i.reply({
                content: outcome === 'owed'
                    ? `⚠️ Cashed out at **${multLabel(currentMult)}**, but the payout could not be credited right now. It has been recorded and will be paid automatically.`
                    : `⚠️ Cashed out at **${multLabel(currentMult)}**, but the payout could not be credited or recorded. Please contact a server admin.`,
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
        }

        await i.reply({
            content: `✅ Cashed out at **${multLabel(currentMult)}** — **+${(payout - bet).toLocaleString()} coins**!`,
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});

        const lines = await getPlayerLines();
        await interaction.editReply({ embeds: [liveMultiEmbed(currentMult, bet, lines)] }).catch(() => {});
    });

    lobby.interval = setInterval(async () => {
        if (gameOver) return;
        try {

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

            // `cashFailed` is excluded on purpose. Those players did cash out —
            // only the write did not land — and their `pendingCrashRefund` is
            // the record that returns their stake, either through the
            // tick-error refund or through the reconciler in
            // src/events/ready.js. Clearing it here, as this once did, threw
            // away the stake of the one group that had already lost the payout.
            const loserIds = [...lobby.players.entries()]
                .filter(([, s]) => s.cashedOutAt === null && !s.cashFailed)
                .map(([uid]) => uid);
            if (loserIds.length > 0) {
                User.updateMany(
                    { userId: { $in: loserIds }, guildId, pendingCrashRefund: { $gte: bet } },
                    // Decremented rather than zeroed, for the same reason the
                    // cash-out decrements it: a player in a second channel's
                    // lobby has that stake counted in the same field.
                    { $inc: { pendingCrashRefund: -bet } }
                ).catch(err => console.error('[crash] failed to clear pendingCrashRefund:', err));
            }

            const finalEmbed = await buildFinalEmbed(crash, bet, lobby.players, interaction.client, guildId);

            // Save crash point to guild history (last 10)
            Guild.updateOne(
                { guildId },
                { $push: { 'casinoStats.crashHistory': { $each: [crash], $slice: -10 } } }
            ).catch(() => {});

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
                    await i.reply({ embeds: [lbEmbed] }).catch(() => {});
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

        } catch (tickErr) {
            if (!gameOver) {
                console.error('[crash] tick error, refunding all bets:', tickErr);
                gameOver = true;
                clearInterval(lobby.interval);
                // Two groups, and they are refunded differently.
                //
                // Players still riding the multiplier never got a result, so
                // their stake comes back as an unwind: as with the join refund,
                // a returned stake is an uncounted one and the wager counter
                // comes back with it.
                //
                // Players whose cash-out write failed are not in that position.
                // Their hand did resolve — they pressed the button and won —
                // and the stake coming back is one half of a payout whose other
                // half is already written down as owed. So they keep the
                // `lifetimeGambled` they earned; taking it back would say the
                // hand never happened when it is about to be paid out.
                const byOutcome = (failed) => [...lobby.players.entries()]
                    .filter(([, s]) => s.cashedOutAt === null && Boolean(s.cashFailed) === failed)
                    .map(([uid]) => uid);

                const refunds = [
                    [byOutcome(false), { $inc: { balance: bet, lifetimeGambled: -bet, pendingCrashRefund: -bet } }],
                    [byOutcome(true),  { $inc: { balance: bet, pendingCrashRefund: -bet } }],
                ];
                for (const [ids, update] of refunds) {
                    if (ids.length === 0) continue;
                    await User.updateMany(
                        { userId: { $in: ids }, guildId, pendingCrashRefund: { $gte: bet } },
                        update,
                    ).catch(e => console.error('[crash] emergency refund failed:', e));
                }
                deleteLobby(channelId);
                interaction.editReply({ content: '❌ Game error — all bets refunded.', components: [] }).catch(() => {});
            }
        }
    }, TICK_MS);

    collector.on('end', (_, reason) => {
        if (reason !== 'crashed' && !gameOver) {
            gameOver = true;
            clearInterval(lobby.interval);
            deleteLobby(channelId);
        }
    });
}
