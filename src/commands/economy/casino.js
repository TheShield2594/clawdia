const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const Guild = require('../../models/Guild');
const User  = require('../../models/User');
const { processJackpotBet, getJackpotDisplay } = require('../../services/casinoJackpotService');
const { advanceMissions } = require('../../services/seasonMissionService');
const { tryAcquire, release } = require('../../utils/activeGameLock');
const { economyLockKey, busyMessage } = require('../../utils/economyLock');

const games = [
    require('../../games/casino/blackjack'),
    require('../../games/casino/crash'),
    require('../../games/casino/cupgame'),
    require('../../games/casino/higherlower'),
    require('../../games/casino/keno'),
    require('../../games/casino/poker'),
    require('../../games/casino/roulette'),
    require('../../games/casino/slots'),
];

const builder = new SlashCommandBuilder()
    .setName('casino')
    .setDescription('Play casino games: blackjack, crash, cupgame, higher/lower, keno, poker, roulette, and slots.')
    .addSubcommand(sub => sub.setName('jackpot').setDescription('View the current progressive jackpot pool.'))
    .addSubcommand(sub => sub
        .setName('setlimit')
        .setDescription('(Admin) Set or clear the maximum bet allowed in casino games.')
        .addIntegerOption(opt => opt
            .setName('limit')
            .setDescription('Max bet in coins. Set to 0 for no limit.')
            .setMinValue(0)
            .setRequired(true)));

for (const game of games) {
    builder.addSubcommand(sub => {
        const base = sub.setName(game.name).setDescription(game.description);
        return game.configure ? game.configure(base) : base;
    });
}

module.exports = {
    data: builder,
    cooldownKey: interaction => `casino:${interaction.options.getSubcommand()}`,
    cooldownAmount: interaction => {
        const sub = interaction.options.getSubcommand();
        const game = games.find(g => g.name === sub);
        return game?.cooldown ?? 3;
    },
    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.gamesEnabled === false) {
            return interaction.reply({ content: 'Economy games are disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.casinoEnabled === false) {
            return interaction.reply({ content: 'Casino games are disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        const sub = interaction.options.getSubcommand();

        if (sub === 'setlimit') {
            if (!interaction.memberPermissions?.has('ManageGuild')) {
                return interaction.reply({ content: '❌ You need the **Manage Server** permission to set the casino bet limit.', flags: MessageFlags.Ephemeral });
            }
            const limit = interaction.options.getInteger('limit');
            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id },
                { $set: { 'economy.casinoMaxBet': limit } }
            );
            const msg = limit === 0
                ? '✅ Casino bet limit **removed** — players can bet any amount up to their wallet balance.'
                : `✅ Casino bet limit set to **${limit.toLocaleString()}** coins.`;
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'jackpot') {
            const { pool, hot, display } = await getJackpotDisplay(interaction.guild.id);
            const lastWinner = guildSettings?.casinoJackpot?.lastWinnerName;
            const lastWon    = guildSettings?.casinoJackpot?.lastWonAmount;
            const embed = new EmbedBuilder()
                .setColor(hot ? '#FF6600' : '#FFD700')
                .setTitle(`${hot ? '🔥 ' : '🎰 '}Progressive Casino Jackpot`)
                .setDescription(
                    `${hot ? '🔥 **The jackpot is HOT!** Every bet brings this closer to dropping.\n\n' : ''}` +
                    `**Current Pool:** ${display}\n\n` +
                    `Every casino bet contributes **${Math.round((guildSettings?.casinoJackpot?.contributionRate ?? 0.005) * 100 * 10) / 10}%** to this pool.\n` +
                    `Trigger chance grows with every bet — someone will win it soon.`
                )
                .addFields(
                    lastWinner ? { name: '🏆 Last Winner', value: `**${lastWinner}** — ${lastWon?.toLocaleString() ?? '?'} coins`, inline: true } : { name: '​', value: '​', inline: false }
                )
                .setFooter({ text: 'Play any casino game to contribute and compete for the pool.' })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        const game = games.find(g => g.name === sub);
        if (!game) {
            return interaction.reply({ content: 'Unknown casino game.', flags: MessageFlags.Ephemeral });
        }

        // One economy action per user — prevents concurrent sessions from racing
        // each other's debits, effects, and jackpot snapshots. The key is shared
        // with /fish, /hunt, /mine, /explore and /craft (utils/economyLock.js),
        // so a hand cannot interleave with a cast over the same user document
        // either. The TTL is the primitive's ten-minute default rather than the
        // grind commands' two minutes, because a hand outlives `execute` by as
        // long as the player takes to play it.
        const lockKey   = economyLockKey(interaction.guild.id, interaction.user.id);
        const lockToken = await tryAcquire(lockKey, undefined, 'casino');
        if (!lockToken) {
            return interaction.reply({
                content: await busyMessage(lockKey),
                flags: MessageFlags.Ephemeral,
            });
        }

        // The lock is released by the game itself (via releaseLock) once the
        // hand actually resolves — win/loss/cash-out/timeout, or an early
        // validation failure — not simply when execute() returns, since every
        // game's interactive turns continue via button collectors well after
        // that point. A "Play Again" follow-up doesn't need the lock re-held:
        // it goes through the same atomic balance debit as any fresh bet, so
        // it can't double-spend even if another casino game starts in
        // parallel once the original hand has settled.
        //
        // If a game throws, or forgets to call releaseLock on some exotic
        // early-return path, the lock's own TTL (10 min) frees the slot —
        // worst case the player is blocked from every economy command for
        // that long, never permanently.
        // Fire-and-forget: the games call this from collector callbacks that
        // cannot await, and a release that loses its round trip is covered by
        // the lease's own TTL.
        let released = false;
        const releaseLock = () => {
            if (released) return;
            released = true;
            release(lockKey, lockToken).catch(err => console.error('[casino] lock release failed:', err));
        };

        try {
            // Progressive jackpot: contribute a share of each bet to the pool and check for a win.
            // Fire-and-forget — the service handles pool reset, user credit, and logging.
            const bet = interaction.options.getInteger(game.betOptionName ?? 'bet') ?? 0;
            if (bet > 0) {
                processJackpotBet({
                    guildId:  interaction.guild.id,
                    userId:   interaction.user.id,
                    username: interaction.user.username,
                    bet,
                    interaction,
                }).catch(err => console.error('[CasinoJackpot] error:', err));

                // Season pass: "Play 5 casino games". Counted here rather than at
                // subcommand dispatch so a hand that never got a bet down — bad
                // amount, empty wallet — isn't scored as a game played.
                advanceMissions(
                    User,
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    'casino', 1, guildSettings,
                ).catch(err => console.error('[casino] season mission error:', err));
            }

            return await game.execute(interaction, { releaseLock });
        } catch (err) {
            releaseLock();
            throw err;
        }
    },
};
