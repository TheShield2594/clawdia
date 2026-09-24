'use strict';

// `/use` on a seasonal event's loot box: spend the box, roll the event's table,
// grant the prize.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { grantItemsOrOwe } = require('../../../utils/creditOrOwe');
const { lootBoxItemPayoutKey } = require('../../../utils/payoutKey');
const { RARITY_COLORS, rollLootBox } = require('../../../data/seasonalEvents');
const { leftInBag } = require('./status');

/** Opens one of `lootBoxEvent`'s boxes. */
async function useLootBox({ interaction, userFilter, canonicalId, itemName, dropEmptyInventorySlots }, lootBoxEvent) {
    const won = rollLootBox(lootBoxEvent);
    if (!won) {
        return interaction.reply({ content: `The **${lootBoxEvent.lootBox.name}** is empty. That shouldn't happen — let a mod know.`, flags: MessageFlags.Ephemeral });
    }

    // Atomically consume the loot box
    const user = await User.findOneAndUpdate(
        { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } } },
        { $inc: { 'inventory.$.quantity': -1 } },
        { new: true }
    );

    if (!user) {
        return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, flags: MessageFlags.Ephemeral });
    }

    // Credit the won item in one atomic update, then clean up zeros. The
    // match-then-push it replaced could leave two slots for the same item
    // when two boxes opened at once, stranding the second slot's quantity.
    //
    // The box is already consumed above, so a grant that fails loses the
    // prize outright — the item-side #804 failure. A bare grant read
    // nothing back and announced the win regardless; grantItemsOrOwe
    // (keyed, never throwing) records it for `payouts:replay` when it
    // will not land, and the embed says so instead of promising an item
    // that isn't in the bag.
    const wonGrant = await grantItemsOrOwe(
        { userId: userFilter.userId, guildId: userFilter.guildId },
        won.itemId, 1,
        {
            payoutKey: lootBoxItemPayoutKey(interaction.id),
            service: 'use',
            jobName: 'lootBoxItem',
        },
    );

    await dropEmptyInventorySlots();

    // `user` is the post-decrement document, so this is already net of
    // the box just opened.
    const boxRemaining = leftInBag(user, canonicalId);

    const embed = new EmbedBuilder()
        .setColor(RARITY_COLORS[won.rarity] ?? '#5865F2')
        .setTitle(`${lootBoxEvent.lootBox.emoji} Opened: ${lootBoxEvent.lootBox.name}`)
        .setDescription(`You found a **${won.rarity}** item:\n\n${won.emoji} **${won.name}**`)
        .addFields({ name: '🎒 Left in bag', value: `${boxRemaining}x ${lootBoxEvent.lootBox.name}`, inline: true })
        .setTimestamp();

    if (!wonGrant.granted) {
        embed.addFields({
            name: '⚠️ Not Yet in Your Inventory',
            value: wonGrant.owed
                ? `**${won.name}** couldn't be added just now and has been recorded as owed — it'll appear once the problem clears. Tell an admin if it doesn't.`
                : `**${won.name}** couldn't be added and could not be recorded — please contact a server admin.`,
        });
    }

    return interaction.reply({ embeds: [embed] });
}

module.exports = { useLootBox };
