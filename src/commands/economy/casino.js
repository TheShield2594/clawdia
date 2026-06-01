const { SlashCommandBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

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
    .setDescription('Play casino games: blackjack, crash, cupgame, higher/lower, keno, poker, roulette, and slots.');

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
        const game = games.find(g => g.name === sub);
        if (!game) {
            return interaction.reply({ content: 'Unknown casino game.', ephemeral: true });
        }
        return game.execute(interaction);
    },
};
