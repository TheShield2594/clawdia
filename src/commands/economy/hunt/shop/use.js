'use strict';

// `/hunt shop use` — activating a consumable already in the bag.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { activateConsumable, getMaxStamina } = require('../../../../services/huntService');
const { CONSUMABLES } = require('../../../../data/huntData');
const COLORS = require('../../../../utils/embedColors');

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const { success, error } = activateConsumable(user, itemId);

    if (!success) {
        return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
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
                .setFooter({ text: 'Go hunt! Use /hunt start' })
        ]
    });
}

module.exports = { handleUse };
