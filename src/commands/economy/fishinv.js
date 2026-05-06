'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { ROD_UPGRADES, MATERIAL_NAMES, BAIT_PACKS } = require('../../data/fishData');
const {
    ensureFishingData,
    applyStaminaRegen,
    rodStatusEmoji,
    durabilityBar
} = require('../../services/fishService');

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fishinv')
        .setDescription('View and manage your fishing inventory')
        .addSubcommand(sub =>
            sub.setName('rods')
                .setDescription('View your fishing rods'))
        .addSubcommand(sub =>
            sub.setName('equip')
                .setDescription('Equip a rod by its inventory number')
                .addIntegerOption(o =>
                    o.setName('number')
                        .setDescription('Rod number from /fishinv rods')
                        .setMinValue(1)
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('bait')
                .setDescription('View your bait and consumable stock'))
        .addSubcommand(sub =>
            sub.setName('materials')
                .setDescription('View your crafting materials')),

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
        applyStaminaRegen(user);

        switch (sub) {
            case 'rods':      return showRods(interaction, user);
            case 'equip':     return equipRod(interaction, user);
            case 'bait':      return showBait(interaction, user, currency);
            case 'materials': return showMaterials(interaction, user);
        }
    }
};

// ─── RODS ────────────────────────────────────────────────────────────────────

async function showRods(interaction, user) {
    const f = user.fishing;

    if (!f.rods.length) {
        return interaction.reply({ content: `You don't own any rods yet. Buy one with \`/buyrod\`.`, ephemeral: true });
    }

    const { ROD_BY_TIER } = require('../../data/fishData');
    const lines = f.rods.map((rod, i) => {
        const equipped   = i === f.equippedRodIndex ? ' **[EQUIPPED]**' : '';
        const statusEmoji = rodStatusEmoji(rod.status);
        const bar         = durabilityBar(rod.currentDurability, rod.maxDurability, 8);
        const upgradeStr  = rod.upgrade ? ` | ${ROD_UPGRADES[rod.upgrade]?.emoji ?? ''} ${rod.upgrade.replace(/_/g, ' ')}` : '';
        return `**${i + 1}.** ${rod.name}${equipped}\n   ${statusEmoji} ${bar} ${rod.currentDurability}/${rod.maxDurability}${upgradeStr}`;
    });

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`🎣 ${interaction.user.username}'s Rods`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Use /fishinv equip <number> to equip a rod • /fishrepair to repair' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── EQUIP ───────────────────────────────────────────────────────────────────

async function equipRod(interaction, user) {
    const f      = user.fishing;
    const number = interaction.options.getInteger('number');
    const index  = number - 1;

    if (index < 0 || index >= f.rods.length) {
        return interaction.reply({ content: `Invalid rod number. You have **${f.rods.length}** rod(s).`, ephemeral: true });
    }

    const rod = f.rods[index];
    if (rod.status === 'broken') {
        return interaction.reply({ content: `Your **${rod.name}** is broken and cannot be equipped. Repair it first with \`/fishrepair\`.`, ephemeral: true });
    }

    f.equippedRodIndex = index;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishinv equip] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('✅ Rod Equipped')
                .setDescription(`You equipped **${rod.name}** (Slot ${number}).`)
                .addFields({ name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: true })
                .setTimestamp()
        ]
    });
}

// ─── BAIT & CONSUMABLES ───────────────────────────────────────────────────────

async function showBait(interaction, user, currency) {
    const f = user.fishing;

    const baitLines = Object.entries(f.bait ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([type, qty]) => {
            const pack = BAIT_PACKS.find(b => b.baitType === type);
            return `${pack?.emoji ?? '🪱'} **${type.replace(/_/g, ' ')}**: ${qty}`;
        });

    const { CONSUMABLES } = require('../../data/fishData');
    const consumableLines = Object.entries(f.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            return `${def?.emoji ?? '📦'} **${def?.name ?? id}**: ${qty}`;
        });

    const activeLines = [];
    if (f.activeBait)    activeLines.push(`🐟 Chum Bait active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)    activeLines.push(`🍀 Angler's Luck queued`);
    if (f.activeXpScroll) activeLines.push(`📜 XP Scroll queued`);

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎒 ${interaction.user.username}'s Fishing Supplies`)
        .addFields(
            { name: '🪱 Bait Stock', value: baitLines.length ? baitLines.join('\n') : 'None', inline: false },
            { name: '🧪 Consumables', value: consumableLines.length ? consumableLines.join('\n') : 'None', inline: false },
            { name: '⚡ Active Buffs', value: activeLines.length ? activeLines.join('\n') : 'None', inline: false }
        )
        .setFooter({ text: 'Use /fishshop to buy supplies • /use <item> to activate consumables' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── MATERIALS ───────────────────────────────────────────────────────────────

async function showMaterials(interaction, user) {
    const f = user.fishing;
    const matLines = Object.entries(f.materials ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}**: ${qty}`);

    // Also show hunt materials the player has (cross-system visibility)
    const huntMats = user.hunt?.materials ?? {};
    const huntMatLines = ['rabbits_foot', 'feather'].map(id => {
        const qty = huntMats[id] ?? 0;
        if (!qty) return null;
        return `• **${id.replace(/_/g, ' ')}** (hunt): ${qty}`;
    }).filter(Boolean);

    const embed = new EmbedBuilder()
        .setColor('#95a5a6')
        .setTitle(`🪨 ${interaction.user.username}'s Fishing Materials`)
        .addFields(
            { name: 'Fishing Materials', value: matLines.length ? matLines.join('\n') : 'None yet — catch fish for material drops!', inline: false }
        );

    if (huntMatLines.length) {
        embed.addFields({ name: 'Hunt Materials (cross-system)', value: huntMatLines.join('\n'), inline: false });
    }

    embed.setFooter({ text: 'Materials are used in crafting recipes. /fishcraft (coming soon)' });
    embed.setTimestamp();

    return interaction.reply({ embeds: [embed] });
}
