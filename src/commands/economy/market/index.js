'use strict';

// `/market` — the player-to-player item marketplace. Each subcommand lives in
// its own sibling file; this one declares the command and routes to them.

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { MIN_PRICE_PER_ITEM } = require('./shared');
const { inventoryChoices, listedItemChoices, listingChoices } = require('./pickers');
const { handleList }   = require('./list');
const { handleBrowse } = require('./browse');
const { handleBuy }    = require('./buy');
const { handleCancel } = require('./cancel');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('market')
        .setDescription('Server player-to-player item marketplace.')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List an item for sale.')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Item to sell — start typing to pick from your inventory.')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addIntegerOption(o =>
                    o.setName('quantity').setDescription('How many to sell.').setRequired(true).setMinValue(1))
                .addIntegerOption(o =>
                    o.setName('price').setDescription('Price per unit (coins).').setRequired(true).setMinValue(MIN_PRICE_PER_ITEM)))
        .addSubcommand(sub =>
            sub.setName('browse')
                .setDescription('Browse active listings.')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Filter by item — start typing to pick one that is actually listed.')
                        .setRequired(false)
                        .setAutocomplete(true)))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Buy a listing by its ID.')
                .addStringOption(o =>
                    o.setName('listing_id')
                        .setDescription('Listing to buy — start typing to pick one.')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('Cancel one of your active listings and get your item back.')
                .addStringOption(o =>
                    o.setName('listing_id')
                        .setDescription('Which of your listings to cancel — start typing to pick one.')
                        .setRequired(true)
                        .setAutocomplete(true))),

    /**
     * Every option on this command was an id typed from memory.
     *
     * `item` is the worse half of that: inventory ids are not uniformly cased —
     * a relic is stored under its prose name and a custom shop item under its
     * display name, because shop.js stores an item as `itemId || name` — so
     * `/market list item:The Tenth Owl` was a spelling test, and the handler's
     * `.toLowerCase()` meant a relic could not be listed at all. `listing_id` is
     * a 24-character hex string that had to be copied out of `/market browse`.
     */
    async autocomplete(interaction) {
        try {
            const sub     = interaction.options.getSubcommand();
            const focused = interaction.options.getFocused(true);
            const typed   = (focused?.value ?? '').toLowerCase();

            if (focused?.name === 'item' && sub === 'list')   return interaction.respond(await inventoryChoices(interaction, typed));
            if (focused?.name === 'item' && sub === 'browse') return interaction.respond(await listedItemChoices(interaction, typed));
            if (focused?.name === 'listing_id')               return interaction.respond(await listingChoices(interaction, typed, sub));
            return interaction.respond([]);
        } catch (err) {
            console.error('[market] autocomplete error:', err);
            await interaction.respond([]).catch(() => {});
        }
    },

    async execute(interaction) {
        const guildSettings = await getGuildSettings(interaction.guild.id);
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const sub      = interaction.options.getSubcommand();

        // The settings are passed on, not re-read by each handler.
        if (sub === 'list')   return handleList(interaction, currency, guildSettings);
        if (sub === 'browse') return handleBrowse(interaction, currency, guildSettings);
        if (sub === 'buy')    return handleBuy(interaction, currency, guildSettings);
        if (sub === 'cancel') return handleCancel(interaction, currency, guildSettings);
    },
};
