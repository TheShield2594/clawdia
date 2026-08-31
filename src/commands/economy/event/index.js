'use strict';

// /event — the command definition and nothing else but dispatch.
//
// Discord registers at most 100 global application commands and rejects the
// whole payload past that, so the budget is the feature roadmap's real
// constraint (#875). Five of the slots were single-holiday activities usable a
// few weeks a year — /snowball, /sandcastle, /trickortreat, /lovenote,
// /trackhunt — each already refusing to run unless seasonalEventService says
// its event is live. They are subcommands of the /event group that gates them
// now, which is where a player looking for "what can I do during this event"
// would look anyway.
//
// The management half (start, end, status) came from commands/admin/event.js,
// which held the /event name. It is the same command; the ManageGuild check on
// start and end moved with it and lives in manage.js. That check is inline
// rather than setDefaultMemberPermissions because Discord's gate is per
// command, and hiding this one from everyone without Manage Server would hide
// the five activities too.
//
// The folder is a command rather than a file for the reason /fish, /hunt and
// /mine are: the loader treats <category>/<name>/index.js as one command, so
// the siblings here never register as commands of their own.

const { SlashCommandBuilder } = require('discord.js');
const { EVENT_TYPE_CHOICES, handleStart, handleEnd, handleStatus, requireManageGuild } = require('./manage');
const { handleSnowball } = require('./snowball');
const { handleSandcastle } = require('./sandcastle');
const { handleTrickOrTreat } = require('./trickortreat');
const { handleLoveNote } = require('./lovenote');
const { handleTrackHunt } = require('./trackhunt');

// The activities, and the event each one belongs to. The handler enforces the
// gate itself — this table is what the descriptions and the cooldown policy
// read, so the two cannot drift from the list of subcommands.
const ACTIVITIES = {
    snowball:     { handler: handleSnowball,     event: 'Winter Wonderland' },
    sandcastle:   { handler: handleSandcastle,   event: 'Summer Festival' },
    trickortreat: { handler: handleTrickOrTreat, event: 'Spooky Season' },
    lovenote:     { handler: handleLoveNote,     event: "Valentine's Day" },
    trackhunt:    { handler: handleTrackHunt,    event: 'The Winter Hunt' },
};

module.exports = {
    // Each subcommand gets its own cooldown bucket, so a snowball throw no
    // longer eats the window for a sandcastle. The activities pass 0 because
    // their real cooldowns are claimed atomically in Mongo — `client.cooldowns`
    // is a process-local Map that is empty after a restart, and it is not what
    // bounds a command that pays coins (tests/economyCooldownClaims).
    cooldownKey: interaction => `event:${interaction.options.getSubcommand()}`,
    cooldownAmount: interaction =>
        (interaction.options.getSubcommand() in ACTIVITIES ? 0 : 3),

    data: new SlashCommandBuilder()
        .setName('event')
        .setDescription('Limited-time events: play the current one, or manage it.')
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Show the currently active event'))
        .addSubcommand(sub =>
            sub.setName('snowball')
                .setDescription('Throw a snowball at another user! Winter Wonderland only.')
                .addUserOption(o =>
                    o.setName('target')
                        .setDescription('Who to throw a snowball at')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('sandcastle')
                .setDescription('Build a sandcastle on the shore! Summer Festival only.'))
        .addSubcommand(sub =>
            sub.setName('trickortreat')
                .setDescription('Knock on a spooky door for candy or consequences! Spooky Season only.'))
        .addSubcommand(sub =>
            sub.setName('lovenote')
                .setDescription("Send a love note into the Arcade and see what comes back! Valentine's Day only."))
        .addSubcommand(sub =>
            sub.setName('trackhunt')
                .setDescription('Track game across the Arctic Tundra! The Winter Hunt only.'))
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Start a limited-time event (Manage Server)')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Event type')
                        .setRequired(true)
                        .addChoices(...EVENT_TYPE_CHOICES))
                .addIntegerOption(o =>
                    o.setName('duration_hours')
                        .setDescription('Duration in hours (default: 24)')
                        .setMinValue(1)
                        .setMaxValue(720)
                        .setRequired(false))
                .addStringOption(o =>
                    o.setName('name')
                        .setDescription('Custom event name (for "custom" type or override)')
                        .setRequired(false))
                .addNumberOption(o =>
                    o.setName('coin_multiplier')
                        .setDescription('Coin multiplier (default: 2x for double coins event)')
                        .setMinValue(1.0)
                        .setMaxValue(5.0)
                        .setRequired(false))
                .addNumberOption(o =>
                    o.setName('xp_multiplier')
                        .setDescription('XP multiplier (default: 1.5x for XP boost event)')
                        .setMinValue(1.0)
                        .setMaxValue(5.0)
                        .setRequired(false))
                .addChannelOption(o =>
                    o.setName('announcement_channel')
                        .setDescription('Channel to announce this event in')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('end')
                .setDescription('End the current event early (Manage Server)')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const activity = ACTIVITIES[sub];
        if (activity) return activity.handler(interaction);

        if (sub === 'status') return handleStatus(interaction);

        // start and end change what event is running, and need Manage Server.
        if (!(await requireManageGuild(interaction))) return;

        if (sub === 'start') return handleStart(interaction);
        if (sub === 'end')   return handleEnd(interaction);
    },
};
