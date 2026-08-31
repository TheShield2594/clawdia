'use strict';

// `/mine shop unlock` — buying access to a depth.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { persistGrindIfNew, saveGrind } = require('../../../../utils/grindProfile');
const { DEPTHS } = require('../../../../data/mineData');
const { chargeBalance, refundBalance } = require('../shared');

async function handleUnlock(interaction, user, currency) {
    const m = user.mining;

    const depthId  = interaction.options.getString('depth');
    const depthDef = DEPTHS[depthId];

    if (!depthDef) return interaction.reply({ content: 'Unknown depth.', flags: MessageFlags.Ephemeral });
    if (depthDef.defaultUnlocked || m.unlockedDepths.includes(depthId)) {
        return interaction.reply({ content: `You've already unlocked **${depthDef.name}**.`, flags: MessageFlags.Ephemeral });
    }
    if (m.level < depthDef.unlockLevel) {
        return interaction.reply({ content: `You need Miner Level **${depthDef.unlockLevel}** to unlock **${depthDef.name}**. You're Level ${m.level}.`, flags: MessageFlags.Ephemeral });
    }
    if (user.balance < depthDef.unlockCost) {
        return interaction.reply({ content: `Unlocking **${depthDef.name}** costs ${currency}${depthDef.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
    }

    await persistGrindIfNew(user, 'mining');
    const charged = await chargeBalance(interaction, depthDef.unlockCost);
    if (!charged) {
        return interaction.reply({ content: `Unlocking **${depthDef.name}** costs ${currency}${depthDef.unlockCost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
    }
    user.balance = charged.balance;
    user.unmarkModified('balance');

    const priorDepth = m.activeDepth;
    m.unlockedDepths.push(depthId);
    m.activeDepth = depthId;
    user.markModified('mining');
    try {
        await saveGrind(user, ['mining']);
    } catch (err) {
        console.error('[mineshop unlock] save error:', err);
        m.unlockedDepths = m.unlockedDepths.filter(id => id !== depthId);
        m.activeDepth = priorDepth;
        await refundBalance(interaction, depthDef.unlockCost);
        return interaction.reply({ content: 'The unlock failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor('#b5651d')
        .setTitle(`${depthDef.emoji} Depth Unlocked!`)
        .setDescription(`**${depthDef.name}** is now accessible.\n> ${depthDef.description}`)
        .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
        .setFooter({ text: `Now set as your active depth — use /mine dig to start digging!` })
        .setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

module.exports = { handleUnlock };
