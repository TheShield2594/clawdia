'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { ROD_BY_TIER } = require('../../data/fishData');
const { ensureFishingData, applyRepair, rodStatusEmoji, durabilityBar } = require('../../services/fishService');

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fishrepair')
        .setDescription('Repair your equipped fishing rod or use a repair kit')
        .addSubcommand(sub =>
            sub.setName('shop')
                .setDescription('Repair your rod at the shop (costs coins; degrades max durability)')
                .addIntegerOption(o =>
                    o.setName('amount')
                        .setDescription('Durability points to restore (default: full repair)')
                        .setMinValue(1)
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('kit')
                .setDescription('Use a Repair Kit from your inventory')
                .addStringOption(o =>
                    o.setName('size')
                        .setDescription('Which kit to use')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Small Repair Kit (+20 durability)', value: 'repair_kit_small' },
                            { name: 'Large Repair Kit (+50 durability)', value: 'repair_kit_large' }
                        ))),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';
        const sub      = interaction.options.getSubcommand();

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureFishingData(user);

        const f = user.fishing;

        if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
            return interaction.reply({ content: `You don't have a rod equipped. Buy one with \`/buyrod\`.`, ephemeral: true });
        }

        const rod = f.rods[f.equippedRodIndex];

        if (sub === 'shop') {
            return handleShopRepair(interaction, user, rod, currency);
        }
        return handleKitRepair(interaction, user, rod, currency);
    }
};

// ─── SHOP REPAIR ─────────────────────────────────────────────────────────────

async function handleShopRepair(interaction, user, rod, currency) {
    const requestedAmount = interaction.options.getInteger('amount') ?? null;
    const result = applyRepair(rod, requestedAmount);

    if (result.error) {
        return interaction.reply({ content: result.error, ephemeral: true });
    }

    if (user.balance < result.cost) {
        return interaction.reply({
            content: `Repairing **${result.restoredAmount}** durability costs **${currency}${result.cost.toLocaleString()}**. You only have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    user.balance -= result.cost;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishrepair shop] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle('🔧 Rod Repaired')
        .addFields(
            { name: 'Rod',             value: rod.name,                                              inline: true },
            { name: 'Restored',        value: `+${result.restoredAmount} durability`,                inline: true },
            { name: 'Cost',            value: `${currency}${result.cost.toLocaleString()}`,          inline: true },
            { name: 'Durability',      value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
            { name: 'Status',          value: `${rodStatusEmoji(rod.status)} ${rod.status}`,         inline: true },
            { name: 'Balance',         value: `${currency}${user.balance.toLocaleString()}`,         inline: true }
        )
        .setTimestamp();

    if (result.condemned) {
        embed.setColor('#e74c3c');
        embed.addFields({ name: '⚠️ Condemned', value: 'This rod has been repaired too many times. It cannot be repaired again. Consider buying a new one.', inline: false });
    } else {
        embed.addFields({ name: 'ℹ️ Note', value: `Max durability slightly reduced to ${rod.maxDurability} after this repair.`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

// ─── KIT REPAIR ──────────────────────────────────────────────────────────────

async function handleKitRepair(interaction, user, rod, currency) {
    const kitId     = interaction.options.getString('size');
    const f         = user.fishing;
    const kitStock  = f.consumables[kitId] ?? 0;
    const kitRestore = kitId === 'repair_kit_small' ? 20 : 50;
    const kitName   = kitId === 'repair_kit_small' ? 'Small Repair Kit' : 'Large Repair Kit';

    if (kitStock <= 0) {
        return interaction.reply({ content: `You don't have any **${kitName}**. Buy one from \`/fishshop\`.`, ephemeral: true });
    }

    if (rod.status === 'condemned') {
        return interaction.reply({ content: 'This rod is condemned. A repair kit cannot fix it.', ephemeral: true });
    }
    if (rod.currentDurability >= rod.maxDurability && rod.status !== 'broken') {
        return interaction.reply({ content: 'Your rod is already at full durability.', ephemeral: true });
    }

    const restored = Math.min(kitRestore, rod.maxDurability - rod.currentDurability);
    rod.currentDurability = Math.min(rod.maxDurability, rod.currentDurability + restored);

    const { updateRodStatus } = require('../../services/fishService');
    updateRodStatus(rod);

    f.consumables[kitId] -= 1;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishrepair kit] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${kitId === 'repair_kit_small' ? '🔧' : '🔨'} ${kitName} Used`)
        .addFields(
            { name: 'Rod',       value: rod.name,                                              inline: true },
            { name: 'Restored',  value: `+${restored} durability`,                            inline: true },
            { name: 'Remaining', value: `${kitStock - 1} kit(s) left`,                        inline: true },
            { name: 'Durability',value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
            { name: 'Status',    value: `${rodStatusEmoji(rod.status)} ${rod.status}`,        inline: true }
        )
        .setFooter({ text: 'Repair kits do not degrade max durability.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}
