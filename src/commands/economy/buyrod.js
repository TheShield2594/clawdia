'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { ROD_TIERS, ROD_BY_SLUG, ROD_UPGRADES } = require('../../data/fishData');
const { ensureFishingData, rodStatusEmoji } = require('../../services/fishService');

const ROD_CHOICES = ROD_TIERS.map(r => ({ name: `${r.emoji} ${r.name} (${r.cost.toLocaleString()} coins)`, value: r.slug }));
const UPGRADE_CHOICES = Object.values(ROD_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('buyrod')
        .setDescription('Purchase a fishing rod or upgrade an existing one')
        .addSubcommand(sub =>
            sub.setName('rod')
                .setDescription('Buy a new fishing rod')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Which rod to buy')
                        .setRequired(true)
                        .addChoices(...ROD_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('upgrade')
                .setDescription('Install an upgrade on your equipped rod (one upgrade per rod)')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Which upgrade to install')
                        .setRequired(true)
                        .addChoices(...UPGRADE_CHOICES))),

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

        if (sub === 'rod') {
            return handleBuyRod(interaction, user, currency);
        }
        return handleBuyUpgrade(interaction, user, currency);
    }
};

// ─── BUY ROD ─────────────────────────────────────────────────────────────────

async function handleBuyRod(interaction, user, currency) {
    const slug    = interaction.options.getString('type');
    const rodData = ROD_BY_SLUG[slug];

    if (!rodData) {
        return interaction.reply({ content: 'Unknown rod type.', ephemeral: true });
    }

    if (user.balance < rodData.cost) {
        return interaction.reply({
            content: `You need **${currency}${rodData.cost.toLocaleString()}** to buy the **${rodData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`${rodData.emoji} Purchase ${rodData.name}?`)
        .setDescription(rodData.description)
        .addFields(
            { name: 'Cost',        value: `${currency}${rodData.cost.toLocaleString()}`, inline: true },
            { name: 'Durability',  value: `${rodData.baseDurability}`,                   inline: true },
            { name: 'Success Rate',value: `${Math.round(rodData.successRate * 100)}%`,   inline: true },
            { name: 'Rarity Boost',value: rodData.rarityBoost > 0 ? `+${Math.round(rodData.rarityBoost * 100)}%` : 'None', inline: true },
            { name: 'Bait Type',   value: rodData.requiresBait ? rodData.baitType.replace(/_/g, ' ') : 'No bait needed', inline: true },
            { name: 'Your Balance',value: `${currency}${user.balance.toLocaleString()}`, inline: true }
        )
        .setFooter({ text: 'This confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buyrod_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buyrod_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true });

    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', ephemeral: true });
        }
        collector.stop();

        if (btn.customId === 'buyrod_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        // Re-fetch for optimistic concurrency safety
        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        ensureFishingData(freshUser);

        if (freshUser.balance < rodData.cost) {
            return btn.update({ content: `Insufficient funds. You need ${currency}${rodData.cost.toLocaleString()}.`, embeds: [], components: [] });
        }

        freshUser.balance -= rodData.cost;
        freshUser.fishing.rods.push({
            name:              rodData.name,
            tier:              rodData.tier,
            slug:              rodData.slug,
            currentDurability: rodData.baseDurability,
            maxDurability:     rodData.baseDurability,
            baseDurability:    rodData.baseDurability,
            repairCount:       0,
            upgrade:           null,
            status:            'good'
        });
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[buyrod] save error:', err);
            return btn.update({ content: 'Something went wrong. Please try again.', embeds: [], components: [] });
        }

        const rodIndex   = freshUser.fishing.rods.length;
        const successEmbed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`${rodData.emoji} ${rodData.name} Purchased!`)
            .setDescription(`You now own a **${rodData.name}**. Equip it with \`/fishinv equip ${rodIndex}\`.`)
            .addFields(
                { name: 'Spent',   value: `${currency}${rodData.cost.toLocaleString()}`, inline: true },
                { name: 'Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true }
            );

        return btn.update({ embeds: [successEmbed], components: [] });
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

// ─── BUY UPGRADE ─────────────────────────────────────────────────────────────

async function handleBuyUpgrade(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Use \`/fishinv equip\` first.`, ephemeral: true });
    }

    const upgradeId   = interaction.options.getString('type');
    const upgradeDef  = ROD_UPGRADES[upgradeId];
    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade.', ephemeral: true });
    }

    const rod     = f.rods[f.equippedRodIndex];
    const rodData = require('../../data/fishData').ROD_BY_TIER[rod.tier];
    const cost    = Math.round(rodData.cost * upgradeDef.costMultiplier);

    if (rod.upgrade) {
        return interaction.reply({
            content: `Your **${rod.name}** already has the **${rod.upgrade.replace(/_/g, ' ')}** upgrade. Each rod can only hold one upgrade.`,
            ephemeral: true
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need **${currency}${cost.toLocaleString()}** to install **${upgradeDef.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle(`${upgradeDef.emoji} Install ${upgradeDef.name}?`)
        .setDescription(`Installing on **${rod.name}**\n${upgradeDef.description}`)
        .addFields(
            { name: 'Cost',        value: `${currency}${cost.toLocaleString()}`, inline: true },
            { name: 'Your Balance',value: `${currency}${user.balance.toLocaleString()}`, inline: true }
        )
        .setFooter({ text: 'One upgrade per rod. This cannot be removed.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('upgrade_confirm').setLabel('Install').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('upgrade_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true });

    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', ephemeral: true });
        }
        collector.stop();

        if (btn.customId === 'upgrade_cancel') {
            return btn.update({ content: 'Installation cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        ensureFishingData(freshUser);

        if (freshUser.balance < cost) {
            return btn.update({ content: `Insufficient funds.`, embeds: [], components: [] });
        }

        const freshRod = freshUser.fishing.rods[freshUser.fishing.equippedRodIndex];
        if (!freshRod || freshRod.upgrade) {
            return btn.update({ content: `Rod already has an upgrade or is no longer equipped.`, embeds: [], components: [] });
        }

        freshUser.balance -= cost;
        freshRod.upgrade   = upgradeId;
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[buyrod upgrade] save error:', err);
            return btn.update({ content: 'Something went wrong. Please try again.', embeds: [], components: [] });
        }

        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${upgradeDef.emoji} ${upgradeDef.name} Installed!`)
                    .setDescription(`**${freshRod.name}** now has **${upgradeDef.name}** installed permanently.`)
                    .addFields(
                        { name: 'Effect',  value: upgradeDef.description, inline: true },
                        { name: 'Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true }
                    )
            ],
            components: []
        });
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Installation timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}
