'use strict';

// `/mine shop repair` — the shop quote and the repair kits.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { persistGrindIfNew, saveGrind } = require('../../../../utils/grindProfile');
const {
    quoteRepair,
    applyRepair,
    pickaxeStatusEmoji,
    isCondemned,
    updatePickaxeStatus,
} = require('../../../../services/mineService');
const { CONSUMABLES } = require('../../../../data/mineData');
const { chargeBalance, refundBalance } = require('../shared');

async function handleRepair(interaction, user, currency) {
    const m = user.mining;

    const method = interaction.options.getString('method');

    if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
        return interaction.reply({ content: `You don't have a pickaxe equipped.`, flags: MessageFlags.Ephemeral });
    }

    const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

    if (method === 'shop') {
        // Price it before touching the pickaxe: applyRepair permanently degrades
        // max durability, so quoting first keeps a player who can't pay from
        // wearing their pickaxe down for nothing.
        const quote = quoteRepair(pickaxe, null);
        if (quote.error) return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });

        if (user.balance < quote.cost) {
            return interaction.reply({ content: `Repair costs ${currency}${quote.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
        }

        await persistGrindIfNew(user, 'mining');
        const charged = await chargeBalance(interaction, quote.cost);
        if (!charged) {
            return interaction.reply({ content: `Repair costs ${currency}${quote.cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
        }
        user.balance = charged.balance;
        user.unmarkModified('balance');

        const repairResult = applyRepair(pickaxe, null);
        user.markModified('mining');
        try {
            await saveGrind(user, ['mining']);
        } catch (err) {
            console.error('[mineshop repair] save error:', err);
            await refundBalance(interaction, quote.cost);
            return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle('🔧 Pickaxe Repaired')
            .setDescription(`**${pickaxe.name}** repaired at the shop.`)
            .addFields(
                { name: 'Durability',  value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                { name: 'Status',      value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true },
                { name: 'Cost',        value: `${currency}${repairResult.cost.toLocaleString()}`, inline: true },
                { name: 'Balance',     value: `${currency}${user.balance.toLocaleString()}`, inline: true }
            );

        if (repairResult.condemned) {
            embed.addFields({ name: '💀 Condemned', value: `After so many repairs, your **${pickaxe.name}** has been condemned. It cannot be repaired again. Time for a new one.`, inline: false });
        }
        embed.setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (method === 'kit_small' || method === 'kit_large') {
        const kitId = method === 'kit_small' ? 'repair_kit_small' : 'repair_kit_large';
        const kit   = CONSUMABLES[kitId];
        const stock = m.consumables[kitId] ?? 0;

        if (stock <= 0) {
            return interaction.reply({ content: `You don't have any **${kit.name}**. Buy one with \`/mine shop buy\`.`, flags: MessageFlags.Ephemeral });
        }

        if (isCondemned(pickaxe)) {
            return interaction.reply({ content: 'This pickaxe is condemned and cannot be repaired. Replace it with `/mine shop pickaxe`.', flags: MessageFlags.Ephemeral });
        }
        if (pickaxe.currentDurability >= pickaxe.maxDurability) {
            return interaction.reply({ content: 'Pickaxe is already at full durability.', flags: MessageFlags.Ephemeral });
        }

        m.consumables[kitId] -= 1;
        const restored = Math.min(kit.durabilityRestore, pickaxe.maxDurability - pickaxe.currentDurability);
        pickaxe.currentDurability = Math.min(pickaxe.maxDurability, pickaxe.currentDurability + kit.durabilityRestore);
        updatePickaxeStatus(pickaxe);
        user.markModified('mining');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#b5651d')
                    .setTitle(`${kit.emoji} Repair Kit Used`)
                    .setDescription(`Restored **${restored}** durability to **${pickaxe.name}**.`)
                    .addFields(
                        { name: 'Durability', value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                        { name: 'Status',     value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true }
                    )
                    .setTimestamp()
            ]
        });
    }
}

module.exports = { handleRepair };
