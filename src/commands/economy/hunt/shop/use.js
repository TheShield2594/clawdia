'use strict';

// `/hunt shop use` — activating a consumable already in the bag, and the
// picker that offers what is held (utils/grindUsePicker).

const { MessageFlags, EmbedBuilder } = require('discord.js');
const {
    activateConsumable, applyStaminaRegen, consumableStatus, ensureHuntData, getMaxStamina,
} = require('../../../../services/huntService');
const { CONSUMABLES } = require('../../../../data/huntData');
const { leftInBagField, resolveConsumableId, respondWithConsumables } = require('../../../../utils/grindUsePicker');
const COLORS = require('../../../../utils/embedColors');
const { ACTIVATABLE } = require('../shared');

const USE_PICKER = {
    key: 'hunt',
    label: 'hunt shop',
    activatable: ACTIVATABLE,
    defOf: id => CONSUMABLES[id],
    ensure: ensureHuntData,
    applyStaminaRegen,
    consumableStatus,
};

/** The `item` autocomplete: held consumables, with count and status. */
const autocompleteUse = interaction => respondWithConsumables(interaction, USE_PICKER);

async function handleUse(interaction, user) {
    const itemId = resolveConsumableId(interaction.options.getString('item'), USE_PICKER);
    const { success, error } = activateConsumable(user, itemId);

    if (!success) {
        return interaction.reply({ content: `${error} Nothing was used.`, flags: MessageFlags.Ephemeral });
    }

    await user.save();

    const def = CONSUMABLES[itemId];
    const h   = user.hunt;
    let statusMsg = '';

    if (def.type === 'bait')                              statusMsg = `Active for **${h.activeBaitHuntsLeft}** hunts.`;
    if (def.type === 'charm')                             statusMsg = `Active for **${h.activeCharmHuntsLeft}** hunts.`;
    if (def.type === 'instant' && itemId === 'hunters_focus') statusMsg = `Will apply on your next hunt.`;
    if (def.type === 'instant' && itemId === 'xp_scroll') statusMsg = `Will apply on your next hunt.`;
    if (def.type === 'stamina')                           statusMsg = `Stamina: **${h.stamina}/${getMaxStamina(user)}** — restored ${def.staminaRestore} points.`;

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle(`${def.emoji} ${def.name} Activated!`)
                .setDescription(`${def.description}\n${statusMsg}`)
                .addFields(leftInBagField(user, USE_PICKER, itemId))
                .setFooter({ text: 'Go hunt! Use /hunt start' })
        ]
    });
}

module.exports = { USE_PICKER, autocompleteUse, handleUse };
