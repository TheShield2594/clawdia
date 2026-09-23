'use strict';

// `/market cancel` — taking a listing down and handing the stock back.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const MarketListing = require('../../../models/MarketListing');
const { listingCancelPayoutKey } = require('../../../utils/payoutKey');
const { grantItemsOrOwe } = require('../../../utils/creditOrOwe');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { itemDescriber } = require('../../../utils/aiItemLookup');
const { itemLabel } = require('./shared');

async function handleCancel(interaction, _currency) {
    const rawId = interaction.options.getString('listing_id');

    let listing;
    try {
        listing = await MarketListing.findOneAndDelete({
            _id:      rawId,
            guildId:  interaction.guild.id,
            sellerId: interaction.user.id,
        });
    } catch {
        return interaction.reply({ content: 'Invalid listing ID.', flags: MessageFlags.Ephemeral });
    }

    if (!listing) {
        return interaction.reply({ content: 'Listing not found, already sold, or not yours.', flags: MessageFlags.Ephemeral });
    }

    // The listing is already deleted, so this credit is the only copy of the
    // stock — and the delete is what makes it the only copy: nothing will find
    // this return again, on this tick or any later one.
    //
    // It used to be a bare `grantInventoryItem` in a `try`, which got both
    // halves of that wrong (#873). The call answers `null` rather than throwing
    // for a seller whose document has gone, and the return value was never
    // looked at — so the reply said "Returned 3x lucky_charm" over an item that
    // by then existed nowhere. And the `catch` that did fire wrote a console
    // line calling the items "owed" without recording anything owed, three
    // hundred lines below the `returnStock` in `handleList` that records exactly
    // this for exactly this reason. Both are `grantItemsOrOwe` now, so the
    // failure the reply describes is the failure that happened.
    const returned = await grantItemsOrOwe(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        listing.itemId, listing.quantity,
        {
            payoutKey: listingCancelPayoutKey(listing._id),
            service: 'market',
            jobName: 'cancelListing',
            extra: { listingId: String(listing._id) },
            // The seller is standing right here typing the command, so their
            // document exists; `upsert` is on for the same reason the expiry
            // sweep has it on — a return that arrives after an account prune is
            // still theirs, and a stock return is not a resurrection worth
            // refusing when the alternative is losing the item.
            upsert: true,
        },
    );
    if (!returned.granted) {
        return interaction.reply({
            content: returned.owed
                ? 'The listing was cancelled, but returning your items failed. It is recorded and an admin can restore them.'
                : 'The listing was cancelled, but returning your items failed and could not be recorded. Please contact a server admin.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const guildSettings = await getGuildSettings(interaction.guild.id);
    const label = itemLabel((await itemDescriber([listing.itemId], guildSettings?.shop ?? []))(listing.itemId));
    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('↩️ Listing Cancelled')
        .setDescription(`Returned **${listing.quantity}x** ${label} to your inventory.`)
        .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = { handleCancel };
