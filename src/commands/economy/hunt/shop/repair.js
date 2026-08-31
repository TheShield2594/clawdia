'use strict';

// `/hunt shop repair` — the shop quote, the repair kits, and what a weapon
// has left before it is condemned.

const { MessageFlags, EmbedBuilder } = require('discord.js');
const {
    isCondemned,
    updateWeaponStatus,
    durabilityBar,
    quoteRepair,
    applyRepair,
    weaponStatusEmoji,
    repairsRemaining,
} = require('../../../../services/huntService');
const { CONSUMABLES } = require('../../../../data/huntData');
const { chargeBalance, refundBalance } = require('../shared');
const COLORS = require('../../../../utils/embedColors');

async function handleRepair(interaction, user, currency) {
    const h = user.hunt;

    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Buy one with `/hunt shop weapon` first.', flags: MessageFlags.Ephemeral });
    }

    const weapon = h.weapons[h.equippedWeaponIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', flags: MessageFlags.Ephemeral });
        }

        const kitDef = CONSUMABLES[kitId];
        const stock  = h.consumables[kitId] ?? 0;

        if (stock <= 0) {
            return interaction.reply({
                content: `You don't have any **${kitDef.name}**. Buy them with \`/hunt shop buy\`.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (isCondemned(weapon)) {
            return interaction.reply({ content: 'This weapon is condemned and cannot be repaired. Replace it with `/hunt shop weapon`.', flags: MessageFlags.Ephemeral });
        }
        if (weapon.currentDurability >= weapon.maxDurability) {
            return interaction.reply({ content: `Your **${weapon.name}** is already at full durability.`, flags: MessageFlags.Ephemeral });
        }

        const before = weapon.currentDurability;
        weapon.currentDurability = Math.min(weapon.maxDurability, weapon.currentDurability + kitDef.durabilityRestore);
        updateWeaponStatus(weapon);
        h.consumables[kitId] -= 1;
        user.markModified('hunt');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle(`${kitDef.emoji} Repair Kit Used`)
                    .setDescription(`Your **${weapon.name}** has been field-repaired.`)
                    .addFields(
                        { name: 'Before',         value: `${before}/${weapon.maxDurability}`,                                                  inline: true },
                        { name: 'After',          value: `${weapon.currentDurability}/${weapon.maxDurability}`,                                 inline: true },
                        { name: 'Kits Remaining', value: `${h.consumables[kitId]} × ${kitDef.name}`,                                          inline: true },
                        { name: 'Durability Bar', value: `${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}` }
                    )
                    .setFooter({ text: 'Field repairs do not degrade max durability' })
            ]
        });
    }

    if (isCondemned(weapon)) {
        return interaction.reply({ content: 'This weapon is **condemned** and cannot be repaired. Replace it with `/hunt shop weapon`.', flags: MessageFlags.Ephemeral });
    }
    if (weapon.currentDurability >= weapon.maxDurability && weapon.status !== 'broken') {
        return interaction.reply({ content: `Your **${weapon.name}** is already at full durability (${weapon.currentDurability}/${weapon.maxDurability}).`, flags: MessageFlags.Ephemeral });
    }

    const needed     = weapon.maxDurability - weapon.currentDurability;
    let requestedAmt = interaction.options.getInteger('amount');
    if (!requestedAmt || requestedAmt > needed) requestedAmt = needed;
    requestedAmt = Math.ceil(requestedAmt / 20) * 20;

    // Price the repair before applying it — applyRepair degrades max durability and
    // bumps the repair count, and none of that should happen on a quote the player
    // can't afford.
    const quote = quoteRepair(weapon, requestedAmt);

    if (quote.error) {
        return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });
    }
    if (user.balance < quote.cost) {
        return interaction.reply({
            content: `Repair costs ${currency}${quote.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const result = applyRepair(weapon, requestedAmt);
    if (result.error) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }

    const chargedRepair = await chargeBalance(interaction, result.cost);
    if (!chargedRepair) {
        return interaction.reply({
            content: `Repair costs ${currency}${result.cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    user.balance = chargedRepair.balance;
    user.unmarkModified('balance');
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[huntshop repair] save error:', err);
        await refundBalance(interaction, result.cost);
        return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const statusIcon = weaponStatusEmoji(result.newStatus);
    // How many repairs are left is the number that decides whether to keep
    // paying into this weapon or replace it, and it was never shown — the embed
    // only counted the ones already spent (#747).
    const repairsLeft = repairsRemaining(weapon);
    const repairCountValue = result.condemned
        ? `${weapon.repairCount} — no repairs left`
        : `${weapon.repairCount} used · **${repairsLeft}** left (max dur -10% each)`;
    const embed = new EmbedBuilder()
        .setColor(result.condemned ? '#e74c3c' : '#2ecc71')
        .setTitle('🔧 Weapon Repaired')
        .setDescription(`Your **${weapon.name}** has been repaired.`)
        .addFields(
            { name: 'Durability Restored', value: `+${result.restoredAmount}`,                             inline: true },
            { name: 'New Durability',       value: `${weapon.currentDurability}/${weapon.maxDurability}`,   inline: true },
            { name: 'Weapon Status',        value: `${statusIcon} ${result.newStatus}`,                     inline: true },
            { name: 'Repair Cost',          value: `${currency}${result.cost.toLocaleString()}`,            inline: true },
            { name: 'New Balance',          value: `${currency}${user.balance.toLocaleString()}`,           inline: true },
            { name: 'Repair Count',         value: repairCountValue,                                       inline: true },
            { name: 'Durability Bar',       value: `${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}` }
        );

    if (result.condemned) {
        embed.addFields({ name: '⚠️ Condemned!', value: 'Max durability has dropped too low. This weapon **cannot be repaired again**. Consider replacing it with `/hunt shop weapon`.' });
    } else if (result.newStatus === 'degraded') {
        embed.addFields({ name: '⚠️ Degraded', value: 'Max durability is below 50% of original. Performance is reduced.' });
    }

    embed.setFooter({ text: 'Each shop repair permanently reduces max durability by 10% • Use repair kits to avoid degradation' });

    return interaction.reply({ embeds: [embed] });
}

module.exports = { handleRepair };
