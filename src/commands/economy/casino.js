const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');
const { processJackpotBet, getJackpotDisplay } = require('../../services/casinoJackpotService');

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
    .addSubcommand(sub => sub.setName('jackpot').setDescription('View the current progressive jackpot pool.'));

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

        // Progressive jackpot: contribute a share of each bet to the pool and check for a win.
        // Fire-and-forget — the service handles pool reset, user credit, and logging.
        const bet = interaction.options.getInteger('bet') ?? 0;
        if (bet > 0) {
            processJackpotBet({
                guildId:  interaction.guild.id,
                userId:   interaction.user.id,
                username: interaction.user.username,
                bet,
                interaction,
            }).catch(err => console.error('[CasinoJackpot] error:', err));
        }

        return game.execute(interaction);
    },
};
