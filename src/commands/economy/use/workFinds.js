'use strict';

// `/use` on the two `/work` finds that do something: the Master Key and the
// Career Badge (data/workFinds).

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { grantItemsOrOwe } = require('../../../utils/creditOrOwe');
const { supplyClosetPayoutKey } = require('../../../utils/payoutKey');
const { rollSupplyCloset, CAREER_BADGE_SHIFTS } = require('../../../data/workFinds');
const COLORS = require('../../../utils/embedColors');
const { leftField, topTierShifts } = require('./status');

/** Spends a Master Key on one roll of the supply closet. */
async function useMasterKey({ interaction, userFilter, canonicalId, item, itemName, dropEmptyInventorySlots }) {
    const found = rollSupplyCloset();

    // Spend the key first, then grant what it opened: the loot box's
    // shape, and for the same reason — a grant that misses is recorded
    // as owed under the key rather than lost.
    const user = await User.findOneAndUpdate(
        { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } } },
        { $inc: { 'inventory.$.quantity': -1 } },
        { new: true }
    );
    if (!user) {
        return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, flags: MessageFlags.Ephemeral });
    }

    const grant = await grantItemsOrOwe(
        { userId: userFilter.userId, guildId: userFilter.guildId },
        found.itemId, 1,
        {
            payoutKey: supplyClosetPayoutKey(interaction.id),
            service: 'use',
            jobName: 'supplyClosetItem',
        },
    );
    await dropEmptyInventorySlots();

    const embed = new EmbedBuilder()
        .setColor(item.color ?? COLORS.SUCCESS)
        .setTitle('🔑 Supply Closet Unlocked')
        .setDescription(`Behind the door marked *Authorized Personnel Only*, you find a ${found.emoji} **${found.name}**.`)
        .addFields(leftField(user, canonicalId))
        .setTimestamp();
    if (!grant.granted) {
        embed.addFields({
            name: '⚠️ Not Yet in Your Inventory',
            value: grant.owed
                ? `**${found.name}** couldn't be added just now and has been recorded as owed — it'll appear once the problem clears. Tell an admin if it doesn't.`
                : `**${found.name}** couldn't be added and could not be recorded — please contact a server admin.`,
        });
    }
    return interaction.reply({ embeds: [embed] });
}

/** Credits `CAREER_BADGE_SHIFTS` shifts, short of the guild's top job tier. */
async function useCareerBadge({ interaction, userFilter, canonicalId, item, tiers, dropEmptyInventorySlots }) {
    const top = topTierShifts(tiers);
    // useStatus already refused a player at the top tier; the
    // filter repeats it so a shift worked in between can't waste one.
    const user = await User.findOneAndUpdate(
        {
            ...userFilter,
            inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
            shiftsWorked: { $lt: top },
        },
        { $inc: { 'inventory.$.quantity': -1, shiftsWorked: CAREER_BADGE_SHIFTS } },
        { new: true }
    );
    if (!user) {
        return interaction.reply({ content: "Couldn't pin the badge on — you may already be at the top job tier, or no longer have one.", flags: MessageFlags.Ephemeral });
    }
    await dropEmptyInventorySlots();

    const shifts = user.shiftsWorked ?? 0;
    const current = [...tiers].reverse().find(t => shifts >= t.minShifts) ?? tiers[0];
    const next = tiers.find(t => t.minShifts > shifts);
    const embed = new EmbedBuilder()
        .setColor(item.color ?? COLORS.SUCCESS)
        .setTitle('📛 Career Badge Pinned')
        .setDescription(
            `HR counts it as **${CAREER_BADGE_SHIFTS} shifts** on your record.\n\n`
            + `**${current.name}** · ${shifts.toLocaleString()} shifts\n`
            + (next
                ? `Next up: ${next.name} in **${(next.minShifts - shifts).toLocaleString()}** more shifts`
                : '✅ Top job tier reached — `/work` now picks from every job.'))
        .addFields(leftField(user, canonicalId))
        .setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

module.exports = { useCareerBadge, useMasterKey };
