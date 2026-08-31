'use strict';

// `/mine shop use` — activating a consumable already in the bag.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { activateConsumable } = require('../../../../services/mineService');
const { resolveConsumableDef } = require('../shared');
const COLORS = require('../../../../utils/embedColors');

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const result = activateConsumable(user, itemId);

    if (!result.success) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }

    await user.save();

    const def = resolveConsumableDef(itemId);
    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                .setDescription(def?.description ?? 'Consumable activated.')
                .setTimestamp()
        ]
    });
}

module.exports = { handleUse };
