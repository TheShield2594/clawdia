'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { handleMap } = require('./explore');

// /map — a shortcut to the Explorer's Map. Same render as /explore map;
// cartographers shouldn't have to type subcommands.
module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('map')
        .setDescription("Unroll your Explorer's Map — every region, landmark, and secret you've charted."),

    async execute(interaction) {
        return handleMap(interaction);
    },
};
