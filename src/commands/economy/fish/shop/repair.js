'use strict';

// `/fish shop repair` — the shop quote and the repair kits.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const {
    updateRodStatus,
    durabilityBar,
    rodStatusEmoji,
    quoteRepair,
    applyRepair,
} = require('../../../../services/fishService');
const { chargeBalance, refundBalance } = require('../shared');
const COLORS = require('../../../../utils/embedColors');

async function handleRepair(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Buy one with \`/fish shop rod\`.`, flags: MessageFlags.Ephemeral });
    }

    const rod    = f.rods[f.equippedRodIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', flags: MessageFlags.Ephemeral });
        }

        const kitStock   = f.consumables[kitId] ?? 0;
        const kitRestore = kitId === 'repair_kit_small' ? 20 : 50;
        const kitName    = kitId === 'repair_kit_small' ? 'Small Repair Kit' : 'Large Repair Kit';

        if (kitStock <= 0) {
            return interaction.reply({ content: `You don't have any **${kitName}**. Buy one with \`/fish shop buy\`.`, flags: MessageFlags.Ephemeral });
        }
        if (rod.status === 'condemned') {
            return interaction.reply({ content: 'This rod is condemned and cannot be repaired.', flags: MessageFlags.Ephemeral });
        }
        if (rod.currentDurability >= rod.maxDurability && rod.status !== 'broken') {
            return interaction.reply({ content: 'Your rod is already at full durability.', flags: MessageFlags.Ephemeral });
        }

        const restored = Math.min(kitRestore, rod.maxDurability - rod.currentDurability);
        rod.currentDurability = Math.min(rod.maxDurability, rod.currentDurability + restored);
        updateRodStatus(rod);
        f.consumables[kitId] -= 1;
        user.markModified('fishing');

        try {
            await user.save();
        } catch (err) {
            console.error('[fishshop repair kit] save error:', err);
            return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
        }

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle(`${kitId === 'repair_kit_small' ? '🔧' : '🔨'} ${kitName} Used`)
                    .addFields(
                        { name: 'Rod',       value: rod.name,                                                                               inline: true },
                        { name: 'Restored',  value: `+${restored} durability`,                                                              inline: true },
                        { name: 'Remaining', value: `${kitStock - 1} kit(s) left`,                                                          inline: true },
                        { name: 'Durability',value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
                        { name: 'Status',    value: `${rodStatusEmoji(rod.status)} ${rod.status}`,                                          inline: true }
                    )
                    .setFooter({ text: 'Repair kits do not degrade max durability.' })
                    .setTimestamp()
            ]
        });
    }

    const requestedAmount = interaction.options.getInteger('amount') ?? null;

    // Price the repair before committing — applying it permanently degrades the
    // rod's max durability, which must not happen on a quote the player can't buy.
    const quote = quoteRepair(rod, requestedAmount);
    if (quote.error) {
        return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });
    }
    if (user.balance < quote.cost) {
        return interaction.reply({
            content: `Repairing **${quote.restoredAmount}** durability costs **${currency}${quote.cost.toLocaleString()}**. You only have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const result = applyRepair(rod, requestedAmount);
    const charged = await chargeBalance(interaction, result.cost);
    if (!charged) {
        return interaction.reply({
            content: `Repairing **${result.restoredAmount}** durability costs **${currency}${result.cost.toLocaleString()}** — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    // Take the authoritative balance and keep the save off that path.
    user.balance = charged.balance;
    user.unmarkModified('balance');
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop repair shop] save error:', err);
        await refundBalance(interaction, result.cost);
        return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('🔧 Rod Repaired')
        .addFields(
            { name: 'Rod',        value: rod.name,                                                                               inline: true },
            { name: 'Restored',   value: `+${result.restoredAmount} durability`,                                                 inline: true },
            { name: 'Cost',       value: `${currency}${result.cost.toLocaleString()}`,                                           inline: true },
            { name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
            { name: 'Status',     value: `${rodStatusEmoji(rod.status)} ${rod.status}`,                                          inline: true },
            { name: 'Balance',    value: `${currency}${user.balance.toLocaleString()}`,                                          inline: true }
        )
        .setTimestamp();

    if (result.condemned) {
        embed.setColor(COLORS.ERROR);
        embed.addFields({ name: '⚠️ Condemned', value: 'This rod has been repaired too many times and cannot be repaired again. Consider buying a new one with `/fish shop rod`.', inline: false });
    } else {
        embed.addFields({ name: 'ℹ️ Note', value: `Max durability slightly reduced to ${rod.maxDurability} after this repair.`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

module.exports = { handleRepair };
