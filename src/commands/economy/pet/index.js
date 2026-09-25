'use strict';

// /pet — the command definition and nothing else but dispatch.
//
// This was one 1,388-line file: adopt, status (with its play/rest/showcase
// collector), feed, release, rename, the shop list, the leaderboard and the
// whole battle system — wild, PvP and the wager escrow — beside a service layer
// (services/petService.js, services/petStatusView.js) that already held the pet
// mechanics. #873 pass 10 keyed the battle winner payout, the wager escrow
// refunds and the adopt-fee refund, which the file's `command-file-size` ceiling
// blocked doing in place, so each subcommand now has its own file and this one
// only routes to it. The folder is a command rather than a file for the reason
// /explore and the grind commands are: the loader treats
// <category>/<name>/index.js as one command, so the siblings here never register
// as commands of their own (see utils/commandLoader.js).

const {
    SlashCommandBuilder, MessageFlags,
} = require('discord.js');
const { petAutocomplete } = require('./autocomplete');
const { executeAdopt } = require('./adopt');
const { executeStatus } = require('./status');
const { executeFeed, MAX_FEED_QUANTITY } = require('./feed');
const { executeRelease } = require('./release');
const { executeRename } = require('./rename');
const { executeList, rareCompanionFooter } = require('./list');
const { executeLeaderboard } = require('./leaderboard');
const { executeBattle } = require('./battle');
const { executeCodex } = require('./codex');
const { executeVacation } = require('./vacation');
const { VACATION_MAX_DAYS } = require('../../../services/petService');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('pet')
        .setDescription('Manage your pets.')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('adopt')
                .setDescription('Adopt a pet from the shop.')
                .addStringOption(opt =>
                    opt.setName('type').setDescription('Pet type to adopt').setRequired(true)
                        .addChoices(
                            { name: '🐶 Dog (2,000)',    value: 'dog'  },
                            { name: '🐱 Cat (2,000)',    value: 'cat'  },
                            { name: '🐦 Bird (3,000)',   value: 'bird' },
                            { name: '🐠 Fish (3,000)',   value: 'fish' },
                            { name: '🦊 Fox (5,000)',    value: 'fox'  },
                            { name: '🐺 Wolf (8,000)',   value: 'wolf' },
                        )
                )
                .addStringOption(opt =>
                    opt.setName('name').setDescription('Give your pet a name right away (optional, max 32 chars)').setRequired(false).setMaxLength(32)
                )
        )
        .addSubcommand(sub => sub.setName('status').setDescription('View your pets and their mood.'))
        .addSubcommand(sub =>
            sub.setName('feed')
                .setDescription('Feed a pet — favourite foods restore the most and grant bonus XP.')
                .addStringOption(opt =>
                    opt.setName('material').setDescription('Which food to use — start typing to see what you have').setRequired(true).setAutocomplete(true)
                )
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which pet to feed (defaults to your first)').setRequired(false).setAutocomplete(true)
                )
                .addIntegerOption(opt =>
                    opt.setName('quantity').setDescription('Feed up to this many — stops once your pet is full (default 1)')
                        .setRequired(false).setMinValue(1).setMaxValue(MAX_FEED_QUANTITY)
                )
        )
        .addSubcommand(sub =>
            sub.setName('release')
                .setDescription('Release a pet permanently.')
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which pet to release').setRequired(true).setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('rename')
                .setDescription('Give your pet a custom name.')
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which pet to rename').setRequired(true).setAutocomplete(true)
                )
                .addStringOption(opt =>
                    opt.setName('name').setDescription('New name (max 32 chars)').setRequired(true).setMaxLength(32)
                )
        )
        .addSubcommand(sub => sub.setName('list').setDescription('View all available pets in the shop.'))
        .addSubcommand(sub => sub.setName('codex').setDescription('Every pet species — the ones you have owned, and where the rare ones come from.'))
        .addSubcommand(sub =>
            sub.setName('vacation')
                .setDescription(`Pause hunger for all your pets for up to ${VACATION_MAX_DAYS} days (passives and battles are off meanwhile).`)
                .addStringOption(opt =>
                    opt.setName('state').setDescription('Start or end the vacation').setRequired(true)
                        .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }))
                .addIntegerOption(opt =>
                    opt.setName('days').setDescription(`How many days (default ${VACATION_MAX_DAYS})`).setRequired(false)
                        .setMinValue(1).setMaxValue(VACATION_MAX_DAYS)))
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('View the top pets in this server.')
                .addStringOption(opt =>
                    opt.setName('type')
                        .setDescription('Sort order (default: bond)')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Bond (Most Loyal)',      value: 'bonds' },
                            { name: 'Level (Highest Level)', value: 'level' },
                            { name: 'PvP Wins (vs members)',  value: 'wins'  },
                            { name: 'Rating (pet ladder)',    value: 'rating' }
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('battle')
                .setDescription('Battle a wild pet for XP, or challenge another member (optionally for coins or rating).')
                .addUserOption(opt =>
                    opt.setName('opponent').setDescription('Member to challenge (leave empty to fight a wild pet)').setRequired(false))
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which of your pets fights (defaults to your first)').setRequired(false).setAutocomplete(true))
                .addIntegerOption(opt =>
                    opt.setName('bet').setDescription('Coins to wager (requires an opponent)').setRequired(false).setMinValue(1))
                .addBooleanOption(opt =>
                    opt.setName('rated').setDescription('A rated battle on the pet ladder (requires an opponent; level-matched)').setRequired(false))),

    async autocomplete(interaction) {
        return petAutocomplete(interaction);
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'adopt')       return await executeAdopt(interaction);
            if (sub === 'status')      return await executeStatus(interaction);
            if (sub === 'feed')        return await executeFeed(interaction);
            if (sub === 'release')     return await executeRelease(interaction);
            if (sub === 'rename')      return await executeRename(interaction);
            if (sub === 'list')        return await executeList(interaction);
            if (sub === 'leaderboard') return await executeLeaderboard(interaction);
            if (sub === 'battle')      return await executeBattle(interaction);
            if (sub === 'codex')       return await executeCodex(interaction);
            if (sub === 'vacation')    return await executeVacation(interaction);
        } catch (err) {
            console.error('[pet] error:', err);
            const msg = { content: 'Something went wrong with the pet command.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    },
};

module.exports.__test__ = { rareCompanionFooter };
