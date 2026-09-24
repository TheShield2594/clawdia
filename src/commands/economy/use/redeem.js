'use strict';

// `/use` on one of the guild's own shop items: grant its role, if it has one,
// and otherwise redeem it — what that means is the server admins' to define.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { findShopRow } = require('../../../utils/itemDisplay');
const { withUserLock } = require('../../../utils/userMutex');
const { grantItemsOrOwe } = require('../../../utils/creditOrOwe');
const { useRoleRefundPayoutKey } = require('../../../utils/payoutKey');
const COLORS = require('../../../utils/embedColors');
const { leftField } = require('./status');

/** Redeems one of a guild shop item, granting its role when it carries one. */
async function useShopItem({ interaction, userFilter, canonicalId, item, itemName, shopItems, dropEmptyInventorySlots }) {
    const shopItem = findShopRow(canonicalId, shopItems);

    // A role item is acknowledged privately *before* the lock, as /gift is:
    // a second press can wait out the first one's forced member fetch,
    // write, roles.add and possibly a refund, and an unacknowledged wait
    // past three seconds ends in "the application did not respond".
    // Refusals and refund notes stay private in that reply; the success
    // card goes out publicly as a follow-up.
    const isRoleItem = Boolean(shopItem?.roleId);
    if (isRoleItem) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    /**
     * Checks the role (for a role item), spends one of the item, grants the
     * role or gives the item back when Discord refuses, and posts the card.
     * Runs under the member's lock for a role item, bare otherwise.
     */
    const redeem = async () => {
        // The role is checked before anything is spent, against a fresh fetch
        // (`force`): a cached member can predate a role another bot or an
        // admin just gave, and would let the item be spent on a no-op.
        let member = null;
        if (isRoleItem) {
            member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
            if (!member) {
                return interaction.editReply({
                    content: `Couldn't check your roles just now, so nothing was used. Try again in a moment.`,
                });
            }
            if (member.roles.cache.has(shopItem.roleId)) {
                return interaction.editReply({
                    content: `You already have <@&${shopItem.roleId}>, so **${shopItem.name ?? item.name}** would do nothing. Nothing was used.`,
                    allowedMentions: { parse: [] },
                });
            }
        } else {
            // Acknowledged before the write, like the role path above.
            await interaction.deferReply();
        }

        // Atomically consume one item before side-effects (role grant)
        const user = await User.findOneAndUpdate(
            { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } } },
            { $inc: { 'inventory.$.quantity': -1 } },
            { new: true }
        );

        if (!user) {
            return interaction.editReply({ content: `You don't have **${itemName}** in your inventory.` });
        }

        await dropEmptyInventorySlots();

        let roleGranted = false;
        if (member) {
            try {
                await member.roles.add(shopItem.roleId, `Used shop item: ${shopItem.name}`);
                roleGranted = true;
            } catch (err) {
                // Discord refused (missing permission, role above the bot's). The
                // item is already spent, so it goes back — keyed, and recorded as
                // owed if even that will not land.
                console.error('[use] role grant failed, returning the item:', err?.message ?? err);
                const refund = await grantItemsOrOwe(
                    { userId: userFilter.userId, guildId: userFilter.guildId },
                    canonicalId, 1,
                    { payoutKey: useRoleRefundPayoutKey(interaction.id), service: 'use', jobName: 'roleRefund' },
                );
                return interaction.editReply({
                    content: refund.granted
                        ? `Couldn't give you <@&${shopItem.roleId}> — the bot may lack permission. Your **${item.name}** was returned; let an admin know.`
                        : `Couldn't give you <@&${shopItem.roleId}>, and returning your **${item.name}** failed${refund.owed ? ' — it is recorded as owed and will come back' : ''}. Please tell an admin.`,
                    allowedMentions: { parse: [] },
                });
            }
        }

        const baseDesc    = shopItem?.description || 'Redeemed from your inventory.';
        const genericDesc = item.lore ? `${baseDesc}\n\n> *${item.lore}*` : baseDesc;

        const embed = new EmbedBuilder()
            .setColor(item.color ?? COLORS.SUCCESS)
            .setTitle(`${item.emoji} Used: ${shopItem?.name ?? item.name}`)
            .setDescription(genericDesc)
            .setTimestamp();

        if (roleGranted) {
            embed.addFields({ name: '🎭 Role Granted', value: `<@&${shopItem.roleId}>`, inline: true });
        }

        // `user` is the post-decrement document — no second subtraction.
        embed.addFields(leftField(user, canonicalId));

        if (isRoleItem) {
            await interaction.editReply({ content: `✅ Used **${shopItem.name ?? item.name}**.` });
            return interaction.followUp({ embeds: [embed] });
        }
        return interaction.editReply({ embeds: [embed] });
    };

    // One role redemption per member at a time: two quick /use presses on a
    // stack of two would otherwise both pass the has-role check and spend
    // the second item on a role the first had just granted.
    return isRoleItem
        ? withUserLock(`use-role:${userFilter.guildId}:${userFilter.userId}`, redeem)
        : redeem();
}

module.exports = { useShopItem };
