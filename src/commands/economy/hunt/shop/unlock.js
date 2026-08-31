'use strict';

// `/hunt shop unlock` — buying access to a zone.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { ZONES, MATERIAL_NAMES } = require('../../../../data/huntData');
const { chargeBalance, refundBalance } = require('../shared');
const COLORS = require('../../../../utils/embedColors');

async function handleUnlock(interaction, user, currency) {
    const h      = user.hunt;
    const zoneId = interaction.options.getString('zone');
    const zone   = ZONES[zoneId];

    if (!zone) {
        return interaction.reply({ content: 'Unknown zone.', flags: MessageFlags.Ephemeral });
    }
    if (zone.defaultUnlocked || h.unlockedZones.includes(zoneId)) {
        return interaction.reply({ content: `**${zone.name}** is already unlocked.`, flags: MessageFlags.Ephemeral });
    }
    if (h.level < zone.unlockLevel) {
        return interaction.reply({
            content: `You need Hunter Level **${zone.unlockLevel}** to unlock **${zone.name}**. You're Level ${h.level}.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < zone.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const chargedUnlock = await chargeBalance(interaction, zone.unlockCost);
    if (!chargedUnlock) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    user.balance = chargedUnlock.balance;
    user.unmarkModified('balance');
    h.unlockedZones.push(zoneId);
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[hunt unlock] save error:', err);
        h.unlockedZones = h.unlockedZones.filter(z => z !== zoneId);
        await refundBalance(interaction, zone.unlockCost);
        return interaction.reply({ content: 'Unlocking the zone failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const tierStr = Object.entries(zone.tierWeights)
        .filter(([, w]) => w > 0)
        .map(([t, w]) => `${t}: ${w}%`)
        .join(' · ');

    const materialStr = (zone.zoneMaterials ?? [])
        .map(id => MATERIAL_NAMES[id] ?? id)
        .join(' · ');

    const unlockEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${zone.emoji} Zone Unlocked: ${zone.name}!`)
        .setDescription(zone.description)
        .addFields(
            { name: 'Loot Table',   value: tierStr,                                                                                             inline: false },
            { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty',           inline: true },
            { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard',                        inline: true },
            { name: 'Unlock Cost',  value: `${currency}${zone.unlockCost.toLocaleString()}`,                                                     inline: true },
            { name: 'New Balance',  value: `${currency}${user.balance.toLocaleString()}`,                                                        inline: true }
        )
        .setFooter({ text: `Switch to it with /hunt zone set ${zoneId}` });

    if (materialStr) {
        unlockEmbed.addFields({ name: '🪨 Materials Found Here', value: materialStr, inline: false });
    }

    return interaction.reply({ embeds: [unlockEmbed] });
}

module.exports = { handleUnlock };
