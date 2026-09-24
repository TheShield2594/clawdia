'use strict';

// `/use` on an active-effect item: a booster, shield or charm that runs for a
// while or waits armed for its trigger (services/effectsService).

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { EFFECT_CONFIGS, activateEffect, hasEffect } = require('../../../services/effectsService');
const COLORS = require('../../../utils/embedColors');
const { describeEffect, leftField, relativeTime } = require('./status');

/** Starts the effect `effectType` from one of `ctx.canonicalId`, or says why not. */
async function useEffect(ctx, effectType) {
    const { interaction, userFilter, preview, canonicalId, item, shopItems, dropEmptyInventorySlots } = ctx;
    const cfg = EFFECT_CONFIGS[effectType];

    if (hasEffect(preview, effectType)) {
        const existing = preview.activeEffects.find(e => e.type === effectType);
        const when = existing?.expiresAt
            ? `It runs out ${relativeTime(existing.expiresAt)} — use another once it does.`
            : 'It is armed and waiting for its trigger — use another once it fires.';
        return interaction.reply({
            content: `**${cfg.emoji} ${cfg.label}** is already active. ${when} Nothing was consumed.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Consume the item and start the effect in one guarded write (#873,
    // pass 14). This used to consume atomically and then add the effect
    // to the loaded document and save() it: a save that failed left the
    // item spent with no effect running, a save that landed wrote the
    // whole activeEffects array back from its snapshot, and two clicks
    // could both pass the "already active" read above and spend two
    // items on one effect.
    const activation = await activateEffect(User, userFilter, effectType, { consumeItemId: canonicalId });

    if (activation.status !== 'activated') {
        // Either the item went, or the effect started, since the read
        // above — a double-click lands here. Nothing was consumed.
        return interaction.reply({
            content: `Couldn't activate **${cfg.emoji} ${cfg.label}** — it may already be active, or you no longer have one.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const { doc: user, effect } = activation;
    user.inventory = user.inventory.filter(e => e.quantity > 0);
    await dropEmptyInventorySlots();

    const embed = new EmbedBuilder()
        .setColor(item.color ?? COLORS.SUCCESS)
        .setTitle(`${cfg.emoji} Activated: ${cfg.label}`)
        .setTimestamp();

    const what = describeEffect(canonicalId, shopItems);
    embed.setDescription([what, item.lore && `> *${item.lore}*`].filter(Boolean).join('\n\n') || null);

    if (effect.expiresAt) {
        embed.addFields({ name: '⏳ Expires', value: relativeTime(effect.expiresAt), inline: true });
    } else if (effect.charges > 1) {
        embed.addFields({ name: '🔋 Charges', value: `${effect.charges} — spent automatically as they trigger`, inline: true });
    } else {
        embed.addFields({ name: '🎯 Armed', value: 'Fires automatically on the next qualifying event', inline: true });
    }
    embed.addFields(leftField(user, canonicalId));

    return interaction.reply({ embeds: [embed] });
}

module.exports = { useEffect };
