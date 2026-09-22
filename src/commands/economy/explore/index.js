'use strict';

// /explore — the command definition and nothing else but dispatch.
//
// This was one 1,655-line file: the expedition roll, every embed, travel, the
// region browser, the journal, the relic case, the profile and prestige, all
// beside a service layer (services/exploreService.js) that already existed for
// exactly this logic. Each subcommand now has its own file and this one only
// routes to it, which is also why the folder is a command rather than a file —
// the loader treats <category>/<name>/index.js as one command, so the siblings
// here never register as commands of their own (see utils/commandLoader.js).

const { SlashCommandBuilder } = require('discord.js');
const { REGION_LIST } = require('../../../data/exploreData');
const { EVENT_TYPE_EMOJI } = require('./shared');
const { handleGo } = require('./go');
const { handleMap } = require('./map');
const { handleTravel } = require('./travel');
const { handleRegions } = require('./regions');
const { handleJournal } = require('./journal');
const { handleRelics } = require('./relics');
const { handleProfile } = require('./profile');
const { handlePrestige } = require('./prestige');

const REGION_CHOICES = REGION_LIST.map(r => ({
    name: `${r.emoji} ${r.name}${r.seasonalEventId ? ' (seasonal)' : ''}`,
    value: r.id,
}));

const EVENT_TYPE_CHOICES = Object.entries(EVENT_TYPE_EMOJI).map(([id]) => ({
    name: `${EVENT_TYPE_EMOJI[id]} ${id.charAt(0).toUpperCase()}${id.slice(1)}`,
    value: id,
}));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('explore')
        .setDescription('World exploration: set out into the wilds, chart your map, and find what hides there.')
        .addSubcommand(sub =>
            sub.setName('go')
                .setDescription('Set out on an expedition. Uses 1 stamina. Cooldown: 60s.')
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Region to explore (defaults to your active region)')
                        .setRequired(false)
                        .addChoices(...REGION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('map')
                .setDescription("View your Explorer's Map — every region, landmark, and secret you've charted."))
        .addSubcommand(sub =>
            sub.setName('travel')
                .setDescription('Travel to a region (unlocking it first if needed) and make it your active region.')
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Destination region')
                        .setRequired(true)
                        .addChoices(...REGION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('regions')
                .setDescription('Browse every known region — requirements, season windows, and your progress.'))
        .addSubcommand(sub =>
            sub.setName('journal')
                .setDescription('Reread your expedition journal — your most recent finds, in order.')
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Only show entries written in this region')
                        .setRequired(false)
                        .addChoices(...REGION_CHOICES))
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Only show one kind of find')
                        .setRequired(false)
                        .addChoices(...EVENT_TYPE_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('relics')
                .setDescription('Open your relic case — everything the wilds let you keep, and what it earns you.')
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Collector to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another wanderer's explorer profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Explorer to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Walk off the edge of your own map: reset Explorer Level for a permanent bonus.')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'go')      return handleGo(interaction);
        if (sub === 'map')     return handleMap(interaction);
        if (sub === 'travel')  return handleTravel(interaction);
        if (sub === 'regions') return handleRegions(interaction);
        if (sub === 'journal') return handleJournal(interaction);
        if (sub === 'relics')  return handleRelics(interaction);
        if (sub === 'profile') return handleProfile(interaction);
        if (sub === 'prestige') return handlePrestige(interaction);
    },

    // Exposed so sibling commands can render the same Explorer's Map
    handleMap,
};

// ── Per-user economy lock ─────────────────────────────────────────────────────
// Exploration mutates the user document with read-modify-write saves, and an
// expedition can sit for 20s waiting on the encounter prompt. The lock key is
// the player rather than this command, so every other money-moving command
// contends for it too — see utils/economyLock.js.
const { withEconomyLock, exceptReadOnly } = require('../../../utils/economyLock');
// Reads that persist nothing, so they never wait on a lease — see
// exceptReadOnly. `go` and `travel` still lock.
const EXPLORE_READ_ONLY = ['map', 'regions', 'journal', 'relics', 'profile'];
module.exports.execute = withEconomyLock(module.exports.execute, {
    activity: 'explore',
    only:     exceptReadOnly(EXPLORE_READ_ONLY),
});
