const { SlashCommandBuilder } = require('discord.js');

const games = [
    require('../../games/casino/baccarat'),
    require('../../games/casino/blackjack'),
    require('../../games/casino/crash'),
    require('../../games/casino/doubleornothing'),
    require('../../games/casino/higherlower'),
    require('../../games/casino/plinko'),
    require('../../games/casino/roulette'),
    require('../../games/casino/slots'),
    require('../../games/casino/wheel'),
];

const builder = new SlashCommandBuilder()
    .setName('casino')
    .setDescription('Play casino games: baccarat, blackjack, crash, plinko, roulette, slots, wheel, and more.');

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
        const sub = interaction.options.getSubcommand();
        const game = games.find(g => g.name === sub);
        if (!game) {
            return interaction.reply({ content: 'Unknown casino game.', ephemeral: true });
        }
        return game.execute(interaction);
    },
};
