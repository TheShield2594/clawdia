'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { LOCATIONS, LOCATION_LIST, TIER_COLORS } = require('../../data/fishData');
const { ensureFishingData } = require('../../services/fishService');

const LOCATION_CHOICES = LOCATION_LIST.filter(l => !l.defaultUnlocked).map(l => ({
    name: `${l.emoji} ${l.name}`,
    value: l.id
}));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fishlocation')
        .setDescription('Manage your fishing locations')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('View all fishing locations and their requirements'))
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Switch to an unlocked location')
                .addStringOption(o =>
                    o.setName('location')
                        .setDescription('Location to fish at')
                        .setRequired(true)
                        .addChoices(...LOCATION_LIST.map(l => ({ name: `${l.emoji} ${l.name}`, value: l.id })))))
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock a new fishing location')
                .addStringOption(o =>
                    o.setName('location')
                        .setDescription('Location to unlock')
                        .setRequired(true)
                        .addChoices(...LOCATION_CHOICES))),

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

        switch (sub) {
            case 'list':   return showList(interaction, user, currency);
            case 'set':    return setLocation(interaction, user);
            case 'unlock': return unlockLocation(interaction, user, currency);
        }
    }
};

// ─── LIST ─────────────────────────────────────────────────────────────────────

async function showList(interaction, user, currency) {
    const f = user.fishing;

    const locationLines = LOCATION_LIST.map(loc => {
        const isUnlocked = f.unlockedLocations.includes(loc.id);
        const isActive   = f.activeLocation === loc.id;
        const tierStr    = formatTierWeights(loc.tierWeights);
        const status     = isActive ? ' **[ACTIVE]**' : isUnlocked ? ' ✅' : ` 🔒 Lv.${loc.unlockLevel}${loc.unlockCost > 0 ? ` / ${currency}${loc.unlockCost.toLocaleString()}` : ''}`;

        return [
            `${loc.emoji} **${loc.name}**${status}`,
            `   ${loc.description}`,
            `   Tiers: ${tierStr}`,
            `   Junk: ${Math.round(loc.junkChance * 100)}% | Treasure: ${Math.round(loc.treasureChance * 100)}%${loc.payoutBonus > 0 ? ` | Payout +${Math.round(loc.payoutBonus * 100)}%` : ''}`
        ].join('\n');
    });

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle('🗺️ Fishing Locations')
        .setDescription(locationLines.join('\n\n'))
        .setFooter({ text: 'Use /fishlocation unlock <location> to unlock • /fishlocation set <location> to switch' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── SET LOCATION ─────────────────────────────────────────────────────────────

async function setLocation(interaction, user) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', ephemeral: true });
    }
    if (!f.unlockedLocations.includes(locationId)) {
        return interaction.reply({
            content: `**${location.name}** is locked. Use \`/fishlocation unlock ${locationId}\` to unlock it first.`,
            ephemeral: true
        });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to fish at **${location.name}**. You are Level **${f.level}**.`,
            ephemeral: true
        });
    }

    f.activeLocation = locationId;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[location set] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`📍 Location Changed`)
        .setDescription(`You are now fishing at **${location.emoji} ${location.name}**.`)
        .addFields({ name: 'About', value: location.description, inline: false })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── UNLOCK LOCATION ──────────────────────────────────────────────────────────

async function unlockLocation(interaction, user, currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', ephemeral: true });
    }
    if (f.unlockedLocations.includes(locationId)) {
        return interaction.reply({ content: `**${location.name}** is already unlocked.`, ephemeral: true });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to unlock **${location.name}**. You are Level **${f.level}**.`,
            ephemeral: true
        });
    }
    if (user.balance < location.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${location.name}** costs **${currency}${location.unlockCost.toLocaleString()}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    user.balance -= location.unlockCost;
    f.unlockedLocations.push(locationId);
    f.activeLocation = locationId;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[location unlock] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🗺️ ${location.emoji} ${location.name} Unlocked!`)
        .setDescription(location.description)
        .addFields(
            { name: 'Cost Paid', value: location.unlockCost > 0 ? `${currency}${location.unlockCost.toLocaleString()}` : 'Free', inline: true },
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Status',    value: 'Now your active location!', inline: true }
        )
        .setFooter({ text: 'Use /fish to start catching from this location' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatTierWeights(weights) {
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    return Object.entries(weights)
        .filter(([, w]) => w > 0)
        .map(([tier, w]) => `${tier} ${Math.round((w / total) * 100)}%`)
        .join(', ');
}
