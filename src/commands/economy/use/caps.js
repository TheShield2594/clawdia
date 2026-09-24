'use strict';

// `/use` on the items that raise a capped counter: a banked streak freeze, a
// crime contract stack, a permanent stamina upgrade, a pet slot. Each one is
// refused at its cap, and the cap is repeated in the write's filter so a
// double-click can't pass it twice.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { MAX_SLOT_EXPANSIONS, petCapacity } = require('../../../services/petService');
const { MAX_STAMINA_UPGRADES } = require('../../../data/crossSystemData');
const COLORS = require('../../../utils/embedColors');
const { MAX_CONTRACT_STACKS, MAX_FREEZES } = require('./status');

/** Banks a streak freeze, up to `MAX_FREEZES`. */
async function useStreakFreeze({ interaction, userFilter, preview, canonicalId, dropEmptyInventorySlots }) {
    const currentFreezes = preview.streak?.freezes ?? 0;
    if (currentFreezes >= MAX_FREEZES) {
        return interaction.reply({
            content: `🧊 You already have **${currentFreezes}** streak freeze${currentFreezes !== 1 ? 's' : ''} banked (max ${MAX_FREEZES}). Use some before banking more.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const user = await User.findOneAndUpdate(
        { ...userFilter, inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } }, 'streak.freezes': { $lt: MAX_FREEZES } },
        { $inc: { 'inventory.$.quantity': -1, 'streak.freezes': 1 } },
        { new: true }
    );

    if (!user) {
        return interaction.reply({ content: `Couldn't bank the freeze — you may be at the cap already.`, flags: MessageFlags.Ephemeral });
    }

    // Local copy stays filtered for anything rendered below; the stored
    // one is corrected by a targeted $pull.
    user.inventory = user.inventory.filter(e => e.quantity > 0);
    await dropEmptyInventorySlots();

    const newFreezes = user.streak?.freezes ?? 0;
    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('🧊 Streak Freeze Banked')
        .setDescription(
            `One freeze is now stored. If you miss a daily, it auto-consumes to keep your streak alive.\n\n` +
            `**Freezes banked:** ${newFreezes} / ${MAX_FREEZES}`
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

/** Adds a permanent +5% crime stack, up to `MAX_CONTRACT_STACKS`. */
async function useBlackMarketContract({ interaction, userFilter, preview, canonicalId, dropEmptyInventorySlots }) {
    const MAX_STACKS = MAX_CONTRACT_STACKS;
    const currentStacks = preview.crimeContractStacks ?? 0;
    if (currentStacks >= MAX_STACKS) {
        return interaction.reply({
            content: `📜 You already have **${currentStacks}** contract stacks (max ${MAX_STACKS}). The house won't deal further.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const user = await User.findOneAndUpdate(
        {
            ...userFilter,
            inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
            crimeContractStacks: { $lt: MAX_STACKS },
        },
        { $inc: { 'inventory.$.quantity': -1, crimeContractStacks: 1 } },
        { new: true }
    );

    if (!user) {
        return interaction.reply({ content: `Couldn't apply the contract — you may be at the max stacks already.`, flags: MessageFlags.Ephemeral });
    }

    // Local copy stays filtered for anything rendered below; the stored
    // one is corrected by a targeted $pull.
    user.inventory = user.inventory.filter(e => e.quantity > 0);
    await dropEmptyInventorySlots();

    const newStacks = user.crimeContractStacks ?? 0;
    const embed = new EmbedBuilder()
        .setColor('#2c3e50')
        .setTitle('📜 Black Market Contract Signed')
        .setDescription(
            `A permanent +5% crime success bonus has been added to your record.\n\n` +
            `**Contract stacks:** ${newStacks} / ${MAX_STACKS} (+${newStacks * 5}% total bonus)`
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

/** Raises max grind stamina by one, up to `MAX_STAMINA_UPGRADES`. */
async function usePermanentStamina({ interaction, userFilter, preview, canonicalId, dropEmptyInventorySlots }) {
    if ((preview.staminaUpgrades ?? 0) >= MAX_STAMINA_UPGRADES) {
        return interaction.reply({
            content: `⚡ You already have all **${MAX_STAMINA_UPGRADES}** stamina upgrades. There is no more endurance to buy.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const user = await User.findOneAndUpdate(
        {
            ...userFilter,
            inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
            staminaUpgrades: { $lt: MAX_STAMINA_UPGRADES },
        },
        { $inc: { 'inventory.$.quantity': -1, staminaUpgrades: 1 } },
        { new: true }
    );
    if (!user) {
        return interaction.reply({ content: "Couldn't apply the upgrade — you may be at the cap already.", flags: MessageFlags.Ephemeral });
    }

    // The decrement above is already persisted; this only clears the
    // husk it may have left behind.
    await dropEmptyInventorySlots();

    const owned = user.staminaUpgrades ?? 0;
    const embed = new EmbedBuilder()
        .setColor('#f1c40f')
        .setTitle('⚡ Stamina Raised')
        .setDescription(
            `Your maximum stamina in hunting, fishing and mining is now **+${owned}**.\n\n` +
            `**Upgrades:** ${owned} / ${MAX_STAMINA_UPGRADES}`
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

/** Adds a pet slot, up to `MAX_SLOT_EXPANSIONS`. */
async function usePetSlotExpansion({ interaction, userFilter, preview, canonicalId, dropEmptyInventorySlots }) {
    if ((preview.petSlots ?? 0) >= MAX_SLOT_EXPANSIONS) {
        return interaction.reply({
            content: `🐾 You already have all **${MAX_SLOT_EXPANSIONS}** expansions (${petCapacity(preview)} pet slots). There's no more room to make.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const user = await User.findOneAndUpdate(
        {
            ...userFilter,
            inventory: { $elemMatch: { itemId: canonicalId, quantity: { $gt: 0 } } },
            petSlots: { $lt: MAX_SLOT_EXPANSIONS },
        },
        { $inc: { 'inventory.$.quantity': -1, petSlots: 1 } },
        { new: true }
    );
    if (!user) {
        return interaction.reply({ content: "Couldn't add the slot — you may be at the cap already.", flags: MessageFlags.Ephemeral });
    }

    // Local copy stays filtered for anything rendered below; the stored
    // one is corrected by a targeted $pull.
    user.inventory = user.inventory.filter(e => e.quantity > 0);
    await dropEmptyInventorySlots();

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('🐾 Pet Slot Added')
        .setDescription(
            `Room for one more companion.\n\n` +
            `**Slots:** ${petCapacity(user)} (${user.petSlots} / ${MAX_SLOT_EXPANSIONS} expansions used)\n` +
            `*Rare companions found while hunting, fishing or mining don't take up a slot.*`
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

module.exports = { useBlackMarketContract, usePermanentStamina, usePetSlotExpansion, useStreakFreeze };
