'use strict';

// `/hunt shop upgrade` — installing a module on the equipped weapon.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { WEAPON_UPGRADES, WEAPON_BY_TIER } = require('../../../../data/huntData');
const { chargeBalance, refundBalance } = require('../shared');
const COLORS = require('../../../../utils/embedColors');

async function handleBuyUpgrade(interaction, user, currency) {
    const moduleId   = interaction.options.getString('module');
    const upgradeDef = WEAPON_UPGRADES[moduleId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade module.', flags: MessageFlags.Ephemeral });
    }

    const h = user.hunt;
    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Equip a weapon first with `/hunt inv equip`.', flags: MessageFlags.Ephemeral });
    }

    const weapon     = h.weapons[h.equippedWeaponIndex];
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    const cost       = Math.round(weaponData.cost * upgradeDef.costMultiplier);

    if (weapon.upgrade) {
        return interaction.reply({
            content: `Your **${weapon.name}** already has a **${weapon.upgrade.replace(/_/g, ' ')}** installed. Each weapon supports only one upgrade.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need ${currency}${cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const charged = await chargeBalance(interaction, cost);
    if (!charged) {
        return interaction.reply({
            content: `This upgrade costs ${currency}${cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    // Take the authoritative balance and keep the save off that path.
    user.balance   = charged.balance;
    user.unmarkModified('balance');
    weapon.upgrade  = moduleId;
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[huntshop upgrade] save error:', err);
        weapon.upgrade = null;
        await refundBalance(interaction, cost);
        return interaction.reply({ content: 'Installing the upgrade failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
                .setDescription(`**${upgradeDef.name}** has been installed on your **${weapon.name}**.`)
                .addFields(
                    { name: 'Effect',      value: upgradeDef.description,                       inline: true },
                    { name: 'Cost',        value: `${currency}${cost.toLocaleString()}`,         inline: true },
                    { name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                )
                .setFooter({ text: 'Upgrade is permanently attached to this weapon instance.' })
        ]
    });
}

module.exports = { handleBuyUpgrade };
