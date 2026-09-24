'use strict';

// `/mine shop use` — activating a consumable already in the bag, and the
// picker that offers what is held (utils/grindUsePicker).

const { MessageFlags, EmbedBuilder } = require('discord.js');
const {
    activateConsumable, applyStaminaRegen, consumableStatus, ensureMineData,
} = require('../../../../services/mineService');
const { leftInBagField, resolveConsumableId, respondWithConsumables } = require('../../../../utils/grindUsePicker');
const { ACTIVATABLE, resolveConsumableDef } = require('../shared');
const COLORS = require('../../../../utils/embedColors');

const USE_PICKER = {
    key: 'mining',
    label: 'mine shop',
    activatable: ACTIVATABLE,
    defOf: resolveConsumableDef,
    ensure: ensureMineData,
    applyStaminaRegen,
    consumableStatus,
};

/** The `item` autocomplete: held consumables, with count and status. */
const autocompleteUse = interaction => respondWithConsumables(interaction, USE_PICKER);

async function handleUse(interaction, user) {
    const itemId = resolveConsumableId(interaction.options.getString('item'), USE_PICKER);
    const result = activateConsumable(user, itemId);

    if (!result.success) {
        return interaction.reply({ content: `${result.error} Nothing was used.`, flags: MessageFlags.Ephemeral });
    }

    await user.save();

    const def = resolveConsumableDef(itemId);
    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                .setDescription(def?.description ?? 'Consumable activated.')
                .addFields(leftInBagField(user, USE_PICKER, itemId))
                .setTimestamp()
        ]
    });
}

module.exports = { USE_PICKER, autocompleteUse, handleUse };
