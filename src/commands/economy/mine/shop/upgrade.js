'use strict';

// `/mine shop upgrade` — installing a module on the equipped pickaxe.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { persistGrindIfNew, saveGrind } = require('../../../../utils/grindProfile');
const { PICKAXE_UPGRADES, PICKAXE_BY_TIER } = require('../../../../data/mineData');
const { chargeBalance, refundBalance } = require('../shared');

async function handleBuyUpgrade(interaction, user, currency) {
    const m = user.mining;

    const moduleId = interaction.options.getString('module');
    const upgradeDef = PICKAXE_UPGRADES[moduleId];
    if (!upgradeDef) return interaction.reply({ content: 'Unknown upgrade module.', flags: MessageFlags.Ephemeral });

    if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
        return interaction.reply({ content: `You don't have a pickaxe equipped. Equip one with \`/mine inv equip\`.`, flags: MessageFlags.Ephemeral });
    }

    const pickaxe = m.pickaxes[m.equippedPickaxeIndex];
    if (pickaxe.upgrade) {
        return interaction.reply({ content: `Your **${pickaxe.name}** already has the **${pickaxe.upgrade.replace(/_/g, ' ')}** upgrade installed. Each pickaxe can only have one upgrade.`, flags: MessageFlags.Ephemeral });
    }

    const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
    const cost = Math.round(pickaxeData.cost * upgradeDef.costMultiplier);

    if (user.balance < cost) {
        return interaction.reply({ content: `This upgrade costs ${currency}${cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
    }

    await persistGrindIfNew(user, 'mining');
    const charged = await chargeBalance(interaction, cost);
    if (!charged) {
        return interaction.reply({ content: `This upgrade costs ${currency}${cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
    }
    // Take the authoritative balance and keep any later save off that path.
    user.balance = charged.balance;
    user.unmarkModified('balance');

    pickaxe.upgrade = moduleId;
    user.markModified('mining');
    try {
        await saveGrind(user, ['mining']);
    } catch (err) {
        console.error('[mineshop upgrade] save error:', err);
        pickaxe.upgrade = null;
        await refundBalance(interaction, cost);
        return interaction.reply({ content: 'Installing the upgrade failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor('#b5651d')
        .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
        .setDescription(`**${upgradeDef.name}** has been installed on your **${pickaxe.name}**.\n> ${upgradeDef.description}`)
        .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
        .setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

module.exports = { handleBuyUpgrade };
