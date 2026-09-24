'use strict';

// `/fish shop use` — activating a consumable already in the bag, and the
// picker that offers what is held (utils/grindUsePicker).

const { MessageFlags, EmbedBuilder } = require('discord.js');
const {
    activateConsumable, applyStaminaRegen, consumableStatus, ensureFishingData,
} = require('../../../../services/fishService');
const { CONSUMABLES } = require('../../../../data/fishData');
const { CROSS_CONSUMABLES } = require('../../../../data/crossSystemData');
const { leftInBagField, resolveConsumableId, respondWithConsumables } = require('../../../../utils/grindUsePicker');
const COLORS = require('../../../../utils/embedColors');

// Everything activateConsumable takes: the fishing shop's own consumables bar
// the repair kits (those go through `/fish shop repair`), and the crafted
// cross-system lures that land in the fishing bag.
const defOf = id => CONSUMABLES[id] ?? CROSS_CONSUMABLES[id];
const ACTIVATABLE = [
    ...Object.values(CONSUMABLES).filter(c => c.type !== 'repair').map(c => c.id),
    ...Object.values(CROSS_CONSUMABLES).filter(c => c.system === 'fishing').map(c => c.id),
];

const USE_PICKER = {
    key: 'fishing',
    label: 'fish shop',
    activatable: ACTIVATABLE,
    defOf,
    ensure: ensureFishingData,
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

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop use] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const def = defOf(itemId);
    const f   = user.fishing;

    const statusLines = [];
    if (f.activeBait)     statusLines.push(`🐟 ${defOf(f.activeBait)?.name ?? f.activeBait.replace(/_/g, ' ')} active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)     statusLines.push(`🍀 Angler's Luck queued for next cast`);
    if (f.activeXpScroll) statusLines.push(`📜 XP Scroll queued for next cast`);

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.RARE)
                .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                .setDescription(`*${def?.description ?? 'Effect applied.'}*`)
                .addFields(
                    { name: 'Active Buffs', value: statusLines.length ? statusLines.join('\n') : 'None' },
                    leftInBagField(user, USE_PICKER, itemId),
                )
                .setTimestamp()
        ]
    });
}

module.exports = { ACTIVATABLE, USE_PICKER, autocompleteUse, handleUse };
