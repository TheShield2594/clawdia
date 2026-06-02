const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');
const User  = require('../../models/User');
const { processJackpotBet, getJackpotDisplay } = require('../../services/casinoJackpotService');
const { logTransaction } = require('../../utils/logTransaction');

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
            const guildDoc = await Guild.findOne({ guildId: interaction.guild.id });
            const lastWinner = guildDoc?.casinoJackpot?.lastWinnerName;
            const lastWon    = guildDoc?.casinoJackpot?.lastWonAmount;
            const embed = new EmbedBuilder()
                .setColor(hot ? '#FF6600' : '#FFD700')
                .setTitle(`${hot ? '🔥 ' : '🎰 '}Progressive Casino Jackpot`)
                .setDescription(
                    `${hot ? '🔥 **The jackpot is HOT!** Every bet brings this closer to dropping.\n\n' : ''}` +
                    `**Current Pool:** ${display}\n\n` +
                    `Every casino bet contributes **${Math.round((guildDoc?.casinoJackpot?.contributionRate ?? 0.005) * 100 * 10) / 10}%** to this pool.\n` +
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
        // Fire-and-forget so we never block the game itself.
        const bet = interaction.options.getInteger('bet') ?? 0;
        if (bet > 0) {
            processJackpotBet({
                guildId:  interaction.guild.id,
                userId:   interaction.user.id,
                username: interaction.user.username,
                bet,
                interaction,
            }).then(async result => {
                if (result.triggered) {
                    // Credit winnings to the user
                    const updated = await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $inc: { balance: result.wonAmount } },
                        { new: true }
                    );
                    logTransaction({
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        type:    'casino_jackpot',
                        amount:  result.wonAmount,
                        balance: updated?.balance ?? 0,
                        note:    `Progressive jackpot — ${sub}`,
                    });
                }
            }).catch(err => console.error('[CasinoJackpot] error:', err));
        }

        return game.execute(interaction);
    },
};
