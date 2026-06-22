const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { startSession, joinSession, beginSession, takeAction, partyStatus, stopSession, CLASSES } = require('../../services/dmService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dm')
        .setDescription('AI Dungeon Master — run a collaborative text RPG')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Start a new DM session in this channel')
        )
        .addSubcommand(sub =>
            sub.setName('join')
                .setDescription('Join the active DM session with a character')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Your character\'s name')
                        .setRequired(true)
                        .setMaxLength(32)
                )
                .addStringOption(opt =>
                    opt.setName('class')
                        .setDescription('Your character class')
                        .setRequired(true)
                        .addChoices(...CLASSES.map(c => ({ name: c, value: c })))
                )
        )
        .addSubcommand(sub =>
            sub.setName('begin')
                .setDescription('Begin the adventure (host only)')
        )
        .addSubcommand(sub =>
            sub.setName('action')
                .setDescription('Take an action in the current story')
                .addStringOption(opt =>
                    opt.setName('action')
                        .setDescription('Describe what your character does')
                        .setRequired(true)
                        .setMaxLength(300)
                )
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Show the current party status')
        )
        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('End the current DM session (host or admin)')
        ),

    async execute(interaction) {
        try {
            const sub = interaction.options.getSubcommand();
            if (sub === 'start') return await startSession(interaction);
            if (sub === 'join') return await joinSession(interaction);
            if (sub === 'begin') return await beginSession(interaction);
            if (sub === 'action') return await takeAction(interaction);
            if (sub === 'status') return await partyStatus(interaction);
            if (sub === 'stop') return await stopSession(interaction);
            console.warn(`[DM] Unknown subcommand: ${sub}`);
            return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
        } catch (err) {
            console.error('[DM] execute error:', err);
            const msg = { content: 'An unexpected error occurred. Please try again.', flags: MessageFlags.Ephemeral };
            if (interaction.deferred || interaction.replied) {
                return interaction.followUp(msg);
            }
            return interaction.reply(msg);
        }
    }
};
