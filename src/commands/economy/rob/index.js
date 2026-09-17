'use strict';

// `/rob` — the heist command and everything that hangs off it (#1022).
//
// Robbing another member, scouting their defences, and arming a tripwire on your
// own wallet were three top-level commands (`/rob`, `/robstatus`, `/trap`) that
// Discord's picker sorted apart and that between them spent three of the app's
// 100 global command slots on one feature. They are subcommands of one command
// now: `/rob attempt`, `/rob status`, and the `/rob trap` group. Each keeps its
// own cooldown — the attempt's 1-hour `lastRob`, the scout's 2-minute in-memory
// map — and its own logic, split across the sibling files so no one file carries
// all three.

const { SlashCommandBuilder } = require('discord.js');
const attempt = require('./attempt');
const status  = require('./status');
const trap    = require('./trap');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Rob a member, scout their defences, or arm a tripwire on your own wallet.')
        .addSubcommand(sub => sub
            .setName('attempt')
            .setDescription("Try to rob another member's wallet. Success is affected by tools and protection.")
            .addUserOption(o => o
                .setName('target')
                .setDescription('The member to rob.')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription("Spy on a target's active rob protections before committing to a heist.")
            .addUserOption(o => o
                .setName('target')
                .setDescription('The user to check.')
                .setRequired(true)))
        .addSubcommandGroup(group => group
            .setName('trap')
            .setDescription('Set or check a hidden tripwire on your wallet.')
            .addSubcommand(sub => sub
                .setName('set')
                .setDescription(`Set a trap on your wallet for ${trap.TRAP_COST.toLocaleString()} coins. Lasts 12 hours.`))
            .addSubcommand(sub => sub
                .setName('status')
                .setDescription('Check whether your trap is currently armed.'))),

    // A bucket per leaf, so folding three commands into one does not make them
    // share `/rob`'s spam-guard slot the way a single top-level key would (#1022).
    // The attempt's real cooldown is its 1-hour `lastRob` and the scout's is its
    // own 2-minute map; this is only the short anti-double-submit gate each
    // top-level command had before the fold.
    cooldownKey: interaction => {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand(false);
        return ['rob', group, sub].filter(Boolean).join(':');
    },

    async execute(interaction) {
        if (interaction.options.getSubcommandGroup(false) === 'trap') {
            return trap.execute(interaction);
        }
        if (interaction.options.getSubcommand() === 'status') {
            return status.execute(interaction);
        }
        return attempt.execute(interaction);
    },
};
