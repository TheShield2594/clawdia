const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');
const { processJackpotBet, getJackpotDisplay } = require('../../services/casinoJackpotService');
const { tryAcquire, release } = require('../../utils/activeGameLock');

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
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        if (guildSettings?.economy?.gamesEnabled === false) {
            return interaction.reply({ content: 'Economy games are disabled on this server.', ephemeral: true });
        }
        if (guildSettings?.economy?.casinoEnabled === false) {
            return interaction.reply({ content: 'Casino games are disabled on this server.', ephemeral: true });
        }
        const sub = interaction.options.getSubcommand();

        if (sub === 'setlimit') {
            if (!interaction.memberPermissions?.has('ManageGuild')) {
                return interaction.reply({ content: '❌ You need the **Manage Server** permission to set the casino bet limit.', ephemeral: true });
            }
            const limit = interaction.options.getInteger('limit');
            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id },
                { $set: { 'economy.casinoMaxBet': limit } }
            );
            const msg = limit === 0
                ? '✅ Casino bet limit **removed** — players can bet any amount up to their wallet balance.'
                : `✅ Casino bet limit set to **${limit.toLocaleString()}** coins.`;
            return interaction.reply({ content: msg, ephemeral: true });
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
            return interaction.reply({ content: 'Unknown casino game.', ephemeral: true });
        }

        // One active casino game per user — prevents concurrent sessions from racing
        // each other's debits, effects, and jackpot snapshots.
        const lockKey   = `casino:${interaction.guild.id}:${interaction.user.id}`;
        const lockToken = tryAcquire(lockKey);
        if (!lockToken) {
            return interaction.reply({
                content: '🎰 You already have a casino game in progress — finish it first.',
                ephemeral: true,
            });
        }

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
            }

            return await game.execute(interaction);
        } finally {
            release(lockKey, lockToken);
        }
    },
};
