'use strict';

// `/fish shop use` — activating a consumable already in the bag.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { activateConsumable } = require('../../../../services/fishService');
const { CONSUMABLES } = require('../../../../data/fishData');
const COLORS = require('../../../../utils/embedColors');

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const result = activateConsumable(user, itemId);

    if (!result.success) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop use] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const def = CONSUMABLES[itemId];
    const f   = user.fishing;

    const statusLines = [];
    if (f.activeBait)     statusLines.push(`🐟 ${f.activeBait.replace(/_/g, ' ')} active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)     statusLines.push(`🍀 Angler's Luck queued for next cast`);
    if (f.activeXpScroll) statusLines.push(`📜 XP Scroll queued for next cast`);

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.RARE)
                .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                .setDescription(`*${def?.description ?? 'Effect applied.'}*`)
                .addFields({ name: 'Active Buffs', value: statusLines.length ? statusLines.join('\n') : 'None' })
                .setTimestamp()
        ]
    });
}

module.exports = { handleUse };
